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
import { validateC31Preference, type C31Preference } from "../provider/c31-preferences.js";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { PassThrough } from "node:stream";
import { HomeBaseRecordingReader } from "./homebase-recordings.js";
import { SoloCamRecordingReader, type CameraStoredRecord } from "./stored-recordings.js";
import type { CameraPresetPosition, VideoCodec } from "../domain/types.js";
import { PpcsAccessUnitAssembler } from "./ppcs-access-unit-assembler.js";
import { decodePpcsAac } from "./ppcs-audio.js";
import { ppcsCandidatePorts, ppcsLocalLookupTargets } from "./ppcs-lookup.js";
import { PpcsLookupSocketPool } from "./ppcs-lookup-sockets.js";
import { decodeSensorContactNotification, type SensorContactObservation } from "./sensor-status-notification.js";

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

/** Reissue a standalone start during startup or after normalized media stalls. */
export function needsStandaloneMediaReassert(
  homeBaseAttached: boolean,
  lastDeliveredFrameAt: number | null,
  now: number,
): boolean {
  return !homeBaseAttached && needsAttachedMediaReassert(lastDeliveredFrameAt, now);
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
 * Limit clear E30/C31 AAC to its requested channel and media lifecycle.
 * Attached E30 routes may use assigned channels; direct E30/C31 routes use zero.
 * Payload validation and protection checks remain with the owning session.
 */
export function acceptsSoloCamAudio(cameraModel: string, homeBaseAttached: boolean, requestedChannel: number,
  frameChannel: number, purpose: string | undefined): boolean {
  return (cameraModel === "T8171" || (cameraModel === "T817L" && !homeBaseAttached))
    && Number.isSafeInteger(requestedChannel) && requestedChannel >= 0
    && frameChannel === requestedChannel && (homeBaseAttached || requestedChannel === 0) && purpose !== "control";
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

/** Inbound datagrams retained while one independently sequenced channel waits for a hole. */
interface PpcsReorderChannel {
  last: number;
  held: Map<number, Buffer>;
  bytes: number;
  timer?: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Delivers PPCS datagrams in channel sequence order before command reassembly.
 *
 * One session owns this buffer and closes it before releasing its UDP socket.
 * A missing packet gets 250 ms to arrive, with at most 128 packets or 2 MiB
 * retained per channel. Expiry discards the partial command through `onSkip`
 * before delivering the earliest successor. Acknowledgements remain the
 * session's responsibility, including duplicates and retransmissions.
 */
export class PpcsDatagramReorderBuffer {
  readonly #channels = new Map<number, PpcsReorderChannel>();
  #closed = false;

  constructor(
    private readonly deliver: (data: Buffer, type: number) => void,
    private readonly onSkip: (type: number, reason: "gap" | "restart") => void,
    private readonly onRepeat: (reason: "duplicate" | "stale") => void,
  ) {}

  /** Accept an acknowledged packet, retaining successors until missing data arrives or expires. */
  push(data: Buffer, sequence: number, type: number): void {
    if (this.#closed) return;
    let channel = this.#channels.get(type);
    if (!channel) {
      channel = { last: sequence, held: new Map(), bytes: 0 };
      this.#channels.set(type, channel);
      this.deliver(data, type);
      return;
    }
    const disposition = ppcsSequenceDisposition(channel.last, sequence);
    if (disposition === "duplicate" || disposition === "stale") {
      this.onRepeat(disposition);
      return;
    }
    if (disposition === "restart") {
      this.#clearTimer(channel);
      channel.held.clear();
      channel.bytes = 0;
      this.onSkip(type, "restart");
      channel.last = sequence;
      this.deliver(data, type);
      return;
    }
    if (disposition === "next") {
      channel.last = sequence;
      this.deliver(data, type);
      this.#drain(type, channel);
      return;
    }
    if (channel.held.has(sequence)) {
      this.onRepeat("duplicate");
      return;
    }
    channel.held.set(sequence, Buffer.from(data));
    channel.bytes += data.length;
    if (channel.held.size >= 128 || channel.bytes >= 2 * 1024 * 1024) {
      this.#abandonHole(type, channel);
    } else {
      this.#arm(type, channel);
    }
  }

  /** Cancel all gap waits and release retained bytes, preventing delivery after session shutdown. */
  close(): void {
    this.#closed = true;
    for (const channel of this.#channels.values()) this.#clearTimer(channel);
    this.#channels.clear();
  }

  #clearTimer(channel: PpcsReorderChannel): void {
    if (channel.timer) clearTimeout(channel.timer);
    channel.timer = undefined;
  }

  #arm(type: number, channel: PpcsReorderChannel): void {
    if (channel.timer || channel.held.size === 0) return;
    channel.timer = setTimeout(() => {
      channel.timer = undefined;
      this.#abandonHole(type, channel);
    }, 250);
    channel.timer.unref?.();
  }

  #drain(type: number, channel: PpcsReorderChannel): void {
    this.#clearTimer(channel);
    while (!this.#closed) {
      const next = (channel.last + 1) & 0xffff;
      const data = channel.held.get(next);
      if (!data) break;
      channel.held.delete(next);
      channel.bytes -= data.length;
      channel.last = next;
      this.deliver(data, type);
    }
    if (!this.#closed) this.#arm(type, channel);
  }

  #abandonHole(type: number, channel: PpcsReorderChannel): void {
    this.#clearTimer(channel);
    const earliest = [...channel.held.keys()].sort(
      (a, b) => ((a - channel.last) & 0xffff) - ((b - channel.last) & 0xffff),
    )[0];
    if (earliest === undefined || this.#closed) return;
    this.onSkip(type, "gap");
    channel.last = (earliest - 1) & 0xffff;
    this.#drain(type, channel);
  }
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

  // Direct cameras have reported declarations for media bytes, metadata plus
  // media, the complete signed frame, and values beyond the outer frame. The
  // XZYH transport boundary is authoritative when a declaration overruns it.
  if (frame.length < 151 + 128) return { failure: "legacy-length" };
  const legacyMediaEnd = 151 + length;
  const mediaEnd = frame.length >= legacyMediaEnd
    ? legacyMediaEnd
    : frame.length;
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
    return { data: Buffer.concat([clear, frame.subarray(151 + 128, mediaEnd)]) };
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

  /** Authenticate the recording audio envelope using the most recently authenticated video media key. */
  decodeRecordingAudio(frame: Buffer): Buffer | null {
    if (!this.#mediaKey || frame.length < 44 || frame[5] !== 0 || frame.readUInt32LE(0) !== frame.length - 44) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#mediaKey, frame.subarray(32, 44));
      decipher.setAAD(Buffer.from("eufy security"));
      decipher.setAuthTag(frame.subarray(16, 32));
      const clear = Buffer.concat([decipher.update(frame.subarray(44)), decipher.final()]);
      return decodePpcsAac(Buffer.concat([frame.subarray(0, 16), clear]));
    } catch { return null; }
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
 * camera decrypts it as its own-session START_LIVE command. A standalone peer
 * that later negotiates level two switches to the separate frame-type-10 form.
 */
export function buildStandaloneLiveStartPayload(value: string, channel: number, key: Buffer): Buffer {
  return buildStandaloneJsonControlPayload(value, channel, key, 11);
}

/**
 * Build the negotiated level-two START_LIVE payload used by a standalone peer.
 *
 * Direct cameras can advertise their session key after accepting an initial
 * level-one start. Reissuing this frame type lets the camera bind the stream to
 * that negotiated session instead of replaying the legacy start indefinitely.
 */
export function buildStandaloneLevel2LiveStartPayload(
  value: string,
  channel: number,
  key: Buffer,
  sequence: number,
): Buffer {
  return rawPayload(encryptLevel2(Buffer.from(value), key, sequence), channel, 8, [8, 0], 10);
}

/** Build the app-observed SoloCam motion status envelope, distinct from live-start frame type 10. */
export function buildSoloCamMotionDetectionPayload(enabled: boolean, key: Buffer, sequence: number, now: number): Buffer {
  if (!Number.isSafeInteger(now) || !/^\d{13}$/.test(`${now}`)) {
    throw new Error("SoloCam motion transaction requires epoch milliseconds");
  }
  const value = JSON.stringify({ commandType: 6040, data: { status: enabled ? 1 : 0, transaction: `${now}` } });
  return rawPayload(encryptLevel2(Buffer.from(value), key, sequence), 0, 8, [8, 0], 0);
}

/** Build the app-observed SoloCam audio-recording enable envelope, distinct from live-start frame type 10. */
export function buildSoloCamAudioRecordingPayload(enabled: boolean, key: Buffer, sequence: number, now: number): Buffer {
  if (!Number.isSafeInteger(now) || !/^\d{13}$/.test(`${now}`)) {
    throw new Error("SoloCam audio transaction requires epoch milliseconds");
  }
  const value = JSON.stringify({ commandType: 6012, data: { enable: enabled ? 1 : 0, transaction: `${now}` } });
  return rawPayload(encryptLevel2(Buffer.from(value), key, sequence), 0, 8, [8, 0], 0);
}

/** Encrypt the native SoloCam streaming-quality wrapper; quality zero restores adaptive streaming. */
export function buildSoloCamStreamingQualityPayload(
  quality: number, accountId: string, key: Buffer, sequence: number, now: number,
): Buffer {
  if (!Number.isInteger(quality) || quality < 0 || quality > 3) throw new Error("Unsupported SoloCam streaming quality");
  if (!accountId) throw new Error("Streaming quality requires the camera administrator identity");
  if (!Number.isSafeInteger(now) || !/^\d{13}$/.test(`${now}`)) throw new Error("Streaming quality requires epoch milliseconds");
  const value = JSON.stringify({ account_id: accountId, cmd: 2730, mChannel: 0, mValue3: 0,
    payload: { quality, mode: 0, primary_view: 0, channel: 0, transaction: `${now}` } });
  return rawPayload(encryptLevel2(Buffer.from(value), key, sequence), 0, 8, [8, 0], 0);
}

/** Encrypt the exact standalone C31 quality wrapper, preserving its automatic mode selection. */
export function buildStandaloneC31StreamingQualityPayload(
  quality: number, accountId: string, key: Buffer, sequence: number, now: number,
): Buffer {
  if (![0, 2, 3].includes(quality)) throw new Error("Unsupported C31 streaming quality");
  if (!accountId) throw new Error("Streaming quality requires the camera administrator identity");
  if (!Number.isSafeInteger(now) || !/^\d{13}$/.test(`${now}`)) throw new Error("Streaming quality requires epoch milliseconds");
  const value = JSON.stringify({ account_id: accountId, cmd: 2730, mChannel: 0, mValue3: 0,
    payload: { quality, mode: -1, primary_view: -1, transaction: `${now}` } });
  return rawPayload(encryptLevel2(Buffer.from(value), key, sequence), 0, 8, [8, 0], 0);
}

/** Encrypt the C31 night mode on its native authenticated channel-zero settings wrapper. */
export function buildStandaloneC31NightVisionPayload(
  mode: number, accountId: string, key: Buffer, sequence: number, now: number,
): Buffer {
  if (![0, 1, 2].includes(mode)) throw new Error("Unsupported C31 night vision mode");
  if (!accountId) throw new Error("Night vision requires the camera administrator identity");
  if (!Number.isSafeInteger(now) || !/^\d{13}$/.test(`${now}`)) throw new Error("Night vision requires epoch milliseconds");
  const value = JSON.stringify({ account_id: accountId, cmd: 1277, mChannel: 0, mValue3: 0,
    payload: { night_sion: mode, channel: 0, transaction: `${now}` } });
  return rawPayload(encryptLevel2(Buffer.from(value), key, sequence), 0, 8, [8, 0], 0);
}

/** Encrypt the native C31 privacy switch, where zero enables the standalone camera. */
export function buildStandaloneC31EnabledPayload(
  rawValue: number, accountId: string, key: Buffer, sequence: number, now: number,
): Buffer {
  if (rawValue !== 0 && rawValue !== 1) throw new Error("Unsupported C31 enablement value");
  if (!accountId) throw new Error("Enablement requires the camera administrator identity");
  if (!Number.isSafeInteger(now) || !/^\d{13}$/.test(`${now}`)) throw new Error("Enablement requires epoch milliseconds");
  const value = JSON.stringify({ account_id: accountId, cmd: 6250, mChannel: 0, mValue3: 0,
    payload: { switch: rawValue, transaction: `${now}` } });
  return rawPayload(encryptLevel2(Buffer.from(value), key, sequence), 0, 8, [8, 0], 0);
}

/** Build the native C31 sound-only start with its captured 30-second safety timeout. */
export function buildStandaloneC31SirenStartPayload(
  accountId: string, key: Buffer, sequence: number, now: number,
): Buffer {
  if (!accountId) throw new Error("C31 siren requires its owning administrator identity");
  if (!Number.isSafeInteger(now) || !/^\d{13}$/.test(`${now}`)) throw new Error("C31 siren requires epoch milliseconds");
  const clear = Buffer.from(JSON.stringify({ account_id: accountId, cmd: 1201, mChannel: 0, mValue3: 0,
    payload: { channel: 0, type: 10, time_out: 30, user_name: "", transaction: `${now}` } }));
  return rawPayload(encryptLevel2(clear, key, sequence), 0, 8, [8, 0], 0);
}

/** Build either ordered native early-stop step; neither binary command starts the siren. */
export function buildStandaloneC31SirenStopPayload(
  command: 1201 | 1202, key: Buffer, sequence: number,
): Buffer {
  if (command !== 1201 && command !== 1202) throw new Error("Unsupported C31 siren stop command");
  const clear = Buffer.alloc(8);
  clear.writeUInt32LE(command === 1201 ? 10 : 255, 0);
  return rawPayload(encryptLevel2(clear, key, sequence), 255, 8, [8, 0], 0);
}

/** Build a reviewed C31 preference with native binary or JSON framing and authenticated protection. */
export function buildC31PreferencePayload(name: C31Preference, value: number, accountId: string, key: Buffer, sequence: number, now: number): { command: number; payload: Buffer } {
  validateC31Preference(name, value);
  if (!accountId) throw new Error("Camera preference requires an owning account");
  if (!Number.isSafeInteger(now) || !/^\d{13}$/.test(`${now}`)) throw new Error("Camera preference requires epoch milliseconds");
  const commands = { microphone: 1240, speaker: 1241, speakerVolume: 1230, imageFlipped: 1207, watermark: 1214, lightBrightness: 1401 };
  let command: number;
  let clear: Buffer;
  if (name === "notificationInterval") {
    command = 1250;
    clear = buildCameraEnableBody(0, value * 60, accountId).subarray(4);
  } else if (name === "preRecording") {
    command = 1350;
    clear = Buffer.from(JSON.stringify({ account_id: accountId, cmd: 6257, mChannel: 0, mValue3: 0, payload: { value, transaction: `${now}` } }));
  } else if (name === "recordingQuality") {
    command = 1350;
    clear = Buffer.from(JSON.stringify({ account_id: accountId, cmd: 2731, mChannel: 0, mValue3: 0, payload: { quality: value, mode: -1, primary_view: -1, transaction: `${now}` } }));
  } else if (name === "statusLed") {
    command = 1700;
    clear = Buffer.from(JSON.stringify({ commandType: 6014, data: { value, transaction: `${now}` } }));
  } else if (name === "soundRoundLook" || name === "enhanceLighting") {
    command = 1350;
    const payload = name === "soundRoundLook" ? { onoff: value, transaction: `${now}` } : { mode: 1 - value, transaction: `${now}` };
    clear = Buffer.from(JSON.stringify({ account_id: accountId, cmd: name === "soundRoundLook" ? 6208 : 6484, mChannel: 0, mValue3: 0, payload }));
  } else if (name === "soundSensitivity" || name === "soundType") {
    command = 1700;
    const data = name === "soundSensitivity" ? { index: value, transaction: `${now}` } : { type: value, transaction: `${now}` };
    clear = Buffer.from(JSON.stringify({ commandType: name === "soundSensitivity" ? 6044 : 6046, data }));
  } else if (name === "soundDetection") {
    command = 1700;
    clear = Buffer.from(JSON.stringify({ commandType: 6043, data: { status: value, transaction: `${now}` } }));
  } else {
    command = commands[name];
    clear = buildCameraEnableBody(0, value, accountId);
  }
  return { command, payload: rawPayload(encryptLevel2(clear, key, sequence), 0, 8, [8, 0], 0) };
}

/** Protect a native SoloCam preset or tracking request on its channel-zero control envelope. */
export function buildSoloCamPanControlPayload(
  command: 6034 | 6035 | 6016,
  value: number | undefined,
  key: Buffer,
  sequence: number,
  transaction: number,
): Buffer {
  const body = buildCameraControlQueryValue(command, buildSoloCamPanControlData(command, value, transaction));
  return rawPayload(encryptLevel2(Buffer.from(body), key, sequence), 0, 8, [8, 0], 0);
}

/** Build the authenticated direct C31 control observed in native tracking, cruise and light captures. */
export function buildStandaloneC31ControlPayload(
  command: 6016 | 6031 | 1400,
  enabled: boolean,
  key: Buffer,
  sequence: number,
  transaction: number,
): Buffer {
  if (![6016, 6031, 1400].includes(command)) throw new Error("Unsupported standalone C31 control");
  const preference = buildSoloCamPanControlData(6016, enabled ? 1 : 0, transaction);
  const data = command === 1400
    ? { value: preference.value, open: preference.value, type: 2, transaction: preference.transaction }
    : preference;
  const body = buildCameraControlQueryValue(command, data);
  return rawPayload(encryptLevel2(Buffer.from(body), key, sequence), 0, 8, [8, 0], 0);
}

/**
 * Encrypt one standalone JSON control value in Eufy's level-one string envelope.
 *
 * The outer XZYH command is supplied by the caller. Live start and wall-light
 * controls both use this body under command 1700. Live start adds frame type
 * 11, while ordinary controls leave that byte clear.
 */
export function buildStandaloneJsonControlPayload(
  value: string,
  channel: number,
  key: Buffer,
  frameType = 0,
): Buffer {
  const bytes = Buffer.from(value);
  const plain = Buffer.alloc(Math.ceil(Math.max(bytes.length, 16) / 16) * 16);
  bytes.copy(plain);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return rawPayload(encrypted, channel, 1, [1, 0], frameType);
}

/** Build the observed timed wall-light value carried by standalone command 1700. */
export function buildTimedCameraLightControlValue(enabled: boolean): string {
  return JSON.stringify({
    commandType: 1400,
    data: { time: 0, type: 2, value: enabled ? 1 : 0 },
  });
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

/** Read an advertised peer candidate from a LAN or cloud lookup response. */
export function ppcsLookupCandidate(message: Buffer): { readonly host: string; readonly port: number } | null {
  if (
    (!has(message, RESP.lookupAddr) && !has(message, RESP.lookupAddr2) && !has(message, RESP.localLookup))
    || message.length < 12
  ) return null;
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
    const h264Types = new Set(this.#nalHeaderBytes.map((byte) => byte & 0x1f));
    if (h264Types.has(7) && h264Types.has(8)) return "h264";
    if (this.#nalHeaderBytes.some((byte) => {
      const type = (byte >> 1) & 0x3f;

      // H.264 delta byte 0x41 resembles HEVC VPS, but its low bit excludes a single-layer HEVC header.
      return (byte & 1) === 0 && (type === 32 || type === 33 || type === 34);
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

  /** Current inventory child identity used only to project HomeBase recording ownership. */
  readonly recordingCameraSerial?: string;

  /** Eufy account identity required inside camera control payloads. */
  readonly accountId: string | null;

  /** Select the HomeBase child-channel handshake instead of direct camera media. */
  readonly homeBaseAttached?: boolean;

  /** Provider-validated eligibility for the standalone E30 night-vision command. */
  readonly standaloneNightVisionSupported?: boolean;

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

  /** Passive child-contact observations while an already requested HomeBase session is open. */
  readonly onSensorContact?: (observation: SensorContactObservation) => void;
}

/** One in-flight control command and the promise settled by its result frame. */
interface PendingControl {
  readonly command: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** One in-flight JSON control query correlated by its inner command type. */
interface PendingControlQuery {
  readonly command: number;
  readonly resolve: (payload: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** One validated camera-info row returned by the read-only PPCS query. */
export interface PpcsCameraInfoParam {
  readonly param_type: number;
  readonly param_value: string | number | boolean;
}

interface PendingCameraInfo {
  readonly resolve: (params: readonly PpcsCameraInfoParam[]) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Build the JSON carried by a command-1700 camera control query. */
export function buildCameraControlQueryValue(
  commandType: number,
  data: Readonly<Record<string, unknown>>,
): string {
  if (!Number.isSafeInteger(commandType) || commandType <= 0) {
    throw new Error("Camera control query command must be a positive integer");
  }
  return JSON.stringify({ commandType, data });
}

/** Build native SoloCam pan-control data, keeping query, slot and tracking meanings distinct. */
export function buildSoloCamPanControlData(
  command: 6034 | 6035 | 6016,
  value?: number,
  transaction = Date.now(),
): Readonly<Record<string, unknown>> {
  if (!Number.isSafeInteger(transaction) || !/^\d{13}$/.test(`${transaction}`)) {
    throw new Error("SoloCam pan-control transaction requires epoch milliseconds");
  }
  if (command === 6034) {
    if (value !== undefined) throw new Error("Preset query does not accept a slot");
    return { transaction: `${transaction}` };
  }
  if (command !== 6035 && command !== 6016) throw new Error("Unsupported SoloCam pan control");
  if (!Number.isSafeInteger(value) || value! < 0 || value! > (command === 6016 ? 1 : 9)) {
    throw new Error("Invalid SoloCam pan-control value");
  }
  return { value, transaction: `${transaction}` };
}

/** Build the complete T817L AI-tracking payload observed in the official app. */
export function buildAiTrackingControlData(
  enabled: boolean,
  transaction = Date.now(),
): Readonly<Record<string, unknown>> {
  if (!Number.isSafeInteger(transaction) || transaction < 0) {
    throw new Error("AI-tracking transaction must be a non-negative whole number");
  }
  return {
    enable: 0,
    index: 0,
    status: 0,
    type: 0,
    value: enabled ? 1 : 0,
    voiceID: 0,
    zonecount: 0,
    transaction: `${transaction}`,
  };
}

/**
 * Reduce a preset query reply to slot indexes, occupancy, and default state.
 *
 * Names, thumbnails, coordinates, and other camera-specific fields are
 * intentionally discarded so diagnostic probes retain no scene information.
 */
export function parseCameraPresetPositions(payload: unknown): CameraPresetPosition[] {
  if (!isRecord(payload) || !Array.isArray(payload.points)) return [];
  const positions: CameraPresetPosition[] = [];
  for (const point of payload.points) {
    if (!isRecord(point)) continue;
    const index = integerValue(point.index ?? point.id ?? point.value);
    if (index === null || index < 0 || index > 255) continue;
    positions.push({
      index,
      enabled: booleanFlag(point.enable ?? point.enabled),
      isDefault: booleanFlag(point.isdefault ?? point.isDefault),
    });
  }
  return positions;
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
 * Media sessions emit Annex-B bytes on `output` and optional validated AAC on
 * `audioOutput` for T8171 media consumers and direct T817L consumers. Control sessions suppress
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

  /** Optional checked AAC for admitted E30/C31 media, ended with the video session. */
  readonly audioOutput = new PassThrough();

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
    cameraInfoParamTypes: [] as number[],
    cameraInfoFrames: 0,
    cameraInfoParseStage: "none",
    cameraInfoSign: -1,
    cameraInfoJsonOffset: -1,
    cameraInfoDecoded: false,
    standaloneGuardMode: null as number | null,
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
    mediaStartProtocols: [] as ("level1" | "level2")[],
    mediaStopAttempts: 0,
    mediaStopProtocol: "none" as "none" | "level1-direct" | "level2-payload",
    closeReason: "open" as PpcsStreamCloseReason | "open",
  };
  readonly #options: PpcsCameraOptions;
  #socket: Socket = createSocket("udp4");
  #lookupSockets: PpcsLookupSocketPool | null = null;

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
  #datagramOrder = new PpcsDatagramReorderBuffer(
    (data, type) => this.#consumeData(data, type),
    (type, reason) => {
      if (reason === "restart") this.stats.sequenceRestarts++;
      else this.stats.sequenceGaps++;
      this.#pendingByType.delete(type);
      this.#updatePendingBytes();
    },
    (reason) => {
      if (reason === "duplicate") this.stats.duplicateDatagrams++;
      else this.stats.staleDatagrams++;
    },
  );
  readonly #videoNormalizer = new PpcsVideoStreamNormalizer();
  readonly #videoAssembler = new PpcsAccessUnitAssembler((drop) => {
    this.stats.incompleteAccessUnits++;
    this.stats.incompleteAccessUnitBytes += drop.carriedBytes;
    this.#recordVideoResult("incomplete-access-unit-dropped");
  });
  #lastDeliveredMediaFrameAt: number | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #attachedMediaRestartTimer: ReturnType<typeof setTimeout> | null = null;
  #lookupTimer: ReturnType<typeof setInterval> | null = null;
  #selfAddress: { host: string; port: number } | null = null;
  #pendingControl: PendingControl | null = null;
  #pendingControlQuery: PendingControlQuery | null = null;
  #pendingCameraInfo: PendingCameraInfo | null = null;

  /** Own correlated card reads separately from live media and camera-setting requests. */
  #recordings: SoloCamRecordingReader | HomeBaseRecordingReader | null = null;

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
      const onMessage = (message: Buffer, info: RemoteInfo, socket: Socket): void => {
        try {
          if (this.#handle(message, info, socket)) { clearTimeout(timeout); resolve(); }
        } catch (error) { clearTimeout(timeout); reject(error); }
      };
      this.#socket.on("message", (message, info) => onMessage(message, info, this.#socket));
      this.#socket.bind(0, async () => {
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
        this.#lookupSockets = new PpcsLookupSocketPool(this.#socket, onMessage, (error) => {
          clearTimeout(timeout);
          this.close("start_failed");
          reject(error);
        });
        if (decodeCloudAddresses(this.#options.appConnection).length > 0) await this.#lookupSockets.bindProbes();
        if (this.#closed) return;
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
      if (this.#options.purpose === "control" && this.stats.mediaStartAttempts === 0) return;
      if (
        this.#options.homeBaseAttached
        && this.#level2Key
        && needsAttachedMediaReassert(this.#lastDeliveredMediaFrameAt, Date.now())
      ) {
        this.#startAttachedMedia();
      }
      else if (needsStandaloneMediaReassert(
        Boolean(this.#options.homeBaseAttached),
        this.#lastDeliveredMediaFrameAt,
        Date.now(),
      )) {
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
   * then perform a fresh readback instead of sending the command twice. The
   * standalone C31 uses its native privacy wrapper without a result frame and
   * always requires the provider to confirm its state independently.
   */
  async writeCameraEnabled(rawValue: number): Promise<void> {
    if (this.#options.purpose !== "control") throw new Error("Camera control requires a control session");
    if (!this.#remote) throw new Error("Camera control session is not connected");
    const accountId = this.#options.accountId;
    if (!accountId) throw new Error("Camera control account identity is unavailable");
    if (rawValue !== 0 && rawValue !== 1) throw new Error("Camera enablement value must be 0 or 1");
    if (this.#options.homeBaseAttached) await this.#waitForLevel2Key();
    if (this.#options.cameraModel === "T817L" && this.#options.homeBaseAttached === false && this.#options.channel === 0) {
      await this.#waitForLevel2Key();
      const transaction = Date.now();
      for (let index = 0; index < 3; index += 1) {
        this.#sendCommand(1350, buildStandaloneC31EnabledPayload(rawValue, accountId, this.#level2Key!, this.#level2Seq++, transaction));
        await delay(200);
      }
      return;
    }
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

  /** Send the standalone 1224 mode command over the camera's direct route. */
  async writeStandaloneGuardMode(mode: number, userName: string): Promise<void> {
    if (this.#options.purpose !== "control") throw new Error("Guard-mode control requires a control session");
    if (!this.#remote) throw new Error("Guard-mode control session is not connected");
    if (this.#options.homeBaseAttached) throw new Error("Standalone guard-mode control requires a direct camera route");
    if (![0, 1, 63].includes(mode)) throw new Error("Unsupported standalone camera guard mode");
    const accountId = this.#options.accountId;
    if (!accountId || !userName) throw new Error("Standalone guard-mode account identity is unavailable");
    const value = buildStandaloneGuardModeValue(
      accountId,
      userName,
      mode,
    );
    const encrypted = encryptLevel1(
      Buffer.from(value),
      commandKey(this.#options.stationSerial, this.#options.p2pDid),
    );
    this.#sendCommand(1350, rawPayload(encrypted, 0, 1, [1, 0], 0));
  }

  /**
   * Read camera-owned settings without changing preferences or stored media.
   *
   * Exact standalone C31 sessions use the SDK integer query on station channel
   * 255. Other routes retain their direct camera-channel query. Decoded replies
   * must satisfy the parameter-table schema and belong to this owned session.
   */
  async readCameraInfo(): Promise<readonly PpcsCameraInfoParam[]> {
    if (this.#options.purpose !== "control" && !this.#allowsViewerPanControl()) {
      return Promise.reject(new Error("Camera-info refresh requires a control session"));
    }
    if (!this.#remote) return Promise.reject(new Error("Camera-info session is not connected"));
    if (this.#options.homeBaseAttached) {
      return Promise.reject(new Error("Direct camera-info refresh does not support a HomeBase route"));
    }
    if (this.#pendingCameraInfo) {
      return Promise.reject(new Error("Camera-info refresh is already in progress"));
    }
    if (this.#options.cameraModel === "T8171"
      || (this.#options.cameraModel === "T817L" && this.#options.channel === 0)) await this.#waitForLevel2Key();
    return new Promise<readonly PpcsCameraInfoParam[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingCameraInfo = null;
        reject(new Error(`Camera-info refresh timed out: frames=${this.stats.cameraInfoFrames} sign=${this.stats.cameraInfoSign} decoded=${this.stats.cameraInfoDecoded} json_offset=${this.stats.cameraInfoJsonOffset} parse=${this.stats.cameraInfoParseStage}`));
      }, CONTROL_TIMEOUT_MILLISECONDS);
      this.#pendingCameraInfo = { resolve, reject, timer };
      if (this.#options.cameraModel === "T817L" && this.#options.channel === 0) {
        this.#sendCommand(1103, buildC31CameraInfoQueryPayload());
      } else this.#sendCommand(1103, voidPayload(this.#options.channel));
    });
  }

  /**
   * Send the verified command-1011 motion switch and await its result.
   *
   * The standalone T8171 and T817L use their native 6040 JSON status command. Its caller
   * must confirm the setting through a fresh inventory read. Other routes use
   * the level-two binary form and await its acknowledgement.
   */
  async writeMotionDetection(enabled: boolean): Promise<void> {
    if (this.#options.purpose !== "control") throw new Error("Motion control requires a control session");
    if (!this.#remote) throw new Error("Motion control session is not connected");
    const accountId = this.#options.accountId;
    if (!accountId) throw new Error("Motion control account identity is unavailable");
    await this.#waitForLevel2Key();
    if (this.#options.cameraModel === "T8171"
      || (this.#options.cameraModel === "T817L" && this.#options.homeBaseAttached === false)) {
      if (this.#options.homeBaseAttached || this.#options.channel !== 0) {
        throw new Error("SoloCam motion control requires a standalone channel-zero route");
      }
      const transaction = Date.now();
      for (let index = 0; index < 3; index += 1) {
        this.#sendCommand(1700, buildSoloCamMotionDetectionPayload(enabled, this.#level2Key!, this.#level2Seq++, transaction));
        await delay(200);
      }
      return;
    }
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

  /** Send only reviewed exact-C31 preferences; the provider must independently confirm inventory. */
  async writeC31Preference(name: C31Preference, value: number): Promise<void> {
    validateC31Preference(name, value);
    if (this.#options.purpose !== "control" || !this.#remote || !this.#options.accountId
      || this.#options.cameraModel !== "T817L" || this.#options.homeBaseAttached !== false || this.#options.channel !== 0) {
      throw new Error("Camera preference requires an owned standalone C31 control session");
    }
    await this.#waitForLevel2Key();
    const now = Date.now();
    for (let index = 0; index < 3; index += 1) {
      const frame = buildC31PreferencePayload(name, value, this.#options.accountId, this.#level2Key!, this.#level2Seq++, now);
      this.#sendCommand(frame.command, frame.payload);
      await delay(200);
    }
  }

  /** Send the native standalone audio setting; callers must confirm fresh inventory readback. */
  async writeAudioRecording(enabled: boolean): Promise<void> {
    if (this.#options.purpose !== "control" || !this.#remote || !this.#options.accountId) {
      throw new Error("Audio recording requires a connected account-owned control session");
    }
    if (!["T8171", "T817L"].includes(this.#options.cameraModel ?? "") || this.#options.homeBaseAttached || this.#options.channel !== 0) {
      throw new Error("Audio recording requires a standalone SoloCam channel-zero route");
    }
    await this.#waitForLevel2Key();
    const transaction = Date.now();
    for (let index = 0; index < 3; index += 1) {
      this.#sendCommand(1700, buildSoloCamAudioRecordingPayload(enabled, this.#level2Key!, this.#level2Seq++, transaction));
      await delay(200);
    }
  }

  /** Send a native quality preference; fresh cloud confirmation remains the caller's responsibility. */
  async writeStreamingQuality(quality: number): Promise<void> {
    if (this.#options.purpose !== "control" || !this.#remote || !this.#options.accountId) {
      throw new Error("Streaming quality requires a connected account-owned control session");
    }
    if (!["T8171", "T817L"].includes(this.#options.cameraModel ?? "") || this.#options.homeBaseAttached || this.#options.channel !== 0) {
      throw new Error("Streaming quality requires a standalone SoloCam channel-zero route");
    }
    const builder = this.#options.cameraModel === "T817L"
      ? buildStandaloneC31StreamingQualityPayload : buildSoloCamStreamingQualityPayload;

    // Reject invalid preferences before opening authenticated command state.
    if (this.#options.cameraModel === "T817L" && ![0, 2, 3].includes(quality)) throw new Error("Unsupported C31 streaming quality");
    await this.#waitForLevel2Key();
    const transaction = Date.now();
    for (let index = 0; index < 3; index += 1) {
      this.#sendCommand(1350, builder(quality, this.#options.accountId, this.#level2Key!, this.#level2Seq++, transaction));
      await delay(200);
    }
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
   * Send the night-vision mode command using the provider-approved peer route.
   *
   * Model-approved modes are wrapped in command 1350 and sent three times through
   * the negotiated level-two channel for attached cameras. An eligible standalone
   * C31 uses its authenticated native wrapper. The E30 uses level one and drains
   * its final transmission before closure. These paths do not await a result
   * frame, so the provider must confirm each preference through fresh readback.
   */
  async writeNightVision(mode: number): Promise<void> {
    if (this.#options.purpose !== "control") throw new Error("Night vision control requires a control session");
    if (!this.#remote) throw new Error("Night vision control session is not connected");
    const standalone = this.#options.homeBaseAttached === false
      && this.#options.standaloneNightVisionSupported === true
      && ["T8171", "T817L"].includes(this.#options.cameraModel ?? "") && this.#options.channel === 0;
    if (!this.#options.homeBaseAttached && !standalone) throw new Error("Night vision control requires a HomeBase-attached camera");
    const accountId = this.#options.accountId;
    if (!accountId) throw new Error("Night vision control account identity is unavailable");
    const maximumMode = this.#options.cameraModel === "T8171" ? 3 : 2;
    if (!Number.isSafeInteger(mode) || mode < 0 || mode > maximumMode
      || (this.#options.cameraModel === "T8171" && mode === 2)) {
      throw new Error("Night vision mode is not supported for this camera model");
    }
    if (standalone && this.#options.cameraModel === "T817L") {
      if (![0, 1, 2].includes(mode)) throw new Error("Unsupported C31 night vision mode");
      await this.#waitForLevel2Key();
      const transaction = Date.now();
      for (let index = 0; index < 3; index += 1) {
        this.#sendCommand(1350, buildStandaloneC31NightVisionPayload(mode, accountId, this.#level2Key!, this.#level2Seq++, transaction));
        await delay(200);
      }
      return;
    }
    if (standalone) {
      const body = encryptLevel1(buildNightVisionBody(0, mode, accountId), commandKey(this.#options.stationSerial, this.#options.p2pDid));
      for (let index = 0; index < 3; index += 1) {
        this.#sendCommand(1350, rawPayload(body, 0, 1, [1, 0], 0));
        await delay(200);
      }
      return;
    }
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

  /** Transmit a native C31 alarm action; the provider owns pulse timing, cancellation and stop. */
  async writeStandaloneC31Siren(enabled: boolean): Promise<void> {
    if (this.#options.purpose !== "control" || !this.#remote
      || this.#options.cameraModel !== "T817L" || this.#options.homeBaseAttached || this.#options.channel !== 0) {
      throw new Error("C31 siren requires its connected direct channel-zero control session");
    }
    const accountId = this.#options.accountId;
    if (!accountId) throw new Error("C31 siren requires its owning administrator identity");
    await this.#waitForLevel2Key();
    if (typeof enabled !== "boolean") throw new Error("C31 siren requires an absolute boolean action");
    const now = Date.now();
    const commands = enabled ? [1350] : [1201, 1202];
    for (const command of commands) {
      for (let index = 0; index < 3; index += 1) {
        const payload = enabled
          ? buildStandaloneC31SirenStartPayload(accountId, this.#level2Key!, this.#level2Seq++, now)
          : buildStandaloneC31SirenStopPayload(command as 1201 | 1202, this.#level2Key!, this.#level2Seq++);
        this.#sendCommand(command, payload);
        if (index < 2) await delay(200);
      }
      if (command === 1201) await delay(200);
    }
  }

  /** Send the native manual light action on a provider-authorized standalone C31. */
  async writeStandaloneC31Light(enabled: boolean): Promise<void> {
    if (this.#options.cameraModel !== "T817L" || this.#options.homeBaseAttached || this.#options.channel !== 0) {
      throw new Error("C31 manual light requires its direct channel-zero route");
    }
    await this.#sendControlPayload(1400, { value: enabled ? 1 : 0, transaction: `${Date.now()}` });
  }

  /** Send the standalone wall-light family's momentary on or off command. */
  async writeTimedCameraLight(enabled: boolean): Promise<void> {
    if (this.#options.purpose !== "control") throw new Error("Camera light control requires a control session");
    if (!this.#remote) throw new Error("Camera light control session is not connected");
    if (this.#options.homeBaseAttached) throw new Error("Timed camera light control requires a standalone camera");
    const payload = buildStandaloneJsonControlPayload(
      buildTimedCameraLightControlValue(enabled),
      this.#options.channel,
      commandKey(this.#options.stationSerial, this.#options.p2pDid),
    );

    // The vendor path is fire-and-forget and reports no durable light state.
    // Repeat the idempotent frame so one lost UDP datagram does not lose the action.
    for (let index = 0; index < 3; index += 1) {
      this.#sendCommand(1700, payload);
      if (index < 2) await delay(200);
    }
  }

  /** Send command 1400 using the direct spotlight family's integer and account envelope. */
  async writeStandaloneCameraLight(enabled: boolean): Promise<void> {
    if (this.#options.purpose !== "control") throw new Error("Camera light control requires a control session");
    if (!this.#remote) throw new Error("Camera light control session is not connected");
    if (this.#options.homeBaseAttached) throw new Error("Standalone camera light control requires a direct camera");
    const accountId = this.#options.accountId;
    if (!accountId) throw new Error("Camera light control account identity is unavailable");
    const body = buildStandaloneCameraLightBody(
      this.#options.channel,
      enabled,
      accountId,
      commandKey(this.#options.stationSerial, this.#options.p2pDid),
    );

    // The vendor path is fire-and-forget and reports no durable light state.
    // Repeat the idempotent frame so one lost UDP datagram does not lose the action.
    for (let index = 0; index < 3; index += 1) {
      this.#sendCommand(1400, body);
      if (index < 2) await delay(200);
    }
  }

  /**
   * Query the camera's preset slots without fetching names or thumbnails.
   *
   * The command-1700 request receives a command-1351 notification whose inner
   * command identifies the preset query. A timeout means no readable preset
   * contract was observed and does not imply that the camera has no presets.
   */
  async queryPresetPositions(): Promise<readonly CameraPresetPosition[]> {
    if (this.#options.cameraModel === "T8171" && this.#options.homeBaseAttached) await this.#preparePanMotorView();
    const payload = await this.#queryControlPayload(6034, this.#options.cameraModel === "T8171"
      ? buildSoloCamPanControlData(6034) : { value: 0 });
    return parseCameraPresetPositions(payload);
  }

  /**
   * Move to a stored position using the model's native absolute command.
   * Direct C31 and SoloCam movement require decoded live video. An owned control
   * connection drains temporary video; an existing viewer retains its output.
   */
  async selectPresetPosition(index: number): Promise<void> {
    if (!Number.isSafeInteger(index) || index < 0 || index > 9) {
      throw new Error("Camera preset index must be between 0 and 9");
    }
    const soloCam = this.#options.cameraModel === "T8171";
    const standaloneC31 = this.#options.cameraModel === "T817L" && !this.#options.homeBaseAttached
      && this.#options.channel === 0;
    if (soloCam || standaloneC31) await this.#preparePanMotorView();
    await this.#sendControlPayload(6035,
      soloCam ? buildSoloCamPanControlData(6035, index) : { value: index });

    // Keep standalone pan travel inside the connection that owns the command.
    await delay(soloCam || standaloneC31 ? 12_000 : 500);
    if (this.#closed) throw new Error("Camera connection closed during preset movement");
  }

  /** Enable or disable AI tracking using this model's app-confirmed command shape. */
  async writeAiTracking(enabled: boolean): Promise<void> {
    await this.#sendControlPayload(6016, (this.#usesSoloCamPanControl()
      || (this.#options.cameraModel === "T817L" && !this.#options.homeBaseAttached && this.#options.channel === 0))
      ? buildSoloCamPanControlData(6016, enabled ? 1 : 0) : buildAiTrackingControlData(enabled));
    await delay(500);
  }

  /** Read completed SoloCam event clips through the provider-validated standalone or HomeBase route. */
  async listStoredRecordings(date: string, signal?: AbortSignal): Promise<readonly CameraStoredRecord[]> {
    const reader = this.#recordingReader();
    await this.#waitForLevel2Key();
    return await reader.list(date, signal);
  }

  /** Retrieve a provider-owned recording reference and verify all returned media tracks. */
  async downloadStoredRecording(record: CameraStoredRecord, signal?: AbortSignal): Promise<Buffer> {
    const reader = this.#recordingReader();
    await this.#waitForLevel2Key();
    return await reader.download(record, signal);
  }

  #recordingReader(): SoloCamRecordingReader | HomeBaseRecordingReader {
    if (this.#options.homeBaseAttached) {
      if (this.#options.cameraModel !== "T8171" || this.#options.stationModel !== "T8030" || this.#options.channel !== 1 ||
        !this.#options.recordingCameraSerial || this.#options.purpose !== "control" || !this.#options.accountId) {
        throw new Error("Stored recordings require the verified SoloCam HomeBase route");
      }
      this.#recordings ??= new HomeBaseRecordingReader({
        serial: this.#options.recordingCameraSerial, stationSerial: this.#options.stationSerial, channel: this.#options.channel,
        query: (transaction, date) => {
          const value = { account_id: this.#options.accountId, cmd: 1306, mChannel: 255, mValue3: 0,
            payload: { cmd: 10011, table: "history_record_info", transaction, payload: {
              count: 100, start_date: date, end_date: date, start_id: 0, end_id: 1, flag: 0, need_ai: 1,
              res_unzip: 1, update_time: "0", start_time: "0", alarm_id: "",
            } } };
          this.#sendCommand(1350, rawPayload(encryptLevel2(Buffer.from(JSON.stringify(value)), this.#level2Key!, this.#level2Seq++), 255, 8, [8, 0], 0));
        },
        download: (filepath, key) => {
          const value = { account_id: this.#options.accountId, cmd: 1024, mChannel: this.#options.channel, mValue3: 1024, payload: { key, filepath } };
          this.#sendCommand(1350, rawPayload(encryptLevel2(Buffer.from(JSON.stringify(value)), this.#level2Key!, this.#level2Seq++), this.#options.channel, 8, [8, 0], 25));
        },
        decodeReply: (payload, sign) => {
          if (sign === 0) return payload;
          if ((sign === 8 || sign === 2) && this.#level2Key) return decryptLevel2(payload, this.#level2Key, sign) ?? null;
          if (sign === 1 && payload.length % 16 === 0) {
            try { return decryptEcb(payload, commandKey(this.#options.stationSerial, this.#options.p2pDid)); } catch { return null; }
          }
          return null;
        },
        decoder: (key) => {
          const decoder = new PpcsVideoFrameDecoder(() => undefined);
          decoder.setEccPrivateKey(key);
          return { video: (payload, sign) => decoder.decode(payload, sign), audio: (payload) => decoder.decodeRecordingAudio(payload),
            close: () => decoder.setEccPrivateKey("") };
        },
      });
      return this.#recordings;
    }
    if (!["T8171", "T817L"].includes(this.#options.cameraModel ?? "") || this.#options.homeBaseAttached ||
      this.#options.channel !== 0 || this.#options.purpose !== "control" || !this.#options.accountId) {
      throw new Error("Stored recordings require the verified standalone SoloCam route");
    }
    this.#recordings ??= new SoloCamRecordingReader({
      serial: this.#options.stationSerial, p2pDid: this.#options.p2pDid,
      deviceType: this.#options.cameraModel === "T817L" ? 10_031 : 88,
      query: (transaction, date) => {
        const value = { account_id: this.#options.accountId, cmd: 1306, mChannel: 0, mValue3: 0,
          payload: { cmd: 10017, table: "history_record_info", transaction, payload: {
            count: 100, detection_type: 0, device_info: [{ device_sn: this.#options.stationSerial }],
            start_date: date, end_date: date, start_time: "0", event_type: 0, flag: 0,
            res_unzip: 1, storage_cloud: -1, ai_type: 0,
          } } };
        this.#sendCommand(1350, rawPayload(encryptLevel2(Buffer.from(JSON.stringify(value)), this.#level2Key!, this.#level2Seq++), 0, 8, [8, 0], 0));
      },
      download: (storagePath) => {
        const body = Buffer.alloc(261);
        Buffer.from(storagePath).copy(body, 5, 0, 127);
        Buffer.from(this.#options.accountId!).copy(body, 133, 0, 127);
        this.#sendCommand(1024, rawPayload(encryptLevel2(body, this.#level2Key!, this.#level2Seq++), 255, 8, [8, 0], 0));
      },
      decodeReply: (payload, sign) => sign === 0 ? payload : sign === 8 && this.#level2Key
        ? decryptLevel2(payload, this.#level2Key, sign) ?? null : null,
    });
    return this.#recordings;
  }

  /** Enable or disable T817L automatic cruise using the app-confirmed action. */
  async writeAutoCruise(enabled: boolean): Promise<void> {
    await this.#sendControlPayload(6031, { value: enabled ? 1 : 0,
      ...(!this.#options.homeBaseAttached && this.#options.cameraModel === "T817L" && this.#options.channel === 0
        ? { transaction: `${Date.now()}` } : {}),
    });
    await delay(500);
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
    this.#recordings?.close();
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
    if (this.#pendingControlQuery) {
      clearTimeout(this.#pendingControlQuery.timer);
      this.#pendingControlQuery.reject(new Error("Camera control session closed before query response"));
      this.#pendingControlQuery = null;
    }
    if (this.#pendingCameraInfo) {
      clearTimeout(this.#pendingCameraInfo.timer);
      this.#pendingCameraInfo.reject(new Error("Camera-info session closed before readback"));
      this.#pendingCameraInfo = null;
    }
    this.#videoAssembler.reset();
    this.#datagramOrder.close();
    this.#pendingByType.clear();
    this.#updatePendingBytes();
    if (this.#options.purpose !== "control" && this.#options.homeBaseAttached) {
      this.#stopAttachedMedia();
    }
    if (this.#remote) this.#send(REQ.end, Buffer.alloc(0), this.#remote);
    if (this.#lookupSockets) this.#lookupSockets.close();
    else this.#socket.close();
    this.output.end();
    this.audioOutput.end();
  }

  /** Send LAN lookup to broadcast and known private targets, then query cloud rendezvous peers. */
  #lookup(): void {
    if (this.#remote) return;
    const local = Buffer.from([0, 0]);
    for (const address of ppcsLocalLookupTargets(this.#options.localAddress)) {
      this.#send(REQ.localLookup, local, address);
    }
    for (const socket of this.#lookupSockets?.sockets ?? [this.#socket]) {
      const lookup = buildPpcsCloudLookup(
        this.#options.p2pDid,
        this.#options.dskKey,
        this.#selfAddress ? { host: this.#selfAddress.host, port: socket.address().port } : undefined,
      );
      for (const address of decodeCloudAddresses(this.#options.appConnection)) {
        this.#send(lookup.type, lookup.payload, address, socket);
      }
    }
  }

  /** Probe the base and adjacent ports on one lookup candidate for CAM_ID. */
  #checkCandidate(address: { host: string; port: number }, socket: Socket): void {
    for (const port of ppcsCandidatePorts(address.port)) this.#check({ host: address.host, port }, socket);
  }

  /**
   * Route one outer PPCS UDP response and acknowledge accepted data packets.
   *
   * Returns `true` only for the first camera identity response. `start` uses
   * that signal to resolve peer discovery, while media and control frames keep
   * flowing through this same socket listener for the rest of the session.
   */
  #handle(message: Buffer, info: RemoteInfo, socket: Socket): boolean {
    if (this.#closed || (this.#remote && socket !== this.#socket)) return false;
    if (has(message, RESP.localLookup)) {
      this.stats.localLookupCandidates++;
      const source = { host: info.address, port: info.port };
      this.#checkCandidate(source, socket);
      const advertised = ppcsLookupCandidate(message);
      if (
        advertised
        && advertised.host !== "0.0.0.0"
        && (advertised.host !== source.host || advertised.port !== source.port)
      ) this.#checkCandidate(advertised, socket);
      return false;
    }
    const candidate = ppcsLookupCandidate(message);
    if (candidate) {
      if (has(message, RESP.lookupAddr2)) this.stats.alternateLookupCandidates++;
      else this.stats.directLookupCandidates++;
      if (candidate.host !== "0.0.0.0") this.#checkCandidate(candidate, socket);
      return false;
    }
    if (isPpcsCameraIdentity(message)) {
      if (this.#remote) return false;
      if (this.#lookupSockets && !this.#lookupSockets.adopt(socket)) return false;
      this.#socket = socket;
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
      if (type.equals(DATA.video) || type.equals(DATA.data) || dataType === 2 ||
        (dataType === 3 && this.#recordings?.downloading)) this.#datagramOrder.push(message.subarray(8), seq, dataType);
    }
    return false;
  }

  /**
   * Reassemble the XZYH command byte stream carried by one PPCS data type.
   *
   * UDP datagrams may split a command header, split its declared payload, or
   * contain several commands. Partial state is keyed by data type because Eufy
   * interleaves independently sequenced command and video streams. A sequence
   * gap that cannot be recovered discards only that type's partial command. Keeping it would join bytes
   * from opposite sides of a missing datagram and produce a plausible but
   * corrupt frame.
   *
   * When unexpected bytes precede a complete XZYH marker, the parser makes one
   * recovery attempt within the current datagram. A second blockage is kept as
   * a diagnostic instead of repeatedly scanning arbitrary media bytes.
   */
  #consumeData(data: Buffer, type: number): void {
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
    if (this.#recordings?.handleFrame(header, payload, type)) return;
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

    if (command === 1351 && this.#options.homeBaseAttached && this.#options.onSensorContact) {
      let clear: Buffer | undefined;
      if (signCode === 0) clear = payload;
      else if ((signCode === 2 || signCode === 8) && this.#level2Key) {
        clear = decryptLevel2(payload, this.#level2Key, signCode);
      } else if (signCode === 1 && payload.length > 0 && payload.length % 16 === 0) {
        try { clear = decryptEcb(payload, commandKey(this.#options.stationSerial, this.#options.p2pDid)); } catch { clear = undefined; }
      }
      if (clear) {
        for (const observation of decodeSensorContactNotification(clear)) this.#options.onSensorContact(observation);
      }
    }

    if (command === 1351 && this.#pendingControlQuery) {
      const decoded = decodePpcsControlRecord(payload, signCode,
        commandKey(this.#options.stationSerial, this.#options.p2pDid), this.#level2Key);
      const responsePayload = decoded && decoded.cmd === this.#pendingControlQuery.command
        ? jsonRecord(decoded.payload)
        : undefined;
      if (responsePayload) {
        const pending = this.#pendingControlQuery;
        this.#pendingControlQuery = null;
        clearTimeout(pending.timer);
        pending.resolve(responsePayload);
        return;
      }
    }

    // 1100 carries the encrypted HomeBase gateway details. 1300 carries
    // media frames after the level-2 request has been accepted.
    if (command === 1100 && signCode === 1) { this.stats.gatewayInfo++; void this.#handleGatewayInfo(payload); }
    else if (command === 1103) this.#inspectCameraInfo(payload, signCode);
    else if (command === 1300 && (!this.#options.homeBaseAttached || acceptsAttachedCameraMedia(command, frameChannel ?? -1, this.#options.channel))) {
      this.stats.videoFrames++;
      if (this.#writeVideo(payload, signCode)) {
        const decoderReady = hasDecoderReadyKeyframe(this.stats.videoCodec, this.stats.videoNalTypes);
        this.#lastDeliveredMediaFrameAt = Date.now();
        if ((!this.#options.homeBaseAttached || decoderReady) && this.#firstFrameTimer) {
          clearTimeout(this.#firstFrameTimer);
          this.#firstFrameTimer = null;
        }
      }
    } else if (command === 1301 && signCode === 0
      && acceptsSoloCamAudio(this.#options.cameraModel, this.#options.homeBaseAttached === true, this.#options.channel,
        frameChannel ?? -1, this.#options.purpose)) {
      const audio = decodePpcsAac(payload);

      // Discard audio without consumers instead of retaining an unbounded stream.
      if (audio && this.audioOutput.listenerCount("data") > 0) this.audioOutput.write(audio);
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
   * Inspect command 1103 for reusable capability and battery-history evidence.
   *
   * The payload may use level-one or negotiated level-two protection. Once
   * decoded, only parameter identifiers, the bounded guard-mode enum, and the
   * schema of parameter 3100 are recorded. Other values never enter diagnostics.
   */
  #inspectCameraInfo(payload: Buffer, signCode: number): void {
    this.stats.cameraInfoFrames++;
    this.stats.cameraInfoSign = signCode;
    this.stats.cameraInfoDecoded = false;
    this.stats.cameraInfoJsonOffset = -1;
    let clear = payload;
    if (signCode === 2 || signCode === 8) {
      if (!this.#level2Key) return;
      const authenticated = decryptLevel2(payload, this.#level2Key, signCode);
      if (!authenticated) return;
      clear = authenticated;
    } else if (signCode === 1 && payload.length > 0 && payload.length % 16 === 0) {
      try { clear = decryptEcb(payload, commandKey(this.#options.stationSerial, this.#options.p2pDid)); } catch { return; }
    } else if (signCode !== 0) return;
    this.stats.cameraInfoDecoded = signCode === 0 || clear !== payload;
    this.stats.cameraInfoJsonOffset = clear.indexOf(0x7b);
    const text = cameraInfoDocumentText(clear);
    this.stats.cameraInfoParseStage = "invalid_json";
    if (!text.startsWith("{")) return;
    try {
      const decoded: unknown = JSON.parse(text);
      this.stats.cameraInfoParseStage = "invalid_schema";
      if (!isRecord(decoded) || !Array.isArray(decoded.params)) return;
      this.stats.cameraInfoParseStage = "parsed";
      const params = decoded.params.flatMap((candidate): PpcsCameraInfoParam[] => (
        isRecord(candidate)
        && Number.isSafeInteger(candidate.param_type)
        && (typeof candidate.param_value === "string"
          || typeof candidate.param_value === "number"
          || typeof candidate.param_value === "boolean")
          ? [{
            param_type: candidate.param_type as number,
            param_value: candidate.param_value as string | number | boolean,
          }]
          : []
      ));
      this.stats.cameraInfoParamTypes = [...new Set(params.map(({ param_type }) => param_type))]
        .sort((left, right) => left - right)
        .slice(0, 256);
      const guardMode = params.find(({ param_type }) => param_type === 1224);
      if (guardMode) {
        const parsed = Number(guardMode.param_value);
        if ([0, 1, 2, 3, 4, 5, 6, 47, 63].includes(parsed)) {
          this.stats.standaloneGuardMode = parsed;
        }
      }
      if (this.#pendingCameraInfo) {
        const pending = this.#pendingCameraInfo;
        this.#pendingCameraInfo = null;
        clearTimeout(pending.timer);
        pending.resolve(params);
      }
      const entry = decoded.params.find((candidate) => isRecord(candidate) && candidate.param_type === 3100);
      if (!isRecord(entry) || typeof entry.param_value !== "string") return;
      this.stats.batteryHistory = batteryHistoryProbeSummary(entry.param_value);
    } catch {
      return;
    }
  }

  /**
   * Serialize gateway-info handling while an ECC key is being found.
   *
   * A peer may retransmit command 1100. Sharing the active promise prevents
   * duplicate asynchronous key resolution and competing media starts.
   */
  async #handleGatewayInfo(payload: Buffer): Promise<void> {
    if (this.#gatewayPromise) return this.#gatewayPromise;
    if (this.#level2Key || !this.#options.resolveCipherKey || payload.length < 133) return;
    this.#gatewayPromise = this.#deriveLevel2(payload);
    try { await this.#gatewayPromise; } finally { this.#gatewayPromise = null; }
  }

  /**
   * Derive the peer's level-two control key from command 1100.
   *
   * The outer envelope uses the deterministic level-one command key. Its
   * cipher identifier selects an ECC private key supplied by the provider,
   * which unwraps the per-session AES key. Attached-camera media startup waits
   * for this chain because its lifecycle commands require level two. A
   * standalone media session starts with its level-one fallback, then reissues
   * START_LIVE at level two as soon as the negotiated key becomes available.
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
    if (this.#options.purpose !== "control") {
      if (this.#options.homeBaseAttached) this.#startAttachedMedia();
      else this.#startOwnMedia();
    }
  }

  /** Wait for in-progress gateway negotiation before a level-two control write. */
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

  /** Send one correlated JSON control query over the negotiated camera route. */
  async #queryControlPayload(
    command: number,
    data: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    if (this.#options.purpose !== "control" && !this.#allowsViewerPanControl(command)) throw new Error("Camera query requires a control session");
    if (!this.#remote) throw new Error("Camera control session is not connected");
    if (this.#pendingControlQuery || this.#pendingControl) {
      throw new Error("Camera already has a control operation in flight");
    }
    if (this.#options.homeBaseAttached || this.#usesSoloCamPanControl()
      || (this.#options.cameraModel === "T817L" && this.#options.channel === 0)) await this.#waitForLevel2Key();
    let pendingQuery: PendingControlQuery | undefined;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingControlQuery = null;
        reject(new Error(`Camera control query ${command} timed out`));
      }, CONTROL_TIMEOUT_MILLISECONDS);
      pendingQuery = { command, resolve, reject, timer };
      this.#pendingControlQuery = pendingQuery;
    });

    // A peer can reject or close while the asynchronous send is still draining.
    // Observe that early rejection now and propagate it through the awaited response.
    void response.catch(() => undefined);
    try {
      await this.#sendControlPayload(command, data);
    } catch (error) {
      this.#pendingControlQuery = null;
      if (pendingQuery) {
        clearTimeout(pendingQuery.timer);
        pendingQuery.reject(error instanceof Error ? error : new Error("Camera control query send failed"));
      }
      await response.catch(() => undefined);
      throw error;
    }
    return response;
  }

  /** Preserve provider-validated viewer ownership only for the model's admitted commands. */
  #allowsViewerPanControl(command?: number): boolean {
    return supportsViewerPanControl(this.#options.cameraModel, Boolean(this.#options.homeBaseAttached), this.#options.channel, command);
  }

  /** Reject untested SoloCam topologies before selecting its native pan-control framing. */
  #usesSoloCamPanControl(): boolean {
    if (this.#options.cameraModel !== "T8171") return false;
    if (this.#options.homeBaseAttached && this.#options.channel === 1) return false;
    if (this.#options.homeBaseAttached || this.#options.channel !== 0) {
      throw new Error("SoloCam pan control requires its verified standalone channel-zero route");
    }
    return true;
  }

  /** Establish decoded video on the owned connection before pan travel. */
  async #preparePanMotorView(): Promise<void> {
    if (!this.#remote || this.#closed) {
      throw new Error("Camera preset wake requires a connected session");
    }
    await this.#waitForLevel2Key();
    if (this.#options.purpose !== "control") {
      if (this.stats.videoOutputFrames === 0) throw new Error("Camera viewer has not confirmed a live camera wake");
      return;
    }
    this.output.resume();
    if (this.#options.homeBaseAttached) this.#startAttachedMedia();
    else this.#startOwnMedia();
    const deadline = Date.now() + CONTROL_TIMEOUT_MILLISECONDS;
    while (!this.#closed && this.stats.videoOutputFrames === 0 && Date.now() < deadline) {
      await delay(50);
    }
    if (this.#closed || this.stats.videoOutputFrames === 0) {
      throw new Error("Camera preset movement could not confirm a live camera wake");
    }
  }

  /** Send one JSON control payload after the model's negotiated camera route is ready. */
  async #sendControlPayload(
    command: number,
    data: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (this.#options.purpose !== "control" && !this.#allowsViewerPanControl(command)) throw new Error("Camera control requires a control session");
    if (!this.#remote) throw new Error("Camera control session is not connected");
    const soloCam = this.#usesSoloCamPanControl();
    const standaloneC31Control = this.#options.cameraModel === "T817L"
      && !this.#options.homeBaseAttached && this.#options.channel === 0 && [6016, 6031, 1400].includes(command);
    if (this.#options.homeBaseAttached || soloCam || standaloneC31Control) await this.#waitForLevel2Key();
    if (standaloneC31Control) {
      if (data.value !== 0 && data.value !== 1) throw new Error("C31 control requires an absolute boolean value");
      for (let transmission = 0; transmission < 3; transmission += 1) {
        this.#sendCommand(1700, buildStandaloneC31ControlPayload(
          command as 6016 | 6031 | 1400, data.value === 1,
          this.#level2Key!, this.#level2Seq++, Number(data.transaction),
        ));
        await delay(200);
      }
      return;
    }
    if (soloCam) {

      // Native absolute writes tolerate retransmission. Drain the last packet
      // before the owning control session closes, as with the verified motion switch.
      for (let transmission = 0; transmission < 3; transmission += 1) {
        this.#sendCommand(1700, buildSoloCamPanControlPayload(
          command as 6034 | 6035 | 6016,
          typeof data.value === "number" ? data.value : undefined,
          this.#level2Key!, this.#level2Seq++, Number(data.transaction),
        ));
        await delay(200);
      }
      return;
    }
    const value = buildCameraControlQueryValue(command, data);
    if (this.#options.cameraModel === "T8171" && this.#options.homeBaseAttached && this.#options.channel === 1) {

      // Native attached SoloCam envelopes carry the rounded cleartext size in byte 11.
      const roundedLength = (Math.ceil(Buffer.byteLength(value) / 4) * 4) & 0xff;
      for (let transmission = 0; transmission < 3; transmission += 1) {
        this.#sendCommand(1700, rawPayload(encryptLevel2(Buffer.from(value), this.#level2Key!, this.#level2Seq++), this.#options.channel, 8, [8, roundedLength], 0));
        await delay(200);
      }
      return;
    }
    if (this.#options.homeBaseAttached) {
      const sequence = this.#level2Seq++;
      const encrypted = encryptLevel2(Buffer.from(value), this.#level2Key!, sequence);
      const header = commandHeader(this.#seq++, 1700);
      this.#send(
        REQ.data,
        Buffer.concat([header, rawPayload(encrypted, this.#options.channel, 8, [8, 0], 0)]),
        this.#remote,
      );
    } else {
      this.#sendCommand(1700, buildStandaloneJsonControlPayload(
        value,
        this.#options.channel,
        commandKey(this.#options.stationSerial, this.#options.p2pDid),
      ));
    }
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

  /** Send START_LIVE using the strongest protection negotiated with a standalone peer. */
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
    if (this.#level2Key) {
      if (!this.stats.mediaStartProtocols.includes("level2")) this.stats.mediaStartProtocols.push("level2");
      this.#sendCommand(1700, buildStandaloneLevel2LiveStartPayload(
        value,
        this.#options.channel,
        this.#level2Key,
        this.#level2Seq++,
      ));
      return;
    }
    if (!this.stats.mediaStartProtocols.includes("level1")) this.stats.mediaStartProtocols.push("level1");
    this.#sendCommand(1700, buildStandaloneLiveStartPayload(
      value,
      this.#options.channel,
      commandKey(this.#options.stationSerial, this.#options.p2pDid),
    ));
  }

  /** Ask one candidate endpoint to prove it owns the requested camera DID. */
  #check(address: { host: string; port: number }, socket: Socket): void {
    this.#send(REQ.check, Buffer.concat([encodeDid(this.#options.p2pDid), Buffer.alloc(3)]), address, socket);
  }

  /** Wrap and send one inner XZYH command over the established data channel. */
  #sendCommand(command: number, payload: Buffer): void {
    if (!this.#remote) return;
    const header = Buffer.concat([DATA.data, u16(this.#seq++), MAGIC, u16le(command)]);
    this.#send(REQ.data, Buffer.concat([header, payload]), this.#remote);
  }

  /** Add the outer PPCS type and length header, then write one UDP datagram. */
  #send(type: Buffer, payload: Buffer, address: { host: string; port: number }, socket: Socket = this.#socket): void {
    socket.send(Buffer.concat([type, u16(payload.length), payload]), address.port, address.host);
  }
}

/** Translate a PPCS access-unit stream marker into the domain codec name. */
function ppcsVideoCodec(streamType: number): VideoCodec | null {
  if (streamType === 1) return "h264";
  if (streamType === 2) return "h265";
  return null;
}

/**
 * Read a camera-info JSON document up to its protocol NUL terminator.
 * Legacy encrypted frames may contain unspecified padding after that boundary.
 * Callers must validate protection before invoking this text-only helper.
 */
export function cameraInfoDocumentText(clear: Buffer): string {
  const end = clear.indexOf(0);
  return clear.subarray(0, end < 0 ? clear.length : end).toString("utf8").trim();
}

/**
 * Build the SDK station-wide integer camera-info query for direct C31 sessions.
 * The 32-byte negotiated key does not meet the SDK's legacy 16-byte integer
 * encryption condition, so the read-only request carries a clear integer 255.
 * Response protection is negotiated independently and must still be verified.
 */
export function buildC31CameraInfoQueryPayload(): Buffer {
  const value = Buffer.alloc(4);
  value.writeUInt32LE(255);
  return rawPayload(value, 255, 0, [1, 0], 0);
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

/** Build the wrapped standalone-camera security-mode command value. */
export function buildStandaloneGuardModeValue(
  accountId: string,
  userName: string,
  mode: number,
): string {
  if (!accountId || !userName) throw new Error("Standalone guard mode requires account identity");
  if (![0, 1, 63].includes(mode)) throw new Error("Unsupported standalone camera guard mode");
  return JSON.stringify({
    account_id: accountId,
    cmd: 1224,
    mChannel: 0,
    mValue3: 0,
    payload: { mode_type: mode, user_name: userName },
  });
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

/** Build the command-1400 body used by direct SoloCam spotlight controls. */
export function buildStandaloneCameraLightBody(
  channel: number,
  enabled: boolean,
  accountId: string,
  key: Buffer,
): Buffer {
  if (!accountId) throw new Error("Camera light control requires a non-empty account identity");
  if (!Number.isSafeInteger(channel) || channel < 0 || channel > 255) {
    throw new Error("Camera light control requires a valid camera channel");
  }
  if (key.length !== 16) throw new Error("Camera light control requires a 16-byte command key");
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
 * Build SET_PAYLOAD JSON for the model-approved night-vision value.
 *
 * The outer control channel and nested camera channel also serve direct channel
 * zero. T8171 alone uses value 3 for forced infrared; the session enforces that
 * model restriction. `night_sion` retains Eufy's observed field spelling.
 */
export function buildNightVisionBody(channel: number, mode: number, accountId: string): Buffer {
  if (!accountId) throw new Error("Night vision control requires a non-empty account identity");
  if (!Number.isSafeInteger(channel) || channel < 0 || channel > 255) throw new Error("Night vision control requires a valid camera channel");
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 3) throw new Error("Night vision mode must be an integer from 0 through 3");
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
 * Encrypt a negotiated level-two command with AES-256-GCM.
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

/** Parse one bounded integer carried as either a JSON number or numeric text. */
function integerValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Interpret the camera's observed boolean flag forms without truthy coercion. */
function booleanFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

/**
 * Allow model-specific controls to share a provider-owned decoded viewer.
 * The provider separately validates device type, account ownership and decoded video.
 * C31 viewers admit saved-position queries, movement and schedule-backed cruise actions.
 * Tracking and unrelated writes require separate validation.
 */
export function supportsViewerPanControl(model: string | undefined, attached: boolean, channel: number, command?: number): boolean {
  return (model === "T8171" && channel === (attached ? 1 : 0))
    || (model === "T817L" && !attached && channel === 0 && (command === 6034 || command === 6035 || command === 6031));
}

/**
 * Decode a control notification using its declared protection before parsing JSON.
 *
 * Both observed level-two signatures require authenticated decryption. Missing
 * keys, unknown signatures and authentication failures never fall back to
 * treating ciphertext as a clear or level-one reply.
 */
export function decodePpcsControlRecord(
  payload: Buffer,
  signCode: number,
  level1Key: Buffer,
  level2Key: Buffer | null,
): Record<string, unknown> | undefined {
  let clear: Buffer | undefined;
  if (signCode === 0) clear = payload;
  else if (signCode === 2 || signCode === 8) {
    if (level2Key) clear = decryptLevel2(payload, level2Key, signCode);
  } else if (signCode === 1 && payload.length > 0 && payload.length % 16 === 0) {
    try { clear = decryptEcb(payload, level1Key); } catch { return undefined; }
  }
  return clear ? parsePpcsControlRecord(clear) : undefined;
}

/** Parse one decrypted control reply, accepting only complete JSON with validated NUL or PKCS7 padding. */
export function parsePpcsControlRecord(value: Buffer): Record<string, unknown> | undefined {
  let end = value.length;
  while (end > 0 && value[end - 1] === 0) end--;
  const padding = value[end - 1] ?? 0;
  if (padding > 0 && padding <= 16 && padding <= end && value.subarray(end - padding, end).every((byte) => byte === padding)) end -= padding;
  const text = value.subarray(0, end).toString("utf8").trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const decoded: unknown = JSON.parse(text);
    return isRecord(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Accept a reply payload that is already an object or contains JSON text. */
function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trimStart().startsWith("{")) return undefined;
  try {
    const decoded: unknown = JSON.parse(value);
    return isRecord(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
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
