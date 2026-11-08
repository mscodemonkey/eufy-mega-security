/**
 * Validates the app-observed standalone C31 continuous-index diagnostic response.
 * The PPCS session owns the request, keys and bytes. This pure boundary returns
 * only structural counts to Diagnostics and never supplies playback references.
 */

/** Fixed failures can cross the HTTP/log boundary without camera or account data. */
export type C31IndexStage = "admission" | "busy" | "cancelled" | "timeout" | "malformed" | "session";

/**
 * Carries one retired index attempt's fixed failure across provider/HTTP boundaries.
 * The trial owner controls cleanup. This error grants no retry or device-write
 * authority and never implies that the camera has no recordings.
 */
export class C31IndexError extends Error {
  constructor(readonly stage: C31IndexStage) { super(`Recording index test ${stage}`); }
}

/** One explicitly selected historical interval, in UTC Unix seconds. */
export interface C31IndexWindow {
  readonly beginTime: number;
  readonly endTime: number;
}

/** Closed structural result, independent of recording content or private identifiers. */
export interface C31IndexSummary {
  readonly outcome: "empty" | "intervals" | "unusable";
  readonly windowMatches: boolean;
  readonly ownerMatches: boolean;
  readonly valid: number;
  readonly invalid: number;
  readonly overlapping: number;
}

/** Reject wrong-unit, future or unbounded ranges before a device is contacted. */
export function validateC31IndexWindow(begin: number, end: number, now: number): void {
  if (![begin, end, now].every(Number.isSafeInteger) || begin < 946684800
    || end <= begin || end - begin > 1800 || end > now || begin < now - 86400) {
    throw new C31IndexError("admission");
  }
}

/**
 * Admit the existing recent-window consent or one closed historical selection.
 * Historical reads retain the same thirty-minute span and are limited to the
 * previous day. Invalid consent, extra fields and partial windows fail before
 * the provider can reserve or contact a camera.
 */
export function parseC31IndexRequest(value: unknown, now: number): C31IndexWindow | undefined {
  const row = object(value);
  if (!row || row.consentReadRecordingIndex !== true) throw new C31IndexError("admission");
  const keys = Object.keys(row);
  if (keys.length === 1) return undefined;
  if (keys.length !== 3 || keys.some(key => !["consentReadRecordingIndex", "beginTime", "endTime"].includes(key))
    || typeof row.beginTime !== "number" || typeof row.endTime !== "number") throw new C31IndexError("admission");
  validateC31IndexWindow(row.beginTime, row.endTime, now);
  return { beginTime: row.beginTime, endTime: row.endTime };
}

/** Reduce a matched reply to counts, rejecting ambiguous envelope ownership or units. */
export function summarizeC31Index(value: unknown, begin: number, end: number, owner: string): C31IndexSummary {
  const record = object(value);
  if (!record || !owner || !Array.isArray(record.videos) || record.videos.length > 512
    || !Number.isSafeInteger(record.id) || typeof record.account !== "string"
    || record.account !== owner) throw new C31IndexError("malformed");
  const snake = Object.hasOwn(record, "begin_time") || Object.hasOwn(record, "end_time");
  const camel = Object.hasOwn(record, "beginTime") || Object.hasOwn(record, "endTime");
  if (snake === camel || (snake ? record.begin_time : record.beginTime) !== begin
    || (snake ? record.end_time : record.endTime) !== end) throw new C31IndexError("malformed");
  let valid = 0, invalid = 0, overlapping = 0;
  for (const item of record.videos) {
    const row = object(item), start = row?.start_time, stop = row?.stop_time, cipher = row?.cipher_id;
    if (!row || typeof start !== "number" || typeof stop !== "number"
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(stop) || start < 946684800
      || stop <= start || stop > end + 86400
      || !(typeof cipher === "number" && Number.isSafeInteger(cipher) && cipher >= 0 || typeof cipher === "string" && cipher.length > 0 && cipher.length <= 256)) {
      invalid++; continue;
    }
    valid++;
    if (start < end && stop > begin) overlapping++;
  }
  return { outcome: record.videos.length === 0 ? "empty" : valid ? "intervals" : "unusable",
    windowMatches: true, ownerMatches: true, valid, invalid, overlapping };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
