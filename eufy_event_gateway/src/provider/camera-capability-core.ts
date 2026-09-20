/**
 * Small core camera capability catalogue used by the Mega gateway today.
 *
 * The provider owns inventory evidence and the shared capability evaluator
 * consumes these rows. Only gateway media/event paths and validated battery
 * reads are declared here.
 */

import type { CoreCapabilityEntry } from "./device-capability-core.js";

/** Camera types with an existing gateway protocol route and admission decision. */
export const CAMERA_DEVICE_TYPES: ReadonlySet<number> = new Set([
  5, 7, 8, 15, 19, 23, 26, 31, 38, 47, 48, 62, 63, 88, 91, 94, 96, 104, 105, 151, 203, 10005, 10031, 10037,
]);

/**
 * Names the vendor device types that affect admission without making marketing names authoritative.
 * The reported numeric type remains the source of truth when a model string disagrees with it.
 */
export const DEVICE_TYPE_NAMES: Readonly<Record<number, string>> = {
  96: "BATTERY_DOORBELL_C31",
  202: "LOCK_85D0",
  203: "LOCK_85V0_VIDEO_DOORBELL",
};

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
export const NON_CAMERA_DEVICE_TYPES: ReadonlySet<number> = new Set([
  0, 18, 25, 27, 28, 300, 301,
  2, 10, 20, 21, 22, 123, 126, 127,
  11,
  50, 51, 52, 53, 54, 55, 56, 57, 58, 140, 141, 142, 143, 180, 184, 189, 201, 202, 209,
]);

/** Media, push, and battery-read paths handled by the gateway. */
export const CAMERA_CAPABILITY_CORE: readonly CoreCapabilityEntry[] = [
  { id: "camera.snapshot_stored", family: "camera", kind: "media", evidenceParamIds: [1004], gatewaySupport: "implemented", baselineWithoutParam: true, note: "Requires a retained image from the provider." },
  { id: "camera.snapshot_live", family: "camera", kind: "media", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true, note: "A ready PPCS route does not prove a fresh frame." },
  { id: "camera.live_stream", family: "camera", kind: "media", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true, note: "A ready PPCS route does not prove a first frame." },
  { id: "camera.record", family: "camera", kind: "media", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true, note: "Clip retrieval still requires provider media evidence." },
  { id: "snapshot.capture", family: "snapshot", kind: "media", evidenceParamIds: [1004], gatewaySupport: "implemented", requiresRoute: true, note: "Live capture needs its own media route." },
  { id: "motion.motion_event", family: "motion", kind: "event", evidenceParamIds: [], gatewaySupport: "implemented", note: "Handled by the gateway's known motion push route." },
  { id: "person_detection.person_event", family: "person_detection", kind: "event", evidenceParamIds: [], gatewaySupport: "implemented", note: "Handled by the gateway's known person push route." },
  { id: "battery.level", family: "battery", kind: "read", evidenceParamIds: [1101], gatewaySupport: "implemented", note: "Refreshed from validated Mega inventory values." },
  { id: "battery.charging", family: "battery", kind: "read", evidenceParamIds: [2111], gatewaySupport: "implemented", note: "Decoded from the Mega battery-status bitfield." },
  { id: "battery.health", family: "battery", kind: "read", evidenceParamIds: [1198], gatewaySupport: "implemented", note: "Refreshed from validated Mega inventory values." },
  { id: "battery.temperature", family: "battery", kind: "read", evidenceParamIds: [1138], gatewaySupport: "implemented", note: "Refreshed from validated Mega inventory values." },
] as const;
