/**
 * Exercises official-model trial admission, semantic commands and confirmation
 * failures offline. Synthetic sessions own their responses and never contact a device.
 */
import { createCipheriv, createDecipheriv } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { modelControlTrialActions, modelControlTrialCommand, parseModelControlTrial, runModelControlTrial,
  type ModelControlRoute, type ModelControlTrial } from "../src/provider/model-control-trials.js";
import { buildModelControlTrialPayload, decodeModelControlTrialAcknowledgement, decodeModelControlTrialResult } from "../src/stream/first-party-ppcs.js";

const direct: ModelControlRoute = { model: "T8423", deviceType: 38, channel: 0,
  homeBaseAttached: false, peerModel: "T8423", selfPeer: true };
const e30: ModelControlRoute = { ...direct, model: "T8417", deviceType: 105, peerModel: "T8417" };
const transaction = 1_800_000_000_000;

test("model trials default off and require an authenticated explicit opt-in", () => {
  assert.equal(loadConfig({}).experimentalModelControls, false);
  assert.throws(() => loadConfig({ EUFY_GATEWAY_EXPERIMENTAL_MODEL_CONTROLS: "true" }), /API_TOKEN/);
  assert.throws(() => loadConfig({ EUFY_GATEWAY_EXPERIMENTAL_MODEL_CONTROLS: "1" }), /true or false/);
  assert.equal(loadConfig({ EUFY_GATEWAY_EXPERIMENTAL_MODEL_CONTROLS: "true",
    EUFY_GATEWAY_API_TOKEN: "synthetic-token-with-at-least-32-characters" }).experimentalModelControls, true);
});

test("trial admission requires exact model, type, channel and topology", () => {
  assert.deepEqual(modelControlTrialActions(direct), ["motion", "spotlight", "ptz"]);
  for (const patch of [{ model: "T8423X" }, { deviceType: 105 }, { channel: 1 }, { channel: null },
    { selfPeer: false }, { homeBaseAttached: true }]) assert.deepEqual(modelControlTrialActions({ ...direct, ...patch }), []);
  for (const [model, deviceType] of [["T84A1", 151], ["T8417", 105]] as const) {
    assert.deepEqual(modelControlTrialActions({ ...direct, model, deviceType }), ["motion"]);
    assert.deepEqual(modelControlTrialActions({ ...direct, model, deviceType: 38 }), []);
  }
  const attached = { ...direct, model: "T8410", deviceType: 31, homeBaseAttached: true, selfPeer: false, peerModel: "T8030", channel: 3 };
  assert.deepEqual(modelControlTrialActions(attached), ["ptz"]);
  for (const patch of [{ peerModel: "T8010" }, { selfPeer: true }, { homeBaseAttached: false }, { channel: -1 }, { channel: 256 }, { channel: 0.5 }]) {
    assert.deepEqual(modelControlTrialActions({ ...attached, ...patch }), []);
  }
});

test("trial requests reject arbitrary commands, unknown fields and implicit values", () => {
  for (const value of [null, [], {}, { action: "motion", enabled: 1 }, { action: "ptz", direction: "stop" },
    { action: "motion", enabled: true, command: 1011 }, { action: "ptz", direction: { toString: () => "left" } }]) {
    assert.throws(() => parseModelControlTrial(value), SyntaxError);
  }
  assert.deepEqual(parseModelControlTrial({ action: "motion", enabled: false }), { action: "motion", enabled: false });
});

test("E30 directional trials require its exact standalone peer without changing motion admission", () => {
  assert.deepEqual(modelControlTrialActions(e30), ["motion", "ptz"]);
  for (const patch of [{ model: "T8417X" }, { deviceType: 38 }, { channel: 1 }, { channel: null },
    { selfPeer: false }, { homeBaseAttached: true }, { peerModel: "T8423" }, { peerModel: "" }]) {
    const route = { ...e30, ...patch };
    assert.equal(modelControlTrialActions(route).includes("ptz"), false);
    assert.throws(() => modelControlTrialCommand({ action: "ptz", direction: "left" }, route, "synthetic", transaction), /route unavailable/);
  }
  assert.deepEqual(modelControlTrialActions({ ...e30, peerModel: "T8423" }), ["motion"]);
});

