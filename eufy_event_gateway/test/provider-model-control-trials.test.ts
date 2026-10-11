/**
 * Exercises peer ownership and fresh trial state through the real provider.
 * Synthetic cloud, push and PPCS prototypes own every external effect.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { GatewayState } from "../src/domain/gateway-state.js";

for (const mode of ["disabled", "enabled", "missing-key"]) {
  const enabled = mode !== "disabled";
  test(`provider trial mode=${mode} owns its peer, confirms fresh state and releases on failure`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "eufy-trial-provider-"));
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ device_sn: "camera", device_model: "T8423",
      device_type: 38, category: "eufy_security", device_channel: 0, p2p_did: "synthetic-peer", p2p_conn: "synthetic-route",
      member: { admin_user_id: "synthetic-account" }, params: [{ param_type: 6040, param_value: "1" }] }] }));
    context.mock.method(MegaClient.prototype, "dskKeys", async () => mode === "missing-key" ? {} : ({ camera: { key: "synthetic-key", expiresAt: null } }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    const starts = context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => undefined);
    const closes = context.mock.method(FirstPartyPpcsSession.prototype, "close");
    let reads = 0, release!: () => void;
    const entered = new Promise<void>(resolve => { release = resolve; });
    let finish!: () => void;
    const writing = new Promise<void>(resolve => { finish = resolve; });
    context.mock.method(FirstPartyPpcsSession.prototype, "readCameraInfo", async () => [{ param_type: 6040, param_value: ++reads === 1 ? "1" : "0" }]);
    const writes = context.mock.method(FirstPartyPpcsSession.prototype, "writeModelControlTrial", async () => { release(); await writing; });
    const state = new GatewayState();
    const events = new Proxy({ camera: (identity: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(identity) },
      { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) }) as unknown as ProviderEvents;
    const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalModelControls: enabled });
    try {
      await provider.start(events);
      if (!enabled) {
        assert.deepEqual(provider.modelControlTrials("camera"), []);
        await assert.rejects(provider.performModelControlTrial("camera", { action: "motion", enabled: false }), /unavailable/);
        assert.equal(starts.mock.callCount(), 0);
        return;
      }
      assert.deepEqual(provider.modelControlTrials("camera"), ["motion", "spotlight", "ptz"]);
      if (mode === "missing-key") {
        await assert.rejects(provider.performModelControlTrial("camera", { action: "motion", enabled: false }), /keys unavailable/);
        assert.equal(starts.mock.callCount(), 0);
        return;
      }
      const trial = provider.performModelControlTrial("camera", { action: "motion", enabled: false });
      await entered;
      assert.equal(state.getCamera("camera").motionDetectionEnabled, true);
      await assert.rejects(provider.startStream("camera"), /Wait/);
      await assert.rejects(provider.performModelControlTrial("camera", { action: "ptz", direction: "left" }), /wait/i);
      assert.throws(() => provider.setCameraLight("camera", true), /trial/);
      finish();
      assert.equal((await trial).outcome, "confirmed");
      assert.equal(writes.mock.callCount(), 1);
      assert.equal(state.getCamera("camera").motionDetectionEnabled, false);
      assert.equal(closes.mock.callCount(), 1);
      context.mock.method(FirstPartyPpcsSession.prototype, "writeModelControlTrial", async () => { throw Error("rejected"); });
      await assert.rejects(provider.performModelControlTrial("camera", { action: "ptz", direction: "up" }), /rejected/);
      assert.equal(closes.mock.callCount(), 2);
      context.mock.method(FirstPartyPpcsSession.prototype, "writeModelControlTrial", async () => undefined);
      assert.equal((await provider.performModelControlTrial("camera", { action: "ptz", direction: "down" })).outcome, "acknowledged");
      assert.equal(closes.mock.callCount(), 3);
      let enteredClosing!: () => void, releaseClosing!: () => void;
      const closingEntered = new Promise<void>(resolve => { enteredClosing = resolve; });
      const closingWrite = new Promise<void>(resolve => { releaseClosing = resolve; });
      context.mock.method(FirstPartyPpcsSession.prototype, "writeModelControlTrial", async () => { enteredClosing(); await closingWrite; });
      const retiring = provider.performModelControlTrial("camera", { action: "ptz", direction: "right" });
      await closingEntered;
      await provider.close();
      releaseClosing();
      await assert.rejects(retiring, /closed/);
      assert.deepEqual(provider.modelControlTrials("camera"), []);
    } finally { finish?.(); await provider.close(); await rm(directory, { recursive: true, force: true }); assert.equal(network.mock.callCount(), 0); }
    assert.equal(network.mock.callCount(), 0);
  });
}
