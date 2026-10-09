/**
 * Reads standalone SoloCam event recordings inside an authenticated PPCS session.
 * The session owns transport and command encryption. This reader owns correlated
 * history replies, bounded downloads and recorded-media decryption. Only the
 * provider may retain its private storage paths; HTTP consumers receive opaque IDs.
 */
import { spawn } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageKey } from "../mega/image.js";
import { decodePpcsAac } from "./ppcs-audio.js";
import { remuxVideoToMp4 } from "./live-stream-manager.js";

const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;

/** Metadata owned by the provider, including a camera-validated private path. */
export interface CameraStoredRecord {
  readonly storagePath: string;
  readonly startTime: string;
  readonly endTime: string | null;
}

/** Public recording metadata with no camera filesystem or account information. */
export interface StoredRecordingSummary {
  readonly id: string;
  readonly startTime: string;
  readonly endTime: string | null;
}

/** Session-owned callbacks; neither key material nor transport is exposed to API callers. */
export interface StoredRecordingTransport {
  readonly serial: string;
  readonly p2pDid: string;
  query(transaction: string, date: string): void;
  download(storagePath: string): void;
  decodeReply(payload: Buffer, sign: number): Buffer | null;
}

interface PendingRead<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

interface DownloadRead extends PendingRead<void> {
  readonly video: StoredVideoFrame[];
  readonly audio: Buffer[];
  bytes: number;
  timestamp: string | null;
  finished: boolean;
}

/** One bounded stored access unit and its independently supplied outer protection flag. */
export interface StoredVideoFrame {
  readonly frame: Buffer;
  readonly sign: number;
}

/** Validate one calendar day before a caller can wake a camera or query its card. */
export function validateRecordingDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new SyntaxError("Invalid recording date");
  }
}

/** Project only completed, local event files belonging to the requested SoloCam. */
export function parseStoredRecordings(value: unknown, serial: string): readonly CameraStoredRecord[] {
  if (!object(value) || value.mIntRet !== 0 || !Array.isArray(value.data)) {
    throw new Error("Camera recording history was not accepted");
  }
  const table = value.data.find((item: unknown) => object(item) && item.table_name === "history_record_info");
  if (!object(table) || !Array.isArray(table.payload) || table.payload.length > 100) {
    throw new Error("Camera recording history has an invalid table");
  }
  const records: CameraStoredRecord[] = [];
  for (const row of table.payload) {
    if (!object(row) || row.device_sn !== serial || row.device_type !== 88) {
      throw new Error("Camera recording history has unexpected ownership");
    }
    if (row.storage_type !== 1 || row.storage_cloud !== 0 || row.write_status !== 1) continue;
    if (typeof row.storage_path !== "string" ||
      !/^\/media\/mmcblk0p1\/Camera00\/event\/\d{6}\/\d{8}\/\d{14}\.zxvideo$/.test(row.storage_path)) continue;
    const startTime = recordTime(row.start_time, row.time_zone);
    if (!startTime) continue;
    const endTime = recordTime(row.end_time, row.time_zone);
    records.push({ storagePath: row.storage_path, startTime, endTime });
  }
  return records.sort((a, b) => b.startTime.localeCompare(a.startTime));
}

/**
 * Own one history read or saved download for the lifetime of a SoloCam session.
 * Callers serialize operations. Closing or aborting rejects pending work and
 * clears private buffers; transfer data is admitted only while this reader owns it.
 */
export class SoloCamRecordingReader {
  #query: (PendingRead<readonly CameraStoredRecord[]> & { transaction: string }) | null = null;
  #download: DownloadRead | null = null;
  #closed = false;

  /** Borrow callbacks from the owning session without creating a socket or changing settings. */
  constructor(private readonly transport: StoredRecordingTransport) {}

