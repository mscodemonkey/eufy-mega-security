/**
 * Tests fresh settings presence and exclusive peer ownership in the real provider.
 * Mocked cloud, push and PPCS methods own all external effects. Gateway state
 * consumes production events, including clean-rejection state preservation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import { CameraSettingError } from "../src/provider/camera-settings.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { GatewayState } from "../src/domain/gateway-state.js";

test("settings reject stale baselines and exclude competing camera operations", async context => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-setting-"));
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ device_sn: "camera", device_model: "T817L", device_type: 10031,
    category: "eufy_security", device_channel: 0, p2p_did: "fixture-peer", p2p_conn: "fixture-route", member: { admin_user_id: "fixture-owner" }, params: [{ param_type: 6041, param_value: "3" }] }] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ camera: { key: "fixture-key", expiresAt: null } }));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => undefined);
  context.mock.method(FirstPartyPpcsSession.prototype, "close");
  let missing = true, actual = 3, writes = 0, entered!: () => void, finish!: () => void;
  const writing = new Promise<void>(resolve => { finish = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  context.mock.method(FirstPartyPpcsSession.prototype, "readCameraInfo", async () => missing ? [] : [{ param_type: 6041, param_value: `${actual}` }]);
  context.mock.method(FirstPartyPpcsSession.prototype, "writeReviewedCameraSetting", async (_change: unknown, _route: unknown, dispatch: () => void) => { dispatch(); writes++; entered(); await writing; actual = 2; });
  const state = new GatewayState();
  const events = new Proxy({ camera: (identity: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(identity) }, { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: directory, maxStreamSeconds: 120 });
  try {
    await provider.start(events);
    await assert.rejects(provider.setCameraSetting("camera", { setting: "motionSensitivity", value: 2 }), (error: unknown) => error instanceof CameraSettingError && error.code === "unavailable");
    assert.equal(writes, 0); assert.equal(state.getCamera("camera").reportedSettings?.motionSensitivityStep, 3);
    missing = false;
    const pending = provider.setCameraSetting("camera", { setting: "motionSensitivity", value: 2 }); await started;
    const actions = [() => provider.startStream("camera"), () => provider.setCameraSetting("camera", { setting: "motionSensitivity", value: 1 }),
      () => provider.setCameraEnabled("camera", true), () => provider.setCameraMotionDetection("camera", true),
      () => provider.setCameraAudioRecording("camera", true), () => provider.setCameraStreamingQuality("camera", 2),
      () => provider.refreshCameraCapabilities("camera"), () => provider.setCameraGuardMode("camera", 0),
      () => provider.setCameraNightVision("camera", 0), () => provider.setCameraPreference("camera", "speaker", 1),
      () => provider.setCameraLight("camera", true), () => provider.setCameraSiren("camera", 1),
      () => provider.getCameraPresetPositions("camera"), () => provider.selectCameraPresetPosition("camera", 0),
      () => provider.setCameraAiTracking("camera", true), () => provider.setCameraAutoCruise("camera", true)];
    for (const action of actions) await assert.rejects(Promise.resolve().then(async () => { await action(); }));
    finish(); assert.equal((await pending).reportedSettings?.motionSensitivityStep, 2); assert.equal(writes, 1);
  } finally { finish?.(); await provider.close(); await rm(directory, { recursive: true, force: true }); assert.equal(network.mock.callCount(), 0); }
});
