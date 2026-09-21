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

// PPCS wraps command payloads in an XZYH header. The outer D1 datagrams and
// these inner command frames use different sequence numbers and byte order.
const MAGIC = Buffer.from("XZYH", "ascii");
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
const DATA = { data: Buffer.from([0xd1, 0]), video: Buffer.from([0xd1, 1]) } as const;
const ATTACHED_MEDIA_STALL_MILLISECONDS = 10_000;
const ATTACHED_MEDIA_RESTART_DELAY_MILLISECONDS = 250;
const FIRST_VIDEO_FRAME_TIMEOUT_MILLISECONDS = 20_000;
const CONTROL_TIMEOUT_MILLISECONDS = 10_000;
const LOOKUP_RETRY_MILLISECONDS = 1_000;
const LOCAL_LOOKUP_PORT = 32_108;
const PPCS_RECEIVE_BUFFER_BYTES = 1024 * 1024;
const PPCS_SEQUENCE_LOOKBACK = 0x8000;
const PPCS_STALE_RETRANSMIT_DEPTH = 1024;
const ANNEX_B_START_CODE = Buffer.from([0, 0, 0, 1]);
const MAX_NAL_UNIT_BYTES = 16 * 1024 * 1024;

type PpcsStreamCloseReason = "client_stop" | "first_frame_timeout" | "max_duration" | "replaced" | "start_failed";

/**
 * Decide whether a HomeBase-attached camera needs its full media start sent again.
 *
 * A HomeBase has no lightweight media keepalive for a child channel. Repeating
 * its start after a decoder-ready keyframe resets that channel, so a reassert
 * is limited to incomplete startup and a genuine media stall.
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

/** Reissue a standalone start until the camera announces a decodable codec configuration. */
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

/** Build the level-two media-control envelope used for a HomeBase camera start or stop. */
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
  if (frame.length < 22) return undefined;
  const length = frame.readUInt32LE(0);
  if (signCode <= 0 || length < 128) {
    if (frame.length < 22 + length) return undefined;
    return frame.subarray(22, 22 + length);
  }
  if (frame.length < 151 + length) return undefined;
  try {
    const key = unwrapKey(frame.subarray(22, 150));
    if (!key || (key.length !== 16 && key.length !== 32)) return undefined;
    const encrypted = frame.subarray(151, 151 + 128);
    const clear = decryptEcb(encrypted, key);
    return Buffer.concat([clear, frame.subarray(151 + 128, 151 + length)]);
  } catch {
    return undefined;
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

  /** Create a decoder around the session's legacy RSA unwrap operation. */
  constructor(private readonly unwrapLegacyKey: (wrapped: Buffer) => Buffer | undefined) {}

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
    if (signCode <= 0) {
      const data = decodePpcsVideoFrame(frame, signCode, this.unwrapLegacyKey);
      return data ? { data, protection: "clear" } : undefined;
    }

    const authenticated = this.#decodeAuthenticated(frame);
    if (authenticated) return { data: authenticated, protection: "ecc-gcm" };

    // A short signed frame cannot carry the legacy 128-byte encrypted prefix.
    // Falling through after failed GCM authentication would emit its envelope as video.
    if (frame.length >= 4 && frame.readUInt32LE(0) < 128) return undefined;
    const legacy = decodePpcsVideoFrame(frame, signCode, this.unwrapLegacyKey);
    return legacy ? { data: legacy, protection: "rsa-ecb" } : undefined;
  }

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

/** Unwrap and authenticate the 32-byte media key carried by an ECC keyframe envelope. */
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

/** Enumerate the advertised UDP port and the bounded NAT-remap neighbourhood used by PPCS. */
export function ppcsCandidatePorts(port: number): number[] {
  const ports: number[] = [];
  for (let candidate = port - 3; candidate <= port + 3; candidate++) {
    if (candidate > 0 && candidate <= 65_535) ports.push(candidate);
  }
  return ports;
}

/** Build broadcast and current-SDK directed targets for a local PPCS lookup. */
export function ppcsLocalLookupTargets(localAddress?: string | null): Array<{ readonly host: string; readonly port: number }> {
  return [
    { host: "255.255.255.255", port: LOCAL_LOOKUP_PORT },
    ...(localAddress ? [{ host: localAddress, port: LOCAL_LOOKUP_PORT }] : []),
  ];
}

/**
 * Normalizes one camera's continuous video byte stream to Annex-B framing.
 *
 * Length prefixes and NAL bodies may cross PPCS frame boundaries, so one
 * instance owns the unfinished prefix and body length for the entire session.
 * Annex-B streams pass through without buffering or rewriting.
 */
export class PpcsVideoStreamNormalizer {
  #mode: "unknown" | "annexb" | "length-prefixed" = "unknown";
  #prefix = Buffer.alloc(0);
  #nalBytesRemaining = 0;
  #nalScanTail = Buffer.alloc(0);
  readonly #nalHeaderBytes: number[] = [];
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

  /** Convert the next ordered media bytes, retaining incomplete prefixes between calls. */
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