  /** Whether binary saved-media packets may enter the owning session's ordered parser. */
  get downloading(): boolean { return this.#download !== null; }

  /** Query at most one hundred completed local event clips on a calendar day. */
  async list(date: string, signal?: AbortSignal): Promise<readonly CameraStoredRecord[]> {
    validateRecordingDate(date);
    this.#requireIdle(signal);
    const transaction = `${Date.now()}`;
    return await this.#wait<readonly CameraStoredRecord[]>(20_000, signal, (pending) => {
      this.#query = { ...pending, transaction };
      this.transport.query(transaction, date.replaceAll("-", ""));
    }, () => { this.#query = null; });
  }

  /** Download one previously validated owned path, requiring EOF and complete media decoding. */
  async download(record: CameraStoredRecord, signal?: AbortSignal): Promise<Buffer> {
    this.#requireIdle(signal);
    if (!/^\/media\/mmcblk0p1\/Camera00\/event\/\d{6}\/\d{8}\/\d{14}\.zxvideo$/.test(record.storagePath)) {
      throw new Error("Invalid camera recording reference");
    }
    let received!: DownloadRead;
    try {
      await this.#wait<void>(40_000, signal, (pending) => {
        received = { ...pending, video: [], audio: [], bytes: 0, timestamp: null, finished: false };
        this.#download = received;
        this.transport.download(record.storagePath);
      }, () => { this.#download = null; });
      if (signal?.aborted || !received.finished || !received.timestamp || received.video.length === 0) {
        throw new Error("Camera recording download was incomplete");
      }
      const video = decodeStoredVideo(received.video, this.transport.serial, this.transport.p2pDid, received.timestamp);
      const audio = received.audio.length ? Buffer.concat(received.audio) : undefined;
      const fragmented = await remuxVideoToMp4(video, "h264", audio, signal);
      const media = await finalizeStoredMp4(fragmented, signal);
      if (media.length > MAX_DOWNLOAD_BYTES || signal?.aborted) throw new Error("Camera recording exceeded its limit");
      await validateStoredMedia(media, signal);
      return media;
    } finally {
      if (received) {
        received.video.length = 0;
        received.audio.length = 0;
        received.timestamp = null;
      }
    }
  }

  /** Consume only replies and binary media belonging to the currently owned operation. */
  handleFrame(header: Buffer, payload: Buffer, type: number): boolean {
    const command = header.readUInt16LE(4);
    if (command === 1306 && this.#query) {
      const clear = this.transport.decodeReply(payload, header[13] ?? 0);
      if (!clear || clear.length > 2 * 1024 * 1024) return true;
      const begin = clear.indexOf(0x7b), end = clear.lastIndexOf(0x7d);
      try {
        const value: unknown = JSON.parse(clear.subarray(begin, end + 1).toString("utf8"));
        if (object(value) && value.cmd === 10017 && value.table === "history_record_info" &&
          String(value.transaction) === this.#query.transaction) {
          this.#query.resolve(parseStoredRecordings(value, this.transport.serial));
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) this.#query.reject(new Error("Camera recording history was invalid"));
      }
      return true;
    }
    const transfer = this.#download;
    if (!transfer) return false;
    if (command === 1024 && type === 0) {

      // Native execution replies retain the request sign byte but carry clear result/timestamp bytes.
      const stamp = payload.subarray(4).toString("ascii").split("\0")[0]!;
      if (payload.length < 15 || payload.length > 132 || payload[14] !== 0 || payload.readInt32LE(0) !== 0 || !/^\d{10}$/.test(stamp)) {
        transfer.reject(new Error("Camera recording key timestamp was unavailable"));
      } else {
        transfer.timestamp = stamp;
        if (transfer.finished) transfer.resolve();
      }
      return true;
    }
    const channel = header[12];
    if (command === 1304 && channel === 0) {
      transfer.finished = true;
      if (transfer.timestamp) transfer.resolve();
      return true;
    }
    if (type !== 3 || channel !== 101 || ![1300, 1301].includes(command)) return false;
    transfer.bytes += payload.length;
    if (transfer.bytes > MAX_DOWNLOAD_BYTES) {
      transfer.reject(new Error("Camera recording exceeded its limit"));
      return true;
    }
    if (command === 1300) {
      if (payload.length < 22 || payload.readUInt32LE(0) !== payload.length - 22 ||
        payload[5] !== 1 || ![0, 3].includes(payload[10] ?? -1) || ![0, 1].includes(header[13] ?? 0)) {
        transfer.reject(new Error("Camera recording video framing was unsupported"));
      } else {
        transfer.video.push({ frame: Buffer.from(payload), sign: header[13] ?? 0 });
      }
    } else {
      const audio = header[13] === 0 ? decodePpcsAac(payload) : null;
      if (!audio) transfer.reject(new Error("Camera recording audio framing was unsupported"));
      else transfer.audio.push(audio);
    }
    return true;
  }

  /** Reject pending reads when the owning session closes, including on provider shutdown. */
  close(): void {
    this.#closed = true;
    const error = new Error("Camera recording session closed");
    this.#query?.reject(error);
    this.#download?.reject(error);
  }

  #requireIdle(signal?: AbortSignal): void {
    if (this.#closed || signal?.aborted) throw new Error("Camera recording operation was cancelled");
    if (this.#query || this.#download) throw new Error("Camera recording operation is already active");
  }

  async #wait<T>(milliseconds: number, signal: AbortSignal | undefined,
    start: (pending: PendingRead<T>) => void, cleanup: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Camera recording operation timed out")), milliseconds);
        abort = () => reject(new Error("Camera recording operation was cancelled"));
        signal?.addEventListener("abort", abort, { once: true });
        start({ resolve, reject });
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
      cleanup();
    }
  }
}

