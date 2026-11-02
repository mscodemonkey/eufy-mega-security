/**
 * Checks one HomeBase recording thumbnail without publishing or retaining media.
 * The session owns peer authentication and cancellation. This reader owns the
 * history-to-file join and bounded JPEG validation. Callers select records, never
 * filesystem paths. Neither successful retrieval nor event identity establishes
 * that the thumbnail is the notification's original cloud image.
 */
import { createRecordedDecipheriv as createDecipheriv } from "../diagnostics/raw-crypto.js";
import { decode } from "jpeg-js";
import { EventNameHistoryError, eventHistoryCursor, eventHistoryId, nextEventHistoryDate } from "./homebase-event-names.js";
import { recordTime } from "./stored-recordings.js";

/** Aggregate evidence for one image, excluding its bytes, path and recording ID. */
export interface EventPictureSummary {
  readonly scope: "one_history_thumbnail";
  readonly records: number;
  readonly imageBytes: number;
  readonly width: number;
  readonly height: number;
}

/** Borrowed authenticated operations for one history page followed by one file read. */
export interface EventPictureTransport {
  readonly serial: string;
  readonly stationSerial: string;

  /** Read one page at an opaque cursor without retries or implicit pagination. */
  query(transaction: string, date: string, startId: string): void;

  /** Read only a file returned by this operation's owned history row. */
  image(file: string): void;
  decodeHistory(payload: Buffer, sign: number): Buffer | null;

  /** Authenticate the observed bootstrap-key envelope, independently of the outbound key. */
  decodeImage(payload: Buffer, sign: number): Buffer | null;
}

/**
 * Derive the observed receive key independently of the negotiated outbound key.
 * The native connection path zero-pads the first 32 account UID bytes, then
 * overwrites the beginning with the station identity's last seven ASCII bytes.
 */
export function eventPictureReceiveKey(accountId: string, stationSerial: string): Buffer {
  if (!/^[A-Za-z0-9]{1,40}$/.test(accountId) || !/^[A-Za-z0-9]{7,32}$/.test(stationSerial)) {
    throw new EventNameHistoryError("unavailable");
  }
  const key = Buffer.alloc(32);
  Buffer.from(accountId, "ascii").copy(key, 0, 0, 32);
  Buffer.from(stationSerial.slice(-7), "ascii").copy(key);
  return key;
}

/** Authenticate only the observed command-1308 sign-1 GCM envelope, with no plaintext fallback. */
export function decodeEventPictureReply(payload: Buffer, sign: number, accountId: string, stationSerial: string): Buffer | null {
  if (sign !== 1 || payload.length < 28 || payload.length > 2 * 1024 * 1024) return null;
  const key = eventPictureReceiveKey(accountId, stationSerial);
  let partial: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(16, 28));
    decipher.setAAD(Buffer.from("eufy security", "ascii"));
    decipher.setAuthTag(payload.subarray(0, 16));
    partial = decipher.update(payload.subarray(28));
    return Buffer.concat([partial, decipher.final()]);
  } catch { return null; }
  finally { key.fill(0); partial?.fill(0); }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accept the observed single JSON terminator, never arbitrary trailing bytes. */
function parse(clear: Buffer): Record<string, unknown> {
  if (clear.length > 2 * 1024 * 1024) throw new EventNameHistoryError("invalid_response");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clear).replace(/\0$/, ""));
  if (!object(value)) throw new EventNameHistoryError("invalid_response");
  return value;
}

/** Strip unexpected provider fields before returning this diagnostic over HTTP. */
export function projectEventPictureSummary(value: unknown): EventPictureSummary {
  if (!object(value) || value.scope !== "one_history_thumbnail") throw new EventNameHistoryError("invalid_response");
  const { records, imageBytes, width, height } = value;
  if (![records, imageBytes, width, height].every(v => typeof v === "number" && Number.isSafeInteger(v) && v > 0)
    || typeof records !== "number" || typeof imageBytes !== "number" || typeof width !== "number" || typeof height !== "number"
    || records > 50 || imageBytes > 1024 * 1024 || width * height > 4_000_000) throw new EventNameHistoryError("invalid_response");
  return { scope: "one_history_thumbnail", records, imageBytes, width, height };
}

/**
 * Own one manual two-stage read until completion, timeout or session closure.
 * History transaction, child, station, day and optional opaque record ID select
 * the file. Its exact echoed path correlates the later authenticated reply.
 * No retry, automatic pagination, snapshot mutation or detection callback occurs.
 */
