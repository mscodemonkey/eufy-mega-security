/**
 * Summarizes raw T8417 inventory fields without inferring physical privacy.
 * EufyProvider owns this tracker and resets it with inventory retirement. Only
 * fixed aggregate messages cross the logging boundary, never device identity.
 */

type Token = "0" | "1" | "missing" | "duplicate" | "invalid" | "unknown";
interface Member { readonly tuple: string; readonly at: number }

function data(row: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function plain(value: unknown): value is object {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function rows(value: unknown[]): unknown[] {
  const length = data(value, "length") as number;
  return Array.from({ length }, (_, index) => data(value, String(index)));
}

function parameterType(value: unknown): number | undefined {
  const number = typeof value === "number" ? value
    : typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) ? number : undefined;
}

function token(params: unknown, type: number): Token {
  if (!Array.isArray(params)) return "missing";
  if ((data(params, "length") as number) > 1024) return "invalid";
  const matches = rows(params).filter(row => plain(row) && parameterType(data(row, "param_type")) === type);
  if (!matches.length) return "missing";
  if (matches.length !== 1) return "duplicate";
  const value = data(matches[0] as object, "param_value");
  if (Object.is(value, -0)) return "invalid";
  if (value === 0 || value === "0") return "0";
  if (value === 1 || value === "1") return "1";
  if (type === 6271 && (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 9_999_999_999
    || typeof value === "string" && /^(0|[1-9][0-9]{0,9})$/.test(value))) return "unknown";
  return "invalid";
}

function topology(row: object, serial: string): "direct" | "attached" | "unknown" {
  let parent = data(row, "parent_sn");
  if (parent === undefined || parent === null || parent === "") parent = data(row, "station_sn");
  if (parent === undefined || parent === null || parent === "" || parent === serial) return "direct";
  return typeof parent === "string" ? "attached" : "unknown";
}

/**
 * Owns private membership and emission clocks for one provider inventory lifetime.
 * Invalid observations leave state untouched. Reset retires every private key,
 * and neither JSON nor ordinary inspection exposes the ES-private maps.
 */
export class T8417ReadShapeTracker {
  #generation: number | null = null;
  #members = new Map<string, Member>();
  #counts = new Map<string, number>();
  #lastNow = 0;

  /** Retire private membership on startup replacement or provider shutdown. */
  reset(): void {
    this.#generation = null;
    this.#members.clear(); this.#counts.clear(); this.#lastNow = 0;
  }

  /** Project descriptor-only raw fields into safe grouped messages, without touching the input. */
  observe(rawDevices: unknown, generation: number, nowMs: number, startup: boolean): string[] {
    try {
      if (!Number.isSafeInteger(generation) || generation < 0 || this.#generation !== null && generation < this.#generation
        || !Number.isFinite(nowMs) || nowMs < 0 || !Array.isArray(rawDevices)
        || (data(rawDevices, "length") as number) > 1024) return [];
      const devices = rows(rawDevices);
      if (!devices.length && !startup) return [];
      const sameGeneration = generation === this.#generation;
      const previous = sameGeneration ? this.#members : new Map<string, Member>();
      const counts = sameGeneration ? this.#counts : new Map<string, number>();
      const lastNow = sameGeneration ? this.#lastNow : 0;
      const serialCounts = new Map<string, number>();
      for (const row of devices) {
        if (!plain(row)) continue;
        const serial = data(row, "device_sn");
        if (typeof serial === "string") serialCounts.set(serial, (serialCounts.get(serial) ?? 0) + 1);
      }
      const groups = new Map<string, string[]>();
      for (const row of devices) {
        if (!plain(row) || data(row, "device_model") !== "T8417" || data(row, "category") !== "eufy_security"
          || ![105, "105"].includes(data(row, "device_type") as number | string)) continue;
        const serial = data(row, "device_sn");
        if (typeof serial !== "string" || !serial || serialCounts.get(serial) !== 1) continue;
        const params = data(row, "params");
        const tuple = `model=T8417 p1035=${token(params, 1035)} p2001=${token(params, 2001)} p6250=${token(params, 6250)} p6271=${token(params, 6271)} topology=${topology(row, serial)}`;
        groups.set(tuple, [...groups.get(tuple) ?? [], serial]);
      }
      const next = new Map<string, Member>();
      const nextCounts = new Map<string, number>();
      const messages: string[] = [];
      for (const [tuple, serials] of groups) {
        const emit = startup || counts.get(tuple) !== serials.length || serials.some(serial => {
          const old = previous.get(serial);
          return !old || old.tuple !== tuple || nowMs >= lastNow && nowMs - old.at >= 900_000;
        });
        if (emit) messages.push(`${tuple} devices=${serials.length}`);
        nextCounts.set(tuple, serials.length);
        for (const serial of serials) next.set(serial, { tuple, at: emit ? Math.max(nowMs, lastNow) : previous.get(serial)!.at });
      }

      // Commit only after every untrusted descriptor and proxy operation has succeeded.
      this.#generation = generation; this.#members = next; this.#counts = nextCounts;
      this.#lastNow = Math.max(nowMs, lastNow);
      return messages;
    } catch { return []; }
  }
}
