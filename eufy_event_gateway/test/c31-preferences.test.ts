/**
 * Verifies native C31 preference framing and rejection boundaries.
 * Tests own synthetic identities and keys. Hardware validation remains the
 * provider and native-app workflow, separate from these deterministic checks.
 */
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import test from "node:test";
import { buildC31CameraInfoQueryPayload, buildC31PreferencePayload, cameraInfoDocumentText } from "../src/stream/first-party-ppcs.js";
import { c31PreferenceValue, validateC31Preference, type C31Preference } from "../src/provider/c31-preferences.js";
import { safeInventoryReads, supportsStandaloneC31Presets, parseMegaInventory } from "../src/provider/eufy-provider.js";

const key = Buffer.alloc(32, 7);

function decode(name: C31Preference, value: number): { command: number; clear: Buffer } {
  const frame = buildC31PreferencePayload(name, value, "synthetic-owner", key, 257, 1791464400000);
  assert.deepEqual(frame.payload.subarray(4, 10), Buffer.from([8, 0, 0, 8, 0, 0]));
  const encrypted = frame.payload.subarray(10);
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
  decipher.setAAD(Buffer.from("eufy security"));
  decipher.setAuthTag(encrypted.subarray(0, 16));
  return { command: frame.command, clear: Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]) };
}

test("native binary preferences preserve channel, value and padded ownership", () => {
  for (const [name, command, values] of [["microphone", 1240, [0, 1]], ["speaker", 1241, [0, 1]], ["speakerVolume", 1230, [1, 70, 80, 100]], ["imageFlipped", 1207, [0, 1]], ["watermark", 1214, [0, 1, 2]]] as const) {
    for (const value of values) {
      const frame = decode(name, value);
      assert.equal(frame.command, command);
      assert.equal(frame.clear.length, 136);
      assert.equal(frame.clear.readUInt32LE(0), 0);
      assert.equal(frame.clear.readUInt32LE(4), value);
      assert.equal(frame.clear.subarray(8, 23).toString(), "synthetic-owner");
      assert.ok(frame.clear.subarray(23).every((byte) => byte === 0));
    }
  }
});

test("pre-record and sound use distinct native JSON wrappers", () => {
  for (const value of [0, 1]) {
    const pre = decode("preRecording", value);
    assert.equal(pre.command, 1350);
    assert.deepEqual(JSON.parse(pre.clear.toString()), { account_id: "synthetic-owner", cmd: 6257, mChannel: 0, mValue3: 0, payload: { value, transaction: "1791464400000" } });
    const sound = decode("soundDetection", value);
    assert.equal(sound.command, 1700);
    assert.deepEqual(JSON.parse(sound.clear.toString()), { commandType: 6043, data: { status: value, transaction: "1791464400000" } });
  }
});

test("invalid names, values, missing ownership and timestamps cannot build commands", () => {
  for (const [name, value] of [["__proto__", 0], ["continuous", 1], ["microphone", true], ["speaker", 2], ["speakerVolume", 0], ["speakerVolume", 101], ["speakerVolume", -1], ["speakerVolume", 70.5], ["watermark", 3], ["preRecording", NaN]]) assert.throws(() => validateC31Preference(name, value));
  assert.throws(() => buildC31PreferencePayload("speaker", 0, "", key, 1, 1791464400000));
  assert.throws(() => buildC31PreferencePayload("speaker", 0, "owner", key, 1, 123));
  assert.equal(c31PreferenceValue({}, "microphone"), undefined);
  assert.equal(c31PreferenceValue({ speakerVolume: true }, "speakerVolume"), undefined);
  assert.equal(c31PreferenceValue({ microphoneEnabled: false }, "microphone"), 0);
});

test("new inventory meanings remain exact model and standalone only", () => {
  const params = [{ param_type: 6257, param_value: "1" }, { param_type: 1214, param_value: "2" }];
  assert.equal(safeInventoryReads(params, 10031, "T817L", true).preRecordingEnabled, true);
  assert.equal(safeInventoryReads(params, 10031, "T817L", true).watermarkMode, 2);
  for (const [type, model, standalone] of [[10031, "T817L121", true], [88, "T817L", true], [10031, "T817L", false]] as const) {
    assert.equal(safeInventoryReads(params, type, model, standalone).preRecordingEnabled, undefined);
    assert.equal(safeInventoryReads(params, type, model, standalone).watermarkMode, undefined);
  }
  const device = parseMegaInventory({ devices: [{ device_sn: "camera", device_model: "T817L", device_type: 10031, device_channel: 0, member: { admin_user_id: "owner" } }] })[0]!;
  const route = { homeBaseAttached: false, peer: device };
  assert.equal(supportsStandaloneC31Presets(device, route, true), true);
  assert.equal(supportsStandaloneC31Presets(device, route, false), false);
  assert.equal(supportsStandaloneC31Presets({ ...device, adminUserId: null }, route, true), false);
  assert.equal(supportsStandaloneC31Presets(device, { ...route, homeBaseAttached: true }, true), false);
  assert.equal(supportsStandaloneC31Presets(device, { ...route, peer: { ...device, serial: "foreign" } }, true), false);
});


