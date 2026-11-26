/**
 * Evaluates local inventory evidence for the web diagnostic. The caller owns
 * the inventory snapshot and tests. This module never opens a session.
 */
import type { GatewayState } from "../domain/gateway-state.js";
import { safeCameraModel } from "../domain/safe-camera-model.js";
import { GENERATED_CATALOGUE_DEVICES } from "../provider/devices/generated-catalogue.js";
import { liveBinding, referenceOperations } from "./model-reference.js";

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

/** Combine exact catalogue identity, app reference and current EMS admission for one local selection. */
export function deviceDecisions(state: GatewayState, serial: string) {
  const inventory = state.listInventoryDiagnostics().find(row => row.serial === serial);
  const camera = state.listCameras().find(row => row.serial === serial);
  const device = inventory ?? camera ?? [...state.listStations(), ...state.listSensors()].find(row => row.serial === serial);
  if (!device) return null;
  const model = safeCameraModel(device.model);
  const type = inventory?.megaDeviceType ?? null;
  const matches = GENERATED_CATALOGUE_DEVICES.filter(row => row.models.includes(model) && row.deviceType === type);
  const capabilities = [...state.listDeviceCapabilities(), ...state.listCameraCapabilities()].filter(row => row.serial === serial);
  const sensors = inventory?.sensorInventory ?? { status: "missing" as const };
  const reference = matches.length === 1 ? liveBinding(model) : undefined;
  return {
    model, deviceType: type, catalogue: matches.length === 1 ? matches[0]!.status : "unresolved",
    topology: inventory?.decisionTopology ?? "unknown", parentModel: inventory?.decisionParentModel ?? null,
    firmware: inventory?.decisionFirmware ?? null,
    referenceOperations: matches.length === 1 ? referenceOperations(model) : [],
    liveHandler: reference ?? "unresolved", sensorInventory: sensors,
    viewMode: inventory?.decisionViewMode ?? "unknown",
    platformPlayerLayout: !camera || !reference ? "unknown" : sensors.status === "reported"
      ? "If the platform V2 player opens this device, portrait starts stacked and landscape starts picture-in-picture."
      : sensors.status === "empty" ? "For a non-sensor device, platform V2 starts with a single view." : "unknown",
    streamAvailable: camera?.streamSupported === true,
    operations: capabilities.flatMap(row => row.matrix.map(({ id, family, kind, gatewaySupport, offerable, deviceEvidence }) =>
      ({ id, family, kind, gatewaySupport, offerable, deviceEvidence }))),
  };
}
