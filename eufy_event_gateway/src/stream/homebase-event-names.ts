/**
 * Checks familiar-name availability in one explicitly requested HomeBase history page.
 * The authenticated session owns transport and cancellation. This boundary owns
 * transaction correlation and record/crop/person joins. It returns counts only,
 * keeps names and identifiers private, and never publishes detection state.
 */
import { recordTime, validateRecordingDate } from "./stored-recordings.js";

/** Counts from a single history page, without inferring absence outside that page. */
export interface EventNameHistorySummary {
  readonly scope: "one_history_page";
  readonly records: number;
  readonly personCrops: number;
  readonly recordsWithFamiliarNames: number;
  readonly unresolvedPersonCrops: number;
}

/** Fixed failure reasons keep remote data and personal names out of errors. */
export class EventNameHistoryError extends Error {

  /** Create one operation-local error without retaining transport values. */
  constructor(readonly code: "unavailable" | "invalid_request" | "invalid_response" | "cancelled" | "timeout" | "busy") {
    super(`Event name history check failed (${code})`);
    this.name = "EventNameHistoryError";
  }
}

/** Authenticated station operations borrowed for one metadata query, never a download. */
export interface EventNameHistoryTransport {
  readonly serial: string;
  readonly stationSerial: string;
  /** Submit the fixed first-page operation at this explicit cursor, without retries. */
  query(transaction: string, date: string, startId: string): void;

  /** Authenticate the station envelope, returning null for unsupported protection. */
  decodeReply(payload: Buffer, sign: number): Buffer | null;
}

/** Keep provider or transport additions out of the portable HTTP result. */
export function projectEventNameHistorySummary(value: unknown): EventNameHistorySummary {
  if (!object(value) || value.scope !== "one_history_page") throw new EventNameHistoryError("invalid_response");
  const { records, personCrops, recordsWithFamiliarNames, unresolvedPersonCrops } = value;
  if (![records, personCrops, recordsWithFamiliarNames, unresolvedPersonCrops].every(item => typeof item === "number" && Number.isSafeInteger(item) && item >= 0)
    || typeof records !== "number" || typeof personCrops !== "number" || typeof recordsWithFamiliarNames !== "number" || typeof unresolvedPersonCrops !== "number"
    || records > 50 || personCrops > 10_000 || recordsWithFamiliarNames > records || recordsWithFamiliarNames > personCrops || unresolvedPersonCrops > personCrops) {
    throw new EventNameHistoryError("invalid_response");
  }
  return { scope: "one_history_page", records, personCrops, recordsWithFamiliarNames, unresolvedPersonCrops };
}

/** Validate an opaque database cursor without interpreting it as a timestamp. */
export function eventHistoryId(value: unknown): string {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(text) || BigInt(text) > 9_223_372_036_854_775_807n) {
    throw new EventNameHistoryError("invalid_request");
  }
  return text;
}

/** Restrict the numeric wire cursor to values JSON can preserve exactly. */
export function eventHistoryCursor(value: unknown): string {
  const result = eventHistoryId(value);
  if (!Number.isSafeInteger(Number(result))) throw new EventNameHistoryError("invalid_request");
  return result;
}

/** Return the observed adjacent calendar boundary without applying a timezone to an ID. */
export function nextEventHistoryDate(date: string): string {
  validateRecordingDate(date);
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  if (next.getUTCFullYear() > 9999) throw new EventNameHistoryError("invalid_request");
  return next.toISOString().slice(0, 10).replaceAll("-", "");
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rows(value: Record<string, unknown>, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value.data)) throw new EventNameHistoryError("invalid_response");
  const tables = value.data.filter(item => object(item) && item.table_name === name);
  if (tables.length !== 1 || !object(tables[0]) || !Array.isArray(tables[0].payload)
    || tables[0].payload.length > 10_000 || !tables[0].payload.every(object)) throw new EventNameHistoryError("invalid_response");
  return tables[0].payload;
}

function id(value: unknown): string {
  try { return eventHistoryId(value); }
  catch { throw new EventNameHistoryError("invalid_response"); }
}

/**
 * Join only the requested type-7 child and day to its returned person records.
 * IDs remain opaque. Conflicting station ownership, duplicate records or roster
 * IDs reject the page. A missing person entry remains unresolved rather than
 * borrowing a name from another record or treating it as a successful lookup.
 */
