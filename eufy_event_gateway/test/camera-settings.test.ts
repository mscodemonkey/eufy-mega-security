/**
 * Verifies exact-model native settings and single-write confirmation boundaries.
 * Synthetic routes and cipher keys own all test state. These tests never contact
 * cameras and are consumed by the gateway's normal repository validation.
 */
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import test from "node:test";
import { cameraSettingProfile, cameraSettingWireValue, CameraSettingError, parseCameraSettingChange, readCameraSetting, runConfirmedCameraSetting } from "../src/provider/camera-settings.js";
import type { ModelControlRoute } from "../src/provider/model-control-trials.js";
import { buildReviewedCameraSettingPayload } from "../src/stream/first-party-ppcs.js";
import { safeInventoryReads } from "../src/provider/eufy-provider.js";

const profiles = [
  ["T8210", 7, true, 1276, [1, 2, 3, 4, 5]],
  ["T8113-Z", 8, true, 1210, [192, 118, 72, 46, 30, 20, 14]],
  ["T8160-C", 19, true, 1210, [1, 2, 3, 4, 5, 6, 7]],
  ["T8171", 88, true, 1276, [1, 2, 3, 4, 5, 6, 7]],
  ["T817L", 10031, false, 6041, [1, 2, 3]],
] as const;

function route(model: string, type: number, attached: boolean): ModelControlRoute {
  return { model, deviceType: type, homeBaseAttached: attached, peerModel: attached ? "T8030" : model, selfPeer: !attached, channel: attached ? 2 : 0 };
}

function clear(frame: { payload: Buffer }, key: Buffer): Buffer {
  const encrypted = frame.payload.subarray(10);
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
  decipher.setAAD(Buffer.from("eufy security")); decipher.setAuthTag(encrypted.subarray(0, 16));
  return Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]);
}

test("reviewed sensitivity ladders preserve exact model, topology, read parameter and direction", () => {
  for (const [model, type, attached, id, ladder] of profiles) {
    const r = route(model, type, attached), p = cameraSettingProfile(r, "motionSensitivity")!;
    assert.deepEqual(p.ladder, ladder); assert.equal(p.readParam, id);
    for (const [index, native] of ladder.entries()) {
      const params = [{ param_type: id, param_value: `${native}` }];
      assert.equal(readCameraSetting(params, model, type, !attached, "motionSensitivity"), index + 1);
      assert.equal(cameraSettingWireValue(p, { setting: "motionSensitivity", value: index + 1 }), native);
      assert.equal(safeInventoryReads(params, type, model, !attached).motionSensitivityStep, index + 1);
      assert.equal(readCameraSetting([...params, ...params], model, type, !attached, "motionSensitivity"), undefined);
    }
    for (const invalid of [true, false, null, "unknown", 0, 999, 1.5]) assert.equal(readCameraSetting([{ param_type: id, param_value: invalid }], model, type, !attached, "motionSensitivity"), undefined);
    for (const modified of [{ ...r, model: model + "X" }, { ...r, deviceType: 999 }, { ...r, channel: null }, { ...r, channel: -1 }, { ...r, homeBaseAttached: !attached }]) {
      assert.equal(cameraSettingProfile(modified, "motionSensitivity"), null);
    }
    assert.throws(() => cameraSettingWireValue(p, { setting: "motionSensitivity", value: ladder.length + 1 }));
  }
  const mirrored = [{ param_type: 1210, param_value: "14" }, { param_type: 1276, param_value: "4" }, { param_type: 6041, param_value: "4" }];
  assert.equal(readCameraSetting(mirrored, "T8113-Z", 8, false, "motionSensitivity"), 7);
  assert.equal(readCameraSetting(mirrored.slice(1), "T8113-Z", 8, false, "motionSensitivity"), undefined);
  assert.equal(cameraSettingProfile(route("T8171", 88, false), "motionSensitivity"), null);
});