export class EventPictureReader {
  #pending: { transaction: string; date: string; recordId: string | undefined; file?: string; records: number;
    resolve: (summary: EventPictureSummary) => void; reject: (error: EventNameHistoryError) => void } | null = null;
  #closed = false;
  #used = false;

  /** Borrow this operation's immutable child and parent binding. */
  constructor(private readonly transport: EventPictureTransport) {}

  /** Query at most fifty rows and retrieve one owned thumbnail within forty seconds. */
  async read(date: string, startId: string, recordId?: string, signal?: AbortSignal): Promise<EventPictureSummary> {
    nextEventHistoryDate(date); eventHistoryCursor(startId);
    if (recordId !== undefined) eventHistoryId(recordId);
    if (this.#closed || signal?.aborted) throw new EventNameHistoryError("cancelled");
    if (this.#pending) throw new EventNameHistoryError("busy");
    if (this.#used) throw new EventNameHistoryError("unavailable");
    this.#used = true;
    return await new Promise((resolve, reject) => {
      const finish = (error?: EventNameHistoryError, value?: EventPictureSummary): void => {
        this.#pending = null; clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value!);
      };
      const abort = (): void => finish(new EventNameHistoryError("cancelled"));
      const timer = setTimeout(() => finish(new EventNameHistoryError("timeout")), 40_000);
      const transaction = `${Date.now()}`;
      this.#pending = { transaction, date, recordId, records: 0, resolve: value => finish(undefined, value), reject: error => finish(error) };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { this.transport.query(transaction, date, startId); }
      catch { finish(new EventNameHistoryError("unavailable")); }
    });
  }

  /** Consume only the operation's station-channel history or image reply. */
  handleFrame(header: Buffer, payload: Buffer): boolean {
    const pending = this.#pending;
    if (!pending || header.length < 14 || header[12] !== 255) return false;
    const command = header.readUInt16LE(4);
    if (command !== (pending.file ? 1308 : 1306)) return false;
    if (payload.length > 2 * 1024 * 1024) { pending.reject(new EventNameHistoryError("invalid_response")); return true; }
    let clear: Buffer | null = null;
    try {
      clear = pending.file ? this.transport.decodeImage(payload, header[13]!) : this.transport.decodeHistory(payload, header[13]!);
      if (!clear) throw new EventNameHistoryError("invalid_response");
      const value = parse(clear);
      if (!pending.file) {
        if (value.cmd !== 10011 || value.table !== "history_record_info" || value.transaction !== pending.transaction) return false;
        if (value.mIntRet !== 0 || !Array.isArray(value.data)) throw new EventNameHistoryError("invalid_response");
        const tables = value.data.filter(v => object(v) && v.table_name === "history_record_info");
        if (tables.length !== 1 || !object(tables[0]) || !Array.isArray(tables[0].payload) || tables[0].payload.length > 50) throw new EventNameHistoryError("invalid_response");
        const owned: Record<string, unknown>[] = [], ids = new Set<string>();
        for (const row of tables[0].payload) {
          if (!object(row) || row.station_sn !== this.transport.stationSerial || typeof row.device_sn !== "string") throw new EventNameHistoryError("invalid_response");
          const id = eventHistoryId(row.record_id);
          if (ids.has(id)) throw new EventNameHistoryError("invalid_response");
          ids.add(id);
          if (row.device_sn !== this.transport.serial) continue;
          if (row.device_type !== 8 || typeof row.start_time !== "string" || !recordTime(row.start_time, row.time_zone)) throw new EventNameHistoryError("invalid_response");
          if (row.start_time.slice(0, 10) === pending.date) owned.push(row);
        }
        const row = pending.recordId === undefined ? owned[0] : owned.find(v => eventHistoryId(v.record_id) === pending.recordId);
        if (!row) throw new EventNameHistoryError("unavailable");
        const path = row.thumb_path;
        if (typeof path !== "string" || path.length > 1024 || !/^\/[A-Za-z0-9._/-]+$/.test(path)
          || path.split("/").slice(1).some(v => !v || v === "." || v === "..")) throw new EventNameHistoryError("invalid_response");
        pending.records = owned.length; pending.file = path;
        this.transport.image(path);
      } else {
        if (value.file !== pending.file) return false;
        if (typeof value.content !== "string" || value.content.length > 1_400_000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(value.content)) throw new EventNameHistoryError("invalid_response");
        const bytes = Buffer.from(value.content, "base64url");
        try {
          if (bytes.toString("base64url") !== value.content.replace(/=+$/, "") || bytes.length > 1024 * 1024
            || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new EventNameHistoryError("invalid_response");
          const image = decode(bytes, { useTArray: true, tolerantDecoding: false, maxResolutionInMP: 4, maxMemoryUsageInMB: 32 });
          try { pending.resolve(projectEventPictureSummary({ scope: "one_history_thumbnail", records: pending.records,
            imageBytes: bytes.length, width: image.width, height: image.height })); }
          finally { image.data.fill(0); }
        } finally { bytes.fill(0); }
      }
    } catch (error) { pending.reject(error instanceof EventNameHistoryError && error.code !== "invalid_request" ? error : new EventNameHistoryError("invalid_response")); }
    finally { clear?.fill(0); }
    return true;
  }

  /** Cancel the pending operation when its authenticated session ends. */
  close(): void {
    this.#closed = true;
    this.#pending?.reject(new EventNameHistoryError("cancelled"));
  }
}
