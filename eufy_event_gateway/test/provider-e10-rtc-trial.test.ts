/**
 * Exercises E10 viewer-owned and finite-video admission through real provider state and fake I/O.
 * The fixtures own inventory, signalling and sessions. No appliance, account or
 * vendor code is contacted, and these checks do not establish hardware playback.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { NvrRtcSession, type NvrRtcOptions } from "../src/stream/nvr-rtc-session.js";

for (const mode of ["valid", "normal-disabled", "disabled", "guest", "missing-owner", "wrong-model", "wrong-type", "attached", "channel", "ppcs"] as const) {
  test(`E10 RTC ${mode} preserves admission and keeps settings closed`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "e10-trial-"));
    context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.getter(MegaClient.prototype, "isAuthenticated", () => true);
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (owner: string) => mode !== "guest" && owner === "synthetic-owner");
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
      { device_sn: "synthetic-e10", device_model: mode === "wrong-model" ? "T8404X" : "T8404", device_type: mode === "wrong-type" ? 9 : 314,
        category: "eufy_security", parent_sn: mode === "attached" ? "synthetic-parent" : "synthetic-e10", device_channel: mode === "channel" ? 1 : 0,
        member: mode === "missing-owner" ? {} : { admin_user_id: "synthetic-owner" }, ...(mode === "ppcs" ? { app_conn: "synthetic-ppcs" } : {}) },
      ...(mode === "attached" ? [{ device_sn: "synthetic-parent", device_model: "T8N00", device_type: 300, category: "eufy_security", member: { admin_user_id: "synthetic-owner" } }] : [])] }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
    let signs = 0, starts = 0, closes = 0;
    context.mock.method(MegaClient.prototype, "nvrSignallingContext", async (serial: string) => {
      signs++; assert.equal(serial, "synthetic-e10");
      return { host: "security-smart.eufylife.com", region: "US", authToken: "synthetic", gtoken: "synthetic", sign: "synthetic" };
    });
    context.mock.method(NvrRtcSession.prototype, "start", async function(this: NvrRtcSession) {
      const options = Reflect.get(this, "options") as NvrRtcOptions;
      assert.equal(options.e10RtpTrial, true);
      assert.equal(options.cameraType, 314); assert.equal(options.sensor, 0); assert.equal(options.liveControls, false);
      assert.equal(options.maximumLifetimeMilliseconds, mode === "valid" && starts < 2 ? null : 75_000);
      assert.equal(options.audio, false); assert.equal(options.current(), true); starts++;
    });
    context.mock.method(NvrRtcSession.prototype, "close", async () => { closes++; });
    const state = new GatewayState();
    const events = new Proxy({ camera: (value: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(value) },
      { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
    const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalNvrLive: mode !== "disabled", normalNvrLive: mode !== "normal-disabled", experimentalNvrControls: true, experimentalModelControls: true });
    try {
      await provider.start(events);
      const controller = new AbortController();
      await assert.rejects(provider.readNvrStateTrial("synthetic-e10", controller.signal));
      if (mode !== "valid" && mode !== "normal-disabled") {
        if (mode === "disabled" || mode === "guest" || mode === "missing-owner") {
          assert.equal(state.getCamera("synthetic-e10").streamSupported, false);
          await assert.rejects(provider.startStream("synthetic-e10"));
        }
        assert.throws(() => provider.reserveNvrLiveTrial("synthetic-e10", controller.signal));
        assert.equal(signs, 0); assert.equal(starts, 0); return;
      }
      assert.equal(state.getCamera("synthetic-e10").streamSupported, mode === "valid");
      assert.equal(state.getCamera("synthetic-e10").hlsIdleHandoverSupported, mode === "valid");
      assert.equal(state.getCamera("synthetic-e10").liveAudioSupported, false);
      assert.equal(state.getCamera("synthetic-e10").nvrLiveControlsSupported, false);
      assert.equal(state.getCamera("synthetic-e10").nightVisionControlSupported, false);
      if (mode === "valid") {
        await provider.startStream("synthetic-e10"); assert.equal(starts, 1); assert.equal(signs, 1);
        assert.throws(() => provider.reserveNvrLiveTrial("synthetic-e10", controller.signal));
        await provider.stopStream("synthetic-e10"); assert.ok(closes > 0);
        await provider.startStream("synthetic-e10"); assert.equal(starts, 2); assert.equal(signs, 2);
        await provider.stopStream("synthetic-e10"); assert.ok(closes >= 2);
      } else {
        await assert.rejects(provider.startStream("synthetic-e10")); assert.equal(signs, 0);
      }
      const release = provider.reserveNvrLiveTrial("synthetic-e10", controller.signal);
      assert.throws(() => provider.reserveNvrLiveTrial("synthetic-e10", controller.signal));
      await provider.startStream("synthetic-e10");
      assert.equal(starts, mode === "valid" ? 3 : 1); assert.equal(signs, starts);
      controller.abort(); await release(); assert.ok(closes > 0);
      const again = provider.reserveNvrLiveTrial("synthetic-e10", new AbortController().signal); await again();
      assert.equal(state.getCamera("synthetic-e10").streamSupported, mode === "valid");
    } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
