/**
 * Checks shape-only camera discovery before Home Assistant entity creation.
 *
 * A reported parameter proves a read is available, while camera family and
 * stream-route checks prevent sensors, hubs, and unreachable peers from
 * acquiring camera features.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { cameraCapabilityLogSummaries, describeCameraCapabilities } from "../src/provider/device-capabilities-core.js";
import {
  CAMERA_CAPABILITY_CORE,
  CAMERA_DEVICE_TYPES,
  KNOWN_CAMERA_DEVICE_TYPES,
  catalogueIntegrationStatus,
} from "../src/provider/camera-capability-core.js";
import { parseMegaInventory, safeParamTypes } from "../src/provider/eufy-provider.js";
import { GatewayState } from "../src/domain/gateway-state.js";

test("publishes gateway basics and implemented battery reads", () => {
  const ids = CAMERA_CAPABILITY_CORE.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(new Set(CAMERA_CAPABILITY_CORE.map(({ family }) => family)), new Set([
    "camera", "snapshot", "motion", "person_detection", "battery",
  ]));
  assert.equal(CAMERA_CAPABILITY_CORE.every(({ evidenceParamIds }) => evidenceParamIds.every((id) => Number.isSafeInteger(id) && id >= 0 && id <= 65_535)), true);
  assert.equal(CAMERA_CAPABILITY_CORE.length, 12);
  assert.equal(CAMERA_CAPABILITY_CORE.filter(({ gatewaySupport }) => gatewaySupport === "implemented").length, 12);
  assert.equal(CAMERA_CAPABILITY_CORE.filter(({ family, gatewaySupport }) => family === "battery" && gatewaySupport === "implemented").length, 4);
});

test("retains parameter IDs without leaking provider values", () => {
  const [device] = parseMegaInventory({ devices: [{
    device_sn: "camera", device_model: "T8113-Z", device_type: 8, category: "eufy_security",
    params: [
      { param_type: 1101, param_value: "57" },
      { param_type: 1101, param_value: "secret" },
      { param_type: -1, param_value: "invalid" },
      { param_type: 99_999, param_value: "invalid" },
      { param_type: "1101junk", param_value: "invalid" },
    ],
  }] });
  assert.deepEqual(device?.paramTypes, [1101]);
  assert.equal(JSON.stringify(device).includes("secret"), false);
  assert.deepEqual(safeParamTypes("not a list"), []);
  assert.deepEqual(safeParamTypes([{ param_type: "2111" }]), [2111]);
});

test("describes one camera from its own parameter evidence and stream route", () => {
  const manifest = describeCameraCapabilities({
    serial: "camera", model: "T8113-Z", category: "eufy_security", deviceType: 8, paramTypes: [1101],
  }, { doorbellSupported: false, streamSupported: false });
  assert.equal(manifest.acceptedAsCamera, true);
  assert.deepEqual(manifest.capabilities.map(({ id }) => id), ["motion", "person", "retainedImage", "batteryLevel"]);
  assert.equal(manifest.capabilities.find(({ id }) => id === "batteryLevel")?.unit, "%");
  assert.equal(JSON.stringify(manifest).includes("57"), false);
});

test("shared core evaluation keeps live media behind a ready route", () => {
  const device = { serial: "sleeping", model: "T8113-Z", category: "eufy_security", deviceType: 8, paramTypes: [] };
  const sleeping = describeCameraCapabilities(device, { doorbellSupported: false, streamSupported: false });
  assert.equal(sleeping.matrix.find(({ id }) => id === "camera.snapshot_stored")?.deviceEvidence, "gateway-baseline");
  assert.equal(sleeping.matrix.find(({ id }) => id === "motion.motion_event")?.offerable, true);
  assert.equal(sleeping.matrix.find(({ id }) => id === "camera.live_stream")?.deviceEvidence, "requires-live-proof");
  assert.equal(sleeping.matrix.find(({ id }) => id === "camera.live_stream")?.offerable, false);
  assert.equal(sleeping.matrix.find(({ id }) => id === "snapshot.capture")?.deviceEvidence, "not-reported");

  const ready = describeCameraCapabilities(device, { doorbellSupported: false, streamSupported: true });
  assert.equal(ready.matrix.find(({ id }) => id === "camera.live_stream")?.deviceEvidence, "ready-route");
  assert.equal(ready.matrix.find(({ id }) => id === "snapshot.capture")?.deviceEvidence, "ready-route");
});

test("offers night-vision control only from reported state and a ready route", () => {
  const reported = { serial: "camera", model: "T8425", category: "eufy_security", deviceType: 47, paramTypes: [1277] };
  const blocked = describeCameraCapabilities(reported, { doorbellSupported: false, streamSupported: false, routeReady: false, homeBaseAttached: true });
  assert.equal(blocked.matrix.find(({ id }) => id === "camera.night_vision")?.offerable, false);

  const ready = describeCameraCapabilities(reported, { doorbellSupported: false, streamSupported: true, routeReady: true, homeBaseAttached: true });
  assert.equal(ready.matrix.find(({ id }) => id === "camera.night_vision")?.offerable, true);

  const standalone = describeCameraCapabilities(reported, { doorbellSupported: false, streamSupported: true, routeReady: true, homeBaseAttached: false });
  assert.equal(standalone.matrix.find(({ id }) => id === "camera.night_vision")?.offerable, false);
});

test("does not infer battery or camera features for unreported params and accessories", () => {
  const noBattery = describeCameraCapabilities({
    serial: "wired", model: "T8410", category: "eufy_security", deviceType: 31, paramTypes: [],
  }, { doorbellSupported: false, streamSupported: true });
  assert.deepEqual(noBattery.capabilities.map(({ id }) => id), ["motion", "person", "retainedImage", "liveVideo"]);

  const accessory = describeCameraCapabilities({
    serial: "entry", model: "T8900", category: "eufy_security", deviceType: 2, paramTypes: [1101],
  }, { doorbellSupported: false, streamSupported: true });
  assert.equal(accessory.acceptedAsCamera, false);
  assert.deepEqual(accessory.capabilities, []);

  const mains = describeCameraCapabilities({
    serial: "floodlight", model: "T8425", category: "eufy_security", deviceType: 47, paramTypes: [1101],
  }, { doorbellSupported: false, streamSupported: true });
  assert.equal(mains.capabilities.some(({ id }) => id === "batteryLevel"), false);
  assert.equal(mains.matrix.find(({ id }) => id === "battery.level")?.deviceEvidence, "suppressed-sentinel");
});

test("suppresses T817L battery-shaped fields without changing camera support", () => {
  const manifest = describeCameraCapabilities({
    serial: "usb-camera", model: "T817L", category: "eufy_security", deviceType: 10031,
    paramTypes: [1101, 2111, 1138],
  }, { doorbellSupported: false, streamSupported: true });

  assert.equal(manifest.acceptedAsCamera, true);
  assert.equal(manifest.capabilities.some(({ id }) => id.startsWith("battery")), false);
  assert.deepEqual(
    manifest.matrix.filter(({ family }) => family === "battery").map(({ deviceEvidence, offerable }) => ({ deviceEvidence, offerable })),
    [
      { deviceEvidence: "suppressed-sentinel", offerable: false },
      { deviceEvidence: "suppressed-sentinel", offerable: false },
      { deviceEvidence: "suppressed-sentinel", offerable: false },
      { deviceEvidence: "suppressed-sentinel", offerable: false },
    ],
  );
  assert.match(
    cameraCapabilityLogSummaries([manifest])[0]?.message ?? "",
    /battery_read=suppressed reported_reads=0 reported_core=none/,
  );
});

test("describes only battery reads reported by this camera", () => {
  const manifest = describeCameraCapabilities({
    serial: "battery", model: "T8170", category: "eufy_security", deviceType: 48,
    paramTypes: [1101, 2111, 1138],
  }, { doorbellSupported: false, streamSupported: true });
  assert.deepEqual(manifest.capabilities.filter(({ id }) => id.startsWith("battery")).map(({ id, kind, unit }) => ({ id, kind, unit })), [
    { id: "batteryLevel", kind: "measurement", unit: "%" },
    { id: "batteryCharging", kind: "state", unit: null },
    { id: "batteryTemperature", kind: "measurement", unit: "°C" },
  ]);
});

test("admits the EufyCam E40 camera type", () => {
  const manifest = describeCameraCapabilities({
    serial: "e40", model: "T8144", category: "eufy_security", deviceType: 49, paramTypes: [],
  }, { doorbellSupported: false, streamSupported: true });

  assert.equal(manifest.acceptedAsCamera, true);
  assert.equal(manifest.reviewCandidate, false);
  assert.equal(manifest.peerRouteReady, true);
  assert.equal(manifest.capabilities.some(({ id }) => id === "liveVideo"), true);
});

test("admits catalogued cameras with ready routes at their evidence status", () => {
  const reportedModels = [
    { model: "T8123", deviceType: 61, status: "supported" },
    { model: "T8130", deviceType: 32, status: "ready_to_test" },
    { model: "T8131", deviceType: 33, status: "ready_to_test" },
    { model: "T8B00", deviceType: 64, status: "ready_to_test" },
    { model: "T8420", deviceType: 3, status: "ready_to_test" },
    { model: "T8441", deviceType: 45, status: "supported" },
  ] as const;

  for (const { model, deviceType, status } of reportedModels) {
    const manifest = describeCameraCapabilities({
      serial: "reported-solocam", model, category: "eufy_security", deviceType, paramTypes: [],
    }, { doorbellSupported: false, streamSupported: false, routeReady: true });

    assert.equal(catalogueIntegrationStatus(model, deviceType), status);
    assert.equal(manifest.acceptedAsCamera, true);
    assert.equal(manifest.reviewCandidate, false);
    assert.equal(manifest.peerRouteReady, true);
  }
});

test("offers compatibility feedback only for the exact ready-to-test model", () => {
  assert.equal(catalogueIntegrationStatus("T8140-R", 14), "ready_to_test");
  assert.equal(catalogueIntegrationStatus("T8224", 96), "supported");
  assert.equal(catalogueIntegrationStatus("T8223", 96), "ready_to_test");
  assert.equal(catalogueIntegrationStatus("unknown", 96), null);
  assert.equal(catalogueIntegrationStatus("T9999", 65_000), null);
});

test("keeps advanced research out of the published device matrix", () => {
  const manifest = describeCameraCapabilities({
    serial: "indoor", model: "T8410", category: "eufy_security", deviceType: 31,
    paramTypes: [6043, 6044, 1240, 1101, 9_999],
  }, { doorbellSupported: false, streamSupported: true });
  assert.equal(manifest.matrix.length, 12);
  assert.equal(manifest.matrix.some(({ id }) => id === "camera.sound_detection"), false);
  assert.equal(manifest.matrix.find(({ id }) => id === "battery.level")?.offerable, true);
  assert.equal(manifest.matrix.find(({ id }) => id === "camera.live_stream")?.offerable, true);
  assert.deepEqual(manifest.unmappedParamIds, [6043, 6044, 1240, 9_999]);
});

test("marks an unknown camera-like row for review without admitting it", () => {
  const candidate = describeCameraCapabilities({
    serial: "new", model: "T9999", category: "eufy_security", deviceType: 109,
    paramTypes: [1004, 1056],
  }, { doorbellSupported: false, streamSupported: false, routeReady: true });
  assert.equal(candidate.acceptedAsCamera, false);
  assert.equal(candidate.reviewCandidate, true);
  assert.equal(candidate.peerRouteReady, true);
  assert.equal(candidate.matrix.some(({ offerable }) => offerable), false);
  assert.match(cameraCapabilityLogSummaries([candidate])[0]?.message ?? "", /admission=review-camera-like ha_adapter=none accepted=false.*peer_route_ready=true media_supported=false/);

  const sensor = describeCameraCapabilities({
    serial: "sensor", model: "T8900", category: "eufy_security", deviceType: 2,
    paramTypes: [1004, 1056],
  }, { doorbellSupported: false, streamSupported: false, routeReady: true });
  assert.equal(sensor.reviewCandidate, false);

  const station = describeCameraCapabilities({
    serial: "station", model: "T8010", category: "eufy_security", deviceType: 0,
    paramTypes: [1004, 1056],
  }, { doorbellSupported: false, streamSupported: false, routeReady: true });
  assert.equal(station.reviewCandidate, false);
});

test("admits the reported T8110 through its existing camera handler", () => {
  const catalogued = describeCameraCapabilities({
    serial: "known", model: "T8110", category: "eufy_security", deviceType: 10035,
    paramTypes: [],
  }, { doorbellSupported: false, streamSupported: true, routeReady: true });

  assert.equal(catalogued.acceptedAsCamera, true);
  assert.equal(catalogued.reviewCandidate, false);
  assert.equal(catalogued.reason, "supported-camera-type");
  assert.match(
    cameraCapabilityLogSummaries([catalogued])[0]?.message ?? "",
    /admission=known-camera-type ha_adapter=camera accepted=true/,
  );
});

test("keeps a declared alternate camera type diagnostic-only", () => {
  assert.equal(KNOWN_CAMERA_DEVICE_TYPES.has(95), true);
  assert.equal(CAMERA_DEVICE_TYPES.has(95), false);
});

test("groups camera capability logs without device identifiers or parameter values", () => {
  const manifest = describeCameraCapabilities({
    serial: "PRIVATE-SERIAL", model: "T8410", category: "eufy_security", deviceType: 31,
    paramTypes: [1101, 9_999],
  }, { doorbellSupported: false, streamSupported: true });
  const summaries = cameraCapabilityLogSummaries([manifest, { ...manifest, serial: "ANOTHER-PRIVATE-SERIAL" }]);
  assert.equal(summaries[0]?.count, 2);
  assert.match(summaries[0]?.message ?? "", /model=T8410.*admission=known-camera-type ha_adapter=camera.*battery_read=reported.*reported_reads=1 reported_core=battery.level not_yet_implemented=none.*gateway_offerable=.*battery.level.*unmapped_params=1/);
  assert.equal(JSON.stringify(summaries).includes("PRIVATE-SERIAL"), false);
  assert.equal(JSON.stringify(summaries).includes("9999"), false);
});

test("returns independent gateway copies of camera manifests", () => {
  const state = new GatewayState();
  const manifest = describeCameraCapabilities({
    serial: "camera", model: "T8210", category: "eufy_security", deviceType: 7, paramTypes: [],
  }, { doorbellSupported: true, streamSupported: true });
  state.updateCameraCapabilities([manifest]);
  const listed = state.listCameraCapabilities();
  assert.deepEqual(listed[0]?.capabilities.map(({ id }) => id), ["motion", "person", "retainedImage", "doorbellPress", "liveVideo"]);
  const mutable = listed as unknown as { capabilities: { id: string }[] }[];
  mutable[0]!.capabilities[0]!.id = "batteryLevel";
  assert.equal(state.listCameraCapabilities()[0]?.capabilities[0]?.id, "motion");
});