test("C31 camera-info uses the SDK station-wide integer query", () => {
  assert.deepEqual(buildC31CameraInfoQueryPayload(), Buffer.from([4, 0, 0, 0, 1, 0, 255, 0, 0, 0, 255, 0, 0, 0]));
});


test("camera-info JSON ends at the protocol NUL before encrypted block padding", () => {
  const document = '{"params":[{"param_type":1240,"param_value":"1"}]}';
  assert.equal(cameraInfoDocumentText(Buffer.concat([Buffer.from(document), Buffer.from([0, 7, 8, 255])])), document);
  assert.equal(cameraInfoDocumentText(Buffer.from(document)), document);
  assert.throws(() => JSON.parse(cameraInfoDocumentText(Buffer.from(document + "invalid"))));
});


test("C31 LED and recording-quality commands retain their native JSON contracts", () => {
  for (const value of [0, 1]) {
    const led = decode("statusLed", value);
    assert.equal(led.command, 1700);
    assert.deepEqual(JSON.parse(led.clear.toString()), { commandType: 6014, data: { value, transaction: "1791464400000" } });
  }
  for (const value of [2, 3]) {
    const quality = decode("recordingQuality", value);
    assert.equal(quality.command, 1350);
    assert.deepEqual(JSON.parse(quality.clear.toString()), { account_id: "synthetic-owner", cmd: 2731, mChannel: 0, mValue3: 0, payload: { quality: value, mode: -1, primary_view: -1, transaction: "1791464400000" } });
  }
  for (const value of [0, 1, 4, true]) assert.throws(() => validateC31Preference("recordingQuality", value));
  const params = [{ param_type: 6014, param_value: "0" }, { param_type: 1045, param_value: "1" }, { param_type: 2731, param_value: JSON.stringify({ cur_mode: 0, mode_0: { quality: 2 } }) }];
  const direct = safeInventoryReads(params, 10031, "T817L", true);
  assert.equal(direct.statusLedEnabled, false);
  assert.equal(direct.recordingQualityTier, 2);
  assert.equal(safeInventoryReads(params, 10031, "T817L121", true).recordingQualityTier, undefined);
  assert.equal(safeInventoryReads(params, 10031, "T817L", false).recordingQualityTier, undefined);
});


test("C31 sound preferences preserve model-specific enums and native wrappers", () => {
  for (const value of [1, 2, 3, 4, 5]) {
    const sound = decode("soundSensitivity", value);
    assert.equal(sound.command, 1700);
    assert.deepEqual(JSON.parse(sound.clear.toString()), { commandType: 6044, data: { index: value, transaction: "1791464400000" } });
  }
  for (const value of [128, 256]) {
    const sound = decode("soundType", value);
    assert.equal(sound.command, 1700);
    assert.deepEqual(JSON.parse(sound.clear.toString()), { commandType: 6046, data: { type: value, transaction: "1791464400000" } });
  }
  for (const value of [0, 1]) {
    const roundLook = decode("soundRoundLook", value), lighting = decode("enhanceLighting", value);
    assert.equal(roundLook.command, 1350);
    assert.equal(lighting.command, 1350);
    assert.deepEqual(JSON.parse(roundLook.clear.toString()), { account_id: "synthetic-owner", cmd: 6208, mChannel: 0, mValue3: 0, payload: { onoff: value, transaction: "1791464400000" } });
    assert.deepEqual(JSON.parse(lighting.clear.toString()), { account_id: "synthetic-owner", cmd: 6484, mChannel: 0, mValue3: 0, payload: { mode: 1 - value, transaction: "1791464400000" } });
  }
  for (const value of [0, 1, 2, 127, 129, 255, 257, true]) assert.throws(() => validateC31Preference("soundType", value));
  for (const value of [0, 6, true, 2.5]) assert.throws(() => validateC31Preference("soundSensitivity", value));
  const params = [{ param_type: 6044, param_value: "2" }, { param_type: 6046, param_value: "128" }, { param_type: 6208, param_value: "0" }, { param_type: 6484, param_value: "1" }];
  const reads = safeInventoryReads(params, 10031, "T817L", true);
  assert.equal(reads.soundDetectionSensitivity, 2);
  assert.equal(reads.soundDetectionType, 128);
  assert.equal(reads.soundRoundLookEnabled, false);
  assert.equal(reads.enhanceLightingEnabled, false);
  for (const [type, model, direct] of [[10031, "T817L121", true], [10031, "T817L", false], [88, "T8171", true]] as const) {
    const other = safeInventoryReads(params, type, model, direct);
    assert.equal(other.soundDetectionType, undefined);
    assert.equal(other.soundDetectionSensitivity, undefined);
    assert.equal(other.soundRoundLookEnabled, undefined);
    assert.equal(other.enhanceLightingEnabled, undefined);
  }
  const older = safeInventoryReads([{ param_type: 6044, param_value: "3" }, { param_type: 6046, param_value: "1" }], 31, "T8410", true);
  assert.equal(older.soundDetectionType, 1);
  assert.equal(older.soundDetectionSensitivity, 3);
});