export function summarizeEventNameHistory(value: unknown, serial: string, stationSerial: string, date: string): EventNameHistorySummary {
  validateRecordingDate(date);
  if (!object(value) || value.mIntRet !== 0) throw new EventNameHistoryError("invalid_response");
  const history = rows(value, "history_record_info"), crops = rows(value, "record_crop_picture_info"), people = rows(value, "person_basic_info");
  if (history.length > 50) throw new EventNameHistoryError("invalid_response");
  const records = new Map<string, Record<string, unknown>>(), owners = new Map<string, string>();
  for (const row of history) {
    const key = id(row.record_id);
    if (owners.has(key)) throw new EventNameHistoryError("invalid_response");
    if (typeof row.device_sn !== "string" || row.station_sn !== stationSerial) throw new EventNameHistoryError("invalid_response");
    owners.set(key, row.device_sn);
    if (row.device_sn !== serial) continue;
    if (row.device_type !== 7 || typeof row.start_time !== "string" || !recordTime(row.start_time, row.time_zone)) {
      throw new EventNameHistoryError("invalid_response");
    }
    if (row.start_time.slice(0, 10) === date) records.set(key, row);
  }
  const roster = new Map<number, Record<string, unknown>>();
  for (const person of people) {
    if (!Number.isInteger(person.person_id) || typeof person.person_id !== "number" || person.person_id < -1
      || person.person_id > 2_147_483_647 || roster.has(person.person_id)
      || person.station_sn !== undefined && person.station_sn !== stationSerial) throw new EventNameHistoryError("invalid_response");
    roster.set(person.person_id, person);
  }
  let personCrops = 0, unresolvedPersonCrops = 0;
  const named = new Set<string>(), seen = new Set<string>();
  for (const crop of crops) {
    const record = id(crop.record_id);
    if (!records.has(record)) continue;
    const cropId = id(crop.crop_id);
    if (seen.has(cropId) || crop.station_sn !== undefined && crop.station_sn !== stationSerial
      || crop.device_sn !== undefined && crop.device_sn !== serial) throw new EventNameHistoryError("invalid_response");
    seen.add(cropId);
    if (crop.detection_type !== 1) continue;
    personCrops++;
    const person = typeof crop.person_id === "number" ? roster.get(crop.person_id) : undefined;
    if (!person || typeof person.group_id !== "number" || !Number.isInteger(person.group_id) || person.group_id < 0 || person.group_id > 255 || typeof person.name !== "string"
      || !person.name.trim() || person.name.length > 160 || /[\u0000-\u001f\u007f]/.test(person.name)) {
      unresolvedPersonCrops++;
    } else if (person.person_id !== -1 && person.group_id !== 255) named.add(record);
  }
  return { scope: "one_history_page", records: records.size, personCrops, recordsWithFamiliarNames: named.size, unresolvedPersonCrops };
}

/**
 * Own one finite, explicitly requested history page until reply, abort or close.
 * The session supplies its authenticated reply decoder. The reader accepts only
 * its station-channel transaction and never retries or paginates automatically.
 */
export class EventNameHistoryReader {
  #pending: { transaction: string; date: string; resolve: (value: EventNameHistorySummary) => void; reject: (error: EventNameHistoryError) => void } | null = null;
  #closed = false;
  #used = false;

  /** Borrow immutable child/parent ownership for the lifetime of this reader. */
  constructor(private readonly transport: EventNameHistoryTransport) {}

  /** Read one page at the supplied opaque cursor; an empty page has limited scope. */
  async read(date: string, startId = "0", signal?: AbortSignal): Promise<EventNameHistorySummary> {
    validateRecordingDate(date); eventHistoryCursor(startId);
    if (this.#closed || signal?.aborted) throw new EventNameHistoryError("cancelled");
    if (this.#pending) throw new EventNameHistoryError("busy");
    if (this.#used) throw new EventNameHistoryError("unavailable");
    this.#used = true;
    return await new Promise((resolve, reject) => {
      const finish = (error?: EventNameHistoryError, value?: EventNameHistorySummary): void => {
        this.#pending = null; clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value!);
      };
      const abort = (): void => finish(new EventNameHistoryError("cancelled"));
      const timer = setTimeout(() => finish(new EventNameHistoryError("timeout")), 20_000);
      const transaction = `${Date.now()}`;
      this.#pending = { transaction, date, resolve: value => finish(undefined, value), reject: error => finish(error) };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { this.transport.query(transaction, date, startId); }
      catch { finish(new EventNameHistoryError("unavailable")); }
    });
  }

  /** Consume only this query's checked station response, leaving other frames untouched. */
  handleFrame(header: Buffer, payload: Buffer): boolean {
    const pending = this.#pending;
    if (!pending || header.length < 14 || header.readUInt16LE(4) !== 1306 || header[12] !== 255) return false;
    const clear = this.transport.decodeReply(payload, header[13] ?? 0);
    if (!clear || clear.length > 2 * 1024 * 1024) { pending.reject(new EventNameHistoryError("invalid_response")); return true; }
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clear).replace(/\0+$/, ""));
      if (!object(value) || value.cmd !== 10011 || value.table !== "history_record_info" || value.transaction !== pending.transaction) return false;
      pending.resolve(summarizeEventNameHistory(value, this.transport.serial, this.transport.stationSerial, pending.date));
    } catch { pending.reject(new EventNameHistoryError("invalid_response")); }
    return true;
  }

  /** Release the pending read when its owning authenticated session closes. */
  close(): void {
    this.#closed = true;
    this.#pending?.reject(new EventNameHistoryError("cancelled"));
  }
}
