/**
 * Evaluates all four core product-family lookups from Mega inventory.
 *
 * The provider owns inventory and PPCS readiness. Family-specific rules here
 * keep camera admission, dummy batteries, and station topology explicit.
 * These decisions contain no current parameter values. They gate which
 * normalized camera, station, and standalone-sensor paths Home Assistant may use.
 */

import type { CameraCapability, CameraCapabilityManifest, CapabilityMatrixRow, DeviceCapabilityManifest } from "../domain/types.js";
import { CAMERA_CAPABILITY_CORE, hasMainsBatterySentinel, megaDeviceRole, NON_CAMERA_DEVICE_TYPES } from "./camera-capability-core.js";
import type { CoreCapabilityEntry } from "./device-capability-core.js";
import { DOORBELL_CAPABILITY_CORE } from "./doorbell-capability-core.js";
import { HOMEBASE_CAPABILITY_CORE, HOMEBASE_DEVICE_TYPES } from "./homebase-capability-core.js";
import { SENSOR_CAPABILITY_CORE, SENSOR_DEVICE_TYPES } from "./sensor-capability-core.js";

/** Inventory shape sufficient for baseline family recognition. */
export interface CapabilityInventoryRow {
  readonly serial: string;
  readonly model: string;
  readonly category: string | null;
  readonly deviceType: number | null;
  readonly paramTypes: readonly number[];
}

/** Route and admission facts already decided by the gateway provider. */
export interface DeviceCapabilityOptions {
  readonly homeBaseSupported: boolean;
  readonly homeBaseRouteReady: boolean;
  readonly doorbellSupported: boolean;
  readonly cameraStreamSupported: boolean;
}

/** Check the existing camera admission boundary before offering camera paths. */
export function isSupportedCameraType(device: { readonly category: string | null; readonly deviceType: number | null }): boolean {
  return device.category === "eufy_security" && megaDeviceRole(device.deviceType) === "camera";
}

/** Build one camera's shape-only manifest from reported inventory and route facts. */
export function describeCameraCapabilities(device: CapabilityInventoryRow, options: {
  readonly doorbellSupported: boolean;
  readonly streamSupported: boolean;
  readonly routeReady?: boolean;
  readonly homeBaseAttached?: boolean;
}): CameraCapabilityManifest {
  const acceptedAsCamera = isSupportedCameraType(device);
  const reason = acceptedAsCamera ? "supported-camera-type"
    : device.category !== "eufy_security" ? "non-security-category" : "unrecognized-camera-type";
  const capabilities: CameraCapability[] = [];
  const mainsSentinel = hasMainsBatterySentinel(device.model);
  if (acceptedAsCamera) {
    capabilities.push(
      { id: "motion", kind: "event", unit: null, evidence: "gateway" },
      { id: "person", kind: "event", unit: null, evidence: "gateway" },
      { id: "retainedImage", kind: "image", unit: null, evidence: "gateway" },
    );
    if (options.doorbellSupported) capabilities.push({ id: "doorbellPress", kind: "event", unit: null, evidence: "gateway" });
    if (options.streamSupported) capabilities.push({ id: "liveVideo", kind: "stream", unit: null, evidence: "ppcs-route" });

    // Inventory carries only the existence of this battery read. Fresh values
    // and Home Assistant reporting remain separate work.
    if (device.paramTypes.includes(1101) && !mainsSentinel) {
      capabilities.push({ id: "batteryLevel", kind: "measurement", unit: "%", evidence: "inventory-param" });
      if (device.paramTypes.includes(2111)) capabilities.push({ id: "batteryCharging", kind: "state", unit: null, evidence: "inventory-param" });
      if (device.paramTypes.includes(1198)) capabilities.push({ id: "batteryHealth", kind: "measurement", unit: "%", evidence: "inventory-param" });
      if (device.paramTypes.includes(1138)) capabilities.push({ id: "batteryTemperature", kind: "measurement", unit: "°C", evidence: "inventory-param" });
    }
  }
  const observed = new Set(device.paramTypes);
  const peerRouteReady = options.routeReady ?? options.streamSupported;
  const matrix = CAMERA_CAPABILITY_CORE.map((entry) => {
    const row = evaluateCoreEntry(entry, observed, acceptedAsCamera, peerRouteReady, mainsSentinel);
    return entry.id === "camera.night_vision" && options.homeBaseAttached !== true
      ? { ...row, offerable: false }
      : row;
  });
  const mapped = new Set(CAMERA_CAPABILITY_CORE.flatMap(({ evidenceParamIds }) => evidenceParamIds));
  const unmapped = device.paramTypes.filter((id) => !mapped.has(id));
  const unmappedParamIds = unmapped.slice(0, 128);

  // Battery IDs occur on accessories too. Unknown camera review needs two
  // camera-specific media signals and a live peer route.
  const cameraReadEvidence = Number(observed.has(1004)) + Number(observed.has(1056));
  const reviewCandidate = !acceptedAsCamera && device.category === "eufy_security"
    && !NON_CAMERA_DEVICE_TYPES.has(device.deviceType ?? -1)
    && peerRouteReady && cameraReadEvidence >= 2;
  return { serial: device.serial, model: device.model, deviceType: device.deviceType, acceptedAsCamera, reviewCandidate, peerRouteReady, reason, capabilities, matrix, unmappedParamIds, unmappedParamCount: unmapped.length };
}

