/**
 * Reads the opening frames of one HomeBase 2 event recording.
 *
 * Eufy's push picture for some HomeBase 2 cameras is a small AI close-up. The
 * full scene exists only in the clip the HomeBase stores on its SD card. This
 * reader requests that clip with the legacy download command, keeps video from
 * the first keyframe onwards and stops the transfer once one picture can be
 * decoded. The owning session supplies the request, cancel and key callbacks;
 * paths, keys and media never leave this module except as Annex-B video.
 */
import { createPrivateKey, type KeyObject } from "node:crypto";
import type { VideoCodec } from "../domain/types.js";
import { decodePpcsVideoFrame, PpcsVideoStreamNormalizer } from "./first-party-ppcs.js";

/** Legacy download command and its station-side completion marker. */
export const HOMEBASE2_DOWNLOAD_COMMAND = 1024;
export const HOMEBASE2_DOWNLOAD_CANCEL_COMMAND = 1051;
export const HOMEBASE2_DOWNLOAD_FINISH_COMMAND = 1304;

const SD_CAMERA_PREFIX = "/media/mmcblk0p1/Camera";
const FRAME_TARGET = 8;
const BYTE_LIMIT = 8 * 1024 * 1024;
const TIMEOUT_MILLISECONDS = 25_000;

/** Session-owned callbacks for one HomeBase 2 child channel. */
export interface HomeBase2EventFrameTransport {
  readonly channel: number;

  /** Send the download request for one validated recording path. */
  request(path: string): void;

  /** Ask the station to stop sending the current recording. */
  cancel(): void;

  /** Unwrap the per-frame AES key carried by signed legacy video frames. */
  unwrapKey(wrapped: Buffer): Buffer | undefined;

  /** Decrypt a command result using the protection selected by its sign code. */
  decodeReply(payload: Buffer, sign: number): Buffer | null;
}

/** Annex-B video that starts at a keyframe and decodes to at least one picture. */
export interface RecordedEventFrames {
  readonly video: Buffer;
  readonly codec: VideoCodec;
  readonly frames: number;
}

interface Transfer {
  resolve(value: RecordedEventFrames): void;
  reject(error: Error): void;
  readonly chunks: Buffer[];
  readonly normalizer: PpcsVideoStreamNormalizer;
  codec: VideoCodec | null;
  frames: number;
  bytes: number;
  settled: boolean;
}

/** Check the HomeBase 2 SD-card clip layout without permitting traversal. */
export function isHomeBase2RecordingPath(path: string): boolean {
  return /^\/media\/mmcblk0p1\/Camera\d{2}\/[A-Za-z0-9_-]{1,64}\.dat$/.test(path);
}

/**
 * Resolve the recording path carried by a HomeBase 2 camera push.
 *
 * Older pushes carry only the clip name and the camera channel, while others
 * carry the absolute path. Anything outside the SD-card camera folders is
 * rejected so a push can never select an arbitrary station file.
 */
export function homeBase2RecordingPath(filePath: string | null, channel: number | null): string | null {
  if (!filePath) return null;
  if (filePath.startsWith("/")) return isHomeBase2RecordingPath(filePath) ? filePath : null;
  if (channel === null || !Number.isInteger(channel) || channel < 0 || channel > 99) return null;
  const name = filePath.endsWith(".dat") ? filePath.slice(0, -4) : filePath;
  const path = `${SD_CAMERA_PREFIX}${String(channel).padStart(2, "0")}/${name}.dat`;
  return isHomeBase2RecordingPath(path) ? path : null;
}

/**
 * Import the station cipher's RSA key as returned by Eufy's cipher lookup.
 *
 * The cloud returns base64 DER with or without PEM armour, in PKCS#8 or
 * PKCS#1 form. Anything else is refused rather than guessed.
 */
export function parseCipherRsaKey(value: unknown): KeyObject | null {
  if (typeof value !== "string" || value.length > 16_384) return null;
  const body = value.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  const der = Buffer.from(body, "base64");
  for (const type of ["pkcs8", "pkcs1"] as const) {
    try {
      const key = createPrivateKey({ key: der, format: "der", type });
      if (key.asymmetricKeyType === "rsa") return key;
    } catch {

      // Try the other envelope before refusing the value.
    }
  }
  return null;
}

/**
 * Build the fixed-width string command value used by HomeBase 2 downloads.
 *
 * The value is five reserved bytes, the clip path and the station admin
 * account, each zero-padded to 128 bytes. The caller applies level-one
 * encryption and the inner command envelope.
 */
export function buildHomeBase2DownloadValue(path: string, accountId: string): Buffer {
  if (!isHomeBase2RecordingPath(path)) throw new Error("Invalid HomeBase 2 recording path");
  if (!accountId || Buffer.byteLength(accountId) > 128) throw new Error("HomeBase 2 download requires the station account");
  const value = Buffer.alloc(5 + 128 + 128);
  Buffer.from(path).copy(value, 5);
  Buffer.from(accountId).copy(value, 5 + 128);
  return value;
}

