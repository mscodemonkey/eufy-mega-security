/**
 * Implements one first-party Eufy PPCS UDP camera session.
 *
 * PPCS is Eufy's peer-to-peer camera transport, not RTSP and not a Home
 * Assistant protocol. This class performs LAN and cloud lookup, `CAM_CHECK`,
 * command-frame reassembly, HomeBase gateway-info decryption, level-two key
 * setup, heartbeat, video-key exchange, H.264 or H.265 Annex-B media output,
 * and bounded camera control writes. It consumes
 * DSK/cipher material prepared by `EufyProvider` and exposes a readable byte
 * stream plus safe counters, so the rest of the gateway never handles PPCS
 * packet layout or camera encryption directly.
 */
import { createCipheriv, createDecipheriv, createECDH, createHmac, generateKeyPairSync, privateDecrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { PassThrough } from "node:stream";
import type { VideoCodec } from "../domain/types.js";
import { PpcsAccessUnitAssembler } from "./ppcs-access-unit-assembler.js";
import { ppcsCandidatePorts, ppcsLocalLookupTargets } from "./ppcs-lookup.js";

// PPCS wraps command payloads in an XZYH header. The outer F1 D0 UDP envelope,
// the inner D1 data channel, and the XZYH command frame have separate sequence
// fields. Their numeric fields also use different byte orders.
const MAGIC = Buffer.from("XZYH", "ascii");

// These request and response values are observed PPCS wire opcodes. Keeping
// them grouped by direction avoids confusing identical values that have
// different meanings depending on which peer sent them.
const REQ = {
  lookup: Buffer.from([0xf1, 0x26]),
  lookup2: Buffer.from([0xf1, 0x6a]),
  localLookup: Buffer.from([0xf1, 0x30]),
  check: Buffer.from([0xf1, 0x41]),
  ping: Buffer.from([0xf1, 0xe0]),
  data: Buffer.from([0xf1, 0xd0]),
  ack: Buffer.from([0xf1, 0xd1]),
  end: Buffer.from([0xf1, 0xf0]),
} as const;
const RESP = {
  lookupAddr: Buffer.from([0xf1, 0x40]),
  lookupAddr2: Buffer.from([0xf1, 0x82]),
  localLookup: Buffer.from([0xf1, 0x41]),
  camId: Buffer.from([0xf1, 0x42]),
  turnServerCamId: Buffer.from([0xf1, 0x84]),
  pong: Buffer.from([0xf1, 0xe1]),
  data: Buffer.from([0xf1, 0xd0]),
} as const;

// The byte after D1 separates command data from camera video while both travel
// inside the same outer F1 D0 PPCS transport packet.
const DATA = { data: Buffer.from([0xd1, 0]), video: Buffer.from([0xd1, 1]) } as const;
const ATTACHED_MEDIA_STALL_MILLISECONDS = 10_000;
const ATTACHED_MEDIA_RESTART_DELAY_MILLISECONDS = 250;
const FIRST_VIDEO_FRAME_TIMEOUT_MILLISECONDS = 20_000;
const CONTROL_TIMEOUT_MILLISECONDS = 10_000;
const LOOKUP_RETRY_MILLISECONDS = 1_000;
const PPCS_RECEIVE_BUFFER_BYTES = 1024 * 1024;
const PPCS_SEQUENCE_LOOKBACK = 0x8000;
const PPCS_STALE_RETRANSMIT_DEPTH = 1024;
const ANNEX_B_START_CODE = Buffer.from([0, 0, 0, 1]);
const MAX_NAL_UNIT_BYTES = 16 * 1024 * 1024;

/** Stable terminal states retained for stream-close diagnostics. */
type PpcsStreamCloseReason = "client_stop" | "first_frame_timeout" | "max_duration" | "replaced" | "start_failed";

/**
 * Decide whether a HomeBase-attached camera needs its full media start sent again.
 *
 * A HomeBase has no lightweight media keepalive for a child channel. Repeating
 * its start while normalized frames are still arriving resets that channel,
 * so a reassert is limited to startup without output and a genuine media stall.
 */
export function needsAttachedMediaReassert(
  lastDeliveredFrameAt: number | null,
  now: number,
): boolean {
  return lastDeliveredFrameAt === null || now - lastDeliveredFrameAt >= ATTACHED_MEDIA_STALL_MILLISECONDS;
}

/** Return whether cumulative codec evidence includes configuration and an IDR. */
export function hasDecoderReadyKeyframe(
  codec: "h264" | "h265" | "unknown",
  nalTypes: readonly number[],
): boolean {
  if (codec === "h264") return nalTypes.includes(7) && nalTypes.includes(8) && nalTypes.includes(5);
  if (codec === "h265") {
    return nalTypes.includes(32)
      && nalTypes.includes(33)
      && nalTypes.includes(34)
      && (nalTypes.includes(19) || nalTypes.includes(20));
  }
  return false;
}

/** Reissue a standalone start until frame metadata or NAL evidence identifies its codec. */
export function needsStandaloneMediaReassert(
  homeBaseAttached: boolean,
  codec: "h264" | "h265" | "unknown",
): boolean {
  return !homeBaseAttached && codec === "unknown";
}

/**
 * Decide whether a decoded HomeBase media command belongs to the camera this session requested.
 *
 * A HomeBase can multiplex children over one peer route. Foreign video must not be sent to this
 * camera's consumer or settle its media-start retry: doing either leaves the requested channel
 * starved while another camera's frames continue to arrive.
 */
export function acceptsAttachedCameraMedia(command: number, frameChannel: number, requestedChannel: number): boolean {
  return command !== 1300 || frameChannel === requestedChannel;
}

/**
 * Build the JSON value encrypted inside a HomeBase media start or stop.
 *
 * Command 1003 starts a child camera and must advertise the session's RSA
 * modulus so the camera can wrap its media key. Command 1004 stops the child
 * channel and deliberately carries an empty payload. The caller applies
 * level-two encryption after this function returns.
 */
export function buildAttachedMediaControlValue(
  command: 1003 | 1004,
  channel: number,
  accountId: string,
  publicKey?: string,
): Buffer {
  if (command === 1003 && !publicKey) throw new Error("Attached media start requires an RSA public key");
  return Buffer.from(JSON.stringify({
    account_id: accountId,
    cmd: command,
    mChannel: channel,
    mValue3: command,
    payload: command === 1003
      ? {
          ClientOS: "Android",
          accountId,
          camera_type: 0,
          entrytype: 0,
          key: publicKey,
          streamtype: 1,
        }
      : {},
  }));
}

/** Build the encrypted direct stop command required by a T8010 HomeBase 2. */
export function buildLegacyAttachedMediaStopPayload(channel: number, key: Buffer): Buffer {
  const value = Buffer.alloc(4);
  value.writeUInt32LE(channel, 0);
  return rawPayload(encryptLevel1(value, key), channel, 1, [1, 0], 0);
}

/** Read the camera channel from the current 16-byte PPCS command header. */
export function ppcsFrameChannel(frame: Buffer): number | null {
  return frame.length >= 16 && frame.subarray(0, 4).equals(MAGIC) ? (frame[12] ?? null) : null;
}

/** Return the bytes to retain when a command stream ends part-way through its next XZYH header. */
export function ppcsPartialCommandPrefix(data: Buffer): Buffer | undefined {
  if (data.length === 0 || data.length >= 16) return undefined;
  if (data.length >= MAGIC.length && data.subarray(0, MAGIC.length).equals(MAGIC)) {
    return Buffer.from(data);
  }
  const limit = Math.min(data.length, MAGIC.length);
  for (let length = limit; length > 0; length -= 1) {
    if (data.subarray(data.length - length).equals(MAGIC.subarray(0, length))) {
      return Buffer.from(data.subarray(data.length - length));
    }
  }
  return undefined;
}

/** Find a complete command header after discarded bytes in one PPCS data body. */
export function ppcsCommandMagicOffset(data: Buffer): number {
  return data.indexOf(MAGIC);
}

/** Classify a 16-bit PPCS datagram sequence relative to the last accepted value. */
export function ppcsSequenceDisposition(
  previous: number | null,
  current: number,
): "first" | "next" | "gap" | "duplicate" | "stale" | "restart" {
  if (previous === null) return "first";
  const advance = (current - previous) & 0xffff;
  if (advance === 0) return "duplicate";
  if (advance > PPCS_SEQUENCE_LOOKBACK) {
    return 0x10000 - advance > PPCS_STALE_RETRANSMIT_DEPTH ? "restart" : "stale";
  }
  return advance === 1 ? "next" : "gap";
}

/**
 * Decode one legacy PPCS video frame using only the key carried by that frame.
 *
 * Encrypted frames wrap a fresh AES key ahead of their media bytes. Plaintext
 * frames must never inherit that key: HomeBase streams can switch between the
 * two forms, and decrypting a later plaintext frame corrupts valid Annex-B.
 */
export function decodePpcsVideoFrame(
  frame: Buffer,
  signCode: number,
  unwrapKey: (wrapped: Buffer) => Buffer | undefined,
): Buffer | undefined {
  return decodeLegacyPpcsVideoFrame(frame, signCode, unwrapKey).data;
}

/** Privacy-safe structural reason a PPCS media frame could not be decoded. */
export type PpcsVideoFrameDecodeFailure =
  | "short-frame"
  | "clear-length"
  | "authenticated-short"
  | "legacy-length"
  | "legacy-key-unwrap"
  | "legacy-key-unavailable"
  | "legacy-key-size"
  | "legacy-decrypt";

interface LegacyPpcsVideoFrameDecodeResult {
  readonly data?: Buffer;
  readonly failure?: PpcsVideoFrameDecodeFailure;
}

/** Decode legacy media while retaining only a bounded structural failure reason. */
function decodeLegacyPpcsVideoFrame(
  frame: Buffer,
  signCode: number,
  unwrapKey: (wrapped: Buffer) => Buffer | undefined,
): LegacyPpcsVideoFrameDecodeResult {
  if (frame.length < 22) return { failure: "short-frame" };
  const length = frame.readUInt32LE(0);
  if (signCode <= 0 || length < 128) {
    if (frame.length < 22 + length) return { failure: "clear-length" };
    return { data: frame.subarray(22, 22 + length) };
  }
  if (frame.length < 151 + length) return { failure: "legacy-length" };
  let key: Buffer | undefined;
  try {
    key = unwrapKey(frame.subarray(22, 150));
  } catch {
    return { failure: "legacy-key-unwrap" };
  }
  if (!key) return { failure: "legacy-key-unavailable" };
  if (key.length !== 16 && key.length !== 32) return { failure: "legacy-key-size" };
  try {
    const encrypted = frame.subarray(151, 151 + 128);
    const clear = decryptEcb(encrypted, key);
    return { data: Buffer.concat([clear, frame.subarray(151 + 128, 151 + length)]) };
  } catch {
    return { failure: "legacy-decrypt" };
  }
}

/** Result of decoding a video payload, including the wire protection that succeeded. */
export interface DecodedPpcsVideoFrame {
  readonly data: Buffer;
  readonly protection: "clear" | "rsa-ecb" | "ecc-gcm";
}

/**
 * Decode both legacy RSA-wrapped media and authenticated ECC-wrapped media.
 *
 * The session owns one instance for the life of a stream because authenticated
 * delta frames reuse the media key established by the most recent keyframe.
 * The ECC private key arrives during HomeBase level-two negotiation, before the
 * attached-camera media request is sent.
 */
export class PpcsVideoFrameDecoder {
  #eccPrivateKey: Buffer | null = null;
  #mediaKey: Buffer | null = null;
  #lastFailure: PpcsVideoFrameDecodeFailure | null = null;

  /** Create a decoder around the session's legacy RSA unwrap operation. */
  constructor(private readonly unwrapLegacyKey: (wrapped: Buffer) => Buffer | undefined) {}

  /** Return the structural reason the most recent decode failed, without media or key data. */
  get lastFailure(): PpcsVideoFrameDecodeFailure | null {
    return this.#lastFailure;
  }

  /** Replace the camera key used for authenticated media and forget any prior stream key. */
  setEccPrivateKey(value: string): void {
    const key = Buffer.from(value, "hex");
    this.#eccPrivateKey = key.length === 32 ? key : null;
    this.#mediaKey = null;
  }

  /**
   * Decode one command-1300 payload for access-unit reassembly.
   *
   * Successfully unwrapped legacy chunks may begin mid-NAL, so framing is
   * deliberately left to the assembler and stream normalizer. Short signed
   * frames remain authenticated-only because they cannot carry the legacy
   * 128-byte encrypted prefix.
   */
  decode(frame: Buffer, signCode: number): DecodedPpcsVideoFrame | undefined {
    this.#lastFailure = null;
    if (signCode <= 0) {
      const result = decodeLegacyPpcsVideoFrame(frame, signCode, this.unwrapLegacyKey);
      this.#lastFailure = result.failure ?? null;
      return result.data ? { data: result.data, protection: "clear" } : undefined;
    }

    const authenticated = this.#decodeAuthenticated(frame);
    if (authenticated) return { data: authenticated, protection: "ecc-gcm" };

    // A short signed frame cannot carry the legacy 128-byte encrypted prefix.
    // Falling through after failed GCM authentication would emit its envelope as video.
    if (frame.length >= 4 && frame.readUInt32LE(0) < 128) {
      this.#lastFailure = "authenticated-short";
      return undefined;
    }
    const legacy = decodeLegacyPpcsVideoFrame(frame, signCode, this.unwrapLegacyKey);
    this.#lastFailure = legacy.failure ?? null;
    return legacy.data ? { data: legacy.data, protection: "rsa-ecb" } : undefined;
  }

  /**
   * Authenticate and decrypt the ECC-GCM media form used by newer HomeBases.
   *
   * Keyframes carry a fresh ECIES-wrapped media key. Delta frames omit that
   * envelope and reuse the last authenticated key, so the decoder owns it for
   * the session lifetime. A key from a keyframe is committed only after GCM
   * authentication succeeds, preventing a damaged frame from poisoning every
   * later delta frame.
   */
  #decodeAuthenticated(frame: Buffer): Buffer | undefined {
    if (!this.#eccPrivateKey || frame.length < 179) return undefined;
    const keyframe = ((frame[4] ?? 0) & 1) === 1;
    const candidateKey = keyframe
      ? unwrapAuthenticatedMediaKey(frame.subarray(22, 151), this.#eccPrivateKey)
      : this.#mediaKey;
    if (!candidateKey) return undefined;

    try {
      const decipher = createDecipheriv("aes-256-gcm", candidateKey, frame.subarray(167, 179));
      decipher.setAAD(Buffer.from("eufy security", "utf8"));
      decipher.setAuthTag(frame.subarray(151, 167));
      const data = Buffer.concat([decipher.update(frame.subarray(179)), decipher.final()]);
      if (keyframe) this.#mediaKey = candidateKey;
      return data.length > 0 ? data : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Unwrap and authenticate the 32-byte media key carried by an ECC keyframe.
 *
 * The envelope contains a compressed P-256 ephemeral public key, an AES-CBC
 * IV and ciphertext, and an HMAC. Eufy's ECIES-compatible derivation expands
 * the ECDH shared secret into separate encryption and authentication material.
 * Authentication is checked before decryption, and malformed peer points or
 * padding failures are reported to the caller as an absent key.
 */
function unwrapAuthenticatedMediaKey(envelope: Buffer, privateKey: Buffer): Buffer | undefined {
  if (envelope.length !== 129) return undefined;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(privateKey);
    const shared = ecdh.computeSecret(envelope.subarray(0, 33));
    const label = Buffer.from("ECIES", "utf8");
    const hmac = (key: Buffer, value: Buffer): Buffer => createHmac("sha256", key).update(value).digest();
    let previous: Buffer<ArrayBufferLike> = label;
    let derived: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    while (derived.length < 48) {
      previous = hmac(shared, previous);
      derived = Buffer.concat([derived, hmac(shared, Buffer.concat([previous, label]))]);
    }
    const expectedTag = hmac(derived.subarray(16, 48), envelope.subarray(33, 97));
    if (!timingSafeEqual(expectedTag, envelope.subarray(97, 129))) return undefined;
    const decipher = createDecipheriv("aes-128-cbc", derived.subarray(0, 16), envelope.subarray(33, 49));
    const plain = Buffer.concat([decipher.update(envelope.subarray(49, 97)), decipher.final()]);
    return plain.length === 32 ? plain : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the level-one control payload that starts a standalone camera stream.
 *
 * The encrypted JSON is labelled with sign code 1 and frame type 11 so the
 * camera decrypts it as its own-session START_LIVE command. HomeBase-attached
 * cameras use the separate negotiated level-two path.
 */
export function buildStandaloneLiveStartPayload(value: string, channel: number, key: Buffer): Buffer {
  const bytes = Buffer.from(value);
  const plain = Buffer.alloc(Math.ceil(Math.max(bytes.length, 16) / 16) * 16);
  bytes.copy(plain);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return rawPayload(encrypted, channel, 1, [1, 0], 11);
}

/**
 * Build one authenticated cloud lookup request for a PPCS peer.
 *
 * The lightweight variant is valid while the host address is still unknown.
 * Once available, the classic request includes the caller's routed address and
 * the app-compatible client version needed to obtain a direct peer candidate.
 */
export function buildPpcsCloudLookup(
  p2pDid: string,
  dskKey: string,
  selfAddress?: { readonly host: string; readonly port: number },
): { readonly type: Buffer; readonly payload: Buffer } {
  if (!selfAddress) {
    return {
      type: REQ.lookup2,
      payload: Buffer.concat([encodeDid(p2pDid), Buffer.from(dskKey), Buffer.alloc(4)]),
    };
  }
  const address = Buffer.alloc(16);
  address.writeUInt16BE(2, 0);
  address.writeUInt16LE(selfAddress.port, 2);
  const octets = selfAddress.host.split(".").map(Number);
  address.set([octets[3] ?? 0, octets[2] ?? 0, octets[1] ?? 0, octets[0] ?? 0], 4);
  return {
    type: REQ.lookup,
    payload: Buffer.concat([
      encodeDid(p2pDid),
      address,
      Buffer.from([2, 5, 1, 5]),
      Buffer.from(dskKey),
      Buffer.alloc(4),
    ]),
  };
}

/** Read a peer candidate from either PPCS cloud lookup response form. */
export function ppcsLookupCandidate(message: Buffer): { readonly host: string; readonly port: number } | null {
  if ((!has(message, RESP.lookupAddr) && !has(message, RESP.lookupAddr2)) || message.length < 12) return null;
  return {
    port: message.readUInt16LE(6),
    host: `${message[11]}.${message[10]}.${message[9]}.${message[8]}`,
  };
}

/** Return whether a PPCS response completes either a direct or relay peer handshake. */
export function isPpcsCameraIdentity(message: Buffer): boolean {
  return has(message, RESP.camId) || has(message, RESP.turnServerCamId);
}

/**
 * Normalizes one camera's continuous video byte stream to Annex-B framing.
 *
 * Length prefixes and NAL bodies may cross PPCS frame boundaries, so one
 * instance owns the unfinished prefix and body length for the entire session.
 * Annex-B streams pass through without buffering or rewriting.
 */
export class PpcsVideoStreamNormalizer {

  // Framing is selected once per camera session. Switching after output has
  // begun would reinterpret bytes already handed to the downstream decoder.
  #mode: "unknown" | "annexb" | "length-prefixed" = "unknown";

  // At most the incomplete four-byte length prefix from the previous push.
  #prefix = Buffer.alloc(0);

  // Length-prefixed NAL bodies can span several PPCS frames. Once a prefix is
  // consumed, this counter prevents continuation bytes being mistaken for a
  // new length field.
  #nalBytesRemaining = 0;

  // The scanner needs a small overlap because an Annex-B start code may be
  // divided between consecutive output chunks. This never retains video
  // frames, only enough trailing bytes to recognise the next boundary.
  #nalScanTail = Buffer.alloc(0);

  // Only the first byte after each Annex-B start code is retained. That is
  // enough to derive the codec-specific NAL type without logging image data.
  readonly #nalHeaderBytes: number[] = [];

  // Access-unit metadata is a fallback only. Parameter-set NAL units observed
  // in emitted bytes take precedence because they prove the actual codec.
  #declaredCodec: VideoCodec | null = null;

  /** The framing selected from the first usable bytes in this session. */
  get framing(): "unknown" | "annexb" | "length-prefixed" {
    return this.#mode;
  }

  /** Return the codec proven by decoder setup, falling back to the PPCS frame marker. */
  get codec(): "h264" | "h265" | "unknown" {
    if (this.#nalHeaderBytes.some((byte) => {
      const type = (byte >> 1) & 0x3f;
      return type === 32 || type === 33 || type === 34;
    })) return "h265";
    if (this.#nalHeaderBytes.some((byte) => {
      const type = byte & 0x1f;
      return type === 7 || type === 8;
    })) return "h264";
    return this.#declaredCodec ?? "unknown";
  }

  /** Return distinct codec-specific NAL types without retaining their payloads. */
  get nalTypes(): readonly number[] {
    const codec = this.codec;
    return [...new Set(this.#nalHeaderBytes.map((byte) => (
      codec === "h265" ? (byte >> 1) & 0x3f : byte & 0x1f
    )))];
  }

  /**
   * Convert the next ordered media bytes into an Annex-B byte-stream chunk.
   *
   * The caller must provide bytes in transport order and must keep one
   * normalizer for the complete camera session. The first usable bytes select
   * Annex-B pass-through or four-byte big-endian length-prefix conversion.
   * Incomplete prefixes and NAL bodies are retained across calls, so an empty
   * return value means "buffered until more bytes arrive", not "invalid".
   *
   * `declaredCodec` is supporting evidence from the PPCS access-unit header.
   * Parameter-set NAL units take precedence because they prove what the
   * emitted byte stream actually contains.
   */
  push(payload: Buffer, declaredCodec?: VideoCodec): Buffer {
    if (declaredCodec && this.#declaredCodec === null) this.#declaredCodec = declaredCodec;
    let data = this.#prefix.length > 0 ? Buffer.concat([this.#prefix, payload]) : payload;
    this.#prefix = Buffer.alloc(0);
    if (this.#mode === "unknown") {
      if (data.length < 4) {
        this.#prefix = Buffer.from(data);
        return Buffer.alloc(0);
      }
      if (beginsWithAnnexB(data)) {
        this.#mode = "annexb";
        return this.#recordNalTypes(data);
      }
      const length = data.readUInt32BE(0);
      const nalHeader = data[4];
      if (
        length === 0
        || length > MAX_NAL_UNIT_BYTES
        || nalHeader === undefined
        || (nalHeader & 0x80) !== 0
        || (nalHeader & 0x1f) === 0
      ) {
        this.#mode = "annexb";
        return this.#recordNalTypes(data);
      }
      this.#mode = "length-prefixed";
    }
    if (this.#mode === "annexb") return this.#recordNalTypes(data);

    const output: Buffer[] = [];
    while (data.length > 0) {
      if (this.#nalBytesRemaining > 0) {
        const carried = Math.min(this.#nalBytesRemaining, data.length);
        output.push(data.subarray(0, carried));
        data = data.subarray(carried);
        this.#nalBytesRemaining -= carried;
        continue;
      }
      if (data.length < 4) {
        this.#prefix = Buffer.from(data);
        break;
      }
      const length = data.readUInt32BE(0);
      if (length === 0 || length > MAX_NAL_UNIT_BYTES) {
        output.push(data);
        break;
      }
      output.push(ANNEX_B_START_CODE);
      this.#nalBytesRemaining = length;
      data = data.subarray(4);
    }
    return output.length > 0 ? this.#recordNalTypes(Buffer.concat(output)) : Buffer.alloc(0);
  }

  /**
   * Observe NAL headers in an outgoing Annex-B chunk and return it unchanged.
   *
   * This method is deliberately a side-effecting pass-through. Every path
   * that emits bytes calls it, which keeps codec diagnostics aligned with the
   * exact stream delivered to consumers without making a second copy of that
   * stream. It recognises both legal Annex-B start-code lengths (`00 00 01`
   * and `00 00 00 01`) and records only the first payload byte after each
   * start code. H.264 and H.265 interpret that byte differently, so conversion
   * to public NAL type numbers is deferred to {@link nalTypes} after the codec
   * has been identified.
   *
   * A start code can be split across two `push` calls. `#nalScanTail` carries
   * the final four bytes of the previous scan so the next call can recognise
   * that boundary. The diagnostic set is capped at 16 distinct header bytes:
   * it is intended to answer whether decoder setup and keyframes appeared,
   * not to retain or fingerprint the camera's video payload.
   */
  #recordNalTypes(output: Buffer): Buffer {
    const data = this.#nalScanTail.length > 0
      ? Buffer.concat([this.#nalScanTail, output])
      : output;

    // Advance to the byte immediately after each start code. Scanning from
    // there avoids treating zero bytes inside the start code as a new match.
    for (let offset = 0; offset + 3 < data.length;) {
      if (data[offset] !== 0 || data[offset + 1] !== 0) {
        offset++;
        continue;
      }
      const startLength = data[offset + 2] === 1
        ? 3
        : data[offset + 2] === 0 && data[offset + 3] === 1 ? 4 : 0;
      if (startLength === 0) {
        offset++;
        continue;
      }
      const payloadOffset = offset + startLength;

      // The start code is complete but its NAL header belongs to the next
      // output chunk. The overlap retained below lets that later call finish
      // the observation without delaying bytes sent to the decoder.
      if (payloadOffset >= data.length) break;
      const headerByte = data[payloadOffset]!;
      if (!this.#nalHeaderBytes.includes(headerByte) && this.#nalHeaderBytes.length < 16) {
        this.#nalHeaderBytes.push(headerByte);
      }
      offset = payloadOffset + 1;
    }

    // Four bytes cover the longest start code plus a boundary-adjacent byte.
    // Buffer.from detaches this tiny diagnostic tail from the larger video
    // buffer so the session does not accidentally keep an entire frame alive.
    this.#nalScanTail = Buffer.from(data.subarray(Math.max(0, data.length - 4)));
    return output;
  }
}

/** Return whether a chunk starts with a three-byte or four-byte Annex-B marker. */
function beginsWithAnnexB(payload: Buffer): boolean {
  return payload.length >= 4
    && payload[0] === 0
    && payload[1] === 0
    && (payload[2] === 1 || (payload[2] === 0 && payload[3] === 1));
}

/** Incomplete XZYH command state owned separately for each PPCS data type. */
interface PendingPpcsFrame {

  /** Complete command header, present only while waiting for its declared body. */
  readonly header?: Buffer;

  /** Partial command body, or a possible prefix of the next XZYH magic value. */
  readonly payload: Buffer;
}

/**
 * Peer, camera, and lifetime values required by one media or control session.
 *
 * `EufyProvider` owns discovery and credential acquisition. A session receives
 * only the values needed for one bounded peer connection and never refreshes
 * account inventory or persists cryptographic material itself.
 */
export interface PpcsCameraOptions {

  /** Serial used only to derive the observed legacy level-one command key. */
  readonly stationSerial: string;

  /** PPCS device identifier encoded into lookup and CAM_CHECK requests. */
  readonly p2pDid: string;

  /** Obfuscated cloud rendezvous list returned by Eufy's inventory service. */
  readonly appConnection: string;

  /** Most recent private peer address, used alongside LAN broadcast lookup. */
  readonly localAddress?: string | null;

  /** DSK authentication material included in cloud rendezvous requests. */
  readonly dskKey: string;

  /** Child-camera channel, or the standalone camera's own channel. */
  readonly channel: number;

  /** Public model identifier used by higher-level diagnostics. */
  readonly cameraModel: string;

  /** Parent peer model used only where HomeBase generations have different media lifecycle commands. */
  readonly stationModel?: string;

  /** Eufy account identity required inside camera control payloads. */
  readonly accountId: string | null;

  /** Select the HomeBase child-channel handshake instead of direct camera media. */
  readonly homeBaseAttached?: boolean;

  /** Previously observed HomeBase cipher identifier for safe diagnostics. */
  readonly cipherId?: number | null;

  /** Optional cached ECC key that can authenticate media before gateway-info arrives. */
  readonly initialEccPrivateKey?: string;

  /** Resolve the private ECC key selected by a HomeBase gateway-info frame. */
  readonly resolveCipherKey?: (cipherId: number) => Promise<string | undefined>;

  /** Hard session lifetime, defaulting to 30 seconds when omitted. */
  readonly maxSeconds?: number;

  /** Limit the session to one control write instead of starting camera media. */
  readonly purpose?: "media" | "control";
}

/** One in-flight control command and the promise settled by its result frame. */
interface PendingControl {
  readonly command: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Identify a write that may have applied even though its result frame was lost. */
export class CameraControlAcknowledgementTimeoutError extends Error {

  /** Create the stable timeout type used by provider readback recovery. */
  constructor() {
    super("Camera enablement acknowledgement timed out");
    this.name = "CameraControlAcknowledgementTimeoutError";
  }
}

/**
 * One bounded, first-party PPCS camera session for media or a control operation.
 *
 * It handles HomeBase-attached and direct camera paths: DSK lookup,
 * CAM_CHECK, the attached-camera gateway-info and level-two media sequence
 * when required, and Annex-B H.264 or H.265 output. It has no dependency on
 * eufy-security-client or the expiring Web Portal PIN.
 *
 * Media sessions emit Annex-B bytes on `output`. Control sessions suppress
 * media startup and expose the small set of verified writes below. Some writes
 * wait for a result frame, while the observed fire-and-repeat forms return
 * after their bounded UDP transmissions.
 * `start` resolves after the peer answers the lookup, not after the first video
 * frame. A camera can therefore be reachable while still failing later during
 * key unwrap or media start. The public stats object makes that distinction
 * visible in diagnostics.
 */
export class FirstPartyPpcsSession {

  /** Ordered Annex-B video bytes; the session ends this stream when it closes. */
  readonly output = new PassThrough();

  /**
   * Bounded, privacy-safe observations collected over this session.
   *
   * Arrays retain only distinct shapes or a small leading sample. The two hex
   * fields contain bounded wire prefixes used for protocol-shape diagnosis,
   * while decoded media, account values, keys, and full payloads are excluded.
   * The provider reads this object when it builds stream-close diagnostics.
   */
  readonly stats = {
    camId: 0,
    localLookupCandidates: 0,
    directLookupCandidates: 0,
    alternateLookupCandidates: 0,
    dataDatagrams: 0,
    frameHeaders: 0,
    gatewayInfo: 0,
    level2: 0,
    videoFrames: 0,
    videoOutputFrames: 0,
    incompleteAccessUnits: 0,
    incompleteAccessUnitBytes: 0,
    foreignVideoFrames: 0,
    batteryHistory: "not-reported",
    firstDataHex: "",
    cipherId: 0,
    level2Error: "",
    commands: [] as number[],
    frameShapes: [] as string[],
    responseLengths: [] as number[],
    sequenceGaps: 0,
    sequenceRestarts: 0,
    duplicateDatagrams: 0,
    staleDatagrams: 0,
    parserResyncs: 0,
    parserBlocked: false,
    pendingBytes: 0,
    startHex: "",
    types: [] as number[],
    videoResults: [] as string[],
    videoCodec: "unknown" as "h264" | "h265" | "unknown",
    videoNalTypes: [] as number[],
    mediaStartAttempts: 0,
    mediaStopAttempts: 0,
    mediaStopProtocol: "none" as "none" | "level1-direct" | "level2-payload",
    closeReason: "open" as PpcsStreamCloseReason | "open",
  };
  readonly #options: PpcsCameraOptions;
  readonly #socket: Socket = createSocket("udp4");

  // Eufy's observed video-key frame is exactly 128 bytes, which binds this
  // ephemeral per-stream key pair to RSA-1024 until compatible hardware proves
  // a larger modulus is accepted. This is a protocol constraint, not a stored key.
  readonly #rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
  readonly #videoDecoder = new PpcsVideoFrameDecoder((wrapped) => (
    privateDecrypt({ key: this.#rsa.privateKey, padding: 1 }, wrapped)
  ));

  // `#remote` is set only after a CAM_ID response wins the lookup race. All
  // later command and heartbeat traffic stays pinned to that responding peer.
  #remote: { host: string; port: number } | null = null;
  #seq = 0;
  #closed = false;
  #maximumDurationTimer: ReturnType<typeof setTimeout> | null = null;
  #firstFrameTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingByType = new Map<number, PendingPpcsFrame>();
  #level2Key: Buffer | null = null;
  #level2Seq = 0;
  #gatewayPromise: Promise<void> | null = null;

  // PPCS sequences are independent for each inner data type. Combining them
  // would manufacture false gaps when command and video datagrams interleave.
  #lastSequenceByType = new Map<number, number>();
  readonly #videoNormalizer = new PpcsVideoStreamNormalizer();
  readonly #videoAssembler = new PpcsAccessUnitAssembler((drop) => {
    this.stats.incompleteAccessUnits++;
    this.stats.incompleteAccessUnitBytes += drop.carriedBytes;
    this.#recordVideoResult("incomplete-access-unit-dropped");
  });
  #lastAttachedMediaFrameAt: number | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #attachedMediaRestartTimer: ReturnType<typeof setTimeout> | null = null;
  #lookupTimer: ReturnType<typeof setInterval> | null = null;
  #selfAddress: { host: string; port: number } | null = null;
  #pendingControl: PendingControl | null = null;

  /** Return the codec proven by emitted NAL headers, or frame metadata as a fallback. */
  get videoCodec(): VideoCodec | null {
    const codec = this.#videoNormalizer.codec;
    return codec === "unknown" ? null : codec;
  }

  /** Create a session; no socket is bound until {@link start} runs. */
  constructor(options: PpcsCameraOptions) {
    this.#options = options;
    if (options.cipherId !== undefined && options.cipherId !== null) this.stats.cipherId = options.cipherId;
    if (options.initialEccPrivateKey) this.#videoDecoder.setEccPrivateKey(options.initialEccPrivateKey);
  }

  /**
   * Bind UDP, find the requested peer, and start the bounded session lifetime.
   *
   * Resolution means a direct or relay CAM_ID response established `#remote`.
   * It does not mean media decryption, decoder setup, or first-frame delivery
   * succeeded. Media sessions therefore retain a separate first-frame timer,
   * while every session gets a maximum-duration timer and heartbeat loop.
   */
  async start(): Promise<void> {

    // Bind an ephemeral UDP port, then try LAN and cloud lookup addresses. A
    // successful CAM_ID response means the peer is reachable, not that video
    // has started yet.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.close("start_failed");
        reject(new Error("PPCS camera lookup timed out"));
      }, 20_000);
      this.#socket.once("error", (error) => {
        clearTimeout(timeout);
        this.close("start_failed");
        reject(error);
      });
      this.#socket.on("message", (message, info) => {
        try {
          if (this.#handle(message, info)) { clearTimeout(timeout); resolve(); }
        } catch (error) { clearTimeout(timeout); reject(error); }
      });
      this.#socket.bind(0, () => {
        try {
          this.#socket.setRecvBufferSize(PPCS_RECEIVE_BUFFER_BYTES);
        } catch {

          // Some hosts cap the UDP receive buffer below the requested size.
        }
        this.#socket.setBroadcast(true);
        const port = this.#socket.address().port;
        void detectLocalIpv4().then((host) => {
          if (host && !this.#closed) this.#selfAddress = { host, port };
        });
        this.#lookup();
        this.#lookupTimer = setInterval(() => this.#lookup(), LOOKUP_RETRY_MILLISECONDS);
        this.#lookupTimer.unref?.();
      });
    });
    this.#maximumDurationTimer = setTimeout(
      () => this.close("max_duration"),
      (this.#options.maxSeconds ?? 30) * 1_000,
    );
    if (this.#options.purpose !== "control") {
      this.#firstFrameTimer = setTimeout(
        () => this.close("first_frame_timeout"),
        FIRST_VIDEO_FRAME_TIMEOUT_MILLISECONDS,
      );
    }
    this.#heartbeat = setInterval(() => {
      if (!this.#remote) return;
      this.#send(REQ.ping, Buffer.alloc(0), this.#remote);
      if (this.#options.purpose === "control") return;
      if (
        this.#options.homeBaseAttached
        && this.#level2Key
        && needsAttachedMediaReassert(this.#lastAttachedMediaFrameAt, Date.now())
      ) {
        this.#startAttachedMedia();
      }
      else if (needsStandaloneMediaReassert(Boolean(this.#options.homeBaseAttached), this.#videoNormalizer.codec)) {
        this.#startOwnMedia();
      }
      else if (!this.#options.homeBaseAttached) this.#sendCommand(1139, voidPayload(this.#options.channel));
    }, 5_000);
    this.#heartbeat.unref?.();
  }

  /**
   * Send camera enablement value 0 or 1 and await its command-result frame.
   *
   * A missing result rejects with {@link CameraControlAcknowledgementTimeoutError}
   * because the UDP write may still have reached the camera. The provider can
   * then perform a fresh readback instead of sending the command twice.
   */
  async writeCameraEnabled(rawValue: number): Promise<void> {
    if (this.#options.purpose !== "control") throw new Error("Camera control requires a control session");
    if (!this.#remote) throw new Error("Camera control session is not connected");
    const accountId = this.#options.accountId;
    if (!accountId) throw new Error("Camera control account identity is unavailable");
    if (rawValue !== 0 && rawValue !== 1) throw new Error("Camera enablement value must be 0 or 1");
    if (this.#options.homeBaseAttached) await this.#waitForLevel2Key();
    const body = buildCameraEnableBody(this.#options.channel, rawValue, accountId);
    const acknowledgement = this.#waitForControlResult(1035);
    if (this.#options.homeBaseAttached) {
      const sequence = this.#level2Seq++;
      const encrypted = encryptLevel2(body, this.#level2Key!, sequence);
      const header = commandHeader(this.#seq++, 1035);
      this.#send(
        REQ.data,
        Buffer.concat([header, rawPayload(encrypted, this.#options.channel, 8, [8, 0], 0)]),
        this.#remote,
      );
    } else {
      const encrypted = encryptLevel1(body, commandKey(this.#options.stationSerial, this.#options.p2pDid));
      this.#sendCommand(1035, rawPayload(encrypted, this.#options.channel, 1, [1, 0], 0));
    }
    await acknowledgement;
  }

  /**
   * Send the verified command-1011 motion switch and await its result.
   *
   * The HomeBase route requires an established level-two key. Three identical
   * transmissions tolerate loss on the UDP and HomeBase radio hops while one
   * acknowledgement slot owns the operation's final result.
   */
  async writeMotionDetection(enabled: boolean): Promise<void> {
    if (this.#options.purpose !== "control") throw new Error("Motion control requires a control session");
    if (!this.#remote) throw new Error("Motion control session is not connected");
    if (!this.#options.homeBaseAttached) throw new Error("Motion control requires a HomeBase-attached camera");
    const accountId = this.#options.accountId;
    if (!accountId) throw new Error("Motion control account identity is unavailable");
    await this.#waitForLevel2Key();
    const body = buildCameraEnableBody(this.#options.channel, enabled ? 1 : 0, accountId);
    const acknowledgement = this.#waitForControlResult(1011);
    for (let index = 0; index < 3; index += 1) {
      const sequence = this.#level2Seq++;
      const encrypted = encryptLevel2(body, this.#level2Key!, sequence);
      const header = commandHeader(this.#seq++, 1011);
      this.#send(
        REQ.data,
        Buffer.concat([header, rawPayload(encrypted, this.#options.channel, 8, [8, 0], 0)]),
        this.#remote,
      );
      if (index < 2) await delay(200);
    }
    await acknowledgement;
  }

  /**
   * Send the T8210-family command-1013 Auto night-vision switch.
   *
   * This observed command uses the legacy direct binary envelope even for an
   * attached camera. It is retransmitted three times and waits for one result.
   */
  async writeAutoNightVision(enabled: boolean): Promise<void> {
    if (this.#options.purpose !== "control") throw new Error("Auto night vision control requires a control session");
    if (!this.#remote) throw new Error("Auto night vision control session is not connected");
    if (!this.#options.homeBaseAttached) throw new Error("Auto night vision control requires a HomeBase-attached camera");
    const accountId = this.#options.accountId;
    if (!accountId) throw new Error("Auto night vision control account identity is unavailable");
    const body = buildAutoNightVisionCommandBody(
      this.#options.channel,
      enabled,
      accountId,
      commandKey(this.#options.stationSerial, this.#options.p2pDid),
    );
    const acknowledgement = this.#waitForControlResult(1013);
    for (let index = 0; index < 3; index += 1) {
      this.#sendCommand(1013, body);
      if (index < 2) await delay(200);
    }
    await acknowledgement;
  }

  /**
   * Send the verified HomeBase-attached night-vision mode command.
   *
   * Modes 0 through 2 are wrapped in command 1350 and sent three times through
   * the negotiated level-two channel. This observed form has no awaited result
   * frame, so resolution confirms transmission rather than device readback.
   */
  async writeNightVision(mode: number): Promise<void> {
    if (this.#options.purpose !== "control") throw new Error("Night vision control requires a control session");
    if (!this.#remote) throw new Error("Night vision control session is not connected");
    if (!this.#options.homeBaseAttached) throw new Error("Night vision control requires a HomeBase-attached camera");
    const accountId = this.#options.accountId;
    if (!accountId) throw new Error("Night vision control account identity is unavailable");
    if (!Number.isSafeInteger(mode) || mode < 0 || mode > 2) throw new Error("Night vision mode must be 0, 1, or 2");
    await this.#waitForLevel2Key();

    // Replay this idempotent write so the HomeBase radio hop can tolerate a lost UDP frame.
    for (let index = 0; index < 3; index += 1) {
      const level2Sequence = this.#level2Seq++;
      const body = encryptLevel2(buildNightVisionBody(this.#options.channel, mode, accountId), this.#level2Key!, level2Sequence);
      const header = commandHeader(this.#seq++, 1350);
      this.#send(REQ.data, Buffer.concat([header, rawPayload(body, 0, 8, [8, 0], 0)]), this.#remote);
      if (index < 2) await delay(200);
    }
  }

  /**
   * Send the observed command-1202 camera siren duration three times.
   *
   * This low-level method validates only that the duration is a non-negative
   * whole number. The provider owns the supported upper limit and any readback
   * or stop policy. Resolution confirms transmission, not siren activation.
   */
  async writeCameraSiren(durationSeconds: number): Promise<void> {
    if (this.#options.purpose !== "control") throw new Error("Camera siren control requires a control session");
    if (!this.#remote) throw new Error("Camera siren control session is not connected");
    const accountId = this.#options.accountId;
    if (!accountId) throw new Error("Camera siren control account identity is unavailable");
    if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 0) throw new Error("Camera siren duration must be a non-negative whole number");
    const body = buildIntStringCommandBody(durationSeconds, this.#options.channel, accountId, commandKey(this.#options.stationSerial, this.#options.p2pDid));
    for (let index = 0; index < 3; index += 1) {
      this.#sendCommand(1202, body);
      if (index < 2) await delay(200);
    }
  }

  /**
   * End the peer session and retain its terminal reason for diagnostics.
   *
   * Closing is idempotent. It clears every timer, rejects an outstanding
   * control wait, drops incomplete access-unit state, sends the appropriate
   * attached-media stop before PPCS END, closes UDP, and ends `output`.
   */
  close(reason: PpcsStreamCloseReason = "client_stop"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.stats.closeReason = reason;
    if (this.#maximumDurationTimer) clearTimeout(this.#maximumDurationTimer);
    if (this.#firstFrameTimer) clearTimeout(this.#firstFrameTimer);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#attachedMediaRestartTimer) clearTimeout(this.#attachedMediaRestartTimer);
    if (this.#lookupTimer) clearInterval(this.#lookupTimer);
    if (this.#pendingControl) {
      clearTimeout(this.#pendingControl.timer);
      this.#pendingControl.reject(new Error("Camera control session closed before acknowledgement"));
      this.#pendingControl = null;
    }
    this.#videoAssembler.reset();
    if (this.#options.purpose !== "control" && this.#options.homeBaseAttached) {
      this.#stopAttachedMedia();
    }
    if (this.#remote) this.#send(REQ.end, Buffer.alloc(0), this.#remote);
    this.#socket.close();
    this.output.end();
  }

  /** Send LAN lookup to broadcast and known private targets, then query cloud rendezvous peers. */
  #lookup(): void {
    if (this.#remote) return;
    const local = Buffer.from([0, 0]);
    for (const address of ppcsLocalLookupTargets(this.#options.localAddress)) {
      this.#send(REQ.localLookup, local, address);
    }
    const lookup = buildPpcsCloudLookup(
      this.#options.p2pDid,
      this.#options.dskKey,
      this.#selfAddress ?? undefined,
    );
    for (const address of decodeCloudAddresses(this.#options.appConnection)) {
      this.#send(lookup.type, lookup.payload, address);
    }
  }

  /** Probe the base and adjacent ports on one lookup candidate for CAM_ID. */
  #checkCandidate(address: { host: string; port: number }): void {
    for (const port of ppcsCandidatePorts(address.port)) this.#check({ host: address.host, port });
  }

  /**
   * Route one outer PPCS UDP response and acknowledge accepted data packets.
   *
   * Returns `true` only for the first camera identity response. `start` uses
   * that signal to resolve peer discovery, while media and control frames keep
   * flowing through this same socket listener for the rest of the session.
   */
  #handle(message: Buffer, info: RemoteInfo): boolean {
    if (has(message, RESP.localLookup)) {
      this.stats.localLookupCandidates++;
      this.#checkCandidate({ host: info.address, port: info.port });
      return false;
    }
    const candidate = ppcsLookupCandidate(message);
    if (candidate) {
      if (has(message, RESP.lookupAddr2)) this.stats.alternateLookupCandidates++;
      else this.stats.directLookupCandidates++;
      if (candidate.host !== "0.0.0.0") this.#checkCandidate(candidate);
      return false;
    }
    if (isPpcsCameraIdentity(message)) {
      if (this.#remote) return false;
      if (this.#lookupTimer) clearInterval(this.#lookupTimer);
      this.stats.camId++;
      this.#remote = { host: info.address, port: info.port };
      this.#send(REQ.ping, Buffer.alloc(0), this.#remote);
      this.#sendCommand(1100, voidPayload(255));
      if (!this.#options.homeBaseAttached && this.#options.purpose !== "control") this.#startOwnMedia();
      return true;
    }
    if (has(message, RESP.pong)) return false;
    if (has(message, RESP.data) && this.#remote) {
      this.stats.dataDatagrams++;
      if (!this.stats.firstDataHex) this.stats.firstDataHex = message.subarray(0, Math.min(message.length, 48)).toString("hex");
      const type = message.subarray(4, 6); const seq = message.readUInt16BE(6);
      if (!this.stats.types.includes(type[1] ?? -1)) this.stats.types.push(type[1] ?? -1);
      this.#send(REQ.ack, Buffer.concat([type, u16(1), u16(seq)]), this.#remote);
      const dataType = type[1] ?? 0;
      if (type.equals(DATA.video) || type.equals(DATA.data) || dataType === 2) this.#consumeData(message.subarray(8), seq, dataType);
    }
    return false;
  }

  /**
   * Reassemble the XZYH command byte stream carried by one PPCS data type.
   *
   * UDP datagrams may split a command header, split its declared payload, or
   * contain several commands. Partial state is keyed by data type because Eufy
   * interleaves independently sequenced command and video streams. A sequence
   * gap discards only that type's partial command. Keeping it would join bytes
   * from opposite sides of a missing datagram and produce a plausible but
   * corrupt frame.
   *
   * When unexpected bytes precede a complete XZYH marker, the parser makes one
   * recovery attempt within the current datagram. A second blockage is kept as
   * a diagnostic instead of repeatedly scanning arbitrary media bytes.
   */
  #consumeData(data: Buffer, sequence: number, type: number): void {
    const previous = this.#lastSequenceByType.get(type);
    const disposition = ppcsSequenceDisposition(previous ?? null, sequence);
    if (disposition === "duplicate") {
      this.stats.duplicateDatagrams++;
      return;
    }
    if (disposition === "stale") {
      this.stats.staleDatagrams++;
      return;
    }
    if (disposition === "gap" || disposition === "restart") {
      if (disposition === "restart") this.stats.sequenceRestarts++;
      else this.stats.sequenceGaps++;
      this.#pendingByType.delete(type);
    }
    this.#lastSequenceByType.set(type, sequence);
    const carried = this.#pendingByType.get(type);
    this.#pendingByType.delete(type);
    let body = data;
    if (carried) {
      if (carried.header) {
        const size = carried.header.readUInt32LE(6);
        const payload = Buffer.concat([carried.payload, body]);
        if (payload.length < size) {
          this.#pendingByType.set(type, { header: carried.header, payload });
          this.#updatePendingBytes();
          return;
        }
        this.#handleFrame(carried.header, payload.subarray(0, size), type);
        body = payload.subarray(size);
      } else {
        body = Buffer.concat([carried.payload, body]);
      }
    }
    let resynced = false;
    while (true) {
      while (body.length >= 16 && body.subarray(0, 4).equals(MAGIC)) {
        const header = body.subarray(0, 16);
        const command = header.readUInt16LE(4);
        if (this.stats.commands.length < 20) this.stats.commands.push(command);
        const size = header.readUInt32LE(6);
        if (command === 1350 && this.stats.responseLengths.length < 5) this.stats.responseLengths.push(size);
        if (size > 16 * 1024 * 1024) {
          this.#pendingByType.delete(type);
          this.#updatePendingBytes();
          return;
        }
        const payload = body.subarray(16);
        if (payload.length < size) {
          this.#pendingByType.set(type, { header: Buffer.from(header), payload: Buffer.from(payload) });
          this.#updatePendingBytes();
          return;
        }
        this.#handleFrame(header, payload.subarray(0, size), type);
        body = body.subarray(16 + size);
      }
      if (body.length === 0) break;
      const offset = ppcsCommandMagicOffset(body);
      if (offset > 0 && !resynced) {
        this.stats.parserResyncs++;
        resynced = true;
        body = body.subarray(offset);
        continue;
      }
      const prefix = ppcsPartialCommandPrefix(body);
      if (prefix) this.#pendingByType.set(type, { payload: prefix });
      else {
        this.stats.parserBlocked = true;
        this.stats.parserResyncs++;
      }
      break;
    }
    this.#updatePendingBytes();
  }

  /**
   * Dispatch one complete XZYH command after transport reassembly.
   *
   * Result frames settle the single pending control promise. Gateway-info
   * frames establish HomeBase level-two encryption, camera-info frames supply
   * privacy-safe structural diagnostics, and command 1300 carries media. For a
   * HomeBase peer, media is accepted only from the requested child channel.
   */
  #handleFrame(header: Buffer, payload: Buffer, type: number): void {
    const command = header.readUInt16LE(4);
    const size = header.readUInt32LE(6);
    const frameChannel = ppcsFrameChannel(header);
    const signCode = header[13] ?? 0;
    this.stats.frameHeaders++;
    const shape = `${command}:${signCode}:${size}:${type}`;
    if (!this.stats.frameShapes.includes(shape) && this.stats.frameShapes.length < 20) {
      this.stats.frameShapes.push(shape);
    }

    if (header[14] === 1 && this.#pendingControl?.command === command) {
      let clear = payload;
      if (signCode === 8 && this.#level2Key) clear = decryptLevel2(payload, this.#level2Key, signCode) ?? payload;
      else if (signCode > 0 && payload.length % 16 === 0) {
        try { clear = decryptEcb(payload, commandKey(this.#options.stationSerial, this.#options.p2pDid)); } catch { clear = payload; }
      }
      if (clear.length >= 4) {
        const pending = this.#pendingControl;
        this.#pendingControl = null;
        clearTimeout(pending.timer);
        const result = clear.readInt32LE(0);
        result === 0 ? pending.resolve() : pending.reject(new Error(`Camera rejected enablement command (${result})`));
      }
      return;
    }

    // 1100 carries the encrypted HomeBase gateway details. 1300 carries
    // media frames after the level-2 request has been accepted.
    if (command === 1100 && signCode === 1) { this.stats.gatewayInfo++; void this.#handleGatewayInfo(payload); }
    else if (command === 1103) this.#inspectCameraInfo(payload, signCode);
    else if (command === 1300 && (!this.#options.homeBaseAttached || acceptsAttachedCameraMedia(command, frameChannel ?? -1, this.#options.channel))) {
      this.stats.videoFrames++;
      if (this.#writeVideo(payload, signCode)) {
        const decoderReady = hasDecoderReadyKeyframe(this.stats.videoCodec, this.stats.videoNalTypes);
        if (this.#options.homeBaseAttached) this.#lastAttachedMediaFrameAt = Date.now();
        if ((!this.#options.homeBaseAttached || decoderReady) && this.#firstFrameTimer) {
          clearTimeout(this.#firstFrameTimer);
          this.#firstFrameTimer = null;
        }
      }
    } else if (command === 1300 && this.#options.homeBaseAttached) {
      this.stats.foreignVideoFrames++;
    }
  }

  /**
   * Decode, assemble, normalize, and publish one command-1300 media payload.
   *
   * The layers are intentionally separate. The decoder removes the frame's
   * cryptographic envelope, the access-unit assembler joins HomeBase chunks,
   * the access-unit assembler joins PPCS chunks, and the stream normalizer
   * converts codec framing to Annex-B. Only bytes
   * that survive all three stages reach {@link output}. The return value means
   * at least one normalized chunk was written, so callers must not treat a
   * decrypted continuation or buffered length prefix as visible video.
   */
  #writeVideo(frame: Buffer, signCode: number): boolean {
    if (frame.length < 22) {
      this.#recordVideoResult("short");
      return false;
    }
    let decoded: DecodedPpcsVideoFrame | undefined;
    const units = this.#videoAssembler.push(frame, (payload) => {
      decoded = this.#videoDecoder.decode(payload, signCode);
      return decoded?.data;
    });
    if (!decoded?.data.length) {
      const failure = this.#videoDecoder.lastFailure ?? "unknown";
      this.#recordVideoResult(signCode > 0 ? `encrypted-frame-rejected-${failure}` : `plaintext-frame-rejected-${failure}`);
      return false;
    }
    let wrote = false;
    for (const unit of units) {
      const declaredCodec = ppcsVideoCodec(unit.streamType);
      const normalized = this.#videoNormalizer.push(unit.data, declaredCodec ?? undefined);
      this.stats.videoCodec = this.#videoNormalizer.codec;
      this.stats.videoNalTypes = [...this.#videoNormalizer.nalTypes];
      if (normalized.length === 0) {
        this.#recordVideoResult("framing-prefix-buffered");
        continue;
      }
      this.output.write(normalized);
      this.stats.videoOutputFrames++;
      const framing = this.#videoNormalizer.framing;
      const result = decoded.protection === "clear" ? "written-clear" : `written-${decoded.protection}`;
      this.#recordVideoResult(`${result}-${framing}`);
      wrote = true;
    }
    return wrote;
  }

  /** Retain a bounded set of distinct pipeline outcomes for close diagnostics. */
  #recordVideoResult(result: string): void {
    if (!this.stats.videoResults.includes(result) && this.stats.videoResults.length < 8) {
      this.stats.videoResults.push(result);
    }
  }

  /** Recalculate how many command-stream bytes are retained between datagrams. */
  #updatePendingBytes(): void {
    this.stats.pendingBytes = [...this.#pendingByType.values()]
      .reduce((total, value) => total + (value.header?.length ?? 0) + value.payload.length, 0);
  }

  /**
   * Inspect command 1103 for the battery-history response shape.
   *
   * The payload may use level-one or negotiated level-two protection. Once
   * decoded, only the schema of parameter 3100 is recorded. Its timestamps,
   * usage values, and other reporter-specific content never enter diagnostics.
   */
  #inspectCameraInfo(payload: Buffer, signCode: number): void {
    let clear = payload;
    if ((signCode === 2 || signCode === 8) && this.#level2Key) {
      clear = decryptLevel2(payload, this.#level2Key, signCode) ?? payload;
    } else if (signCode > 0 && payload.length > 0 && payload.length % 16 === 0) {
      try { clear = decryptEcb(payload, commandKey(this.#options.stationSerial, this.#options.p2pDid)); } catch { return; }
    }
    const text = clear.toString("utf8").replace(/\0+$/g, "").trim();
    if (!text.startsWith("{")) return;
    try {
      const decoded: unknown = JSON.parse(text);
      if (!isRecord(decoded) || !Array.isArray(decoded.params)) return;
      const entry = decoded.params.find((candidate) => isRecord(candidate) && candidate.param_type === 3100);
      if (!isRecord(entry) || typeof entry.param_value !== "string") return;
      this.stats.batteryHistory = batteryHistoryProbeSummary(entry.param_value);
    } catch {
      return;
    }
  }

  /**
   * Serialize HomeBase gateway-info handling while an ECC key is being found.
   *
   * HomeBase may retransmit command 1100. Sharing the active promise prevents
   * duplicate asynchronous key resolution and competing media starts.
   */
  async #handleGatewayInfo(payload: Buffer): Promise<void> {
    if (this.#gatewayPromise) return this.#gatewayPromise;
    if (!this.#options.homeBaseAttached || this.#level2Key || !this.#options.resolveCipherKey || payload.length < 133) return;
    this.#gatewayPromise = this.#deriveLevel2(payload);
    try { await this.#gatewayPromise; } finally { this.#gatewayPromise = null; }
  }

  /**
   * Derive the HomeBase level-two control key from command 1100.
   *
   * The outer envelope uses the deterministic level-one command key. Its
   * cipher identifier selects an ECC private key supplied by the provider,
   * which unwraps the per-session AES key. Media startup is delayed until this
   * chain succeeds because attached-camera lifecycle commands require level
   * two protection.
   */
  async #deriveLevel2(payload: Buffer): Promise<void> {
    let plainPayload: Buffer;
    try { plainPayload = decryptEcb(payload, commandKey(this.#options.stationSerial, this.#options.p2pDid)); } catch (error) { this.stats.level2Error = `gateway decrypt failed: ${error instanceof Error ? error.message : String(error)}`; return; }
    const cipherId = plainPayload.readUInt16LE(0);
    this.stats.cipherId = cipherId;
    let eccPrivateKey: string | undefined;
    try { eccPrivateKey = await this.#options.resolveCipherKey!(cipherId); } catch (error) { this.stats.level2Error = error instanceof Error ? error.message : String(error); return; }
    if (!eccPrivateKey) { this.stats.level2Error = "no ECC private key"; return; }
    this.#videoDecoder.setEccPrivateKey(eccPrivateKey);
    const plain = unwrapGatewayInfo(plainPayload.subarray(4, 133), eccPrivateKey);
    if (!plain || plain.length < 32) { this.stats.level2Error = "gateway info ECIES unwrap failed"; return; }
    this.#level2Key = plain.subarray(0, 32);
    this.stats.level2++;
    if (this.#options.purpose !== "control") this.#startAttachedMedia();
  }

  /** Wait for in-progress gateway negotiation before an attached control write. */
  async #waitForLevel2Key(): Promise<void> {
    const deadline = Date.now() + CONTROL_TIMEOUT_MILLISECONDS;
    while (!this.#level2Key && !this.stats.level2Error && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!this.#level2Key) {
      throw new Error(this.stats.level2Error || "Camera level-two control key timed out");
    }
  }

  /**
   * Reserve the session's single acknowledgement slot for a control command.
   *
   * A timeout is deliberately ambiguous: UDP loss means the camera may have
   * applied the write even though its result frame did not arrive. The typed
   * error lets the provider choose a readback rather than blindly retrying a
   * potentially non-idempotent operation.
   */
  #waitForControlResult(command: number): Promise<void> {
    if (this.#pendingControl) return Promise.reject(new Error("Camera already has a control command in flight"));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingControl = null;
        reject(new CameraControlAcknowledgementTimeoutError());
      }, CONTROL_TIMEOUT_MILLISECONDS);
      this.#pendingControl = { command, resolve, reject, timer };
    });
  }

  /** Start an attached channel, or restart it after output has genuinely stalled. */
  #startAttachedMedia(): void {
    if (!this.#remote || !this.#level2Key) return;
    if (this.stats.mediaStartAttempts > 0) {
      this.#restartAttachedMedia();
      return;
    }
    this.#sendAttachedMediaControl(1003);
  }

  /** Break a stale HomeBase encoder run before requesting a new decoder bootstrap. */
  #restartAttachedMedia(): void {
    if (this.#attachedMediaRestartTimer) return;
    this.#stopAttachedMedia();
    this.#attachedMediaRestartTimer = setTimeout(() => {
      this.#attachedMediaRestartTimer = null;
      if (!this.#closed) this.#sendAttachedMediaControl(1003);
    }, ATTACHED_MEDIA_RESTART_DELAY_MILLISECONDS);
    this.#attachedMediaRestartTimer.unref?.();
  }

  /** Release this camera channel without ending the HomeBase peer session first. */
  #stopAttachedMedia(): void {
    if (!this.#remote || !this.#level2Key || this.stats.mediaStartAttempts === 0) return;
    if (this.#options.stationModel === "T8010") {
      this.stats.mediaStopAttempts++;
      this.stats.mediaStopProtocol = "level1-direct";
      this.#sendCommand(1004, buildLegacyAttachedMediaStopPayload(
        this.#options.channel,
        commandKey(this.#options.stationSerial, this.#options.p2pDid),
      ));
      return;
    }
    this.#sendAttachedMediaControl(1004);
  }

  /** Encrypt and send one HomeBase media lifecycle command on the negotiated level-two channel. */
  #sendAttachedMediaControl(command: 1003 | 1004): void {
    if (!this.#remote || !this.#level2Key) return;
    if (command === 1003) this.stats.mediaStartAttempts++;
    else {
      this.stats.mediaStopAttempts++;
      this.stats.mediaStopProtocol = "level2-payload";
    }
    const value = buildAttachedMediaControlValue(
      command,
      this.#options.channel,
      this.#options.accountId ?? "",
      command === 1003 ? publicModulus(this.#rsa.publicKey) : undefined,
    );

    // The level-2 body is AES-GCM encrypted. The RSA modulus inside the JSON
    // lets the camera establish the per-stream video key for frame payloads.
    const level2Sequence = this.#level2Seq++;
    const body = encryptLevel2(value, this.#level2Key, level2Sequence);
    const streamId = this.#options.channel === 0 || this.#options.channel === 255 ? 0 : 10 + (this.#level2Seq & 127);
    const header = commandHeader(this.#seq++, 1350);
    const packet = Buffer.concat([header, rawPayload(body, this.#options.channel, 8, [8, 0], streamId)]);
    if (!this.stats.startHex) this.stats.startHex = packet.subarray(0, 32).toString("hex");
    this.#send(REQ.data, packet, this.#remote);
  }

  /** Send the level-one START_LIVE command used by a standalone camera peer. */
  #startOwnMedia(): void {
    this.stats.mediaStartAttempts++;
    const key = publicModulus(this.#rsa.publicKey);
    const now = Date.now();
    const value = JSON.stringify({ commandType: 1000, data: {
      cmd: 1000, account_id: this.#options.accountId ?? "", accountId: this.#options.accountId ?? "",
      mValueStrSub: this.#options.accountId ?? "", mChannel: this.#options.channel, mValue3: 0, mValue5: 0,
      msg_id: 1, camera_type: 0, entrytype: 0, extValue: 1000, ivalue: 1, restore: 0, streamtype: 2,
      video_type: 12, timestamp: now, transaction: `${now}`, encryptkey: key,
    } });
    this.#sendCommand(1700, buildStandaloneLiveStartPayload(
      value,
      this.#options.channel,
      commandKey(this.#options.stationSerial, this.#options.p2pDid),
    ));
  }

  /** Ask one candidate endpoint to prove it owns the requested camera DID. */
  #check(address: { host: string; port: number }): void {
    this.#send(REQ.check, Buffer.concat([encodeDid(this.#options.p2pDid), Buffer.alloc(3)]), address);
  }

  /** Wrap and send one inner XZYH command over the established data channel. */
  #sendCommand(command: number, payload: Buffer): void {
    if (!this.#remote) return;
    const header = Buffer.concat([DATA.data, u16(this.#seq++), MAGIC, u16le(command)]);
    this.#send(REQ.data, Buffer.concat([header, payload]), this.#remote);
  }

  /** Add the outer PPCS type and length header, then write one UDP datagram. */
  #send(type: Buffer, payload: Buffer, address: { host: string; port: number }): void {
    this.#socket.send(Buffer.concat([type, u16(payload.length), payload]), address.port, address.host);
  }
}

/** Translate a PPCS access-unit stream marker into the domain codec name. */
function ppcsVideoCodec(streamType: number): VideoCodec | null {
  if (streamType === 1) return "h264";
  if (streamType === 2) return "h265";
  return null;
}

/** Build the minimal unencrypted body used by commands without a value payload. */
function voidPayload(channel: number): Buffer {
  const result = Buffer.alloc(10);
  result.writeUInt16LE(1, 4);
  result[6] = channel;
  return result;
}

/** Build the D1 data-channel and XZYH prefix shared by inner camera commands. */
function commandHeader(sequence: number, command: number): Buffer {
  const result = Buffer.concat([DATA.data, u16(sequence), MAGIC, Buffer.alloc(2)]);
  result.writeUInt16LE(command, 8);
  return result;
}

/**
 * Wrap command bytes in Eufy's ten-byte value envelope.
 *
 * `signCode` identifies the protection scheme, `magic` identifies its payload
 * family, and `streamId` routes a HomeBase child stream. This is the inner
 * command value envelope, not the outer UDP or XZYH header.
 */
function rawPayload(data: Buffer, channel: number, signCode: number, magic: readonly [number, number], streamId: number): Buffer {
  const result = Buffer.alloc(10 + data.length);
  result.writeUInt16LE(data.length, 0); result[4] = magic[0]; result[5] = magic[1];
  result[6] = channel & 0xff; result[7] = signCode & 0xff; result[8] = streamId & 0xff;
  data.copy(result, 10); return result;
}

/** Build and level-one encrypt the fixed-width integer/account command form. */
function buildIntStringCommandBody(value: number, valueSub: number, accountId: string, key: Buffer): Buffer {
  const valueSubBuffer = Buffer.alloc(4);
  valueSubBuffer.writeUInt32LE(valueSub >>> 0, 0);
  const valueBuffer = Buffer.alloc(4);
  valueBuffer.writeUInt32LE(value >>> 0, 0);
  const accountBuffer = Buffer.alloc(128);
  Buffer.from(accountId).copy(accountBuffer);
  const plain = Buffer.concat([valueSubBuffer, valueBuffer, accountBuffer]);
  return rawPayload(encryptLevel1(plain, key), valueSub, 1, [1, 0], 0);
}

/**
 * Build the verified command-1013 body used by T8210-family Auto night vision.
 *
 * The account identity occupies the protocol's fixed 128-byte field. The
 * resulting value uses the legacy level-one key even when the target camera is
 * reached through a HomeBase.
 */
export function buildAutoNightVisionCommandBody(channel: number, enabled: boolean, accountId: string, key: Buffer): Buffer {
  if (!accountId) throw new Error("Auto night vision control requires a non-empty account identity");
  if (!Number.isSafeInteger(channel) || channel < 0 || channel > 255) throw new Error("Auto night vision control requires a valid camera channel");
  if (key.length !== 16) throw new Error("Auto night vision control requires a 16-byte command key");
  return buildIntStringCommandBody(enabled ? 1 : 0, channel, accountId, key);
}

/**
 * Build the fixed-width channel, value, and account body for camera writes.
 *
 * Callers validate the command-specific meaning of `value`. This helper owns
 * only the binary layout shared by enablement and motion-detection commands.
 */
export function buildCameraEnableBody(channel: number, value: number, accountId: string): Buffer {
  if (!accountId) throw new Error("Camera control requires a non-empty account identity");
  const body = Buffer.alloc(8 + 128);
  body.writeUInt32LE(channel, 0);
  body.writeUInt32LE(value, 4);
  body.write(accountId.slice(0, 128), 8, "ascii");
  return body;
}

/**
 * Build the verified SET_PAYLOAD JSON for an attached-camera night-vision mode.
 *
 * The outer command targets the HomeBase control channel, while the nested
 * `channel` selects the child camera. `night_sion` retains Eufy's observed
 * field spelling and must not be corrected as an English typo.
 */
export function buildNightVisionBody(channel: number, mode: number, accountId: string): Buffer {
  if (!accountId) throw new Error("Night vision control requires a non-empty account identity");
  if (!Number.isSafeInteger(channel) || channel < 0 || channel > 255) throw new Error("Night vision control requires a valid camera channel");
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 2) throw new Error("Night vision mode must be 0, 1, or 2");
  return Buffer.from(JSON.stringify({
    account_id: accountId,
    cmd: 1277,
    mChannel: 0,
    mValue3: 0,
    payload: { channel, night_sion: mode },
  }));
}

/** Pad and encrypt a legacy control value with AES-128-ECB. */
function encryptLevel1(plaintext: Buffer, key: Buffer): Buffer {
  const padded = Buffer.alloc(Math.ceil(Math.max(plaintext.length, 16) / 16) * 16);
  plaintext.copy(padded);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

/**
 * Encrypt a negotiated HomeBase command with AES-256-GCM.
 *
 * The four bytes after the nonce are envelope metadata expected by the peer.
 * Only the low sequence byte is carried there; XZYH owns the independent
 * transport sequence used for ordering and acknowledgement.
 */
function encryptLevel2(plaintext: Buffer, key: Buffer, sequence: number): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("eufy security", "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([cipher.getAuthTag(), nonce, Buffer.from([sequence & 0xff, 3, 2, 1]), ciphertext]);
}

/** Authenticate and decrypt either observed level-two response envelope form. */
function decryptLevel2(payload: Buffer, key: Buffer, signCode: number): Buffer | undefined {
  const ciphertextOffset = signCode === 8 ? 32 : 28;
  if (payload.length < ciphertextOffset) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(16, 28));
    decipher.setAAD(Buffer.from("eufy security", "utf8"));
    decipher.setAuthTag(payload.subarray(0, 16));
    return Buffer.concat([decipher.update(payload.subarray(ciphertextOffset)), decipher.final()]);
  } catch { return undefined; }
}

/**
 * Describe battery-history JSON without retaining its values.
 *
 * The diagnostic intentionally reports only bounded field names and structural
 * types. A reporter can compare that schema with the Eufy app while account,
 * device, timestamp, and usage values stay out of logs.
 */
export function batteryHistoryProbeSummary(value: string): string {
  if (value.length === 0 || value.length > 65_536) return "invalid-size";
  try {
    return describeProbeValue(JSON.parse(value), 0);
  } catch {
    return "invalid-json";
  }
}

/** Recursively reduce an unknown JSON value to a bounded, value-free schema. */
function describeProbeValue(value: unknown, depth: number): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (depth >= 2) return "array";
    const kinds = [...new Set(value.slice(0, 8).map((item) => describeProbeValue(item, depth + 1)))].slice(0, 4);
    return `array[${kinds.join("|") || "empty"}]`;
  }
  if (isRecord(value)) {
    if (depth >= 2) return "object";
    const fields = Object.keys(value)
      .filter((key) => /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key))
      .sort()
      .slice(0, 16)
      .map((key) => `${key}:${describeProbeValue(value[key], depth + 1)}`);
    return `object{${fields.join(",") || "empty"}}`;
  }
  if (typeof value === "number") return Number.isFinite(value) ? "number" : "invalid-number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  return "unknown";
}

/** Narrow an unknown JSON value to a non-null object with string keys. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Unwrap the level-two AES key from a HomeBase gateway-info ECIES envelope.
 *
 * This observed path decrypts the envelope's fixed ciphertext region without
 * interpreting padding. Callers therefore validate the resulting length
 * before accepting its first 32 bytes as key material.
 */
function unwrapGatewayInfo(envelope: Buffer, privateKeyHex: string): Buffer | undefined {
  try {
    if (envelope.length < 129) return undefined;
    const ephemeral = envelope.subarray(0, 33);
    const iv = envelope.subarray(33, 49);
    const ciphertext = envelope.subarray(49, 97);
    const ecdh = createECDH("prime256v1"); ecdh.setPrivateKey(Buffer.from(privateKeyHex, "hex"));
    const shared = ecdh.computeSecret(ephemeral);
    const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
    const label = Buffer.from("ECIES"); let t = label; let output = Buffer.alloc(0);
    while (output.length < 48) { t = hmac(shared, t); output = Buffer.concat([output, hmac(shared, Buffer.concat([t, label]))]); }
    const decrypt = createDecipheriv("aes-128-cbc", output.subarray(0, 16), iv); decrypt.setAutoPadding(false);
    return Buffer.concat([decrypt.update(ciphertext), decrypt.final()]);
  } catch { return undefined; }
}

/** Export the session RSA public modulus in the camera's unprefixed hex form. */
function publicModulus(key: ReturnType<typeof generateKeyPairSync>["publicKey"]): string {
  const jwk = key.export({ format: "jwk" }) as { n: string };
  return Buffer.from(jwk.n, "base64url").toString("hex").replace(/^00/, "");
}

/** Encode a 16-bit PPCS transport value in network byte order. */
function u16(value: number): Buffer {
  const result = Buffer.alloc(2);
  result.writeUInt16BE(value);
  return result;
}

/** Encode a 16-bit XZYH command value in little-endian order. */
function u16le(value: number): Buffer {
  const result = Buffer.alloc(2);
  result.writeUInt16LE(value);
  return result;
}

/** Return whether a datagram starts with the requested two-byte PPCS type. */
function has(value: Buffer, header: Buffer): boolean {
  return value.subarray(0, 2).equals(header);
}

/** Derive the observed 16-byte legacy command key from peer identity fields. */
function commandKey(serial: string, did: string): Buffer {
  return Buffer.from(`${serial.slice(-7)}${did.substring(did.indexOf("-"), did.indexOf("-") + 9)}`);
}

/** Decrypt a block-aligned value without interpreting protocol padding. */
function decryptEcb(value: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv(`aes-${key.length * 8}-ecb`, key, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(value), decipher.final()]);
}

/** Encode the three textual DID components in PPCS's fixed 20-byte layout. */
function encodeDid(value: string): Buffer {
  const [prefix, number, suffix] = value.split("-");
  const result = Buffer.alloc(20);
  Buffer.from(prefix ?? "").copy(result);
  result.writeUInt32BE(Number(number ?? 0), 8);
  Buffer.from(suffix ?? "").copy(result, 12);
  return result;
}

/**
 * Decode Eufy's obfuscated comma-separated cloud rendezvous host list.
 *
 * The decoded portion used here yields only hostnames. PPCS cloud lookup uses
 * the fixed 32100 port, and actual camera candidates arrive in the lookup
 * responses sent by those rendezvous servers.
 */
function decodeCloudAddresses(value: string): { host: string; port: number }[] {
  const table = Buffer.from("4959433db5bf6da347534f6165e371e9677f02030badb3892b2f35c16b8b959711e5a70deff1050783fb9d3bc5c713171d1f2529d3df", "hex");
  const encoded = value.split(":", 1)[0] ?? ""; const out = Buffer.alloc(Math.floor(encoded.length / 2));
  for (let i = 0; i < out.length; i++) { let z = 57; for (let j = 0; j < i; j++) z ^= out[j]!; out[i] = z ^ table[i % table.length]! ^ ((encoded.charCodeAt(i * 2) - 65) * 16 + encoded.charCodeAt(i * 2 + 1) - 65); }
  return out.toString().split(",").filter(Boolean).map((host) => ({ host, port: 32100 }));
}

/**
 * Discover the local IPv4 address selected by the host's routing table.
 *
 * Connecting an unbound UDP socket does not send application data. It lets the
 * operating system choose the interface it would route toward the public DNS
 * address. Cloud lookup then advertises that interface address with the main
 * PPCS socket's bound port. Failure is non-fatal because the alternate lookup
 * form does not require a caller address.
 */
function detectLocalIpv4(): Promise<string | null> {
  return new Promise((resolve) => {
    const probe = createSocket("udp4");
    let settled = false;
    const finish = (host: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { probe.close(); } catch { /* The probe may already have closed after an error. */ }
      resolve(host);
    };
    const timeout = setTimeout(() => finish(null), 2_000);
    timeout.unref?.();
    probe.once("error", () => finish(null));
    probe.connect(53, "8.8.8.8", () => {
      try { finish(probe.address().address); } catch { finish(null); }
    });
  });
}

/** Pause between bounded retransmissions of the same observed control request. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