test("C31 brightness and notification spacing keep distinct binary layouts", () => {
  const light = decode("lightBrightness", 60);
  assert.equal(light.command, 1401);
  assert.equal(light.clear.length, 136);
  assert.equal(light.clear.readUInt32LE(0), 0);
  assert.equal(light.clear.readUInt32LE(4), 60);
  assert.equal(light.clear.subarray(8, 23).toString(), "synthetic-owner");
  for (const value of [0, 1, 5]) {
    const interval = decode("notificationInterval", value);
    assert.equal(interval.command, 1250);
    assert.equal(interval.clear.length, 132);
    assert.equal(interval.clear.readUInt32LE(0), value * 60);
    assert.equal(interval.clear.subarray(4, 19).toString(), "synthetic-owner");
  }
  const params = [{ param_type: 1401, param_value: "80" }, { param_type: 1250, param_value: "60" }];
  assert.equal(safeInventoryReads(params, 10031, "T817L", true).lightBrightness, 80);
  assert.equal(safeInventoryReads(params, 10031, "T817L", true).notificationIntervalMinutes, 1);
  assert.equal(safeInventoryReads([{ param_type: 1250, param_value: "61" }], 10031, "T817L", true).notificationIntervalMinutes, undefined);
  for (const [type, model, direct] of [[10031, "T817L121", true], [10031, "T817L", false], [48, "T8170", true]] as const) {
    const other = safeInventoryReads(params, type, model, direct);
    assert.equal(other.lightBrightness, undefined);
    assert.equal(other.notificationIntervalMinutes, undefined);
  }
  assert.equal(safeInventoryReads(params, 48, "T8170", true).recordingIntervalSeconds, 60);
  for (const value of [-1, 6, 60, true]) assert.throws(() => validateC31Preference("notificationInterval", value));
});


test("C31 publication and continuous recording retain distinct native framing and route limits", () => {
  for (const value of [0, 1]) {
    const rtsp = decode("rtspPublication", value);
    assert.equal(rtsp.command, 1145);
    assert.equal(rtsp.clear.length, 136);
    assert.equal(rtsp.clear.readUInt32LE(0), 0);
    assert.equal(rtsp.clear.readUInt32LE(4), value);
    assert.equal(rtsp.clear.subarray(8, 23).toString(), "synthetic-owner");
    assert.ok(rtsp.clear.subarray(23).every((byte) => byte === 0));
    const continuous = decode("continuousRecording", value);
    assert.equal(continuous.command, 1700);
    assert.deepEqual(JSON.parse(continuous.clear.toString()), {
      commandType: 6010, data: { enable: value, transaction: "1791464400000" },
    });
  }
  const params = [{ param_type: 1145, param_value: "0" }, { param_type: 6010, param_value: "1" }];
  const reads = safeInventoryReads(params, 10031, "T817L", true);
  assert.equal(reads.rtspPublicationEnabled, false);
  assert.equal(reads.continuousRecordingEnabled, true);
  for (const [type, model, standalone] of [[10031, "T817L121", true], [88, "T817L", true], [10031, "T817L", false]] as const) {
    const excluded = safeInventoryReads(params, type, model, standalone);
    assert.equal(excluded.rtspPublicationEnabled, undefined);
    assert.equal(excluded.continuousRecordingEnabled, undefined);
  }
  for (const value of [2, true, "1", -1]) {
    assert.throws(() => validateC31Preference("rtspPublication", value));
    assert.throws(() => validateC31Preference("continuousRecording", value));
  }
});
