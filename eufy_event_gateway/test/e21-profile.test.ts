/**
 * Tests strict E21 state and native command bytes using synthetic keys.
 * Fixtures own all input and perform no network, media or device operations.
 */
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import test from "node:test";
import { e21Integer, e21Readings, e21PreferenceNames, e21PreferenceContracts, validateE21Preference } from "../src/provider/e21-profile.js";
import { buildE21PreferencePayload, buildC31PreferencePayload, acceptsSoloCamAudio, buildStandaloneLiveStartValue } from "../src/stream/first-party-ppcs.js";
import { parseMegaInventory } from "../src/provider/eufy-provider.js";

const key = Buffer.alloc(32, 7);
const rows = (...pairs: readonly (readonly [number, unknown])[]) => pairs.map(([param_type, param_value]) => ({ param_type, param_value }));
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

function decode(name: typeof e21PreferenceNames[number], value: number, mode: 0 | 12 | null = 0) {
  const frame = buildE21PreferencePayload(name, value, "synthetic-owner", key, 257, 1791464400000, mode);
  assert.deepEqual(frame.payload.subarray(4, 10), Buffer.from([8, 0, 0, 8, 0, 0]));
  const encrypted = frame.payload.subarray(10);
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
  decipher.setAAD(Buffer.from("eufy security")); decipher.setAuthTag(encrypted.subarray(0, 16));
  return { command: frame.command, clear: Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]) };
}

test("strict reads preserve malformed, absent and duplicate values as unknown", () => {
  for (const value of [true, false, null, {}, [], "", "01", " 1", "+1", "1.0", "1e0", "0x1", Infinity, NaN, 1.5]) {
    assert.equal(e21Integer(value), null);
    assert.equal(e21Readings(rows([1240, value])).preferences.microphone, undefined);
  }
  assert.equal(e21Readings(rows([1240, "1"])).preferences.microphone, 1);
  assert.equal(e21Readings(rows([1240, 1], [1240, 0])).preferences.microphone, undefined);
  assert.equal(e21Readings(rows([6046, 129])).preferences.soundType, undefined);
  for (const name of ["rtspPublication", "cameraEnabled", "preRecording", "notificationInterval", "nightVision", "__proto__"]) assert.throws(() => validateE21Preference(name, 0));
});

test("temperature readings need reported units and normalize Fahrenheit", () => {
  assert.equal(e21Readings(rows([7000, 72], [7003, 0])).careSettings.roomTemperatureCelsius, 22.2);
  assert.equal(e21Readings(rows([7000, 22], [7003, 1])).careSettings.roomTemperatureCelsius, 22);
  for (const pairs of [[[7000, 0], [7003, 1]], [[7000, 22]], [[7000, 22.5], [7003, 1]], [[7000, 22], [7003, 2]], [[7000, 121], [7003, 0]]] as const) assert.equal(e21Readings(rows(...pairs)).careSettings.roomTemperatureCelsius, null);
  const care = e21Readings(rows([7001, 90], [7002, 50], [7003, 0], [6282, 60], [1145, 1])).careSettings;
  assert.equal(care.highTemperatureCelsius, 32.2); assert.equal(care.lowTemperatureCelsius, 10);
  assert.equal(care.whiteNoiseTimerRaw, 60); assert.equal(care.rtspPublicationEnabled, true);
});

test("quality bank selection requires its independent reported mode", () => {
  const banks = encoded({ mode_0: { quality: 1 }, mode_1: { quality: 4 } });
  assert.equal(e21Readings(rows([2730, banks])).preferences.streamingQuality, undefined);
  assert.equal(e21Readings(rows([2730, banks], [6243, 0])).preferences.streamingQuality, 1);
  assert.equal(e21Readings(rows([2730, banks], [6243, 12])).preferences.streamingQuality, 4);
  assert.equal(e21Readings(rows([2730, encoded(2)], [6243, 12])).preferences.streamingQuality, 2);
  assert.equal(e21Readings(rows([2730, banks], [6243, 0], [6243, 12])).preferences.streamingQuality, undefined);
});

test("binary commands preserve native ownership and E21 zero volume", () => {
  for (const [name, command, value] of [["microphone",1240,1],["speaker",1241,0],["speakerVolume",1230,0],["imageFlipped",1207,1],["watermark",1214,2]] as const) {
    const frame = decode(name, value); assert.equal(frame.command, command); assert.equal(frame.clear.length, 136);
    assert.equal(frame.clear.readUInt32LE(0), 0); assert.equal(frame.clear.readUInt32LE(4), value);
    assert.equal(frame.clear.subarray(8,23).toString(), "synthetic-owner");
  }
  assert.throws(() => buildC31PreferencePayload("speakerVolume", 0, "synthetic-owner", key, 1, 1791464400000));
});

test("JSON preferences use the separately traced E21 envelopes", () => {
  const expected = {
    statusLed: [1700,6014,{value:1}], soundDetection:[1700,6043,{status:1}], soundSensitivity:[1700,6044,{index:5}],
    soundType:[1700,6046,{type:256}], soundRoundLook:[1350,6208,{onoff:1}], audioRecording:[1700,6012,{enable:1}],
    continuousRecording:[1700,6010,{enable:1}], motionDetection:[1700,6040,{status:1}], motionSensitivity:[1700,6041,{value:5,index:5,channel:0}],
    aiTracking:[1700,6016,{value:1}], cruise:[1700,6031,{value:1}], streamingQuality:[1350,2730,{quality:4,mode:12,primary_view:0,channel:0}],
    recordingQuality:[1350,2731,{quality:4,mode:-1,primary_view:-1}], whiteNoiseVolume:[1350,6283,{volume:100}], temperatureMonitoring:[1350,7004,{value:1}],
  } as const;
  for (const [name, [outer, inner, fields]] of Object.entries(expected)) {
    const preference = name as keyof typeof expected;
    const value = e21PreferenceContracts[preference].maximum;
    const frame = decode(preference, value, 12); assert.equal(frame.command, outer);
    const body = JSON.parse(frame.clear.toString());
    assert.deepEqual(body, outer === 1700 ? { commandType: inner, data: { ...fields, transaction: "1791464400000" } }
      : { account_id: "synthetic-owner", cmd: inner, mChannel: 0, mValue3: 0, payload: { ...fields, transaction: "1791464400000" } });
    assert.throws(() => validateE21Preference(name, value+1));
  }
  assert.throws(() => decode("streamingQuality", 0, null));
});

test("duplicate E21 rows and wrong audio lifetimes cannot cross admission", () => {
  const row = { device_sn:"synthetic", device_model:"T8354", device_type:86, category:"eufy_care" };
  assert.deepEqual(parseMegaInventory({devices:[row,row]}), []);
  assert.equal(acceptsSoloCamAudio("T8354", false, 0, 0, undefined), true);
  for (const [attached,requested,frame,purpose] of [[true,1,1,undefined],[false,0,1,undefined],[false,0,0,"control"],[false,0,0,"passive"]] as const) assert.equal(acceptsSoloCamAudio("T8354",attached,requested,frame,purpose),false);
  const start = JSON.parse(buildStandaloneLiveStartValue("T8354",0,"synthetic-owner","synthetic-public",1791464400000));
  assert.equal(start.commandType,1000); assert.equal(start.data.video_type,12); assert.equal(start.data.restore,0); assert.equal(start.data.encryptkey,"synthetic-public");
});
