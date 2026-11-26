/**
 * Evaluates local inventory evidence for the web diagnostic. The caller owns
 * the inventory snapshot and tests. This module never opens a session.
 */
import type { GatewayState } from "../domain/gateway-state.js";
import { safeCameraModel } from "../domain/safe-camera-model.js";
import { GENERATED_CATALOGUE_DEVICES } from "../provider/devices/generated-catalogue.js";
import { androidModelReference, referenceOperations } from "./model-reference.js";

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
  const reference = androidModelReference(model);
  const liveHandler = reference?.liveHandler;
  const topology = inventory?.decisionTopology ?? "unknown";
  return {
    referenceBuild: "6.1.20_31181", model, deviceType: type, catalogue: matches.length === 1 ? matches[0]!.status : "unresolved",
    topology, predictedStartRequest: liveHandler ? inventory?.referenceStartRequest ?? "unresolved" : "unresolved", parentModel: inventory?.decisionParentModel ?? null,
    firmware: inventory?.decisionFirmware ?? null,
    referenceSnapshot: "2026-11-19", androidReference: reference ?? null,
    referenceOperations: referenceOperations(reference?.resolvedOperations ?? []),
    liveHandler: liveHandler ?? "unresolved", sensorInventory: sensors,
    viewMode: inventory?.decisionViewMode ?? "unknown",
    platformPlayerLayout: !camera || !liveHandler ? "unknown" : sensors.status === "reported"
      ? "If the platform V2 player opens this device, portrait starts stacked and landscape starts picture-in-picture."
      : sensors.status === "empty" ? "For a non-sensor device, platform V2 starts with a single view." : "unknown",
    streamAvailable: camera?.streamSupported === true,
    operations: capabilities.flatMap(row => row.matrix.map(({ id, family, kind, gatewaySupport, offerable, deviceEvidence }) =>
      ({ id, family, kind, gatewaySupport, offerable, deviceEvidence }))),
  };
}
