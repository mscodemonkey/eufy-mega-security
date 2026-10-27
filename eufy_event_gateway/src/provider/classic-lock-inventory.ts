/**
 * Projects opt-in T8520 cloud inventory into read-only lock observations.
 * The provider owns refresh timing and publication. This module owns no network
 * or actuator and cannot turn reported cloud values into motor authority.
 */
import type { MegaDevice } from "../mega/types.js";
import type { SmartLockState } from "../domain/types.js";

const MODELS = new Set(["T8520", "T8520J11", "T8520S"]);

function integer(value: unknown): number | null {
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,9})$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * Admit exact published models on the type-51 direct route without opening a
 * connection. Unknown or duplicate state stays unknown. The observation time
 * records this inventory receipt, not a fresh physical query of the bolt.
 */
export function classicLockInventory(rows: readonly MegaDevice[], enabled: boolean, receivedAt: number): SmartLockState[] {
  if (!enabled || !Number.isSafeInteger(receivedAt) || receivedAt < 0 || receivedAt > 8_640_000_000_000_000) return [];
  const identities = new Map<string, number>();
  for (const row of rows) {
    if (row && typeof row === "object" && !Array.isArray(row)) identities.set(row.device_sn, (identities.get(row.device_sn) ?? 0) + 1);
  }
  const result: SmartLockState[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    if (!MODELS.has(row.device_model ?? "") || row.device_type !== 51 || row.category !== "eufy_security"
      || typeof row.device_sn !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(row.device_sn)
      || identities.get(row.device_sn) !== 1
      || (row.parent_sn && row.parent_sn !== row.device_sn) || (row.station_sn && row.station_sn !== row.device_sn)) continue;
    const selected = new Map<number, number | null>();
    const seen = new Set<number>();
    for (const parameter of Array.isArray(row.params) && row.params.length <= 4096 ? row.params : []) {
      if (!parameter || typeof parameter !== "object") continue;
      const id = integer(parameter.param_type);
      if (id === null || ![6000, 6001, 1101].includes(id)) continue;
      selected.set(id, seen.has(id) ? null : integer(parameter.param_value));
      seen.add(id);
    }
    const state = selected.get(6000);
    const battery = selected.has(6001) ? selected.get(6001) : selected.get(1101);
    const name = typeof row.device_name === "string" && row.device_name.trim() ? row.device_name.trim().slice(0, 100) : row.device_model!;
    result.push({ serial: row.device_sn, name, model: row.device_model as "T8520" | "T8520J11" | "T8520S",
      state: state === 4 ? "locked" : state === 3 ? "unlocked" : "unknown", available: true,
      batteryPercent: typeof battery === "number" && battery >= 0 && battery <= 100 ? battery : null,
      stateObservedAt: new Date(receivedAt).toISOString(), readOnly: true, observationSource: "cloud_inventory" });
  }
  return result;
}
