/**
 * Verifies the exact E21 sensor-only boundary and transient state lifecycle.
 *
 * These tests own no account, network, media, or hardware side effects. They
 * protect the inventory predicate, capability shape, and independent timers
 * consumed by the production provider and Home Assistant adapter.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { GatewayState } from "../src/domain/gateway-state.js";
import { careMonitorPushKind, careMonitorSensorState, isCareBabyMonitor } from "../src/provider/care-monitor.js";
import { describeCameraCapabilities, describeDeviceCapabilities } from "../src/provider/device-capabilities-core.js";

const exact = {
  serial: "E21",
  name: "Nursery",
  model: "T8354",
  deviceType: 86,
  category: "eufy_care",
} as const;

const noSupport = {
  homeBaseSupported: false,
  homeBaseGuardModeSupported: false,
  homeBaseRouteReady: false,
  doorbellSupported: false,
  cameraStreamSupported: false,
} as const;

test("admits only the exact reviewed E21 identity", () => {
  assert.equal(isCareBabyMonitor(exact), true);
  for (const candidate of [
    { ...exact, model: "t8354" },
    { ...exact, model: "T8354A" },
    { ...exact, model: "T8355" },
    { ...exact, deviceType: 85 },
    { ...exact, deviceType: null },
    { ...exact, deviceType: "86" as never },
    { ...exact, category: "eufy_security" },
    { ...exact, category: null },
  ]) assert.equal(isCareBabyMonitor(candidate), false);
});

test("publishes two sensor events without camera admission", () => {
  assert.deepEqual(careMonitorSensorState(exact)?.capabilities, ["crying", "sound"]);
  assert.equal(describeCameraCapabilities({ ...exact, paramTypes: [] }, {
    doorbellSupported: false, streamSupported: false,
  }).acceptedAsCamera, false);
  const manifests = describeDeviceCapabilities({ ...exact, paramTypes: [] }, noSupport);
  assert.equal(manifests.length, 1);
  assert.deepEqual(manifests[0]?.matrix.map(({ id }) => id), [
    "sensor.crying_event", "sensor.sound_event",
  ]);
  assert.equal(manifests[0]?.supported, true);
});

test("requires message type 18 and maps only crying and sound", () => {
  assert.equal(careMonitorPushKind(exact, 18, 3104), "crying");
  assert.equal(careMonitorPushKind(exact, 18, 3105), "sound");
  assert.equal(careMonitorPushKind(exact, 17, 3104), null);
  assert.equal(careMonitorPushKind(exact, 18, 3106), null);
  assert.equal(careMonitorPushKind({ ...exact, model: "T8354A" }, 18, 3104), null);
});

test("holds care flags independently and withdraws removed capabilities", async () => {
  const state = new GatewayState(15);
  const sensor = careMonitorSensorState(exact);
  assert.ok(sensor);
  const emitted: unknown[] = [];
  state.on("event", (event) => emitted.push(event));
  state.registerSensor(sensor);
  state.recordSensorDetection("E21", "crying", true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  state.recordSensorDetection("E21", "sound", true);
  assert.equal(state.listSensors()[0]?.cryingDetected, true);
  assert.equal(state.listSensors()[0]?.soundDetected, true);
  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.equal(state.listSensors()[0]?.cryingDetected, false);
  assert.equal(state.listSensors()[0]?.soundDetected, true);
  const last = emitted.at(-1) as { sensor: { soundDetected: boolean } };
  last.sensor.soundDetected = false;
  assert.equal(state.listSensors()[0]?.soundDetected, true);
  state.registerSensor({
    ...sensor,
    capabilities: ["sound"],
    cryingDetected: undefined,
  } as never);
  assert.equal(state.listSensors()[0]?.capabilities.includes("crying"), false);
  state.recordSensorDetection("E21", "crying", true);
  assert.equal(state.listSensors()[0]?.cryingDetected, undefined);
  state.close();
});
