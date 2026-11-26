/**
 * Projects the device list's Android sensor descriptors for local diagnostics.
 * Inventory refresh owns their lifetime. The report only consumes the projection.
 */

/** Only small numeric sensor descriptors may cross the diagnostic boundary. */
export type SensorInventory = { status: "missing" | "empty" | "invalid" | "duplicate" }
  | { status: "reported"; sensors: { id: number; type: number }[] };

/** Read parameter 9240 from a single inventory response and discard raw values. */
export function sensorInventory(params: unknown): SensorInventory {
  const rows = Array.isArray(params) ? params.filter(p => p?.param_type === 9240 || p?.param_type === "9240") : [];
  if (!rows.length) return { status: "missing" };
  if (rows.length !== 1) return { status: "duplicate" };
  let value: unknown = rows[0].param_value;
  if (typeof value === "string") {
    if (value === "") return { status: "empty" };
    if (value.length > 4096) return { status: "invalid" };
    try { value = JSON.parse(value); } catch { return { status: "invalid" }; }
  }
  if (!Array.isArray(value) || value.length > 32) return { status: "invalid" };
  if (!value.length) return { status: "empty" };
  const sensors = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { status: "invalid" };
    const { id = 0, type = 0 } = entry;
    if (![id, type].every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return { status: "invalid" };
    sensors.push({ id, type });
  }
  return { status: "reported", sensors };
}
