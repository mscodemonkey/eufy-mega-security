/**
 * Verifies small sensor, HomeBase, and doorbell baselines from Mega inventory.
 *
 * These tests keep unsupported sensor candidates out of HA admission, keep
 * T9000 control claims out of HomeBase 3, and check gateway copies and logs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { GatewayState } from "../src/domain/gateway-state.js";
import { describeDeviceCapabilities, deviceCapabilityLogSummaries } from "../src/provider/device-capabilities-core.js";
import { DOORBELL_CAPABILITY_CORE } from "../src/provider/doorbell-capability-core.js";
import { HOMEBASE_CAPABILITY_CORE } from "../src/provider/homebase-capability-core.js";
import { SENSOR_CAPABILITY_CORE } from "../src/provider/sensor-capability-core.js";

const noSupport = { homeBaseSupported: false, homeBaseRouteReady: false, doorbellSupported: false, cameraStreamSupported: false } as const;

test("keeps published non-camera catalogues small and unique", () => {
  const entries = [...SENSOR_CAPABILITY_CORE, ...HOMEBASE_CAPABILITY_CORE, ...DOORBELL_CAPABILITY_CORE];
  assert.equal(entries.length, 22);
  assert.equal(new Set(entries.map(({ id }) => id)).size, entries.length);
  assert.equal(entries.every(({ evidenceParamIds }) => evidenceParamIds.every((id) => Number.isSafeInteger(id) && id >= 0 && id <= 65_535)), true);
  assert.equal(SENSOR_CAPABILITY_CORE.every(({ gatewaySupport }) => gatewaySupport === "implemented"), true);
});

test("admits a contact sensor only for its reported implemented fields", () => {
  const [sensor] = describeDeviceCapabilities({
    serial: "PRIVATE", model: "T8900", category: "eufy_security", deviceType: 2,
    paramTypes: [1550, 1551, 1101, 9_999],
  }, noSupport);
  assert.equal(sensor?.family, "sensor");
  assert.equal(sensor?.recognized, true);
  assert.equal(sensor?.supported, true);
  assert.equal(sensor?.matrix.find(({ id }) => id === "sensor.contact_open")?.deviceEvidence, "reported-param");
  assert.deepEqual(sensor?.matrix.filter(({ offerable }) => offerable).map(({ id }) => id), [
    "sensor.contact_open", "sensor.contact_event", "sensor.battery_level", "sensor.last_seen",
  ]);
  assert.equal(sensor?.unmappedParamCount, 1);
});

test("does not infer contact state for a PIR sensor or camera", () => {
  const [motion] = describeDeviceCapabilities({
    serial: "PIR", model: "T8910", category: "eufy_security", deviceType: 10, paramTypes: [1101],
  }, noSupport);
  assert.equal(motion?.matrix.find(({ id }) => id === "sensor.contact_open")?.deviceEvidence, "not-reported");
  assert.equal(motion?.matrix.find(({ id }) => id === "sensor.motion_event")?.offerable, true);
  assert.deepEqual(describeDeviceCapabilities({
    serial: "CAMERA", model: "T8113", category: "eufy_security", deviceType: 8, paramTypes: [1101],
  }, noSupport), []);
});

test("offers read-only discovery for HomeBase 2 and controls only for HomeBase 3", () => {
  const [managed] = describeDeviceCapabilities({
    serial: "HB3", model: "T8030", category: "eufy_security", deviceType: 18, paramTypes: [],
  }, { ...noSupport, homeBaseSupported: true, homeBaseRouteReady: true });
  assert.equal(managed?.supported, true);
  assert.equal(managed?.matrix.find(({ id }) => id === "homebase.guard_mode_write")?.offerable, true);
  assert.equal(managed?.matrix.find(({ id }) => id === "homebase.emmc_storage")?.deviceEvidence, "ready-route");

  const [unready] = describeDeviceCapabilities({
    serial: "HB3", model: "T8030", category: "eufy_security", deviceType: 18, paramTypes: [],
  }, { ...noSupport, homeBaseSupported: true });
  assert.equal(unready?.matrix.find(({ id }) => id === "homebase.available")?.offerable, true);
  assert.equal(unready?.matrix.find(({ id }) => id === "homebase.connected")?.offerable, true);
  assert.equal(unready?.matrix.find(({ id }) => id === "homebase.guard_mode_write")?.offerable, false);

  const [homeBase2] = describeDeviceCapabilities({
    serial: "HB2", model: "T8010", category: "eufy_security", deviceType: 0, paramTypes: [],
  }, { ...noSupport, homeBaseRouteReady: true });
  assert.equal(homeBase2?.recognized, true);
  assert.equal(homeBase2?.supported, true);
  assert.deepEqual(
    homeBase2?.matrix.filter(({ offerable }) => offerable).map(({ id }) => id),
    ["homebase.available", "homebase.camera_route"],
  );
  assert.equal(homeBase2?.matrix.find(({ id }) => id === "homebase.guard_mode_write")?.offerable, false);

  const [t9000] = describeDeviceCapabilities({
    serial: "T9000", model: "T9000", category: "eufy_security", deviceType: 27, paramTypes: [],
  }, { ...noSupport, homeBaseRouteReady: true });
  assert.equal(t9000?.recognized, true);
  assert.equal(t9000?.supported, false);
  assert.equal(t9000?.matrix.some(({ offerable }) => offerable), false);
  assert.match(deviceCapabilityLogSummaries([t9000!])[0]?.message ?? "", /admission=unverified-station-protocol ha_adapter=none.*supported=false/);
});

test("layers press onto the existing camera and battery baseline for a doorbell", () => {
  const [doorbell] = describeDeviceCapabilities({
    serial: "BELL", model: "T8214", category: "eufy_security", deviceType: 94,
    paramTypes: [1101, 2111],
  }, { ...noSupport, doorbellSupported: true, cameraStreamSupported: true });
  assert.equal(doorbell?.family, "doorbell");
  assert.equal(doorbell?.supported, true);
  assert.equal(doorbell?.matrix.find(({ id }) => id === "doorbell.press")?.offerable, true);
  assert.equal(doorbell?.matrix.find(({ id }) => id === "camera.live_stream")?.offerable, true);
  assert.equal(doorbell?.matrix.find(({ id }) => id === "battery.level")?.offerable, true);
  assert.equal(doorbell?.matrix.length, 13);
});

test("groups non-camera diagnostics without private identifiers", () => {
  const [sensor] = describeDeviceCapabilities({
    serial: "PRIVATE-SERIAL", model: "T8900", category: "eufy_security", deviceType: 2, paramTypes: [1550],
  }, noSupport);
  const lines = deviceCapabilityLogSummaries([sensor!, { ...sensor!, serial: "ANOTHER-PRIVATE-SERIAL" }]);
  assert.equal(lines[0]?.count, 2);
  assert.match(lines[0]?.message ?? "", /family=sensor model=T8900.*admission=known-supported-type ha_adapter=sensor.*supported=true.*reported_core=sensor.contact_open,sensor.contact_event.*not_yet_implemented=none.*gateway_offerable=sensor.contact_open,sensor.contact_event/);
  assert.equal(JSON.stringify(lines).includes("PRIVATE-SERIAL"), false);
});

test("returns independent copies of product-family decisions", () => {
  const [sensor] = describeDeviceCapabilities({
    serial: "PRIVATE", model: "T8900", category: "eufy_security", deviceType: 2, paramTypes: [1550],
  }, noSupport);
  const state = new GatewayState();
  state.updateDeviceCapabilities([sensor!]);
  const returned = state.listDeviceCapabilities() as unknown as { matrix: { id: string }[] }[];
  returned[0]!.matrix[0]!.id = "changed";
  assert.equal(state.listDeviceCapabilities()[0]?.matrix[0]?.id, "sensor.contact_open");
});
