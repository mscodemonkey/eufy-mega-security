/**
 * Retains a notification's exact recording identity for optional picture recovery.
 * The normalizer owns the immutable reference. The HomeBase reader consumes it
 * only after route admission and an exact history-row join. No path is fetched
 * directly and no identifier or timestamp is inferred from a database ID.
 */

/** Private notification fields that must travel together from the same payload. */
export interface PushRecordingReference {
  readonly id: string;
  readonly storagePath: string;
  readonly triggerMilliseconds: number;
}

/** Preserve only exact, supported scalar shapes without rounding numeric IDs. */
export function pushRecordingReference(payload: Record<string, unknown>): PushRecordingReference | null {
  const raw = payload.record_id;
  const id = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : raw;
  if (typeof id !== "string" || !/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9_223_372_036_854_775_807n
    || typeof payload.file_path !== "string" || payload.file_path.length > 1024
    || typeof payload.trigger_time !== "number" || !Number.isSafeInteger(payload.trigger_time)
    || payload.trigger_time < 1_000_000_000_000 || payload.trigger_time > 9_999_999_999_999) return null;
  if (recordingPathDate(payload.file_path) === null) return null;
  return Object.freeze({ id, storagePath: payload.file_path, triggerMilliseconds: payload.trigger_time });
}

/**
 * Read the wall-calendar day from the observed HomeBase recording path layout.
 * Folder and filename timestamps must agree on the day and month. This is a
 * conservative route-specific layout, not a general filename/date heuristic.
 * The later history join still requires the entire path and exact record ID.
 */
export function recordingPathDate(path: unknown): string | null {
  if (typeof path !== "string" || path.length > 1024) return null;
  const match = /^\/zx\/hdd_data[0-9]+\/Camera[0-9]{2}\/([0-9]{6})\/([0-9]{14})\/([0-9]{14})\.zxvideo$/.exec(path);
  if (!match || match[1] !== match[2]!.slice(0, 6) || match[2]!.slice(0, 8) !== match[3]!.slice(0, 8)) return null;
  for (const stamp of [match[2]!, match[3]!]) {
    const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}Z`;
    const value = new Date(iso);
    if (!Number.isFinite(value.getTime()) || value.toISOString() !== iso.replace("Z", ".000Z")) return null;
  }
  return `${match[2]!.slice(0, 4)}-${match[2]!.slice(4, 6)}-${match[2]!.slice(6, 8)}`;
}