test("E30 directional wire contracts retain standalone 1700 and single-click semantics", () => {
  const legacyKey = Buffer.alloc(16, 7);
  for (const [direction, rotate_type] of [["left", 1], ["right", 2], ["up", 3], ["down", 4]] as const) {
    const request: ModelControlTrial = { action: "ptz", direction };
    const expected = { commandType: 6030, data: { cmd_type: 1, rotate_type, zoom: 1, ivalue: -1, transaction: `${transaction}` } };
    const semantic = modelControlTrialCommand(request, e30, "synthetic", transaction);
    assert.equal(semantic.command, 1700);
    assert.deepEqual(JSON.parse(String(semantic.value)), expected);
    const frame = buildModelControlTrialPayload(request, e30, "synthetic", legacyKey, null, 5, transaction);
    assert.equal(frame.command, 1700);
    assert.equal(frame.payload[6], 0);
    assert.equal(frame.payload[7], 1);
    assert.equal(frame.payload[8], 0);
    const decipher = createDecipheriv("aes-128-ecb", legacyKey, null);
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(frame.payload.subarray(10)), decipher.final()]).toString().replace(/\0+$/, "");
    assert.deepEqual(JSON.parse(plain), expected);
    assert.throws(() => buildModelControlTrialPayload(request, e30, "synthetic", Buffer.alloc(0), null, 5, transaction));
  }
  const header = Buffer.alloc(16);
  header.write("XZYH"); header.writeUInt16LE(1700, 4); header[14] = 1;
  assert.equal(decodeModelControlTrialAcknowledgement(header, Buffer.alloc(4), 1700, 0, legacyKey, null), 0);
  assert.equal(decodeModelControlTrialAcknowledgement(header, Buffer.alloc(4), 1350, 0, legacyKey, null), null);
  assert.equal(decodeModelControlTrialAcknowledgement(header, Buffer.alloc(4), 1700, 3, legacyKey, null), null);
  header[14] = 0;
  assert.equal(decodeModelControlTrialAcknowledgement(header, Buffer.alloc(4), 1700, 0, legacyKey, null), null);
});

test("official command variants retain their distinct envelopes and spotlight master", () => {
  const motion = modelControlTrialCommand({ action: "motion", enabled: false }, direct, "synthetic", transaction);
  assert.equal(motion.command, 1700);
  assert.deepEqual(JSON.parse(String(motion.value)), { commandType: 6040, data: { status: 0, transaction: `${transaction}` } });
  assert.deepEqual(modelControlTrialCommand({ action: "spotlight", enabled: true }, direct, "synthetic", transaction), { command: 1403, value: true });
  for (const [direction, rotate_type] of [["left", 1], ["right", 2], ["up", 3], ["down", 4]] as const) {
    const request: ModelControlTrial = { action: "ptz", direction };
    const frame = modelControlTrialCommand(request, direct, "synthetic", transaction);
    assert.equal(frame.command, 1350);
    assert.deepEqual(JSON.parse(String(frame.value)), { account_id: "synthetic", cmd: 6030, mChannel: 0, mValue3: 6030,
      payload: { cmd_type: 1, rotate_type, zoom: 1, ivalue: -1, transaction: `${transaction}` } });
    const attached = modelControlTrialCommand(request, { ...direct, model: "T8410", deviceType: 31,
      homeBaseAttached: true, selfPeer: false, peerModel: "T8030", channel: 3 }, "synthetic", transaction);
    assert.equal(attached.command, 1700);
    assert.deepEqual(JSON.parse(String(attached.value)), { commandType: 6030, data: { cmd_type: 1, rotate_type, transaction: `${transaction}` } });
  }
  assert.throws(() => modelControlTrialCommand({ action: "motion", enabled: true }, direct, "", transaction));
});

