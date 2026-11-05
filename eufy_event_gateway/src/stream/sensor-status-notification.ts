/**
 * Validates contact observations from a decrypted HomeBase notification.
 *
 * The PPCS session owns decryption and connection lifetime. The provider owns
 * station/channel identity matching, and the gateway owns sensor state. Raw
 * notification fields and unsupported parameters never leave this decoder.
 */

/** One contact value on a HomeBase child channel, not a device-type identifier. */
export interface SensorContactObservation {
  readonly channel: number;
  readonly open: boolean;
}

/** A HomeBase child channel and its source-reported epoch-millisecond trigger. */
export interface SensorMotionObservation {
  readonly channel: number;
  readonly triggeredAt: number;
}

/** Decode native 1605 motion timestamps, discarding conflicting channels within one frame. */
export function decodeSensorMotionNotification(clear: Buffer): readonly SensorMotionObservation[] {
  if (clear.length === 0 || clear.length > 65_536) return [];
  let decoded: unknown;
  try { decoded = JSON.parse(clear.toString("utf8").replace(/\0+$/g, "")); } catch { return []; }
  if (!record(decoded) || decoded.cmd !== 1829 || !record(decoded.payload)) return [];
  const params = decoded.payload.params;
  if (!Array.isArray(params) || params.length > 256) return [];
  const values = new Map<number, number | null>();
  for (const row of params) {
    if (!record(row) || scalar(row.param_type) !== 1605) continue;
    const channel = scalar(row.dev_type), timestamp = scalar(row.param_value);
    if (channel === null || channel < 0 || channel >= 255 || timestamp === null
      || timestamp < 946_684_800_000) continue;
    if (!values.has(channel)) values.set(channel, timestamp);
    else if (values.get(channel) !== timestamp) values.set(channel, null);
  }
  return [...values].flatMap(([channel, triggeredAt]) => triggeredAt === null ? [] : [{ channel, triggeredAt }]);
}

/** Decode bounded command-1829 contact rows, omitting malformed or conflicting channels. */
export function decodeSensorContactNotification(clear: Buffer): readonly SensorContactObservation[] {
  if (clear.length === 0 || clear.length > 65_536) return [];
  let decoded: unknown;
  try { decoded = JSON.parse(clear.toString("utf8").replace(/\0+$/g, "")); } catch { return []; }
  if (!record(decoded) || decoded.cmd !== 1829 || !record(decoded.payload)) return [];
  const params = decoded.payload.params;
  if (!Array.isArray(params) || params.length > 256) return [];
  const contacts = new Map<number, boolean | null>();
  for (const row of params) {
    if (!record(row) || scalar(row.param_type) !== 1550) continue;
    const channel = scalar(row.dev_type);
    const value = scalar(row.param_value);
    if (channel === null || !Number.isInteger(channel) || channel < 0 || channel >= 255
      || (value !== 0 && value !== 1)) continue;
    const open = value === 1;
    if (!contacts.has(channel)) contacts.set(channel, open);
    else if (contacts.get(channel) !== open) contacts.set(channel, null);
  }
  return [...contacts].flatMap(([channel, open]) => open === null ? [] : [{ channel, open }]);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
