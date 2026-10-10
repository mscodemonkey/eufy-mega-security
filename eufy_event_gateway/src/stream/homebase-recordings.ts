/**
 * Reads the tested SoloCam E30 child recordings from a HomeBase 3 session.
 * The provider owns route eligibility and opaque references. This reader owns
 * correlated station history, per-download recipient keys, bounded media and
 * cancellation. Its transport borrows the session's authenticated command path.
 */
import { createECDH } from "node:crypto";
import type { DecodedPpcsVideoFrame } from "./first-party-ppcs.js";
import { PpcsVideoStreamNormalizer } from "./first-party-ppcs.js";
import { remuxVideoToMp4 } from "./live-stream-manager.js";
import { finalizeStoredMp4, recordTime, validateRecordingDate, validateStoredMedia, type CameraStoredRecord } from "./stored-recordings.js";

const LIMIT = 32 * 1024 * 1024;

/** Recording-only decoder; closing releases its private recipient and media keys. */
export interface RecordingMediaDecoder {

  /** Authenticate signed video and retain its media key for later audio. */
  video(payload: Buffer, sign: number): DecodedPpcsVideoFrame | undefined;

  /** Authenticate the recording audio envelope with the last authenticated video key. */
  audio(payload: Buffer): Buffer | null;

  /** Forget the decoder recipient and media keys after completion or failure. */
  close(): void;
}

/** Session-owned command callbacks and immutable current child/parent ownership. */
export interface HomeBaseRecordingTransport {
  readonly serial: string;
  readonly stationSerial: string;
  readonly channel: number;

  /** Send one bounded station-channel10011 history query for the requested day. */
  query(transaction: string, date: string): void;

  /** Request only the supplied validated owned path with this download recipient public point. */
  download(path: string, publicKey: string): void;

  /** Authenticate a station reply using the session key selected by its outer protection flag. */
  decodeReply(payload: Buffer, sign: number): Buffer | null;

  /** Create a separate recording decoder around this download recipient private key. */
  decoder(privateKey: string): RecordingMediaDecoder;
}

interface Pending<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

interface Transfer extends Pending<void> {
  frames: { command: number; sign: number; payload: Buffer }[];
  bytes: number;
  eof: boolean;
}

/** Check the native event-file structure without permitting traversal or arbitrary remote files. */
export function isHomeBaseRecordingPath(path: string): boolean {
  const match = /^\/[A-Za-z0-9_-]{1,32}\/[A-Za-z0-9_-]{1,32}\/Camera\d{2}\/(\d{6})\/(\d{14})\/\2\.zxvideo$/.exec(path);
  return match !== null && match[2]!.startsWith(match[1]!);
}

/** Project only completed type-88 clips owned by this child on this station. */
export function parseHomeBaseRecordings(value: unknown, serial: string, stationSerial: string): readonly CameraStoredRecord[] {
  if (!object(value) || value.mIntRet !== 0 || !Array.isArray(value.data)) throw new Error("HomeBase recording history was not accepted");
  const tables = value.data.filter((table: unknown) => object(table) && table.table_name === "history_record_info");
  if (tables.length !== 1 || !object(tables[0]) || !Array.isArray(tables[0].payload) || tables[0].payload.length > 100) {
    throw new Error("HomeBase recording history has an invalid table");
  }
  const records: CameraStoredRecord[] = [];
  for (const row of tables[0].payload) {
    if (!object(row)) throw new Error("HomeBase recording history has an invalid row");

    // Station history includes siblings. Only the requested child's rows can create references.
    if (row.device_sn !== serial) continue;
    if (row.device_type !== 88 || row.station_sn !== stationSerial) throw new Error("HomeBase recording history has unexpected ownership");
    if (row.storage_type !== 2 || row.storage_cloud !== 0 || row.write_status !== 1 ||
      typeof row.storage_path !== "string" || !isHomeBaseRecordingPath(row.storage_path)) continue;
    const startTime = recordTime(row.start_time, row.time_zone), endTime = recordTime(row.end_time, row.time_zone);
    if (!startTime || !endTime || endTime < startTime) continue;
    records.push({ storagePath: row.storage_path, startTime, endTime });
  }
  return records.sort((a, b) => b.startTime.localeCompare(a.startTime));
}

