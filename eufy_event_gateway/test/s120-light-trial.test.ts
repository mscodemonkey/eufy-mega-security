/**
 * Tests exact S120 light admission, binary construction and write-only results.
 * Synthetic keys and sessions own all effects. No device or network is used.
 */
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import test from "node:test";
import { modelControlTrialActions, modelControlTrialCommand, parseModelControlTrial, runModelControlTrial,
  type ModelControlRoute } from "../src/provider/model-control-trials.js";
import { buildModelControlTrialPayload } from "../src/stream/first-party-ppcs.js";

const route: ModelControlRoute = { model: "T81A0", deviceType: 10005, peerModel: "T8030", peerDeviceType: 18,
  homeBaseAttached: true, selfPeer: false, channel: 3 };

test("manual light is exact-model and excludes station-wide or ambiguous channels", () => {
  assert.deepEqual(modelControlTrialActions(route), ["manualLight"]);
  for (const patch of [{ model: "T84A0" }, { deviceType: 151 }, { peerModel: "T8010" }, { peerDeviceType: 0 },
    { peerDeviceType: null }, { homeBaseAttached: false }, { selfPeer: true }, { channel: -1 }, { channel: 255 }, { channel: 0.5 }, { channel: null }]) {
    assert.equal(modelControlTrialActions({ ...route, ...patch }).includes("manualLight"), false);
  }
  for (const enabled of [true, false]) assert.deepEqual(parseModelControlTrial({ action: "manualLight", enabled }), { action: "manualLight", enabled });
  for (const value of [{ action: "manualLight", enabled: 1 }, { action: "manualLight", enabled: "true" },
    { action: "manualLight", enabled: true, command: 1400 }, { action: "manualLight" }]) assert.throws(() => parseModelControlTrial(value));
});

test("manual On/Off uses only encrypted 1400 channel/value/account bytes", () => {
  for (const enabled of [true, false]) {
    const request = { action: "manualLight" as const, enabled }, key = Buffer.alloc(32, 9), legacy = Buffer.alloc(16, 7);
    assert.deepEqual(modelControlTrialCommand(request, route, "synthetic-account", 1_800_000_000_000), { command: 1400, value: enabled });
    for (const invalid of [null, Buffer.alloc(16)]) assert.throws(() => buildModelControlTrialPayload(request, route, "synthetic-account", legacy, invalid, 5, 1_800_000_000_000));
    const frame = buildModelControlTrialPayload(request, route, "synthetic-account", legacy, key, 5, 1_800_000_000_000);
    assert.equal(frame.command, 1400); assert.equal(frame.payload[6], 3); assert.equal(frame.payload[7], 8);
    const encrypted = frame.payload.subarray(10), cipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
    cipher.setAAD(Buffer.from("eufy security")); cipher.setAuthTag(encrypted.subarray(0, 16));
    const plain = Buffer.concat([cipher.update(encrypted.subarray(32)), cipher.final()]);
    assert.equal(plain.length, 136); assert.equal(plain.readUInt32LE(0), 3); assert.equal(plain.readUInt32LE(4), Number(enabled));
    assert.equal(plain.subarray(8, 25).toString(), "synthetic-account");
    assert.doesNotMatch(plain.toString(), /commandType|payload|transaction/);
  }
});

test("manual light runner never reads or confirms state and never replays a failed write", async () => {
  for (const fails of [false, true]) {
    let writes = 0;
    const operation = runModelControlTrial({ read: async () => { throw Error("Read forbidden"); },
      write: async () => { writes++; if (fails) throw Error("failed once"); } }, { action: "manualLight", enabled: true }, () => {});
    if (fails) await assert.rejects(operation, /failed once/);
    else assert.deepEqual(await operation, { outcome: "acknowledged", physicalConfirmationRequired: true });
    assert.equal(writes, 1);
  }
});
