/**
 * Interprets the reporter-observed NVR schedule without owning device state.
 * The consented guard trial consumes only a stable expected mode. Private
 * schedule bytes and operator timezone never leave this parsing boundary.
 */
import { NvrGuardError } from "./nvr-guard-trial.js";

/** Concrete effective modes supported by the restricted guard diagnostic. */
export type NvrGuardEffective = 0 | 1 | 3 | 4 | 5;

/** Validate an operator-supplied IANA zone without inferring or persisting it. */
export function nvrGuardTimeZone(value: unknown): string {
  try {
    if (typeof value !== "string" || value.length < 1 || value.length > 64
      || /^(?:Etc\/)?(?:GMT|UTC)[+-]/i.test(value)
      || !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(value)) throw Error();
    return new Intl.DateTimeFormat("en-GB", { timeZone: value }).resolvedOptions().timeZone;
  } catch { throw new NvrGuardError("admission"); }
}

/**
 * Require a non-Home schedule window stable from one minute before the query
 * through five minutes afterwards. This deliberately refuses boundary, DST,
 * unsupported, and ambiguous schedules rather than authorizing a risky trial.
 * Recovery checks only five seconds ahead, so a later boundary cannot falsely
 * invalidate a restore that is already proven in the original active slot.
 */
export function nvrGuardSchedule(raw: string, zone: string, now: number, recovery = false): Exclude<NvrGuardEffective, 1> {
  try {
    const timeZone = nvrGuardTimeZone(zone);
    if (!Number.isFinite(now) || !raw.length || raw.length > 65_536) throw Error();
    const bytes = Buffer.from(raw, "base64");
    if (bytes.toString("base64") !== raw || bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) throw Error();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const root: unknown = JSON.parse(text);
    rejectDuplicateKeys(text);
    if (!record(root) || !Array.isArray(root.schedules) || !root.schedules.length || root.schedules.length > 512) throw Error();
    const keys = ["week", "start_h", "start_m", "end_h", "end_m", "mode_id"];
    const slots = root.schedules.map((slot: unknown) => {
      if (!record(slot) || Object.keys(slot).length !== keys.length || !keys.every(key => Object.hasOwn(slot, key))
        || !keys.every(key => Number.isInteger(slot[key]) && !Object.is(slot[key], -0))) throw Error();
      const values = slot as Record<string, number>;
      if (values.week! < 0 || values.week! > 6 || ![values.start_h, values.end_h].every(n => n! >= 0 && n! <= 23)
        || ![values.start_m, values.end_m].every(n => n! >= 0 && n! <= 59)
        || ![0, 1, 3, 4, 5].includes(values.mode_id!)) throw Error();
      const start = values.start_h! * 60 + values.start_m!;
      const end = values.end_h === 23 && values.end_m === 59 ? 1440 : values.end_h! * 60 + values.end_m!;
      if (start >= end || values.start_h === values.end_h && values.start_m === values.end_m) throw Error();
      return { week: values.week!, start, end, mode: values.mode_id! };
    });
    for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i]!, b = slots[j]!;
      if (a.week === b.week && a.start < b.end && b.start < a.end) throw Error();
    }
    const formatter = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    let expected: number | undefined, previous: number | undefined, active: object | undefined;
    for (let seconds = -60; seconds <= (recovery ? 5 : 300); seconds++) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(now + seconds * 1000)).map(p => [p.type, p.value]));
      const minute = Number(parts.hour) * 60 + Number(parts.minute);
      const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute), Number(parts.second));
      const week = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))).getUTCDay();
      const matches = slots.filter(slot => slot.week === week && minute >= slot.start && minute < slot.end);
      if (matches.length !== 1 || matches[0]!.mode === 1 || previous !== undefined && local !== previous + 1000
        || expected !== undefined && matches[0]!.mode !== expected || active !== undefined && matches[0] !== active
        || previous !== undefined && minute === 0 && Number(parts.second) === 0) throw Error();
      previous = local; active = matches[0]; expected = matches[0]!.mode;
    }
    if (expected === undefined || expected === 1) throw Error();
    return expected as Exclude<NvrGuardEffective, 1>;
  } catch { throw new NvrGuardError("baseline"); }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectDuplicateKeys(text: string): void {
  const tokens = [...text.matchAll(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\]:,]/g)].map(match => match[0]);
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (/^-?\d/.test(token) && /[.eE]/.test(token)) throw Error();
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ":") {
      const keys = stack.at(-1), key = JSON.parse(token) as string;
      if (!keys || keys.has(key)) throw Error();
      keys.add(key);
    }
  }
}
