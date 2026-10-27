/**
 * Exercises opt-in T8425 brightness through the production provider.
 * Fixtures own current account, cloud inventory and local parameter replies.
 * No real request or device command is available to these tests.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { CameraSettingError } from "../src/provider/camera-settings.js";
import { GatewayState } from "../src/domain/gateway-state.js";

for (const { setting, model, type } of [
  { setting: "lightBrightness", model: "T8425", type: 47 },
  { setting: "lightBrightness", model: "T8426", type: 87 },
  { setting: "manualFloodlight", model: "T8426", type: 87 },
] as const) for (const mode of ["success", "disabled", "shared", "missing", "changed-account", "lost-reply"] as const) {
  test(`${model} ${setting} provider ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "brightness-"));
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ device_sn: "fixture", device_model: model, device_type: type,
      category: "eufy_security", device_channel: 0, p2p_did: "fixture-peer", p2p_conn: "fixture-route", member: { admin_user_id: "fixture-owner" },
      params: [{ param_type: setting === "lightBrightness" ? 1401 : 1400, param_value: setting === "lightBrightness" ? "80" : "0" }] }] }));
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ fixture: { key: "fixture-key", expiresAt: null } }));
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", () => mode !== "shared");
    let current = true;
    context.mock.method(MegaClient.prototype, "authenticatedBinding", () => () => current);
    context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    const opened = context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => undefined);
    context.mock.method(FirstPartyPpcsSession.prototype, "close");
    const baseline = setting === "lightBrightness" ? 80 : false;
    const expected = setting === "lightBrightness" ? 70 : true;
    const field = setting === "lightBrightness" ? "lightBrightness" : "manualFloodlightEnabled";
    const capability = setting === "lightBrightness" ? "lightBrightnessControlSupported" : "manualFloodlightControlSupported";
    let value: number | boolean = baseline, reads = 0, writes = 0;
    context.mock.method(FirstPartyPpcsSession.prototype, "readCameraInfo", async () => {
      reads++;
      if (mode === "changed-account") current = false;
      return mode === "missing" ? [] : [{ param_type: setting === "lightBrightness" ? 1401 : 1400, param_value: `${typeof value === "boolean" ? Number(value) : value}` }];
    });
    context.mock.method(FirstPartyPpcsSession.prototype, "writeReviewedCameraSetting", async (change: { value: number | boolean }, _route: unknown, dispatch: () => void) => {
      dispatch(); writes++;
      if (mode === "lost-reply") throw Error("Lost reply");
      value = change.value;
    });
    const state = new GatewayState();
    const events = new Proxy({ camera: (camera: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(camera) },
      { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) }) as unknown as ProviderEvents;
    const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 60, experimentalModelControls: mode !== "disabled" });
    try {
      await provider.start(events);
      assert.equal(state.getCamera("fixture")[capability], !["disabled", "shared"].includes(mode));
      const result = provider.setCameraSetting("fixture", setting === "lightBrightness" ? { setting, value: 70 } : { setting, value: true });
      if (mode === "success") {
        assert.equal((await result).reportedSettings?.[field], expected);
        assert.equal(reads, 2); assert.equal(writes, 1);
      } else {
        await assert.rejects(result, (error: unknown) => error instanceof CameraSettingError && error.code === (mode === "lost-reply" ? "outcome_unknown" : "unavailable"));
        assert.equal(writes, mode === "lost-reply" ? 1 : 0);
        assert.equal(state.getCamera("fixture").reportedSettings?.[field], mode === "lost-reply" ? null : baseline);
      }
      if (["disabled", "shared"].includes(mode)) assert.equal(opened.mock.callCount(), 0);
      assert.equal(network.mock.callCount(), 0);
    } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
