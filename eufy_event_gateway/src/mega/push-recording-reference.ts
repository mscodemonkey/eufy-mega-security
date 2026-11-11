/**
 * Retains a notification's exact recording identity for optional picture recovery.
 * The normalizer owns the immutable reference. The HomeBase reader consumes it
 * only after route admission and an exact history-row join. No path is fetched
 * directly and no identifier or timestamp is inferred from a database ID.
 */

/** Private notification fields that must travel together from the same payload. */
export interface PushRecordingReference {

  /** Opaque station database identity, never interpreted as a time or sequence. */
  readonly id: string;
  readonly storagePath: string;

  /** Camera trigger clock used for freshness and rejecting an explicitly older visit. */
  readonly triggerMilliseconds: number;
}

/** Closed shape failures, with no reference values or device identities. */
export type PushRecordingReferenceProblem = "id_absent" | "id_invalid" | "path_absent" | "path_unsupported" | "time_absent" | "time_invalid";

/**
 * Closed, value-free reference diagnostics retained by the notification normalizer.
 * Layout tokens describe field types only. The provider may log them when exact
 * name recovery is refused, without retaining a path, ID, clock or person name.
 */
export interface PushRecordingReferenceShape {
  readonly pathShape: string;
  readonly calendar: "supported" | "unsupported";
  readonly clock: "absent" | "milliseconds" | "seconds" | "invalid";
}

/** Describe the same innermost payload without changing reference admission. */
export function pushRecordingReferenceShape(payload: Record<string, unknown>): PushRecordingReferenceShape {
  const path = payload.file_path;
  let pathShape = "absent";
  if (path !== undefined && path !== null) {
    if (typeof path !== "string") pathShape = "not_string";
    else if (path.length === 0) pathShape = "empty";
    else if (path.length > 1024) pathShape = "too_long";
    else if (/[\s\x00-\x1f\x7f]/u.test(path)) pathShape = "invalid_characters";
    else {
      const parts = path.split("/");
      if (parts.length > 12) pathShape = "too_many_segments";
      else pathShape = parts.map((part, index) => {
        if (index === 0 && part === "") return "absolute";
        if (part === "zx") return "zx";
        if (/^hdd_data[0-9]+$/.test(part)) return "storage";
        if (/^Camera[0-9]+$/.test(part)) return part.length === 7 ? "camera1" : part.length === 8 ? "camera2" : "camera_other";
        if (/^[0-9]{6}$/.test(part)) return "digits6";
        if (/^[0-9]{8}$/.test(part)) return "digits8";
        if (/^[0-9]{14}$/.test(part)) return "digits14";
        if (/^[0-9]{14}\.zxvideo$/.test(part)) return "video14";
        if (part.endsWith(".zxvideo")) return "video_other";
        return "other";
      }).join(".");
    }
  }
  const trigger = payload.trigger_time;
  const clock = trigger === undefined || trigger === null ? "absent"
    : typeof trigger !== "number" || !Number.isSafeInteger(trigger) ? "invalid"
      : trigger >= 1_000_000_000_000 && trigger <= 9_999_999_999_999 ? "milliseconds"
        : trigger >= 1_000_000_000 && trigger <= 9_999_999_999 ? "seconds" : "invalid";
  return Object.freeze({ pathShape, calendar: recordingPathDate(path) === null ? "unsupported" : "supported", clock });
}

/**
 * Explain the first rejected innermost reference field without relaxing admission.
 * Missing fields remain separate from unsupported shapes so the provider can
 * select the next source comparison without requesting a raw notification.
 */
export function pushRecordingReferenceProblem(payload: Record<string, unknown>): PushRecordingReferenceProblem | null {
  const raw = payload.record_id;
  if (raw === undefined || raw === null) return "id_absent";
  const id = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : raw;
  if (typeof id !== "string" || !/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9_223_372_036_854_775_807n) return "id_invalid";
  if (payload.file_path === undefined || payload.file_path === null) return "path_absent";
  if (recordingPathDate(payload.file_path) === null) return "path_unsupported";
  if (payload.trigger_time === undefined || payload.trigger_time === null) return "time_absent";
  if (typeof payload.trigger_time !== "number" || !Number.isSafeInteger(payload.trigger_time)
    || payload.trigger_time < 1_000_000_000_000 || payload.trigger_time > 9_999_999_999_999) return "time_invalid";
  return null;
}

/** Preserve only exact, supported scalar shapes without rounding numeric IDs. */
export function pushRecordingReference(payload: Record<string, unknown>): PushRecordingReference | null {
  if (pushRecordingReferenceProblem(payload) !== null) return null;
  return Object.freeze({ id: String(payload.record_id), storagePath: payload.file_path as string,
    triggerMilliseconds: payload.trigger_time as number });
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
