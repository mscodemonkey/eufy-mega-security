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