test("setting trials require a fresh baseline and fresh matching readback, writing once", async () => {
  let writes = 0;
  const request = { action: "motion", enabled: false } as const;
  await assert.rejects(runModelControlTrial({ read: async () => ({}), write: async () => { writes++; } }, request, () => {}), /original/);
  assert.equal(writes, 0);
  const unchanged = await runModelControlTrial({ read: async () => ({ motionDetectionEnabled: false }), write: async () => { writes++; } }, request, () => {});
  assert.equal(unchanged.outcome, "unchanged");
  assert.equal(writes, 0);
  let reads = 0;
  const result = await runModelControlTrial({ read: async () => ({ motionDetectionEnabled: ++reads < 3 }), write: async () => { writes++; } }, request, () => {});
  assert.equal(result.outcome, "confirmed");
  assert.equal(writes, 1);
  await assert.rejects(runModelControlTrial({ read: async () => ({ motionDetectionEnabled: true }), write: async () => { writes++; } }, request, () => {}), /not confirmed/);
  assert.equal(writes, 2);
});

test("negative or missing acknowledgement never becomes success or a replay", async () => {
  for (const action of ["motion", "ptz"] as const) {
    let writes = 0, reads = 0;
    const request: ModelControlTrial = action === "motion" ? { action, enabled: false } : { action, direction: "left" };
    await assert.rejects(runModelControlTrial({ read: async () => { reads++; return { motionDetectionEnabled: true }; },
      write: async () => { writes++; throw Error("rejected or timed out"); } }, request, () => {}), /rejected/);
    assert.equal(writes, 1);
    assert.equal(reads, action === "motion" ? 1 : 0);
  }
});

test("route retirement prevents writes and prevents publishing late successful replies", async () => {
  let retired = false, writes = 0;
  await assert.rejects(runModelControlTrial({ read: async () => { retired = true; return { spotlightEnabled: false }; },
    write: async () => { writes++; } }, { action: "spotlight", enabled: true }, () => { if (retired) throw Error("closed"); }), /closed/);
  assert.equal(writes, 0);
  retired = false;
  await assert.rejects(runModelControlTrial({ read: async () => ({}), write: async () => { retired = true; writes++; } },
    { action: "ptz", direction: "up" }, () => { if (retired) throw Error("changed"); }), /changed/);
  assert.equal(writes, 1);
});

test("directional acknowledgement explicitly retains physical confirmation requirement", async () => {
  assert.deepEqual(await runModelControlTrial({ read: async () => { throw Error("must not read"); }, write: async () => {} },
    { action: "ptz", direction: "down" }, () => {}), { outcome: "acknowledged", physicalConfirmationRequired: true });
});

test("trial result decoder never mistakes unsupported protection or ciphertext for success", () => {
  const key = Buffer.alloc(16, 7);
  for (const [payload, sign] of [[Buffer.alloc(4), 3], [Buffer.alloc(4), 8], [Buffer.alloc(16), 8], [Buffer.alloc(3), 1]] as const) {
    assert.equal(decodeModelControlTrialResult(payload, sign, key, null), null);
  }
});


test("trial result decoding preserves negative acknowledgements and authenticates GCM", () => {
  const legacyKey = Buffer.alloc(16, 7), key = Buffer.alloc(32, 9);
  for (const result of [0, -1, 5]) {
    const scalar = Buffer.alloc(4);
    scalar.writeInt32LE(result);
    assert.equal(decodeModelControlTrialResult(scalar, 0, legacyKey, null), result);
    const plain = Buffer.alloc(16);
    scalar.copy(plain);
    const legacy = createCipheriv("aes-128-ecb", legacyKey, null);
    legacy.setAutoPadding(false);
    assert.equal(decodeModelControlTrialResult(Buffer.concat([legacy.update(plain), legacy.final()]), 1, legacyKey, null), result);
    const nonce = Buffer.alloc(12, 3);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from("eufy security"));
    const ciphertext = Buffer.concat([cipher.update(scalar), cipher.final()]);
    const frame = Buffer.concat([cipher.getAuthTag(), nonce, Buffer.from([1, 3, 2, 1]), ciphertext]);
    assert.equal(decodeModelControlTrialResult(frame, 8, legacyKey, key), result);
    frame[0] = frame[0]! ^ 1;
    assert.equal(decodeModelControlTrialResult(frame, 8, legacyKey, key), null);
  }
});


