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

for (const mode of ["ready", "disabled", "guest", "no-binding", "no-api", "missing-read", "changed-binding"] as const) {
  test(`S220 sensitivity retains current account, opt-in and fresh baseline: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "s220-setting-"));
    let actual = 2, writes = 0, bound = true;
    context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(globalThis, "setInterval", (() => ({ unref() {} })) as unknown as typeof setInterval);
    context.mock.method(globalThis, "clearInterval", (() => {}) as typeof clearInterval);
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", () => mode !== "guest");
    context.mock.method(MegaClient.prototype, "authenticatedBinding", () => mode === "no-binding" ? null : () => bound);
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ device_sn: "test", device_model: "T8134", device_type: 63,
      category: "eufy_security", parent_sn: "test", device_channel: 0, p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic",
      member: { admin_user_id: "synthetic" }, params: [{ param_type: 6070, param_value: "2" }] }] }));
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ test: { key: "synthetic", expiresAt: null } }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
    context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => {});
    context.mock.method(FirstPartyPpcsSession.prototype, "close");
    context.mock.method(FirstPartyPpcsSession.prototype, "readCameraInfo", async () => {
      if (mode === "changed-binding") bound = false;
      return mode === "missing-read" ? [] : [{ param_type: 6070, param_value: `${actual}` }];
    });
    context.mock.method(FirstPartyPpcsSession.prototype, "writeReviewedCameraSetting", async (_change: unknown, _route: unknown, dispatch: () => void) => {
      dispatch(); writes++; actual = 5;
    });
    const state = new GatewayState();
    const events = new Proxy({ camera: (identity: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(identity) },
      { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
    const provider = new EufyProvider({ username: "synthetic", password: "redacted", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalModelControls: mode !== "disabled", apiAuthenticationConfigured: mode !== "no-api" });
    try {
      await provider.start(events);
      if (mode === "ready") {
        assert.equal(state.getCamera("test").motionSensitivityControlSupported, true);
        assert.equal(state.getCamera("test").motionSensitivitySteps, 7);
        assert.equal((await provider.setCameraSetting("test", { setting: "motionSensitivity", value: 5 })).reportedSettings?.motionSensitivityStep, 5);
        assert.equal(writes, 1);
      } else {
        if (["disabled", "guest", "no-binding", "no-api"].includes(mode)) assert.equal(state.getCamera("test").motionSensitivityControlSupported, false);
        await assert.rejects(provider.setCameraSetting("test", { setting: "motionSensitivity", value: 5 }));
        assert.equal(writes, 0);
      }
    } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

for (const mode of ["ready", "disabled", "guest", "no-binding", "no-api", "missing-read", "changed-binding"] as const) {
  test(`S220 live quality retains current account, opt-in and fresh baseline: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "s220-setting-"));
    let actual = 1, writes = 0, bound = true;
    context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(globalThis, "setInterval", (() => ({ unref() {} })) as unknown as typeof setInterval);
    context.mock.method(globalThis, "clearInterval", (() => {}) as typeof clearInterval);
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", () => mode !== "guest");
    context.mock.method(MegaClient.prototype, "authenticatedBinding", () => mode === "no-binding" ? null : () => bound);
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ device_sn: "test", device_model: "T8134", device_type: 63,
      category: "eufy_security", parent_sn: "test", device_channel: 0, p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic",
      member: { admin_user_id: "synthetic" }, params: [{ param_type: 1020, param_value: "1" }] }] }));
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ test: { key: "synthetic", expiresAt: null } }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
    context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => {});
    context.mock.method(FirstPartyPpcsSession.prototype, "close");
    context.mock.method(FirstPartyPpcsSession.prototype, "readCameraInfo", async () => {
      if (mode === "changed-binding") bound = false;
      return mode === "missing-read" ? [] : [{ param_type: 1020, param_value: `${actual}` }];
    });
    context.mock.method(FirstPartyPpcsSession.prototype, "writeReviewedCameraSetting", async (_change: unknown, _route: unknown, dispatch: () => void) => {
      dispatch(); writes++; actual = 3;
    });
    const state = new GatewayState();
    const events = new Proxy({ camera: (identity: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(identity) },
      { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
    const provider = new EufyProvider({ username: "synthetic", password: "redacted", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalModelControls: mode !== "disabled", apiAuthenticationConfigured: mode !== "no-api" });
    try {
      await provider.start(events);
      if (mode === "ready") {
        assert.equal(state.getCamera("test").streamingQualityControlSupported, true);
        assert.deepEqual(state.getCamera("test").streamingQualityModes?.map(row => row.value), [0, 1, 2, 3]);
        assert.equal((await provider.setCameraStreamingQuality("test", 3)).reportedSettings?.streamingQualityTier, 3);
        assert.equal(writes, 1);
      } else {
        if (["disabled", "guest", "no-binding", "no-api"].includes(mode)) assert.equal(state.getCamera("test").streamingQualityControlSupported, false);
        await assert.rejects(provider.setCameraStreamingQuality("test", 3));
        assert.equal(writes, 0);
      }
    } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}


for (const mode of ["ready", "disabled", "guest", "no-binding", "no-api", "parent-owner", "missing-read", "changed-binding"] as const) {
  test(`HomeBase 2 sensitivity trial retains account, opt-in and fresh confirmation: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "hb2-setting-"));
    let actual = 46, writes = 0, bound = true;
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(globalThis, "setInterval", (() => ({ unref() {} })) as unknown as typeof setInterval);
    context.mock.method(globalThis, "clearInterval", (() => {}) as typeof clearInterval);
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", () => mode !== "guest");
    context.mock.method(MegaClient.prototype, "authenticatedBinding", () => mode === "no-binding" ? null : () => bound);
    context.mock.method(MegaClient.prototype, "inventory", async () => {
      if (mode === "changed-binding") bound = false;
      return { devices: [
        { device_sn: "base", device_model: "T8010", device_type: 0, category: "eufy_security", p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic",
          member: { admin_user_id: mode === "parent-owner" ? "other" : "synthetic" } },
        { device_sn: "camera", parent_sn: "base", device_model: "T8113-Z", device_type: 8, category: "eufy_security", device_channel: 0,
          member: { admin_user_id: "synthetic" }, params: mode === "missing-read" ? [] : [{ param_type: 1210, param_value: String(actual) }] },
      ] };
    });
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ base: { key: "synthetic", expiresAt: null } }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
    context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => {});
    context.mock.method(FirstPartyPpcsSession.prototype, "close");
    context.mock.method(FirstPartyPpcsSession.prototype, "writeReviewedCameraSetting", async (_change: unknown, _route: unknown, dispatch: () => void) => {
      dispatch(); writes++; actual = 72;
    });
    const state = new GatewayState();
    const events = new Proxy({ camera: (identity: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(identity) },
      { get: (target, name) => Reflect.get(target, name) ?? (() => {}) }) as unknown as ProviderEvents;
    const provider = new EufyProvider({ username: "synthetic", password: "redacted", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalModelControls: mode !== "disabled", apiAuthenticationConfigured: mode !== "no-api" });
    try {
      await provider.start(events);
      assert.equal(state.getCamera("camera").motionSensitivityExperimental, true);
      if (mode === "ready") {
        assert.equal(state.getCamera("camera").motionSensitivityControlSupported, true);
        assert.equal((await provider.setCameraSetting("camera", { setting: "motionSensitivity", value: 3 })).reportedSettings?.motionSensitivityStep, 3);
        assert.equal(writes, 1);
      } else {
        if (mode !== "changed-binding") assert.equal(state.getCamera("camera").motionSensitivityControlSupported, false);
        await assert.rejects(provider.setCameraSetting("camera", { setting: "motionSensitivity", value: 3 }));
        assert.equal(writes, 0);
      }
    } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); assert.equal(network.mock.callCount(), 0); }
  });
}


for (const mode of ["ready", "disabled", "guest", "no-binding", "no-api", "parent-owner", "missing-read", "changed-binding"] as const) {
  test(`2C spotlight trial retains account, opt-in and fresh confirmation: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "2c-light-"));
    let actual = 0, writes = 0, bound = true;
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(globalThis, "setInterval", (() => ({ unref() {} })) as unknown as typeof setInterval);
    context.mock.method(globalThis, "clearInterval", (() => {}) as typeof clearInterval);
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", () => mode !== "guest");
    context.mock.method(MegaClient.prototype, "authenticatedBinding", () => mode === "no-binding" ? null : () => bound);
    context.mock.method(MegaClient.prototype, "inventory", async () => {
      if (mode === "changed-binding") bound = false;
      return { devices: [
        { device_sn: "base", device_model: "T8030", device_type: 18, category: "eufy_security", p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic",
          member: { admin_user_id: mode === "parent-owner" ? "other" : "synthetic" } },
        { device_sn: "camera", parent_sn: "base", device_model: "T8113-Z", device_type: 8, category: "eufy_security", device_channel: 0,
          member: { admin_user_id: "synthetic" }, params: mode === "missing-read" ? [] : [{ param_type: 1400, param_value: String(actual) }] },
      ] };
    });
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ base: { key: "synthetic", expiresAt: null } }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
    context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => {});
    context.mock.method(FirstPartyPpcsSession.prototype, "close");
    context.mock.method(FirstPartyPpcsSession.prototype, "writeReviewedCameraSetting", async (_change: unknown, _route: unknown, dispatch: () => void) => {
      dispatch(); writes++; actual = 1; return true;
    });
    const state = new GatewayState();
    const events = new Proxy({ camera: (identity: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(identity) },
      { get: (target, name) => Reflect.get(target, name) ?? (() => {}) }) as unknown as ProviderEvents;
    const provider = new EufyProvider({ username: "synthetic", password: "redacted", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalModelControls: mode !== "disabled", apiAuthenticationConfigured: mode !== "no-api" });
    try {
      await provider.start(events);
      const reason = { ready: "ready", disabled: "trial_disabled", guest: "owner_account_required", "no-binding": "account_binding_unavailable",
        "no-api": "api_authentication_required", "parent-owner": "parent_owner_mismatch", "missing-read": "state_unavailable", "changed-binding": "ready" }[mode];
      assert.equal(state.getCamera("camera").manualFloodlightControlReason, reason);
      if (mode === "ready") {
        assert.equal(state.getCamera("camera").manualFloodlightControlSupported, true);
        assert.equal((await provider.setCameraSetting("camera", { setting: "manualFloodlight", value: true })).reportedSettings?.manualFloodlightEnabled, true);
        assert.equal(writes, 1);
      } else {
        if (mode !== "changed-binding") assert.equal(state.getCamera("camera").manualFloodlightControlSupported, false);
        await assert.rejects(provider.setCameraSetting("camera", { setting: "manualFloodlight", value: true }));
        assert.equal(writes, 0);
      }
    } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); assert.equal(network.mock.callCount(), 0); }
  });
}

