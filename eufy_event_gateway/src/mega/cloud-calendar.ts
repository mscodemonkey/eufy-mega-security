/**
 * Checks read-only cloud calendar hints for the diagnostic HTTP boundary.
 * The client owns authentication and the provider owns current camera binding.
 * This module retains no account state and never authorizes recording playback.
 * Endpoint filtering and timezone semantics remain unconfirmed on real accounts.
 */

/** A real month with an inferred, fixed offset in seconds east of UTC. */
export interface CloudCalendarQuery {
  readonly month: string;
  readonly timezoneOffset: number;
}

/** Availability hints only, independent of record ownership or playable bytes. */
export interface CloudCalendarResult {
  readonly month: string;
  readonly days: readonly number[];
}

/** Internal projection counts may be logged but never cross the HTTP boundary. */
export interface CloudCalendarProjection extends CloudCalendarResult {
  readonly droppedRows: number;
}

/** Fixed failures crossing client, provider and server without vendor text. */
export type CloudCalendarStage = "admission" | "inventory" | "auth" | "request" | "response" | "cancelled";

/** Carries only a fixed stage, with no response body, URL or account identifier. */
export class CloudCalendarError extends Error {
  constructor(readonly stage: CloudCalendarStage) {
    super("Cloud calendar unavailable");
  }
}

/** Reject invalid caller bounds before any authenticated cloud request. */
export function validateCloudCalendarQuery(query: CloudCalendarQuery): void {
  if (typeof query.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(query.month)
    || Number(query.month.slice(0, 4)) < 2000 || Number(query.month.slice(0, 4)) > 2100
    || !Number.isSafeInteger(query.timezoneOffset) || query.timezoneOffset % 60 !== 0
    || Math.abs(query.timezoneOffset) > 50_400) throw new SyntaxError("Invalid cloud calendar query");
}

/** Compute our exclusive month window without depending on the server timezone. */
export function cloudCalendarBounds(query: CloudCalendarQuery): { readonly start: number; readonly end: number } {
  validateCloudCalendarQuery(query);
  const year = Number(query.month.slice(0, 4)), month = Number(query.month.slice(5));
  const start = Date.UTC(year, month - 1, 1) / 1000 - query.timezoneOffset;
  const end = Date.UTC(year, month, 1) / 1000 - query.timezoneOffset;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0
    || end - start < 28 * 86400 || end - start > 31 * 86400) throw new SyntaxError("Invalid cloud calendar query");
  return { start, end };
}

/** Validate optional bindings and project numeric dates, discarding out-of-window hints. */
export function projectCloudCalendar(value: unknown, query: CloudCalendarQuery, camera: string, station: string): CloudCalendarProjection {
  const { start, end } = cloudCalendarBounds(query);
  if (value === null || value === undefined) return { month: query.month, days: [], droppedRows: 0 };
  if (!Array.isArray(value) || value.length > 1000) throw new CloudCalendarError("response");
  const days = new Set<number>();
  let droppedRows = 0;
  for (const row of value) {
    if (typeof row !== "object" || row === null || Array.isArray(row)
      || Object.getPrototypeOf(row) !== Object.prototype && Object.getPrototypeOf(row) !== null
      || !Number.isSafeInteger(row.date) || row.date < 0
      || row.device_sn != null && row.device_sn !== camera
      || row.station_sn != null && row.station_sn !== station) throw new CloudCalendarError("response");
    if (row.date < start || row.date >= end) { droppedRows++; continue; }
    days.add(new Date((row.date + query.timezoneOffset) * 1000).getUTCDate());
  }
  return { month: query.month, days: [...days].sort((a, b) => a - b), droppedRows };
}