test("trial acknowledgements cannot settle a different command or camera channel", () => {
  const header = Buffer.alloc(16), key = Buffer.alloc(16);
  header.write("XZYH"); header.writeUInt16LE(1700, 4); header[12] = 3; header[14] = 1;
  assert.equal(decodeModelControlTrialAcknowledgement(header, Buffer.alloc(4), 1700, 3, key, null), 0);
  assert.equal(decodeModelControlTrialAcknowledgement(header, Buffer.alloc(4), 1403, 3, key, null), null);
  assert.equal(decodeModelControlTrialAcknowledgement(header, Buffer.alloc(4), 1700, 0, key, null), null);
  header[14] = 0;
  assert.equal(decodeModelControlTrialAcknowledgement(header, Buffer.alloc(4), 1700, 3, key, null), null);
  assert.equal(decodeModelControlTrialAcknowledgement(Buffer.alloc(0), Buffer.alloc(4), 1700, 3, key, null), null);
});

test("a specifically missing setting acknowledgement can be confirmed by changed fresh state without replay", async () => {
  const missing = Error("missing result frame");
  let reads = 0, writes = 0;
  const result = await runModelControlTrial({ read: async () => ({ spotlightEnabled: ++reads !== 1 }),
    write: async () => { writes++; throw missing; } }, { action: "spotlight", enabled: true }, () => {}, error => error === missing);
  assert.equal(result.outcome, "confirmed");
  assert.equal(result.acknowledgementReceived, false);
  assert.equal(writes, 1);
  await assert.rejects(runModelControlTrial({ read: async () => ({}), write: async () => { throw missing; } },
    { action: "ptz", direction: "left" }, () => {}, error => error === missing), /missing result/);
});


test("trial wire frames preserve command, channel, protection and native binary layout", () => {
  const legacyKey = Buffer.alloc(16, 7), key = Buffer.alloc(32, 9);
  const motion = buildModelControlTrialPayload({ action: "motion", enabled: true }, direct, "synthetic", legacyKey, null, 5, transaction);
  assert.equal(motion.command, 1700);
  assert.equal(motion.payload[6], 0); assert.equal(motion.payload[7], 1); assert.equal(motion.payload[8], 0);
  const legacy = createDecipheriv("aes-128-ecb", legacyKey, null);
  legacy.setAutoPadding(false);
  const native = Buffer.concat([legacy.update(motion.payload.subarray(10)), legacy.final()]).toString().replace(/\0+$/, "");
  assert.deepEqual(JSON.parse(native), { commandType: 6040, data: { status: 1, transaction: `${transaction}` } });
  for (const request of [{ action: "spotlight", enabled: false }, { action: "ptz", direction: "right" }] as const) {
    assert.throws(() => buildModelControlTrialPayload(request, direct, "synthetic", legacyKey, null, 5, transaction), /level-two/);
    const frame = buildModelControlTrialPayload(request, direct, "synthetic", legacyKey, key, 5, transaction);
    assert.equal(frame.payload[7], 8); assert.equal(frame.payload[6], 0); assert.equal(frame.payload[8], 0);
    const encrypted = frame.payload.subarray(10);
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
    decipher.setAAD(Buffer.from("eufy security")); decipher.setAuthTag(encrypted.subarray(0, 16));
    const plain = Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]);
    if (request.action === "spotlight") {
      assert.equal(frame.command, 1403); assert.equal(plain.length, 136);
      assert.equal(plain.readUInt32LE(0), 0); assert.equal(plain.readUInt32LE(4), 0);
      assert.equal(plain.subarray(8, 17).toString(), "synthetic");
    } else {
      assert.equal(frame.command, 1350);
      assert.equal(JSON.parse(plain.toString()).payload.rotate_type, 2);
    }
  }
});