test("only the exact attached T8210 chime gains write authority", () => {
  const r = route("T8210", 7, true), p = cameraSettingProfile(r, "homebaseChime")!;
  assert.equal(readCameraSetting([{ param_type: 1702, param_value: "0" }], "T8210", 7, false, "homebaseChime"), false);
  assert.equal(cameraSettingWireValue(p, { setting: "homebaseChime", value: true }), 1);
  assert.equal(safeInventoryReads([{ param_type: 1702, param_value: "1" }], 7, "T8210").homebaseChimeEnabled, true);
  for (const [model, type] of [["T8210", 5], ["T8214", 94], ["T8113-Z", 8]] as const) assert.equal(cameraSettingProfile(route(model, type, true), "homebaseChime"), null);
});

test("setting bodies are closed and retain JSON's documented duplicate-key semantics", () => {
  for (const body of [null, [], {}, Object.create({ setting: "motionSensitivity", value: 1 }), { setting: "motionSensitivity", value: true }, { setting: "motionSensitivity", value: "1" }, { setting: "motionSensitivity", value: 1.5 }, { setting: "homebaseChime", value: 1 }, { setting: "homebaseChime", value: false, extra: 1 }]) assert.throws(() => parseCameraSettingChange(body), SyntaxError);
  assert.deepEqual(parseCameraSettingChange(JSON.parse('{"setting":"motionSensitivity","value":1,"value":2}')), { setting: "motionSensitivity", value: 2 });
  assert.throws(() => parseCameraSettingChange(JSON.parse('{"setting":"homebaseChime","value":false,"__proto__":{}}')), SyntaxError);
});

test("reviewed frames retain native command, channel, ownership and one-step encoding", () => {
  const key = Buffer.alloc(32, 7), now = 1791464400000;
  for (const [model, type, attached, id, ladder] of profiles) {
    const r = route(model, type, attached);
    const frame = buildReviewedCameraSettingPayload({ setting: "motionSensitivity", value: 2 }, r, "fixture-owner", key, 257, now);
    const body = clear(frame, key);
    if (id === 1210) {
      assert.equal(frame.command, 1210); assert.equal(body.length, 136);
      assert.equal(body.readUInt32LE(0), 2); assert.equal(body.readUInt32LE(4), ladder[1]);
      assert.equal(body.subarray(8, 21).toString(), "fixture-owner");
    } else if (id === 1276) {
      assert.equal(frame.command, 1350);
      assert.deepEqual(JSON.parse(body.toString()), { account_id: "fixture-owner", cmd: 1276, mChannel: 2, mValue3: 0, payload: { sensitivity: 2, channel: 2 } });
    } else {
      assert.equal(frame.command, 1700);
      assert.deepEqual(JSON.parse(body.toString()), { commandType: 6041, data: { value: 2, index: 2, channel: 0, transaction: `${now}` } });
    }
  }
  const frame = buildReviewedCameraSettingPayload({ setting: "homebaseChime", value: false }, route("T8210", 7, true), "fixture-owner", key, 1, now);
  assert.equal(frame.command, 1702); assert.equal(clear(frame, key).readUInt32LE(4), 0);
});

test("confirmation requires a present fresh baseline and sends once despite ignored or ambiguous writes", async () => {
  for (const scenario of ["success", "noop", "missing", "ignored", "ambiguous", "cancel-before", "cancel-after"] as const) {
    let actual: number | undefined = scenario === "missing" ? undefined : scenario === "noop" ? 3 : 2;
    let writes = 0, invalidations = 0;
    const controller = new AbortController(); if (scenario === "cancel-before") controller.abort();
    const work = runConfirmedCameraSetting({ deadline: Date.now() + 90_000, signal: controller.signal,
      read: async () => actual, check: () => {}, invalidate: () => { invalidations++; }, wait: async () => {},
      write: async dispatch => { dispatch(); writes++; if (scenario === "cancel-after") controller.abort(); if (scenario === "ambiguous") throw Error("lost"); if (scenario !== "ignored") actual = 3; },
    }, 3);
    if (["success", "noop", "cancel-after"].includes(scenario)) await work;
    else await assert.rejects(work, (error: unknown) => error instanceof CameraSettingError && error.code === (["ignored", "ambiguous"].includes(scenario) ? "outcome_unknown" : "unavailable"));
    assert.equal(writes, ["noop", "missing", "cancel-before"].includes(scenario) ? 0 : 1);
    assert.equal(invalidations, ["ignored", "ambiguous"].includes(scenario) ? 1 : 0);
  }
});