  #recordNalTypes(output: Buffer): Buffer {
    const data = this.#nalScanTail.length > 0
      ? Buffer.concat([this.#nalScanTail, output])
      : output;
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
      if (payloadOffset >= data.length) break;
      const headerByte = data[payloadOffset]!;
      if (!this.#nalHeaderBytes.includes(headerByte) && this.#nalHeaderBytes.length < 16) {
        this.#nalHeaderBytes.push(headerByte);
      }
      offset = payloadOffset + 1;
    }
    this.#nalScanTail = Buffer.from(data.subarray(Math.max(0, data.length - 4)));
    return output;
  }
}

function beginsWithAnnexB(payload: Buffer): boolean {
  return payload.length >= 4
    && payload[0] === 0
    && payload[1] === 0
    && (payload[2] === 1 || (payload[2] === 0 && payload[3] === 1));
}

interface PendingPpcsFrame {
  readonly header?: Buffer;
  readonly payload: Buffer;
}

/** Peer and camera values required to establish one PPCS media session. */
export interface PpcsCameraOptions {
  readonly stationSerial: string;
  readonly p2pDid: string;
  readonly appConnection: string;
  readonly localAddress?: string | null;
  readonly dskKey: string;
  readonly channel: number;
  readonly cameraModel: string;

  /** Parent peer model used only where HomeBase generations have different media lifecycle commands. */
  readonly stationModel?: string;
  readonly accountId: string | null;
  readonly homeBaseAttached?: boolean;
  readonly cipherId?: number | null;
  readonly initialEccPrivateKey?: string;
  readonly resolveCipherKey?: (cipherId: number) => Promise<string | undefined>;
  readonly maxSeconds?: number;

  /** Limit the session to one control write instead of starting camera media. */
  readonly purpose?: "media" | "control";
}

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
 * One bounded, first-party PPCS camera session for media or a confirmed write.
 *
 * It handles HomeBase-attached and direct camera paths: DSK lookup,
 * CAM_CHECK, the attached-camera gateway-info and level-two media sequence
 * when required, and Annex-B H.264 extraction. It has no dependency on
 * eufy-security-client or the expiring Web Portal PIN.
 *
 * Media sessions emit Annex-B bytes on `output`. Control sessions suppress
 * media startup and accept one acknowledged camera command before closing.
 * `start` resolves after the peer answers the lookup, not after the first video
 * frame. A camera can therefore be reachable while still failing later during
 * key unwrap or media start. The public stats object makes that distinction
 * visible in diagnostics.
 */
export class FirstPartyPpcsSession {
  readonly output = new PassThrough();
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
  #remote: { host: string; port: number } | null = null;
  #seq = 0;
  #closed = false;
  #maximumDurationTimer: ReturnType<typeof setTimeout> | null = null;
  #firstFrameTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingByType = new Map<number, PendingPpcsFrame>();
  #level2Key: Buffer | null = null;
  #level2Seq = 0;
  #gatewayPromise: Promise<void> | null = null;
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

  /** Return the codec declared by received PPCS frame metadata, when known. */
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

  /** Bind UDP, perform lookup and handshake, then start heartbeats. */
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

  /** Send one camera enablement write and wait for the peer's command result. */
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

  /** Send the verified 1011 direct-binary motion switch and await its result. */
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

  /** Send the verified HomeBase-attached night-vision mode command. */
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

  /** Send the reference camera siren duration command for a bounded local probe. */
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

  /** End the peer session and retain its terminal reason for privacy-safe diagnostics. */
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

