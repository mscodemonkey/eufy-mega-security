/**
 * Resolves one inventory row to its protocol peer without knowing about
 * Home Assistant or issuing network requests. The provider consumes this
 * boundary for media readiness, diagnostics, and future control routing.
 */

/** Minimal inventory shape required to resolve a device relationship. */
export interface DeviceRouteRow {
  readonly serial: string;
  readonly parentSerial: string;
}

/** Canonical role and peer decision for one device row. */
export interface DeviceRouteDecision<TRow extends DeviceRouteRow> {
  readonly role: "standalone" | "station-child";
  readonly peer: TRow;
  readonly homeBaseAttached: boolean;
}

/**
 * Resolve a standalone or station-child row exactly once.
 *
 * A missing non-self parent is deliberately unavailable. Treating it as a
 * direct camera would make media and control paths disagree about ownership.
 */
export function resolveDeviceRoute<TRow extends DeviceRouteRow>(
  row: TRow,
  rowsBySerial: ReadonlyMap<string, TRow>,
): DeviceRouteDecision<TRow> | null {
  if (!row.parentSerial || row.parentSerial === row.serial) {
    return { role: "standalone", peer: row, homeBaseAttached: false };
  }
  const station = rowsBySerial.get(row.parentSerial);
  return station
    ? { role: "station-child", peer: station, homeBaseAttached: true }
    : null;
}
