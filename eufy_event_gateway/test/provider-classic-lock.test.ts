/**
 * Verifies that camera startup may publish an opt-in classic lock observation
 * while all motor and MQTT authority remains with the separate E30 adapter.
 * Tests own fake inventory and forbid both cloud and local transport effects.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import type { SmartLockState } from "../src/domain/types.js";

for (const enabled of [false, true]) for (const e30 of [false, true]) {
  test(`classic lock inventory has no actuator or transport with experimental=${enabled}, e30=${e30}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "classic-lock-"));
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ device_sn: "fixture", device_model: "T8520", device_type: 51,
      category: "eufy_security", params: [{ param_type: 6000, param_value: "3" }, { param_type: 6001, param_value: "70" }] }] }));
    const credentials = context.mock.method(MegaClient.prototype, "e30MqttCredentials", async () => { throw Error("Credentials forbidden"); });
    const peer = context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => { throw Error("Peer forbidden"); });
    context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 60, experimentalModelControls: enabled, experimentalE30Locks: e30 });
    let locks: readonly SmartLockState[] = [];
    const events = new Proxy({}, { get: (_target, name) => name === "locks" ? (rows: readonly SmartLockState[]) => { locks = rows; } : () => undefined }) as ProviderEvents;
    try {
      await provider.start(events); await new Promise(resolve => setImmediate(resolve));
      assert.equal(locks.length, enabled ? 1 : 0);
      if (enabled) { assert.equal(locks[0]?.state, "unlocked"); assert.equal(locks[0]?.readOnly, true); }
      await assert.rejects(provider.refreshLock("fixture"), /unavailable/);
      await assert.rejects(provider.setLockState("fixture", true), /unavailable/);
      await assert.rejects(provider.setLockState("fixture", false), /unavailable/);
      assert.equal(network.mock.callCount(), 0); assert.equal(credentials.mock.callCount(), 0); assert.equal(peer.mock.callCount(), 0);
    } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
