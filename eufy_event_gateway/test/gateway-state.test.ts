/**
 * Tests the protocol-neutral camera state machine.
 *
 * These cases establish how transient detection flags, retained snapshots,
 * person recognition ordering, and timer-based clearing appear to API/SSE
 * consumers.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { GatewayState, normalizePersonName } from "../src/domain/gateway-state.js";

const camera = {
  serial: "camera-1",
  name: "Driveway",
  model: "T8142",
  catalogueStatus: "ready_to_test" as const,
  stationSerial: "homebase-1",
  streamSupported: true,
  doorbellSupported: false,
};

test("retains a recognized person after the transient sensor clears", () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  state.recordPerson(camera.serial, true, "  Alex  ", new Date("2026-09-11T01:02:03Z"));
  state.recordPerson(camera.serial, false, null);

  const result = state.getCamera(camera.serial);
  assert.equal(result.catalogueStatus, "ready_to_test");
  assert.equal(result.personDetected, false);
  assert.equal(result.lastDetection?.personName, "Alex");
  assert.equal(result.lastDetection?.recognized, true);
  assert.equal(result.lastDetection?.occurredAt, "2026-09-11T01:02:03.000Z");
});

test("exposes only provider-confirmed timed light support", () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  assert.equal(state.getCamera(camera.serial).timedLightControlSupported, false);

  state.registerCamera({ ...camera, timedLightControlSupported: true });
  assert.equal(state.getCamera(camera.serial).timedLightControlSupported, true);
});

test("does not claim an identity for Eufy unknown values", () => {
  assert.equal(normalizePersonName(undefined), null);
  assert.equal(normalizePersonName(""), null);
  assert.equal(normalizePersonName("Unknown"), null);
  assert.equal(normalizePersonName("Unknown Person"), null);
  assert.equal(normalizePersonName("No Person"), null);
});

test("keeps person detection as the latest richer event after simultaneous motion", () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  state.recordMotion(camera.serial, true, new Date("2026-09-11T01:02:03Z"));
  state.recordPerson(camera.serial, true, "Alex", new Date("2026-09-11T01:02:04Z"));

  assert.equal(state.getCamera(camera.serial).lastDetection?.kind, "person");
});

test("does not downgrade a recent named-person detection when a generic motion pulse arrives", () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  state.recordPerson(camera.serial, true, "Alex", new Date("2026-09-11T01:02:03Z"));
  state.recordMotion(camera.serial, true, new Date("2026-09-11T01:02:04Z"));

  assert.equal(state.getCamera(camera.serial).lastDetection?.personName, "Alex");
});

test("records a later motion as a new detection", () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  state.recordPerson(camera.serial, true, "Alex", new Date("2026-09-11T01:02:03Z"));
  state.recordMotion(camera.serial, true, new Date("2026-09-11T01:02:14Z"));

  assert.equal(state.getCamera(camera.serial).lastDetection?.kind, "motion");
});

test("keeps expanded AI detections distinct and clears their transient flags", async () => {
  const state = new GatewayState(20);
  state.registerCamera(camera);
  state.recordDetection(camera.serial, "pet", true);
  state.recordDetection(camera.serial, "vehicle", true);

  assert.equal(state.getCamera(camera.serial).motionDetected, true);
  assert.equal(state.getCamera(camera.serial).petDetected, true);
  assert.equal(state.getCamera(camera.serial).vehicleDetected, true);
  assert.equal(state.getCamera(camera.serial).lastDetection?.kind, "vehicle");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(state.getCamera(camera.serial).motionDetected, false);
  assert.equal(state.getCamera(camera.serial).petDetected, false);
  assert.equal(state.getCamera(camera.serial).vehicleDetected, false);
});

test("keeps general motion active across overlapping visual detections", () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  state.recordMotion(camera.serial, true);
  state.recordPerson(camera.serial, true, null);
  state.recordDetection(camera.serial, "pet", true);

  state.recordMotion(camera.serial, false);
  assert.equal(state.getCamera(camera.serial).motionDetected, true);
  state.recordPerson(camera.serial, false, null);
  assert.equal(state.getCamera(camera.serial).motionDetected, true);
  state.recordDetection(camera.serial, "pet", false);
  assert.equal(state.getCamera(camera.serial).motionDetected, false);

  state.recordDetection(camera.serial, "sound", true);
  assert.equal(state.getCamera(camera.serial).motionDetected, false);
  state.close();
});

test("records and clears a transient doorbell press for supported cameras", async () => {
  const state = new GatewayState(10);
  const doorbell = { ...camera, doorbellSupported: true };
  const events: unknown[] = [];
  state.on("event", (event) => events.push(event));
  state.registerCamera(doorbell);
  state.recordDoorbell(doorbell.serial, true, new Date("2026-09-11T01:02:03Z"));

  assert.equal(state.getCamera(doorbell.serial).doorbellPressed, true);
  assert.equal(state.getCamera(doorbell.serial).lastDetection?.kind, "doorbell");
  assert.equal((events[1] as { type: string }).type, "detection");

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(state.getCamera(doorbell.serial).doorbellPressed, false);
  state.close();
});

test("ignores doorbell presses from cameras without doorbell support", () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  state.recordDoorbell(camera.serial, true);

  assert.equal(state.getCamera(camera.serial).doorbellPressed, false);
  assert.equal(state.getCamera(camera.serial).lastDetection, null);
});

test("clears detection pulses when a provider never sends a false event", async () => {
  const state = new GatewayState(10);
  state.registerCamera(camera);
  state.recordMotion(camera.serial, true);
  state.recordPerson(camera.serial, true, null);

  await new Promise((resolve) => setTimeout(resolve, 25));

  const result = state.getCamera(camera.serial);
  assert.equal(result.motionDetected, false);
  assert.equal(result.personDetected, false);
  assert.equal(result.lastDetection?.kind, "person");
});

test("extends a detection pulse when another true event arrives", async () => {
  const state = new GatewayState(25);
  state.registerCamera(camera);
  state.recordPerson(camera.serial, true, null);

  await new Promise((resolve) => setTimeout(resolve, 15));
  state.recordPerson(camera.serial, true, null);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(state.getCamera(camera.serial).personDetected, true);

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(state.getCamera(camera.serial).personDetected, false);
});

test("retains immutable HomeBase snapshots and emits station updates", () => {
  const state = new GatewayState();
  const events: unknown[] = [];
  state.on("event", (event) => events.push(event));
  const station = {
    serial: "homebase-1",
    name: "HomeBase",
    model: "T8030",
    firmware: "3.6.0.1",
    available: true,
    cameraRouteReady: true,
    controlsSupported: true,
    guardModeControlSupported: true,
    stateReadSupported: true,
    homeBaseSirenControlSupported: true,
    connected: true,
    guardMode: 0,
    effectiveMode: 0,
    alarmActive: false,
    alarmVolume: 20,
    promptVolume: 10,
    alarmTone: 2,
    storage: {
      emmc: { status: "normal", totalBytes: 100, freeBytes: 40 },
      hdd: null,
    },
  };

  state.registerStation(station);
  station.storage.emmc.freeBytes = 0;

  assert.equal(state.getStation(station.serial).storage.emmc?.freeBytes, 40);
  assert.equal((events[0] as { type: string }).type, "station-updated");
});

test("retains standalone contact state and clears transient sensor motion", async () => {
  const state = new GatewayState(10);
  state.registerSensor({
    serial: "sensor-1", name: "Side gate", model: "T8900", deviceType: 2,
    available: true, capabilities: ["battery", "contact", "motion"],
    batteryLevel: 74, contactOpen: false, lastSeen: null, motionDetected: false,
  });
  state.updateSensorContact("sensor-1", true);
  state.recordSensorMotion("sensor-1", true);
  assert.equal(state.listSensors()[0]?.contactOpen, true);
  assert.equal(state.listSensors()[0]?.motionDetected, true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(state.listSensors()[0]?.motionDetected, false);
  state.close();
});