/** Own one bounded recording request until it yields a picture, fails or closes. */
export class HomeBase2EventFrameReader {
  #transfer: Transfer | null = null;
  #closed = false;

  /** Borrow a provider-validated HomeBase 2 child route. */
  constructor(private readonly transport: HomeBase2EventFrameTransport) {}

  /** Whether binary recording data should currently reach this reader. */
  get downloading(): boolean { return this.#transfer !== null; }

  /** Request one clip and return its opening Annex-B video from the first keyframe. */
  async firstFrames(path: string, signal?: AbortSignal): Promise<RecordedEventFrames> {
    if (this.#closed || signal?.aborted) throw new Error("HomeBase 2 recording operation was cancelled");
    if (this.#transfer) throw new Error("HomeBase 2 recording operation is already active");
    if (!isHomeBase2RecordingPath(path)) throw new Error("Invalid HomeBase 2 recording path");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let transfer!: Transfer;
    const abort = (): void => this.#settle(transfer, new Error("HomeBase 2 recording operation was cancelled"));
    try {
      return await new Promise<RecordedEventFrames>((resolve, reject) => {
        transfer = {
          resolve, reject, chunks: [], normalizer: new PpcsVideoStreamNormalizer(),
          codec: null, frames: 0, bytes: 0, settled: false,
        };
        this.#transfer = transfer;
        timer = setTimeout(() => this.#settle(transfer, new Error("HomeBase 2 recording operation timed out")), TIMEOUT_MILLISECONDS);
        signal?.addEventListener("abort", abort, { once: true });
        this.transport.request(path);
      });
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (this.#transfer === transfer) this.#transfer = null;
      transfer.chunks.length = 0;

      // The station keeps streaming the remaining clip unless told to stop.
      this.transport.cancel();
    }
  }

  /** Consume this transfer's video, completion marker and download result. */
  handleFrame(header: Buffer, payload: Buffer, type: number): boolean {
    const transfer = this.#transfer;
    if (!transfer || transfer.settled) return false;
    const command = header.readUInt16LE(4), channel = header[12], sign = header[13] ?? 0;
    if (command === HOMEBASE2_DOWNLOAD_COMMAND && header[14] === 1) {
      const clear = this.transport.decodeReply(payload, sign);
      const result = clear && clear.length >= 4 ? clear.readInt32LE(0) : null;
      if (result !== null && result !== 0) this.#settle(transfer, new Error(`HomeBase 2 rejected the recording request (${result})`));
      return true;
    }
    if (command === HOMEBASE2_DOWNLOAD_FINISH_COMMAND && (channel === this.transport.channel || channel === 255)) {
      this.#settle(transfer, transfer.frames > 0 ? null : new Error("HomeBase 2 recording ended before a keyframe"));
      return true;
    }
    if (type !== 3 || channel !== this.transport.channel) return false;
    if (command === 1301) return true;
    if (command !== 1300) return false;
    if (payload.length < 22) {
      this.#settle(transfer, new Error("HomeBase 2 recording media framing was unsupported"));
      return true;
    }
    const keyframe = payload[4] === 1;
    const codec: VideoCodec | null = payload[5] === 1 ? "h264" : payload[5] === 2 ? "h265" : null;
    if (!transfer.codec) {

      // Clips begin with a keyframe, but a resumed transfer may not. Anything
      // before the first keyframe cannot be decoded on its own.
      if (!keyframe || !codec) return true;
      transfer.codec = codec;
    }
    const decoded = decodePpcsVideoFrame(payload, sign, (wrapped) => this.transport.unwrapKey(wrapped));
    if (!decoded) {
      this.#settle(transfer, new Error("HomeBase 2 recording video could not be decrypted"));
      return true;
    }
    const normalized = transfer.normalizer.push(decoded, transfer.codec);
    transfer.bytes += normalized.length;
    if (transfer.bytes > BYTE_LIMIT) {
      this.#settle(transfer, new Error("HomeBase 2 recording exceeded its limit"));
      return true;
    }
    if (normalized.length) {
      transfer.chunks.push(normalized);
      transfer.frames++;
    }
    if (transfer.frames >= FRAME_TARGET) this.#settle(transfer, null);
    return true;
  }

  /** Reject pending work when the owning session closes. */
  close(): void {
    this.#closed = true;
    if (this.#transfer) this.#settle(this.#transfer, new Error("HomeBase 2 recording session closed"));
  }

  #settle(transfer: Transfer, error: Error | null): void {
    if (transfer.settled) return;
    transfer.settled = true;
    if (error) transfer.reject(error);
    else transfer.resolve({ video: Buffer.concat(transfer.chunks), codec: transfer.codec!, frames: transfer.frames });
  }
}
