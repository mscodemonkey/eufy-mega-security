/**
 * Exercises exact S340 route/state admission and encrypted live-quality frames.
 * Synthetic inventory and keys own all inputs. No camera or setting is touched.
 */
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import test from "node:test";
import { isS340LiveQualityRoute, readS340LiveQuality, s340LiveQualityValue } from "../src/provider/s340-live-quality.js";
import { cameraSettingProfile, readCameraSetting } from "../src/provider/camera-settings.js";
import { safeInventoryReads } from "../src/provider/eufy-provider.js";
import { buildReviewedCameraSettingPayload } from "../src/stream/first-party-ppcs.js";

const route = { model: "T8170", deviceType: 48, homeBaseAttached: true, selfPeer: false,
  peerModel: "T8030", peerDeviceType: 18, channel: 5, liveQualityVideoMode: 0 };
const params = (quality: unknown, mode: unknown = "0") => [
  { param_type: 6243, param_value: mode }, { param_type: 2730, param_value: quality },
];

test("S340 mode-zero reads accept scalar and encoded quality without confusing recording or another mode", () => {
  for (const quality of [0, 1, 2, 3]) for (const raw of [quality, String(quality),
    JSON.stringify({ mode_0: { quality }, mode_1: { quality: 99 } }),
    Buffer.from(JSON.stringify({ mode_0: { quality }, mode_1: { quality: 99 } })).toString("base64")]) {
    assert.deepEqual(readS340LiveQuality(params(raw)), { quality, videoMode: 0 });
    assert.equal(readCameraSetting(params(raw), "T8170", 48, false, "streamingQuality"), quality);
    assert.equal(safeInventoryReads(params(raw), 48, "T8170", false).streamingQualityTier, quality);
  }
  for (const raw of [true, null, "bad", { quality: 3 }, { mode_1: { quality: 3 } }, { mode_0: { quality: "3" } }, 4, -1, 2.5]) {
    assert.equal(readS340LiveQuality(params(raw)), undefined);
  }
  for (const mode of [null, true, "12", 12, 1]) assert.equal(readS340LiveQuality(params("3", mode)), undefined);
  const valid = params("3");
  assert.equal(readS340LiveQuality(valid.slice(1)), undefined);
  assert.equal(readS340LiveQuality([...valid, valid[0]!]), undefined);
  assert.equal(readS340LiveQuality([...valid, valid[1]!]), undefined);
  assert.equal(readS340LiveQuality([{ param_type: 6243, param_value: "0" }, { param_type: 2731, param_value: "3" }]), undefined);
});

test("only an exact HomeBase 3 S340 with fresh mode-zero evidence gains quality authority", () => {
  assert.equal(isS340LiveQualityRoute(route), true);
  assert.equal(cameraSettingProfile(route, "streamingQuality")?.form, "attached-quality");
  const { liveQualityVideoMode: _missing, ...missingMode } = route;
  assert.equal(cameraSettingProfile(missingMode, "streamingQuality"), null);
  for (const changed of [{ model: "T8170E" }, { deviceType: 88 }, { peerModel: "T9000" }, { peerDeviceType: 27 },
    { homeBaseAttached: false }, { selfPeer: true }, { channel: -1 }, { channel: 32 }, { channel: 1.5 },
    { liveQualityVideoMode: 12 }]) {
    const denied = { ...route, ...changed };
    assert.equal(isS340LiveQualityRoute(denied), false);
    assert.equal(cameraSettingProfile(denied, "streamingQuality"), null);
    assert.throws(() => s340LiveQualityValue(denied, 3, "synthetic-owner"));
  }
});

test("encrypted S340 live-quality request preserves child, owner and mode without writing recording quality", () => {
  const key = Buffer.alloc(32, 7);
  const frame = buildReviewedCameraSettingPayload({ setting: "streamingQuality", value: 3 }, route, "synthetic-owner", key, 5, 1791464400000);
  assert.equal(frame.command, 1350);
  const encrypted = frame.payload.subarray(10);
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
  decipher.setAAD(Buffer.from("eufy security")); decipher.setAuthTag(encrypted.subarray(0, 16));
  const clear = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]).toString());
  assert.deepEqual(clear, { account_id: "synthetic-owner", cmd: 2730, mChannel: 5, mValue3: 0,
    payload: { quality: 3, mode: 0, primary_view: 0, channel: 5 } });
  for (const value of [-1, 4, 1.5]) assert.throws(() => s340LiveQualityValue(route, value, "synthetic-owner"));
});
