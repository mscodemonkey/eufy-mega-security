/**
 * Checks paced startup recovery with synthetic cloud outcomes and owned timers.
 * The provider owns retry generations. No account login, peer or security write
 * is performed, and close/replacement startup must retire old scheduled reads.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import type { ProviderEvents } from "../src/provider/provider.js";

for (const mode of ["recovers", "close", "replaced", "permanent", "partial"] as const) {
  test(`inventory startup retry ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "inventory-startup-retry-"));
    const temporary = new Error("synthetic temporary inventory failure");
    const permanent = new Error("synthetic permanent refusal");
    let reads = 0, discoveries = 0;
    const states: string[] = [], details: string[] = [];
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    const connect = context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.getter(MegaClient.prototype, "isAuthenticated", () => true);
    context.mock.method(MegaClient.prototype, "isInventoryTemporarilyUnavailable", (error: unknown) => error === temporary);
    context.mock.method(MegaClient.prototype, "inventory", async () => {
      reads++;
      if (mode === "permanent") throw permanent;
      if (mode !== "partial" && (mode === "close" || reads <= (mode === "recovers" ? 2 : 1))) throw temporary;
      return { ...(mode === "partial" ? { complete: false } : {}), devices: [{ device_sn: "synthetic", device_model: "T8171", device_type: 88, category: "eufy_security",
        parent_sn: "synthetic", device_channel: 0, params: [], member: { admin_user_id: "synthetic-owner" } }] };
    });
    context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
    const provider = new EufyProvider({ username: "synthetic", password: "redacted", country: "AU", persistentDirectory: directory, maxStreamSeconds: 120 });
    const events = new Proxy({}, { get: (_target, key) => key === "connection" ? (state: string, detail: string) => { states.push(state); details.push(detail); }
      : key === "camera" ? () => { discoveries++; } : () => {} }) as ProviderEvents;
    const settled = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
    context.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      if (mode === "partial") {
        await provider.start(events);
        assert.equal(states.at(-1), "connected");
        assert.match(details.at(-1)!, /partial inventory/);
        assert.equal(discoveries, 1);
      } else if (mode === "permanent") {
        await assert.rejects(provider.start(events), error => error === permanent);
        context.mock.timers.tick(120_000); await settled(); assert.equal(reads, 1);
      } else {
        await provider.start(events); assert.equal(reads, 1); assert.equal(states.at(-1), "disconnected");
        if (mode === "close") {
          await provider.close(); context.mock.timers.tick(120_000); await settled(); assert.equal(reads, 1);
        } else if (mode === "replaced") {
          await provider.start(events); assert.equal(reads, 2);
          context.mock.timers.tick(120_000); await settled(); assert.equal(reads, 2);
          assert.equal(states.at(-1), "connected");
        } else {
          context.mock.timers.tick(59_999); await settled(); assert.equal(reads, 1);
          context.mock.timers.tick(1); await settled(); assert.equal(reads, 2);
          context.mock.timers.tick(60_000); await settled(); assert.equal(reads, 3);
          assert.equal(states.at(-1), "connected"); assert.equal(discoveries, 1);
          assert.equal(connect.mock.callCount(), 1, "retry only inventory, never repeat authentication");
        }
      }
      assert.equal(network.mock.callCount(), 0);
    } finally { context.mock.timers.reset(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
