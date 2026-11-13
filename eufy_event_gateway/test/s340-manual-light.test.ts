/**
 * Qualifies the exact S340 attached manual-light candidate using synthetic keys.
 * The native timed preference is separate from physical illumination or a
 * guaranteed automatic stop. Provider tests retain one-dispatch and cleanup guards.
 */
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import test from "node:test";
import { modelControlTrialActions, type ModelControlRoute } from "../src/provider/model-control-trials.js";
import { buildModelControlTrialPayload } from "../src/stream/first-party-ppcs.js";

const route: ModelControlRoute = { model: "T8170", deviceType: 48, peerModel: "T8030", peerDeviceType: 18,
  homeBaseAttached: true, selfPeer: false, channel: 3 };

test("S340 manual light excludes standalone routes, wrong parent types and ambiguous channels", () => {
  assert.deepEqual(modelControlTrialActions(route), ["manualLight"]);
  for (const patch of [{ model: "T8170C" }, { deviceType: 88 }, { peerModel: "T9000" }, { peerDeviceType: 0 },
    { homeBaseAttached: false }, { selfPeer: true }, { channel: 32 }, { channel: null }]) {
    assert.equal(modelControlTrialActions({ ...route, ...patch }).includes("manualLight"), false);
  }
});

test("S340 sends its exact timed JSON on the authenticated child channel with no legacy-key fallback", () => {
  const key = Buffer.alloc(32, 7), legacy = Buffer.alloc(16, 3);
  for (const enabled of [true, false]) {
    const request = { action: "manualLight" as const, enabled };
    assert.throws(() => buildModelControlTrialPayload(request, route, "synthetic-owner", legacy, null, 0, 1791464400000));
    const frame = buildModelControlTrialPayload(request, route, "synthetic-owner", legacy, key, 1, 1791464400000);
    assert.equal(frame.command, 1700); assert.equal(frame.payload[6], 3); assert.equal(frame.payload[7], 8);
    const encrypted = frame.payload.subarray(10), decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
    decipher.setAAD(Buffer.from("eufy security")); decipher.setAuthTag(encrypted.subarray(0, 16));
    const clear = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]).toString());
    assert.deepEqual(clear, { commandType: 1400, data: { value: Number(enabled), open: Number(enabled), type: 2, time: 60 } });
  }
});