/** Return one manifest for each recognized non-camera or doorbell family. */
export function describeDeviceCapabilities(device: CapabilityInventoryRow, options: DeviceCapabilityOptions): DeviceCapabilityManifest[] {
  if (device.category !== "eufy_security") return [];
  const manifests: DeviceCapabilityManifest[] = [];
  if (SENSOR_DEVICE_TYPES.has(device.deviceType ?? -1)) {
    manifests.push(describeSensorFamily(device));
  }
  if (HOMEBASE_DEVICE_TYPES.has(device.deviceType ?? -1)) {
    manifests.push(describeHomeBaseFamily(device, options));
  }
  if (options.doorbellSupported) {
    const camera = describeCameraCapabilities(device, {
      doorbellSupported: true,
      streamSupported: options.cameraStreamSupported,
    });
    const press = DOORBELL_CAPABILITY_CORE.map((entry) => evaluateCoreEntry(entry, new Set(device.paramTypes), camera.acceptedAsCamera, false));
    manifests.push({
      serial: device.serial,
      model: device.model,
      deviceType: device.deviceType,
      family: "doorbell",
      recognized: true,
      supported: camera.acceptedAsCamera,
      matrix: [...camera.matrix, ...press],
      unmappedParamCount: camera.unmappedParamCount,
    });
  }
  return manifests;
}

function describeHomeBaseFamily(
  device: CapabilityInventoryRow,
  options: DeviceCapabilityOptions,
): DeviceCapabilityManifest {
  const discovered = device.deviceType === 0 && device.model.startsWith("T8010");
  const supported = options.homeBaseSupported || discovered;
  const manifest = describeCoreFamily(
    "homebase",
    device,
    HOMEBASE_CAPABILITY_CORE,
    supported,
    options.homeBaseRouteReady,
  );
  if (options.homeBaseSupported) return manifest;
  return {
    ...manifest,
    matrix: manifest.matrix.map((row) => ({
      ...row,
      offerable: discovered && ["homebase.available", "homebase.camera_route"].includes(row.id)
        && row.offerable,
    })),
  };
}

function describeSensorFamily(device: CapabilityInventoryRow): DeviceCapabilityManifest {
  const observed = new Set(device.paramTypes);
  const motionType = device.deviceType === 10 || device.deviceType === 127;
  const supported = motionType || [1101, 1550, 1551].some((id) => observed.has(id));
  const mapped = new Set(SENSOR_CAPABILITY_CORE.flatMap(({ evidenceParamIds }) => evidenceParamIds));
  const matrix = SENSOR_CAPABILITY_CORE.map((entry) => {
    if (entry.id === "sensor.motion_event" && !motionType) {
      return { ...evaluateCoreEntry(entry, observed, false, false), deviceEvidence: "requires-live-proof" as const };
    }
    return evaluateCoreEntry(entry, observed, supported, false);
  });
  return {
    serial: device.serial,
    model: device.model,
    deviceType: device.deviceType,
    family: "sensor",
    recognized: true,
    supported,
    matrix,
    unmappedParamCount: device.paramTypes.filter((id) => !mapped.has(id)).length,
  };
}

function describeCoreFamily(
  family: "sensor" | "homebase",
  device: CapabilityInventoryRow,
  catalogue: readonly CoreCapabilityEntry[],
  supported: boolean,
  routeReady: boolean,
): DeviceCapabilityManifest {
  const observed = new Set(device.paramTypes);
  const mapped = new Set(catalogue.flatMap(({ evidenceParamIds }) => evidenceParamIds));
  return {
    serial: device.serial,
    model: device.model,
    deviceType: device.deviceType,
    family,
    recognized: true,
    supported,
    matrix: catalogue.map((entry) => evaluateCoreEntry(entry, observed, supported, routeReady)),
    unmappedParamCount: device.paramTypes.filter((id) => !mapped.has(id)).length,
  };
}