for (const mode of ["administrator", "super-admin", "guest", "foreign-member", "parent-guest", "parent-foreign", "missing-role", "revoked"] as const) {
  test(`2C spotlight binds delegated authority to both current account memberships: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "2c-member-light-"));
    let actual = false, writes = 0, revoked = false;
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(globalThis, "setInterval", (() => ({ unref() {} })) as unknown as typeof setInterval);
    context.mock.method(globalThis, "clearInterval", (() => {}) as typeof clearInterval);
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (id: string) => id === "signed-in-member");
    context.mock.method(MegaClient.prototype, "authenticatedBinding", () => () => true);
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
      { device_sn: "base", device_model: "T8030", device_type: 18, category: "eufy_security", p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic",
        member: { admin_user_id: "primary-owner", member_user_id: mode === "parent-foreign" ? "foreign" : "signed-in-member", member_type: mode === "parent-guest" ? 0 : 1 } },
      { device_sn: "camera", parent_sn: "base", device_model: "T8113-Z", device_type: 8, category: "eufy_security", device_channel: 2,
        member: { admin_user_id: "primary-owner", member_user_id: mode === "foreign-member" ? "foreign" : "signed-in-member",
          ...(mode === "missing-role" ? {} : { member_type: mode === "guest" || revoked ? 0 : mode === "super-admin" ? 2 : 1 }) },
        params: [{ param_type: 1400, param_value: "0" }] },
    ] }));
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ base: { key: "synthetic", expiresAt: null } }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
    context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => {});
    context.mock.method(FirstPartyPpcsSession.prototype, "close");
    context.mock.method(FirstPartyPpcsSession.prototype, "writeReviewedCameraSetting", async (change: { value: number | boolean }, _route: unknown, dispatch: () => void) => {
      dispatch(); writes++; actual = change.value === true; return actual;
    });
    const state = new GatewayState();
    const events = new Proxy({ camera: (identity: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(identity) },
      { get: (target, name) => Reflect.get(target, name) ?? (() => {}) }) as unknown as ProviderEvents;
    const provider = new EufyProvider({ username: "synthetic", password: "redacted", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalModelControls: true, apiAuthenticationConfigured: true });
    try {
      await provider.start(events);
      const admitted = ["administrator", "super-admin", "revoked"].includes(mode);
      assert.equal(state.getCamera("camera").manualFloodlightControlSupported, admitted);
      revoked = mode === "revoked";
      if (mode === "administrator" || mode === "super-admin") {
        assert.equal((await provider.setCameraSetting("camera", { setting: "manualFloodlight", value: true })).reportedSettings?.manualFloodlightEnabled, true);
        assert.equal(writes, 1);
        assert.equal((await provider.setCameraSetting("camera", { setting: "manualFloodlight", value: false })).reportedSettings?.manualFloodlightEnabled, false);
        assert.equal(writes, 2);
        assert.equal(actual, false);
      } else {
        await assert.rejects(provider.setCameraSetting("camera", { setting: "manualFloodlight", value: true }));
        assert.equal(writes, 0);
      }
    } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); assert.equal(network.mock.callCount(), 0); }
  });
}
