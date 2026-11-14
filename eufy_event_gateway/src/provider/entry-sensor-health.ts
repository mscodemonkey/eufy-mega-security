/**
 * Decodes reported health for the exact T8900 entry-sensor contract.
 * Inventory owns freshness and identity. This boundary accepts only explicit
 * status and battery bits and never infers health from an absent parameter.
 * The sensor adapter consumes these readings without querying or changing hardware.
 */

/** Optional entry-sensor readings, absent when the reported value is unusable. */
export interface EntrySensorHealth {
  /** Parameter 1131 reports online only in state 1. Other known states are offline. */
  readonly entrySensorConnected?: boolean;

  /** Parameter 1552 is the app's explicit low-power bit, independent of percentage. */
  readonly entrySensorBatteryLow?: boolean;
}

/** Decode one unambiguous reported value per field on the qualified model/type. */
export function entrySensorHealth(value: unknown, model: string | undefined, deviceType: number | null): EntrySensorHealth {
  if (model !== "T8900" || deviceType !== 2 || !Array.isArray(value)) return {};
  const field = (id: number): unknown => {
    const rows = value.filter(row => typeof row === "object" && row !== null && !Array.isArray(row)
      && (row.param_type === id || row.param_type === String(id)));
    return rows.length === 1 ? rows[0].param_value : undefined;
  };
  const number = (raw: unknown): number | undefined => typeof raw === "number" && Number.isInteger(raw) ? raw
    : typeof raw === "string" && /^[0-5]$/.test(raw) ? Number(raw) : undefined;
  const status = number(field(1131)), low = number(field(1552));
  return {
    ...(status !== undefined && status >= 0 && status <= 5 ? { entrySensorConnected: status === 1 } : {}),
    ...(low === 0 || low === 1 ? { entrySensorBatteryLow: low === 1 } : {}),
  };
}
