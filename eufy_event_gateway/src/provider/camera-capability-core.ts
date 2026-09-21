/**
 * Small core camera capability catalogue used by the Mega gateway today.
 *
 * The provider owns inventory evidence and the shared capability evaluator
 * consumes these rows. Only gateway media/event paths and validated battery
 * reads are declared here.
 */

import type { CoreCapabilityEntry } from "./device-capability-core.js";
import {
  GENERATED_CATALOGUE_DEVICES,
  GENERATED_CAMERA_DEVICE_TYPES,
  GENERATED_KNOWN_CAMERA_DEVICE_TYPES,
  GENERATED_NON_CAMERA_DEVICE_TYPES,
} from "./devices/generated-catalogue.js";

/** Integration confidence recorded for one catalogue identity. */
export type CatalogueIntegrationStatus = "supported" | "ready_to_test" | "recognised";

/** Resolve catalogue confidence using the reported model before its shared numeric type. */
export function catalogueIntegrationStatus(model: string, deviceType: number | null): CatalogueIntegrationStatus | null {
  if (deviceType === null) return null;
  const typeMatches = GENERATED_CATALOGUE_DEVICES.filter((candidate) => candidate.deviceType === deviceType);
  const normalizedModel = model.toUpperCase();
  const modelMatches = typeMatches.filter((candidate) => (
    candidate.models.some((candidateModel) => candidateModel.toUpperCase() === normalizedModel)
  ));
  const matches = modelMatches.length > 0 ? modelMatches : typeMatches.length === 1 ? typeMatches : [];
  if (matches.some(({ status }) => status === "ready_to_test")) return "ready_to_test";
  if (matches.some(({ status }) => status === "supported")) return "supported";
  return matches.length > 0 ? "recognised" : null;
}

/** Camera types with an existing gateway protocol route and admission decision. */
export const CAMERA_DEVICE_TYPES: ReadonlySet<number> = GENERATED_CAMERA_DEVICE_TYPES;

/** Camera-like types known to the catalogue, whether admitted or not. */
export const KNOWN_CAMERA_DEVICE_TYPES: ReadonlySet<number> = GENERATED_KNOWN_CAMERA_DEVICE_TYPES;

/** The coarse role used before route and capability evidence are evaluated. */
export type MegaDeviceRole = "camera" | "non-camera" | "unknown";

/** Resolve the conservative inventory role for a vendor device type. */
export function megaDeviceRole(deviceType: number | null): MegaDeviceRole {
  if (deviceType === null) return "unknown";
  if (CAMERA_DEVICE_TYPES.has(deviceType)) return "camera";
  if (NON_CAMERA_DEVICE_TYPES.has(deviceType)) return "non-camera";
  return "unknown";
}

/** Known externally powered models whose inventory battery fields are sentinels. */
export const MAINS_BATTERY_SENTINEL_MODELS: readonly string[] = ["T8425", "T8419", "T817L"];

/** Return whether a model's battery-shaped inventory values are non-battery telemetry. */
export function hasMainsBatterySentinel(model: string): boolean {
  const normalized = model.toUpperCase();
  return MAINS_BATTERY_SENTINEL_MODELS.some((prefix) => normalized.startsWith(prefix));
}

/** Known non-camera inventory types excluded from camera-review diagnostics. */
export const NON_CAMERA_DEVICE_TYPES: ReadonlySet<number> = GENERATED_NON_CAMERA_DEVICE_TYPES;

/** Media, push, and battery-read paths handled by the gateway. */
export const CAMERA_CAPABILITY_CORE: readonly CoreCapabilityEntry[] = [
  { id: "camera.snapshot_stored", family: "camera", kind: "media", evidenceParamIds: [1004], gatewaySupport: "implemented", baselineWithoutParam: true, note: "Requires a retained image from the provider." },
  { id: "camera.snapshot_live", family: "camera", kind: "media", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true, note: "A ready PPCS route does not prove a fresh frame." },
  { id: "camera.live_stream", family: "camera", kind: "media", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true, note: "A ready PPCS route does not prove a first frame." },
  { id: "camera.record", family: "camera", kind: "media", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true, note: "Clip retrieval still requires provider media evidence." },
  { id: "snapshot.capture", family: "snapshot", kind: "media", evidenceParamIds: [1004], gatewaySupport: "implemented", requiresRoute: true, note: "Live capture needs its own media route." },
  { id: "motion.motion_event", family: "motion", kind: "event", evidenceParamIds: [], gatewaySupport: "implemented", note: "Handled by the gateway's known motion push route." },
  { id: "camera.night_vision", family: "camera", kind: "action", evidenceParamIds: [1277], gatewaySupport: "implemented", requiresRoute: true, note: "The current write path requires a HomeBase-attached camera and confirms the selected mode through cloud inventory." },
  { id: "person_detection.person_event", family: "person_detection", kind: "event", evidenceParamIds: [], gatewaySupport: "implemented", note: "Handled by the gateway's known person push route." },
  { id: "battery.level", family: "battery", kind: "read", evidenceParamIds: [1101], gatewaySupport: "implemented", note: "Refreshed from validated Mega inventory values." },
  { id: "battery.charging", family: "battery", kind: "read", evidenceParamIds: [2111], gatewaySupport: "implemented", note: "Decoded from the Mega battery-status bitfield." },
  { id: "battery.health", family: "battery", kind: "read", evidenceParamIds: [1198], gatewaySupport: "implemented", note: "Refreshed from validated Mega inventory values." },
  { id: "battery.temperature", family: "battery", kind: "read", evidenceParamIds: [1138], gatewaySupport: "implemented", note: "Refreshed from validated Mega inventory values." },
] as const;
