/**
 * Selects the reported T8030 alarm volume from one device's cloud inventory.
 * The inventory owner supplies the exact model and type. This pure projection
 * owns no state or requests, and the station provider consumes it as a cached
 * reading rather than local command confirmation.
 */

/** Return one unambiguous station-volume value for the evidenced HB3 profile. */
export function homeBaseInventoryAlarmVolume(params: unknown, model: string | undefined, deviceType: number | null): number | undefined {
  if (model !== "T8030" || deviceType !== 18 || !Array.isArray(params) || params.length > 4096) return undefined;
  const candidates = params.filter(row => row !== null && typeof row === "object" && !Array.isArray(row)
    && (row.param_type === 1235 || row.param_type === "1235")
    && ["channel", "dev_type"].every(key => !Object.hasOwn(row, key) || row[key] === 255 || row[key] === "255"));
  if (candidates.length !== 1) return undefined;
  const value: unknown = candidates[0].param_value;
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && /^(?:[1-9]|1[0-9]|2[0-6])$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 26 ? parsed : undefined;
}
