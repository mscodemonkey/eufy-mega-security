/**
 * Tests the provider's pure Mega-to-domain transformations.
 *
 * The cases cover inventory field aliases, safe diagnostics and push logs,
 * and conservative person-name rules without starting a real account or push
 * receiver.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  cameraDetectionKind,
  cameraEnableRawValue,
  confirmStationWrite,
  inventoryDiagnostics,
  inventoryLogSummaries,
  initialHomeBaseState,
  isDiscoveredHomeBase,
  isDoorbellDevice,
  isPpcsStreamSupported,
  parseMegaInventory,
  personNameFromPush,
  ppcsStreamLogSummary,
  ppcsStreamRoute,
  safePushLogSummary,
  safeInventoryReads,
} from "../src/provider/eufy-provider.js";
import { HomeBaseCommandAcknowledgementTimeoutError, type HomeBasePpcsState } from "../src/stream/homebase-ppcs.js";

const event = (overrides: Partial<Parameters<typeof personNameFromPush>[0]>): Parameters<typeof personNameFromPush>[0] => ({
  eventType: null,
  personName: null,
  content: null,
  ...overrides,
});

const stationState = (alarmVolume: number | null): HomeBasePpcsState => ({
  firmware: null,
  guardMode: null,
  effectiveMode: null,
  alarmVolume,
  promptVolume: null,
  alarmTone: null,
  storage: null,
});

test("accepts matching T8030 readback after an acknowledgement timeout", async () => {
  let writes = 0;
  const result = await confirmStationWrite(
    "alarmVolume",
    18,
    async () => {
      writes += 1;
      throw new HomeBaseCommandAcknowledgementTimeoutError();
    },
    async () => stationState(18),
  );

  assert.equal(writes, 1);
  assert.equal(result.acknowledgementTimedOut, true);
  assert.equal(result.observed.alarmVolume, 18);
});

test("does not hide a rejected command or mismatched timeout readback", async () => {
  await assert.rejects(
    confirmStationWrite(
      "alarmVolume",
      18,
      async () => { throw new Error("HomeBase rejected command (-1)"); },
      async () => stationState(18),
    ),
    /HomeBase rejected command/,
  );
  await assert.rejects(
    confirmStationWrite(
      "alarmVolume",
      18,
      async () => { throw new HomeBaseCommandAcknowledgementTimeoutError(); },
      async () => stationState(17),
    ),
    /acknowledgement timed out and readback did not confirm alarmVolume/,
  );
});

test("uses a structured person name when Eufy supplies one", () => {
  assert.equal(personNameFromPush(event({ eventType: 3111, personName: "Alex" })), "Alex");
});

test("extracts a name from explicit HB3 identity notification text", () => {
  assert.equal(personNameFromPush(event({ eventType: 3111, content: "Alex has been detected." })), "Alex");
  assert.equal(personNameFromPush(event({ eventType: 3111, content: "Test camera: Alex was spotted in the garden" })), "Alex");
});

test("never infers an identity from generic or non-identity notifications", () => {
  assert.equal(personNameFromPush(event({ eventType: 3111, content: "Someone has been spotted" })), null);
  assert.equal(personNameFromPush(event({ eventType: 3111, content: "Stranger was spotted" })), null);
  assert.equal(personNameFromPush(event({ eventType: 3101, content: "Alex has been detected" })), null);
});

test("parses only whitelisted Mega inventory fields and de-duplicates serials", () => {
  const result = parseMegaInventory({ devices: [{
    device_sn: "T8113ABC", device_name: "Test camera", device_model: "T8113-Z", parent_sn: "T8030ABC",
    device_type: 8, device_channel: 3, category: "eufy_security", p2p_did: "ABC-123456-XYZ",
    device_key: "must-not-escape",
    charging_days: "44",
  }, { device_sn: "T8113ABC", device_name: "duplicate" }, { device_name: "missing serial" }] });

  assert.deepEqual(result, [{
    serial: "T8113ABC", name: "Test camera", model: "T8113-Z", parentSerial: "T8030ABC",
    deviceType: 8, category: "eufy_security", channel: 3, p2pDid: "ABC-123456-XYZ",
    adminUserId: null, userName: null, firmware: null, p2pConnection: null, cipherId: null,
    paramTypes: [], reads: { lastChargingDays: 44 },
  }]);
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
});

test("decodes only validated capability-backed inventory values", () => {
  assert.deepEqual(safeInventoryReads([
    { param_type: 1101, param_value: "82" },
    { param_type: 2111, param_value: "4" },
    { param_type: 1198, param_value: "96" },
    { param_type: 1138, param_value: "24.5" },
    { param_type: 1550, param_value: "1" },
    { param_type: 1551, param_value: "1789500000" },
    { param_type: 9999, param_value: "private" },
  ]), {
    batteryLevel: 82,
    batteryCharging: true,
    batteryHealth: 96,
    batteryTemperature: 24.5,
    contactOpen: true,
    lastSeen: "2026-09-15T19:20:00.000Z",
  });
  assert.deepEqual(safeInventoryReads([
    { param_type: 1101, param_value: "101" },
    { param_type: 1550, param_value: "unknown" },
  ]), {});
  assert.equal(safeInventoryReads([
    { param_type: 1101, param_value: "50" },
    { param_type: 1101, param_value: "49" },
  ]).batteryLevel, 49);
});

test("decodes reported camera enablement with family-specific polarity", () => {
  assert.equal(safeInventoryReads([{ param_type: 1035, param_value: "0" }], 88).enabled, true);
  assert.equal(safeInventoryReads([{ param_type: 1035, param_value: "1" }], 88).enabled, false);
  assert.equal(safeInventoryReads([{ param_type: 1035, param_value: "1" }], 31).enabled, true);
  assert.equal(safeInventoryReads([{ param_type: 2001, param_value: "0" }], 31).enabled, false);
  assert.equal(safeInventoryReads([{ param_type: 1035, param_value: "2" }], 88).enabled, undefined);
});

test("decodes the reported motion-detection switch without inventing it", () => {
  assert.equal(safeInventoryReads([{ param_type: 1011, param_value: "1" }]).motionDetectionEnabled, true);
  assert.equal(safeInventoryReads([{ param_type: 1011, param_value: "0" }]).motionDetectionEnabled, false);
  assert.equal(safeInventoryReads([{ param_type: 1011, param_value: "2" }]).motionDetectionEnabled, undefined);
});

test("writes battery and indoor camera enablement with the matching polarity", () => {
  assert.equal(cameraEnableRawValue(88, true), 0);
  assert.equal(cameraEnableRawValue(88, false), 1);
  assert.equal(cameraEnableRawValue(31, true), 1);
  assert.equal(cameraEnableRawValue(31, false), 0);
});

test("accepts only bounded whole days from the cloud inventory field", () => {
  assert.equal(parseMegaInventory({ devices: [{ device_sn: "valid", charging_days: 44 }] })[0]?.reads.lastChargingDays, 44);
  assert.equal(parseMegaInventory({ devices: [{ device_sn: "negative", charging_days: -1 }] })[0]?.reads.lastChargingDays, undefined);
  assert.equal(parseMegaInventory({ devices: [{ device_sn: "fraction", charging_days: 2.5 }] })[0]?.reads.lastChargingDays, undefined);
});

test("inherits the HomeBase live-view account identity for child cameras", () => {
  const devices = parseMegaInventory({ devices: [
    { device_sn: "camera", parent_sn: "homebase", device_type: 8, category: "eufy_security" },
    { device_sn: "homebase", device_type: 18, category: "eufy_security", member: { admin_user_id: "owner" } },
  ] });
  assert.equal(devices.find(({ serial }) => serial === "camera")?.adminUserId, "owner");
});

test("discovers T8010 without enabling unverified station controls", () => {
  const [station] = parseMegaInventory({ devices: [{
    device_sn: "homebase", device_name: "HomeBase 2", device_model: "T8010",
    device_type: 0, category: "eufy_security", p2p_did: "did", p2p_conn: "connection",
    main_sw_version: "3.4.2.6h",
  }] });
  assert.ok(station);
  assert.equal(isDiscoveredHomeBase(station), true);
  assert.deepEqual(initialHomeBaseState(station, true), {
    serial: "homebase",
    name: "HomeBase 2",
    model: "T8010",
    firmware: "3.4.2.6h",
    available: true,
    cameraRouteReady: true,
    controlsSupported: false,
    homeBaseSirenControlSupported: true,
    connected: false,
    guardMode: null,
    effectiveMode: null,
    alarmActive: null,
    alarmVolume: null,
    promptVolume: null,
    alarmTone: null,
    storage: { emmc: null, hdd: null },
  });
});

test("classifies recognized Mega camera types without admitting stations or unknown devices", () => {
  const devices = parseMegaInventory({ devices: [
    { device_sn: "doorbell", device_name: "Door", device_model: "T8210", parent_sn: "homebase", device_type: 7, category: "eufy_security" },
    { device_sn: "battery", device_name: "Test camera", device_model: "T8113-Z", parent_sn: "homebase", device_type: 8, category: "eufy_security" },
    { device_sn: "c2-pro", device_name: "Driveway", device_model: "T8142-Z", parent_sn: "homebase", device_type: 15, category: "eufy_security" },
    { device_sn: "s330", device_name: "Garden", device_model: "T8160", parent_sn: "homebase", device_type: 19, category: "eufy_security" },
    { device_sn: "s300", device_name: "Side", device_model: "T8161", parent_sn: "homebase", device_type: 23, category: "eufy_security" },
    { device_sn: "wall-light", device_name: "Side", device_model: "T84A1", device_type: 151, device_channel: 0, category: "eufy_security" },
    { device_sn: "indoor", device_name: "Indoor", device_model: "T8410", parent_sn: "homebase", device_type: 31, category: "eufy_security" },
    { device_sn: "solocam", device_name: "SoloCam", device_model: "T8134", parent_sn: "homebase", device_type: 63, category: "eufy_security" },
    { device_sn: "new-doorbell", device_name: "Front", device_model: "T8213", parent_sn: "homebase", device_type: 91, category: "eufy_security" },
    { device_sn: "wired", device_name: "Front", device_model: "T817L", parent_sn: "homebase", device_type: 10031, category: "eufy_security" },
    { device_sn: "homebase", device_name: "HomeBase", device_model: "T8030", device_type: 18, category: "eufy_security" },
    { device_sn: "unknown", device_name: "Unknown", device_model: "T9999", device_type: 999, category: "eufy_security" },
    { device_sn: "wrong-category", device_name: "Wrong category", device_model: "T8134", device_type: 63, category: "other" },
  ] });
  assert.deepEqual(inventoryDiagnostics(devices).map(({ serial, acceptedAsCamera }) => [serial, acceptedAsCamera]), [
    ["doorbell", true], ["battery", true], ["c2-pro", true], ["s330", true], ["s300", true], ["wall-light", true], ["indoor", true],
    ["solocam", true], ["new-doorbell", true], ["wired", true], ["homebase", false],
    ["unknown", false], ["wrong-category", false],
  ]);
});

test("admits T8142-Z inventory through a ready HomeBase 2", () => {
  const devices = parseMegaInventory({ devices: [
    {
      device_sn: "camera", device_model: "T8142-Z", parent_sn: "station", device_type: 15,
      device_channel: 2, category: "eufy_security",
    },
    {
      device_sn: "station", device_model: "T8010", device_type: 0,
      category: "eufy_security", p2p_did: "did", p2p_conn: "connection",
    },
  ] });
  const summaries = inventoryLogSummaries(devices, new Set(["station"]));
  assert.equal(summaries[0]?.acceptedAsCamera, true);
  assert.equal(summaries[0]?.streamRoute, "homebase");
  assert.equal(summaries[0]?.streamSupported, true);
});

test("accepts T8161 inventory through a ready HomeBase 3", () => {
  const devices = parseMegaInventory({ devices: [
    {
      device_sn: "camera", device_model: "T8161", parent_sn: "station", device_type: 23,
      device_channel: 2, category: "eufy_security",
    },
    {
      device_sn: "station", device_model: "T8030", device_type: 18,
      category: "eufy_security", p2p_did: "did", p2p_conn: "connection",
    },
  ] });
  const summaries = inventoryLogSummaries(devices, new Set(["station"]));
  assert.equal(summaries[0]?.acceptedAsCamera, true);
  assert.equal(summaries[0]?.streamRoute, "homebase");
  assert.equal(summaries[0]?.streamSupported, true);
});

test("admits issue 22 cameras through their inventoried parent peers", () => {
  const devices = parseMegaInventory({ devices: [
    { device_sn: "doorbell", device_model: "T8214", parent_sn: "station-one", device_type: 94,
      device_channel: 1, category: "eufy_security" },
    { device_sn: "camera", device_model: "T8416", parent_sn: "station-two", device_type: 104,
      device_channel: 2, category: "eufy_security" },
    { device_sn: "station-one", device_model: "T8023", device_type: 25,
      category: "eufy_security", p2p_did: "did-one", p2p_conn: "connection-one" },
    { device_sn: "station-two", device_model: "T8030", device_type: 18,
      category: "eufy_security", p2p_did: "did-two", p2p_conn: "connection-two" },
  ] });
  const summaries = inventoryLogSummaries(devices, new Set(["station-one", "station-two"]));
  assert.deepEqual(summaries.map(({ acceptedAsCamera, streamRoute, streamSupported }) => ({
    acceptedAsCamera, streamRoute, streamSupported,
  })), [
    { acceptedAsCamera: true, streamRoute: "homebase", streamSupported: true },
    { acceptedAsCamera: true, streamRoute: "homebase", streamSupported: true },
    { acceptedAsCamera: false, streamRoute: "unavailable", streamSupported: false },
    { acceptedAsCamera: false, streamRoute: "unavailable", streamSupported: false },
  ]);
});

test("admits issue 27 Mega cameras through a ready T9000 HomeBase", () => {
  const issue27Cameras = [
    { serial: "t8162", model: "T8162", deviceType: 26, channel: 1 },
    { serial: "t8170", model: "T8170", deviceType: 48, channel: 2 },
    { serial: "t81a0", model: "T81A0", deviceType: 10005, channel: 3 },
    { serial: "t8425", model: "T8425", deviceType: 47, channel: 4 },
  ];
  const devices = parseMegaInventory({ devices: [
    ...issue27Cameras.map(({ serial, model, deviceType, channel }) => ({
      device_sn: serial, device_model: model, parent_sn: "t9000", device_type: deviceType,
      device_channel: channel, category: "eufy_security",
    })),
    {
      device_sn: "t9000", device_model: "T9000", device_type: 27,
      category: "eufy_security", p2p_did: "did", p2p_conn: "connection",
    },
    {
      device_sn: "wrong-category", device_model: "T8162", device_type: 26,
      parent_sn: "t9000", device_channel: 5, category: "other",
    },
  ] });
  const summaries = inventoryLogSummaries(devices, new Set(["t9000"]));

  assert.deepEqual(inventoryDiagnostics(devices).map(({ serial, acceptedAsCamera }) => [serial, acceptedAsCamera]), [
    ["t8162", true], ["t8170", true], ["t81a0", true], ["t8425", true],
    ["t9000", false], ["wrong-category", false],
  ]);
  assert.deepEqual(summaries.slice(0, 4).map(({ deviceType, acceptedAsCamera, streamSupported }) => ({
    deviceType, acceptedAsCamera, streamSupported,
  })), [
    { deviceType: 26, acceptedAsCamera: true, streamSupported: true },
    { deviceType: 48, acceptedAsCamera: true, streamSupported: true },
    { deviceType: 10005, acceptedAsCamera: true, streamSupported: true },
    { deviceType: 47, acceptedAsCamera: true, streamSupported: true },
  ]);
  assert.equal(summaries.find(({ deviceType, category }) => deviceType === 27 && category === "eufy_security")?.acceptedAsCamera, false);
  assert.equal(summaries.find(({ category }) => category === "other")?.acceptedAsCamera, false);
});

test("identifies the T8214 doorbell without classifying the T8416 indoor camera as one", () => {
  assert.equal(isDoorbellDevice({ category: "eufy_security", deviceType: 5 }), true);
  assert.equal(isDoorbellDevice({ category: "eufy_security", deviceType: 94 }), true);
  assert.equal(isDoorbellDevice({ category: "eufy_security", deviceType: 96 }), true);
  assert.equal(isDoorbellDevice({ category: "eufy_security", deviceType: 203 }), true);
  assert.equal(isDoorbellDevice({ category: "eufy_security", deviceType: 104 }), false);
});

test("admits T8224 type 96 as a camera with confirmed press support", () => {
  const [doorbell] = parseMegaInventory({ devices: [{
    device_sn: "t8224", device_model: "T8224", device_type: 96,
    device_channel: 0, category: "eufy_security",
  }] });
  assert.ok(doorbell);
  assert.equal(inventoryDiagnostics([doorbell])[0]?.acceptedAsCamera, true);
  assert.equal(isDoorbellDevice(doorbell), true);
});

test("admits the T8400 and T8419 camera types without inventing doorbell support", () => {
  const devices = parseMegaInventory({ devices: [
    { device_sn: "t8400", device_model: "T8400", device_type: 30, category: "eufy_security" },
    { device_sn: "t8419", device_model: "T8419", device_type: 10009, category: "eufy_security" },
  ] });
  assert.deepEqual(devices.map((device) => inventoryDiagnostics([device])[0]?.acceptedAsCamera), [true, true]);
  assert.deepEqual(devices.map((device) => isDoorbellDevice(device)), [false, false]);
});

test("admits newly reported camera families through a ready HomeBase 3", () => {
  const devices = parseMegaInventory({ devices: [
    {
      device_sn: "floodlight", device_model: "T8423", parent_sn: "station", device_type: 38,
      device_channel: 1, category: "eufy_security",
    },
    {
      device_sn: "indoor", device_model: "T8417", parent_sn: "station", device_type: 105,
      device_channel: 2, category: "eufy_security",
    },
    {
      device_sn: "video-lock", device_model: "T85V0", parent_sn: "station", device_type: 203,
      device_channel: 3, category: "eufy_security",
    },
    {
      device_sn: "solar", device_model: "T8124", parent_sn: "station", device_type: 62,
      device_channel: 4, category: "eufy_security",
    },
    {
      device_sn: "station", device_model: "T8030", device_type: 18,
      category: "eufy_security", p2p_did: "did", p2p_conn: "connection",
    },
  ] });
  const summaries = inventoryLogSummaries(devices, new Set(["station"]));

  assert.deepEqual(summaries.slice(0, 4).map(({ deviceType, acceptedAsCamera, streamSupported }) => ({
    deviceType, acceptedAsCamera, streamSupported,
  })), [
    { deviceType: 38, acceptedAsCamera: true, streamSupported: true },
    { deviceType: 105, acceptedAsCamera: true, streamSupported: true },
    { deviceType: 203, acceptedAsCamera: true, streamSupported: true },
    { deviceType: 62, acceptedAsCamera: true, streamSupported: true },
  ]);
  assert.equal(isDoorbellDevice(devices[2]!), true);
});

test("admits a self-parented T8200 through its own PPCS route", () => {
  const [doorbell] = parseMegaInventory({ devices: [{
    device_sn: "t8200", parent_sn: "t8200", device_model: "T8200", device_type: 5,
    device_channel: 0, category: "eufy_security", p2p_did: "direct-did", p2p_conn: "direct-connection",
  }] });
  assert.ok(doorbell);
  const devices = new Map([[doorbell.serial, doorbell]]);
  assert.deepEqual(ppcsStreamRoute(doorbell, devices), { peer: doorbell, homeBaseAttached: false });
  assert.equal(isPpcsStreamSupported(doorbell, devices, new Set([doorbell.serial])), true);
  assert.equal(isDoorbellDevice(doorbell), true);
});

test("accepts SoloCam C20 inventory through a ready HomeBase 3", () => {
  const devices = parseMegaInventory({ devices: [
    {
      device_sn: "camera", device_model: "T8134", parent_sn: "station", device_type: 63,
      device_channel: 4, category: "eufy_security",
    },
    {
      device_sn: "station", device_model: "T8030", device_type: 18,
      category: "eufy_security", p2p_did: "did", p2p_conn: "connection",
    },
  ] });
  const summaries = inventoryLogSummaries(devices, new Set(["station"]));
  assert.equal(summaries[0]?.acceptedAsCamera, true);
  assert.equal(summaries[0]?.streamSupported, true);
  assert.equal(summaries[1]?.acceptedAsCamera, false);
});

test("admits a T814X C37 without misclassifying T85D0 lock inventory", () => {
  const devices = parseMegaInventory({ devices: [
    {
      device_sn: "camera", device_model: "T814X", parent_sn: "station", device_type: 10037,
      device_channel: 4, category: "eufy_security",
    },
    {
      device_sn: "lock", device_model: "T85D0", parent_sn: "station", device_type: 202,
      device_channel: 5, category: "eufy_security",
    },
    {
      device_sn: "station", device_model: "T8030", device_type: 18,
      category: "eufy_security", p2p_did: "did", p2p_conn: "connection",
    },
  ] });
  const summaries = inventoryLogSummaries(devices, new Set(["station"]));

  assert.deepEqual(summaries.slice(0, 2).map(({ deviceType, acceptedAsCamera, streamSupported }) => ({
    deviceType, acceptedAsCamera, streamSupported,
  })), [
    { deviceType: 10037, acceptedAsCamera: true, streamSupported: true },
    { deviceType: 202, acceptedAsCamera: false, streamSupported: false },
  ]);
});

test("logs safe motion routing for a T8210 without private push fields", () => {
  const event = {
    eventType: 3101, messageType: 1, notificationStyle: 2, alarmType: null,
    pictureUrl: "https://example.invalid/private?access_token=secret",
    cameraSerial: "PRIVATE-SERIAL", cameraName: "Front Porch", personName: "Alex",
    content: "Alex rang the bell",
  };
  const summary = safePushLogSummary(event, {
    model: "T8210", category: "eufy_security", deviceType: 7,
  }, true, true);
  assert.match(summary, /model=T8210 .*event_type=3101 message_type=1 notification_style=2 handling=motion picture_present=true/);
  for (const privateValue of ["PRIVATE-SERIAL", "Front Porch", "Alex", "secret", "example.invalid"]) {
    assert.equal(summary.includes(privateValue), false);
  }
});

test("logs an unhandled T8210 notification without assuming it was a doorbell press", () => {
  const summary = safePushLogSummary({
    eventType: 3001, messageType: 9, notificationStyle: null,
    pictureUrl: null, alarmType: null,
  }, { model: "T8210", category: "eufy_security", deviceType: 7 }, true, false);
  assert.match(summary, /model=T8210 device_known=true camera_accepted=true station_present=true station_managed=false/);
  assert.match(summary, /event_type=3001 message_type=9 notification_style=missing handling=unhandled picture_present=false/);
});

test("routes a confirmed T8210 press code as a doorbell event", () => {
  const press = safePushLogSummary({
    eventType: 3103, messageType: 18, notificationStyle: 1,
    pictureUrl: null, alarmType: null,
  }, { model: "T8210", category: "eufy_security", deviceType: 7 }, true, false);
  assert.match(press, /event_type=3103 message_type=18 notification_style=1 handling=doorbell_press/);

  const nonDoorbell = safePushLogSummary({
    eventType: 3103, messageType: 18, notificationStyle: 1,
    pictureUrl: null, alarmType: null,
  }, { model: "T8113-Z", category: "eufy_security", deviceType: 8 }, true, false);
  assert.match(nonDoorbell, /handling=unhandled/);
});

test("shows the known T817L model in safe person-event logs", () => {
  const summary = safePushLogSummary({
    eventType: 3102, messageType: 18, notificationStyle: 2,
    pictureUrl: null, alarmType: null,
  }, { model: "T817L", category: "eufy_security", deviceType: 10031 }, true, false);
  assert.match(summary, /model=T817L .*handling=person/);
});

test("maps expanded Eufy AI event ids without collapsing their meanings", () => {
  assert.deepEqual(
    [3101, 3102, 3104, 3105, 3106, 3107, 3108, 3109, 3110, 3111, 3112, 3304, 9999].map(cameraDetectionKind),
    ["motion", "person", "crying", "sound", "pet", "vehicle", "dog", "dog", "dog", "person", "stranger", "packageStranded", null],
  );
});

test("does not report unsupported HomeBase inventory as a handled camera event", () => {
  const summary = safePushLogSummary({
    eventType: 3101, messageType: 1, notificationStyle: null,
    pictureUrl: null, alarmType: null,
  }, { model: "T8010", category: "eufy_security", deviceType: 0 }, true, false);
  assert.match(summary, /model=T8010 device_known=true camera_accepted=false station_present=true station_managed=false/);
  assert.match(summary, /handling=unhandled/);
});

test("rejects arbitrary inventory labels and invalid push codes from copyable logs", () => {
  const summary = safePushLogSummary({
    eventType: -1, messageType: 999_999, notificationStyle: null,
    pictureUrl: null, alarmType: null,
  }, { model: "Front Porch private@example.invalid", category: "eufy_security", deviceType: 7 }, false, false);
  assert.match(summary, /model=unknown/);
  assert.match(summary, /event_type=missing message_type=missing notification_style=missing handling=unhandled/);
  assert.equal(summary.includes("Front Porch"), false);
  assert.equal(summary.includes("private@example.invalid"), false);
});

test("groups safe inventory evidence without names or serial numbers", () => {
  const devices = parseMegaInventory({ devices: [
    {
      device_sn: "private-camera-one", device_name: "Private place", device_model: "S330",
      parent_sn: "private-homebase", device_type: 8, device_channel: 1, category: "eufy_security",
    },
    {
      device_sn: "private-camera-two", device_name: "Another private place", device_model: "S330",
      parent_sn: "private-homebase", device_type: 8, device_channel: 2, category: "eufy_security",
    },
    {
      device_sn: "private-homebase", device_name: "Private HomeBase", device_model: "S380",
      device_type: 18, category: "eufy_security", p2p_did: "private-did", p2p_conn: "private-connection",
    },
    {
      device_sn: "private-wall-light", device_name: "Private wall", device_model: "T84A1",
      device_type: 151, device_channel: 0, category: "eufy_security", p2p_did: "direct-did", p2p_conn: "direct-connection",
    },
  ] });

  const summaries = inventoryLogSummaries(devices, new Set(["private-homebase", "private-wall-light"]));

  assert.deepEqual(summaries, [
    {
      count: 2, model: "S330", deviceType: 8, category: "eufy_security", hasParent: true,
      hasChannel: true, acceptedAsCamera: true, stationPresent: true, stationPpcsReady: true,
      stationDskReady: true, streamRoute: "homebase", peerPpcsReady: true, peerDskReady: true, streamSupported: true,
    },
    {
      count: 1, model: "S380", deviceType: 18, category: "eufy_security", hasParent: false,
      hasChannel: false, acceptedAsCamera: false, stationPresent: false, stationPpcsReady: false,
      stationDskReady: false, streamRoute: "unavailable", peerPpcsReady: false, peerDskReady: false, streamSupported: false,
    },
    {
      count: 1, model: "T84A1", deviceType: 151, category: "eufy_security", hasParent: false,
      hasChannel: true, acceptedAsCamera: true, stationPresent: false, stationPpcsReady: false,
      stationDskReady: false, streamRoute: "direct", peerPpcsReady: true, peerDskReady: true, streamSupported: true,
    },
  ]);
  assert.equal(JSON.stringify(summaries).includes("private-camera"), false);
  assert.equal(JSON.stringify(summaries).includes("Private place"), false);
});

test("routes a standalone camera through its own PPCS peer", () => {
  const [wallLight] = parseMegaInventory({ devices: [{
    device_sn: "wall-light", device_model: "T84A1", device_type: 151, device_channel: 0,
    category: "eufy_security", p2p_did: "direct-did", p2p_conn: "direct-connection",
  }] });
  assert.ok(wallLight);
  const devices = new Map([[wallLight.serial, wallLight]]);
  assert.deepEqual(ppcsStreamRoute(wallLight, devices), { peer: wallLight, homeBaseAttached: false });
  assert.equal(isPpcsStreamSupported(wallLight, devices, new Set([wallLight.serial])), true);
});

test("summarizes PPCS failure stages without private transport data", () => {
  const device = parseMegaInventory({ devices: [{
    device_sn: "PRIVATE-SERIAL", device_model: "T81A0", parent_sn: "PRIVATE-SERIAL",
    device_type: 10005, device_channel: 0, category: "eufy_security",
    p2p_did: "PRIVATE-DID", p2p_conn: "PRIVATE-CONNECTION",
  }] })[0]!;
  const route = ppcsStreamRoute(device, new Map([[device.serial, device]]));
  const summary = ppcsStreamLogSummary(device.model, route, {
    camId: 1,
    dataDatagrams: 3,
    frameHeaders: 2,
    videoFrames: 0,
    videoOutputFrames: 0,
    types: [0, 2],
    commands: [1700, 1103],
    frameShapes: ["1700:1:64:0", "1103:0:32:2"],
    sequenceGaps: 1,
    parserBlocked: true,
    pendingBytes: 17,
    videoResults: [],
    videoCodec: "h264",
    videoNalTypes: [7, 8, 5],
    closeReason: "first_frame_timeout",
  }, new Error("Timed out waiting for a fresh camera frame"));
  assert.match(summary, /model=T81A0 route=direct stage=first_frame cam_id=1 data_datagrams=3 frame_headers=2 video_frames=0/);
  assert.match(summary, /video_output_frames=0 incomplete_access_units=0 incomplete_access_unit_bytes=0 foreign_video_frames=0 data_types=0,2 commands=1700,1103 frame_shapes=1700:1:64:0,1103:0:32:2 sequence_gaps=1 sequence_restarts=0 duplicate_datagrams=0 stale_datagrams=0 parser_resyncs=0 parser_blocked=true pending_bytes=17 video_results=none video_codec=h264 video_nal_types=7,8,5 codec_bootstrap=ready/);
  assert.match(summary, /battery_history=not-reported/);
  assert.match(summary, /close_reason=first_frame_timeout/);
  assert.equal(summary.includes("PRIVATE"), false);
});

test("uses a self-parented camera as its own PPCS peer and blocks a missing parent", () => {
  const [selfParented, missingParent] = parseMegaInventory({ devices: [
    {
      device_sn: "self-parented", parent_sn: "self-parented", device_model: "T84A1", device_type: 151,
      device_channel: 0, category: "eufy_security", p2p_did: "direct-did", p2p_conn: "direct-connection",
    },
    {
      device_sn: "missing-parent", parent_sn: "absent-homebase", device_model: "T84A1", device_type: 151,
      device_channel: 0, category: "eufy_security", p2p_did: "direct-did", p2p_conn: "direct-connection",
    },
  ] });
  assert.ok(selfParented && missingParent);
  const devices = new Map([[selfParented.serial, selfParented], [missingParent.serial, missingParent]]);
  assert.deepEqual(ppcsStreamRoute(selfParented, devices), { peer: selfParented, homeBaseAttached: false });
  assert.equal(isPpcsStreamSupported(missingParent, devices, new Set([missingParent.serial])), false);
});