  #checkCandidate(address: { host: string; port: number }): void {
    for (const port of ppcsCandidatePorts(address.port)) this.#check({ host: address.host, port });
  }

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
        if ((!this.#options.homeBaseAttached || decoderReady) && this.#firstFrameTimer) {
          clearTimeout(this.#firstFrameTimer);
          this.#firstFrameTimer = null;
        }
        if (this.#options.homeBaseAttached && decoderReady) this.#lastAttachedMediaFrameAt = Date.now();
      }
    } else if (command === 1300 && this.#options.homeBaseAttached) {
      this.stats.foreignVideoFrames++;
    }
  }

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
      this.#recordVideoResult(signCode > 0 ? "encrypted-frame-rejected" : "plaintext-frame-rejected");
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

  #recordVideoResult(result: string): void {
    if (!this.stats.videoResults.includes(result) && this.stats.videoResults.length < 8) {
      this.stats.videoResults.push(result);
    }
  }

  #updatePendingBytes(): void {
    this.stats.pendingBytes = [...this.#pendingByType.values()]
      .reduce((total, value) => total + (value.header?.length ?? 0) + value.payload.length, 0);
  }

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

  async #handleGatewayInfo(payload: Buffer): Promise<void> {
    if (this.#gatewayPromise) return this.#gatewayPromise;
    if (!this.#options.homeBaseAttached || this.#level2Key || !this.#options.resolveCipherKey || payload.length < 133) return;
    this.#gatewayPromise = this.#deriveLevel2(payload);
    try { await this.#gatewayPromise; } finally { this.#gatewayPromise = null; }
  }

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

  async #waitForLevel2Key(): Promise<void> {
    const deadline = Date.now() + CONTROL_TIMEOUT_MILLISECONDS;
    while (!this.#level2Key && !this.stats.level2Error && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!this.#level2Key) {
      throw new Error(this.stats.level2Error || "Camera level-two control key timed out");
    }
  }

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

  #check(address: { host: string; port: number }): void { this.#send(REQ.check, Buffer.concat([encodeDid(this.#options.p2pDid), Buffer.alloc(3)]), address); }
  #sendCommand(command: number, payload: Buffer): void {
    if (!this.#remote) return;
    const header = Buffer.concat([DATA.data, u16(this.#seq++), MAGIC, u16le(command)]);
    this.#send(REQ.data, Buffer.concat([header, payload]), this.#remote);
  }
  #send(type: Buffer, payload: Buffer, address: { host: string; port: number }): void {
    this.#socket.send(Buffer.concat([type, u16(payload.length), payload]), address.port, address.host);
  }
}

function ppcsVideoCodec(streamType: number): VideoCodec | null {
  if (streamType === 1) return "h264";
  if (streamType === 2) return "h265";
  return null;
}

function voidPayload(channel: number): Buffer { const result = Buffer.alloc(10); result.writeUInt16LE(1, 4); result[6] = channel; return result; }
function commandHeader(sequence: number, command: number): Buffer {
  const result = Buffer.concat([DATA.data, u16(sequence), MAGIC, Buffer.alloc(2)]);
  result.writeUInt16LE(command, 8);
  return result;
}
function rawPayload(data: Buffer, channel: number, signCode: number, magic: readonly [number, number], streamId: number): Buffer {
  const result = Buffer.alloc(10 + data.length);
  result.writeUInt16LE(data.length, 0); result[4] = magic[0]; result[5] = magic[1];
  result[6] = channel & 0xff; result[7] = signCode & 0xff; result[8] = streamId & 0xff;
  data.copy(result, 10); return result;
}

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
/** Build the bounded direct-command body used by camera enablement writes. */
export function buildCameraEnableBody(channel: number, value: number, accountId: string): Buffer {
  if (!accountId) throw new Error("Camera control requires a non-empty account identity");
  const body = Buffer.alloc(8 + 128);
  body.writeUInt32LE(channel, 0);
  body.writeUInt32LE(value, 4);
  body.write(accountId.slice(0, 128), 8, "ascii");
  return body;
}

/** Build the verified SET_PAYLOAD body for a HomeBase-attached night-vision write. */
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

function encryptLevel1(plaintext: Buffer, key: Buffer): Buffer {
  const padded = Buffer.alloc(Math.ceil(Math.max(plaintext.length, 16) / 16) * 16);
  plaintext.copy(padded);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}
function encryptLevel2(plaintext: Buffer, key: Buffer, sequence: number): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("eufy security", "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([cipher.getAuthTag(), nonce, Buffer.from([sequence & 0xff, 3, 2, 1]), ciphertext]);
}
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

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
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
function publicModulus(key: ReturnType<typeof generateKeyPairSync>["publicKey"]): string { const jwk = key.export({ format: "jwk" }) as { n: string }; return Buffer.from(jwk.n, "base64url").toString("hex").replace(/^00/, ""); }
function u16(value: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; }
function u16le(value: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; }
function has(value: Buffer, header: Buffer): boolean { return value.subarray(0, 2).equals(header); }
function commandKey(serial: string, did: string): Buffer { return Buffer.from(`${serial.slice(-7)}${did.substring(did.indexOf("-"), did.indexOf("-") + 9)}`); }
function decryptEcb(value: Buffer, key: Buffer): Buffer { const decipher = createDecipheriv(`aes-${key.length * 8}-ecb`, key, null); decipher.setAutoPadding(false); return Buffer.concat([decipher.update(value), decipher.final()]); }
function encodeDid(value: string): Buffer { const [a, b, c] = value.split("-"); const result = Buffer.alloc(20); Buffer.from(a ?? "").copy(result); result.writeUInt32BE(Number(b ?? 0), 8); Buffer.from(c ?? "").copy(result, 12); return result; }
function decodeCloudAddresses(value: string): { host: string; port: number }[] {
  const table = Buffer.from("4959433db5bf6da347534f6165e371e9677f02030badb3892b2f35c16b8b959711e5a70deff1050783fb9d3bc5c713171d1f2529d3df", "hex");
  const encoded = value.split(":", 1)[0] ?? ""; const out = Buffer.alloc(Math.floor(encoded.length / 2));
  for (let i = 0; i < out.length; i++) { let z = 57; for (let j = 0; j < i; j++) z ^= out[j]!; out[i] = z ^ table[i % table.length]! ^ ((encoded.charCodeAt(i * 2) - 65) * 16 + encoded.charCodeAt(i * 2 + 1) - 65); }
  return out.toString().split(",").filter(Boolean).map((host) => ({ host, port: 32100 }));
}

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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