function evaluateCoreEntry(
  entry: CoreCapabilityEntry,
  observed: ReadonlySet<number>,
  supported: boolean,
  routeReady: boolean,
  suppressBattery = false,
): CapabilityMatrixRow {
  const reportedParamIds = entry.evidenceParamIds.filter((id) => observed.has(id));
  let deviceEvidence: CapabilityMatrixRow["deviceEvidence"];
  if (suppressBattery && entry.family === "battery") deviceEvidence = "suppressed-sentinel";
  else if (reportedParamIds.length > 0) deviceEvidence = "reported-param";
  else if (entry.requiresRoute && routeReady) deviceEvidence = "ready-route";
  else if (entry.requiresRoute) deviceEvidence = entry.evidenceParamIds.length > 0 ? "not-reported" : "requires-live-proof";
  else if (supported && (entry.evidenceParamIds.length === 0 || entry.baselineWithoutParam)) deviceEvidence = "gateway-baseline";
  else deviceEvidence = entry.evidenceParamIds.length > 0 ? "not-reported" : "requires-live-proof";
  return {
    id: entry.id,
    family: entry.family,
    kind: entry.kind,
    reportedParamIds,
    deviceEvidence,
    gatewaySupport: entry.gatewaySupport,
    offerable: supported && entry.gatewaySupport === "implemented"
      && (!entry.requiresRoute || routeReady)
      && ["reported-param", "gateway-baseline", "ready-route"].includes(deviceEvidence),
    note: entry.note ?? null,
  };
}

function safeModel(value: string): string {
  return /^T[0-9A-Z-]{3,12}$/.test(value) ? value : "unknown";
}

/** Group camera evidence and HA admission decisions without private fields. */
export function cameraCapabilityLogSummaries(manifests: readonly CameraCapabilityManifest[]): { count: number; message: string }[] {
  const groups = new Map<string, { count: number; message: string }>();
  for (const manifest of manifests) {
    const reportedReads = manifest.matrix.filter(({ deviceEvidence, kind }) => kind === "read" && deviceEvidence === "reported-param");
    const unimplementedReads = reportedReads.filter(({ gatewaySupport }) => gatewaySupport === "reference-only");
    const supported = manifest.matrix.filter(({ offerable }) => offerable);
    const battery = manifest.matrix.find(({ id }) => id === "battery.level")?.deviceEvidence;
    const admission = manifest.acceptedAsCamera ? "known-camera-type"
      : manifest.reviewCandidate ? "review-camera-like"
        : manifest.reason === "non-security-category" ? "excluded-category" : "unrecognized-type";
    const message = [
      `model=${safeModel(manifest.model)}`,
      `device_type=${manifest.deviceType ?? "missing"}`,
      `admission=${admission}`,
      `ha_adapter=${manifest.acceptedAsCamera ? "camera" : "none"}`,
      `accepted=${manifest.acceptedAsCamera}`,
      `review_candidate=${manifest.reviewCandidate}`,
      `peer_route_ready=${manifest.peerRouteReady}`,
      `media_supported=${manifest.matrix.find(({ id }) => id === "camera.live_stream")?.offerable === true}`,
      `battery_read=${battery === "reported-param" ? "reported" : battery === "suppressed-sentinel" ? "suppressed" : "missing"}`,
      `reported_reads=${reportedReads.length}`,
      `reported_core=${reportedReads.map(({ id }) => id).join(",") || "none"}`,
      `not_yet_implemented=${unimplementedReads.map(({ id }) => id).join(",") || "none"}`,
      `gateway_offerable=${supported.map(({ id }) => id).join(",") || "none"}`,
      `unmapped_params=${manifest.unmappedParamCount}`,
    ].join(" ");
    const prior = groups.get(message);
    groups.set(message, { count: (prior?.count ?? 0) + 1, message });
  }
  return [...groups.values()];
}

/** Group product-family decisions without names, serials, or raw values. */
export function deviceCapabilityLogSummaries(manifests: readonly DeviceCapabilityManifest[]): { count: number; message: string }[] {
  const groups = new Map<string, { count: number; message: string }>();
  for (const manifest of manifests) {
    const reported = manifest.matrix.filter(({ deviceEvidence }) => deviceEvidence === "reported-param");
    const unimplemented = reported.filter(({ gatewaySupport }) => gatewaySupport === "reference-only");
    const offerable = manifest.matrix.filter(({ offerable: allowed }) => allowed).map(({ id }) => id);
    const haAdapter = manifest.supported
      ? manifest.family === "homebase" ? "homebase" : manifest.family === "sensor" ? "sensor" : "camera-doorbell"
      : "none";
    const admission = manifest.supported ? "known-supported-type"
      : manifest.family === "sensor" ? "needs-sensor-adapter" : "unverified-station-protocol";
    const message = [
      `family=${manifest.family}`,
      `model=${safeModel(manifest.model)}`,
      `device_type=${manifest.deviceType ?? "missing"}`,
      `admission=${admission}`,
      `ha_adapter=${haAdapter}`,
      `recognized=${manifest.recognized}`,
      `supported=${manifest.supported}`,
      `route_ready=${manifest.matrix.some(({ deviceEvidence }) => deviceEvidence === "ready-route")}`,
      `reported_core=${reported.map(({ id }) => id).join(",") || "none"}`,
      `not_yet_implemented=${unimplemented.map(({ id }) => id).join(",") || "none"}`,
      `gateway_offerable=${offerable.join(",") || "none"}`,
      `unmapped_params=${manifest.unmappedParamCount}`,
    ].join(" ");
    const prior = groups.get(message);
    groups.set(message, { count: (prior?.count ?? 0) + 1, message });
  }
  return [...groups.values()];
}