/** Decrypt stored codec-one access units using the timestamp returned by this download. */
export function decodeStoredVideo(frames: readonly StoredVideoFrame[], serial: string, did: string, timestamp: string): Buffer {
  if (!/^\d{10}$/.test(timestamp)) throw new Error("Invalid recording key timestamp");
  const key = Buffer.from(imageKey(serial, did, timestamp), "ascii").subarray(0, 16);
  const output: Buffer[] = [];
  for (const { frame, sign } of frames) {
    let media = frame.subarray(22);
    if (sign === 1) {
      if (media.length < 128) throw new Error("Encrypted recording frame was truncated");
      const decrypt = createDecipheriv("aes-128-ecb", key, null);
      decrypt.setAutoPadding(false);
      media = Buffer.concat([decrypt.update(media.subarray(0, 128)), decrypt.final(), media.subarray(128)]);
    }
    if (!media.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1])) &&
      !media.subarray(0, 3).equals(Buffer.from([0, 0, 1]))) throw new Error("Recording video could not be decrypted");
    output.push(media);
  }
  return Buffer.concat(output);
}

/** Decode every MP4 track before serving a recording, cancelling the verifier with its caller. */
export async function validateStoredMedia(media: Buffer, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Camera recording operation was cancelled");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-v", "error", "-xerror", "-err_detect", "explode", "-i", "pipe:0", "-map", "0", "-f", "null", "-"], { stdio: ["pipe", "ignore", "ignore"] });
    const abort = (): void => { child.kill("SIGKILL"); };
    const timer = setTimeout(abort, 30_000);
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.stdin.on("error", () => undefined);
    child.once("error", () => { cleanup(); reject(new Error("Recording media verifier was unavailable")); });
    child.once("close", (code) => { cleanup(); if (code === 0 && !signal?.aborted) resolve(); else reject(new Error("Recording media did not fully decode")); });
    child.stdin.end(media);
  });
}

/** Finalize seekable MP4 bytes in an owned temporary directory and remove that directory on every exit. */
export async function finalizeStoredMp4(fragmented: Buffer, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) throw new Error("Camera recording operation was cancelled");
  const directory = await mkdtemp(join(tmpdir(), "eufy-stored-"));
  try {
    const target = join(directory, "video.mp4");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", ["-v", "error", "-i", "pipe:0", "-map", "0", "-c", "copy",
        "-movflags", "+faststart", target], { stdio: ["pipe", "ignore", "ignore"], signal });
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.stdin.on("error", () => undefined);
      child.once("error", () => { clearTimeout(timer); reject(new Error("Recording packaging was unavailable")); });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && !signal?.aborted) resolve();
        else reject(new Error("Recording could not be finalized"));
      });
      child.stdin.end(fragmented);
    });
    if ((await stat(target)).size > MAX_DOWNLOAD_BYTES || signal?.aborted) throw new Error("Camera recording exceeded its limit");
    return await readFile(target);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Interpret the native recording timestamp with its explicit numeric timezone. */
export function recordTime(value: unknown, zone: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ||
    typeof zone !== "string" || !/^[+-](?:0\d|1[0-4])[0-5]\d$/.test(zone)) return null;
  const time = Date.parse(`${value.replace(" ", "T")}${zone.slice(0, 3)}:${zone.slice(3)}`);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