/**
 * Own one station history read or saved transfer until it completes or closes.
 * The provider serializes operations and prevents competing live sessions.
 * Keys exist only for one download. EOF and complete authenticated decoding are
 * required before the caller receives an MP4, including clips with no audio.
 */
export class HomeBaseRecordingReader {
  #query: (Pending<readonly CameraStoredRecord[]> & { transaction: string }) | null = null;
  #transfer: Transfer | null = null;
  #closed = false;
  #downloadController: AbortController | null = null;


  /** Borrow a provider-validated child route; this class never discovers or changes camera settings. */
  constructor(private readonly transport: HomeBaseRecordingTransport) {}


  /** Whether this reader currently owns binary saved-media reception. */
  get downloading(): boolean { return this.#transfer !== null; }


  /** Read the first hundred station events on a day and project only this camera's completed clips. */
  async list(date: string, signal?: AbortSignal): Promise<readonly CameraStoredRecord[]> {
    validateRecordingDate(date);
    this.#idle(signal);
    const transaction = `${Date.now()}`;
    return await this.#wait<readonly CameraStoredRecord[]>(20_000, signal, (pending) => {
      this.#query = { ...pending, transaction };
      this.transport.query(transaction, date.replaceAll("-", ""));
    }, () => { this.#query = null; });
  }


  /** Download one opaque-reference-owned clip with a new recipient key and verify every media track. */
  async download(record: CameraStoredRecord, signal?: AbortSignal): Promise<Buffer> {
    this.#idle(signal);
    if (!isHomeBaseRecordingPath(record.storagePath)) throw new Error("Invalid HomeBase recording reference");
    const recipient = createECDH("prime256v1"), publicKey = recipient.generateKeys().subarray(1).toString("hex");

    // OpenSSL can omit leading zero bytes from a valid P-256 private scalar.
    const privateKey = recipient.getPrivateKey().toString("hex").padStart(64, "0");
    const decoder = this.transport.decoder(privateKey);
    const controller = new AbortController();
    const lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.#downloadController = controller;
    let received!: Transfer;
    try {
      await this.#wait<void>(40_000, lifetime, (pending) => {
        received = { ...pending, frames: [], bytes: 0, eof: false };
        this.#transfer = received;
        this.transport.download(record.storagePath, publicKey);
      }, () => { this.#transfer = null; });
      if (!received.eof || lifetime.aborted) throw new Error("HomeBase recording download was incomplete");
      const video: Buffer[] = [], audio: Buffer[] = [];
      const normalizer = new PpcsVideoStreamNormalizer();
      let first: number | undefined, last: number | undefined, authenticated = 0;
      for (const frame of received.frames) {
        if (lifetime.aborted) throw new Error("HomeBase recording operation was cancelled");
        if (frame.command === 1300) {
          const decoded = decoder.video(frame.payload, frame.sign);
          if (!decoded || (frame.sign > 0 && decoded.protection !== "ecc-gcm")) throw new Error("HomeBase recording video authentication failed");
          const normalized = normalizer.push(decoded.data, "h264");
          if (!normalized.length) throw new Error("HomeBase recording video framing was incomplete");
          video.push(normalized);
          if (decoded.protection === "ecc-gcm") authenticated++;
          const stamp = frame.payload.readUIntLE(14, 6);
          if (last !== undefined && stamp < last) throw new Error("HomeBase recording timing was invalid");
          first ??= stamp; last = stamp;
        } else {
          const decoded = decoder.audio(frame.payload);
          if (!decoded) throw new Error("HomeBase recording audio authentication failed");
          audio.push(decoded);
        }
      }
      if (video.length < 2 || !authenticated || first === undefined || last === undefined || last <= first) throw new Error("HomeBase recording was incomplete");
      const fps = (video.length - 1) * 1000 / (last - first);
      if (fps < 1 || fps > 60) throw new Error("HomeBase recording timing was invalid");
      const fragmented = await remuxVideoToMp4(Buffer.concat(video), "h264", audio.length ? Buffer.concat(audio) : undefined, lifetime, fps);
      const media = await finalizeStoredMp4(fragmented, lifetime);
      if (media.length > LIMIT || lifetime.aborted) throw new Error("HomeBase recording exceeded its limit");
      await validateStoredMedia(media, lifetime);
      return media;
    } finally {
      decoder.close();
      this.#downloadController = null;
      if (received) received.frames.length = 0;
    }
  }


  /** Consume only correlated history or this download's child-channel, stream-25 media. */
  handleFrame(header: Buffer, payload: Buffer, type: number): boolean {
    const command = header.readUInt16LE(4), channel = header[12], sign = header[13] ?? 0;
    if (command === 1306 && this.#query && channel === 255) {
      const clear = this.transport.decodeReply(payload, sign);
      if (!clear || clear.length > 2 * 1024 * 1024) return true;
      try {
        const value: unknown = JSON.parse(clear.subarray(clear.indexOf(123), clear.lastIndexOf(125) + 1).toString("utf8"));
        if (object(value) && value.cmd === 10011 && value.table === "history_record_info" && String(value.transaction) === this.#query.transaction) {
          this.#query.resolve(parseHomeBaseRecordings(value, this.transport.serial, this.transport.stationSerial));
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) this.#query.reject(new Error("HomeBase recording history was invalid"));
      }
      return true;
    }
    const transfer = this.#transfer;
    if (!transfer) return false;
    if (command === 1304 && channel === 255 && header[14] === 0 && transfer.frames.length > 0) {
      if (sign !== 0 || (payload.length !== 0 && (payload.length !== 4 || payload.readInt32LE(0) !== 0))) transfer.reject(new Error("HomeBase recording EOF was invalid"));
      else { transfer.eof = true; transfer.resolve(); }
      return true;
    }
    if (type !== 3 || channel !== this.transport.channel || header[14] !== 25 || ![1300, 1301].includes(command)) return false;
    transfer.bytes += payload.length;
    if (transfer.bytes > LIMIT) transfer.reject(new Error("HomeBase recording exceeded its limit"));
    else if ((command === 1300 && (payload.length < (sign === 1 ? 179 : 22) || ![0, 1].includes(sign) || payload[5] !== 1 || payload.readUInt32LE(0) !== payload.length - (sign === 1 ? 179 : 22))) || (command === 1301 && (payload.length < 44 || sign !== 1))) {
      transfer.reject(new Error("HomeBase recording media framing was unsupported"));
    } else transfer.frames.push({ command, sign, payload: Buffer.from(payload) });
    return true;
  }


  /** Reject pending work on route changes, shutdown or cancellation of the owning session. */
  close(): void {
    this.#closed = true;
    this.#downloadController?.abort();
    const error = new Error("HomeBase recording session closed");
    this.#query?.reject(error); this.#transfer?.reject(error);
  }

  #idle(signal?: AbortSignal): void {
    if (this.#closed || signal?.aborted) throw new Error("HomeBase recording operation was cancelled");
    if (this.#query || this.#transfer || this.#downloadController) throw new Error("HomeBase recording operation is already active");
  }

  async #wait<T>(milliseconds: number, signal: AbortSignal | undefined, start: (pending: Pending<T>) => void, cleanup: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => pendingReject?.(new Error("HomeBase recording operation was cancelled"));
    let pendingReject: ((error: Error) => void) | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        pendingReject = reject;
        timer = setTimeout(() => reject(new Error("HomeBase recording operation timed out")), milliseconds);
        signal?.addEventListener("abort", abort, { once: true });
        start({ resolve, reject });
      });
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort); cleanup();
    }
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
