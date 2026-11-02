/**
 * Checks history-name admission and ownership with invented inventory and sessions.
 * Mocks forbid network and detection publication, while the provider owns cleanup.
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
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";
import type { ProviderEvents } from "../src/provider/provider.js";

for (const mode of ["valid", "unauthenticated", "wrong-model", "changed", "duplicate", "cancelled", "busy"] as const) {
  test(`manual history-name provider lifecycle: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "history-names-provider-"));
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    const child = { device_sn: "invented-child", device_model: mode === "wrong-model" ? "T8214" : "T8210", device_type: 7,
      device_channel: 2, parent_sn: "invented-parent", category: "eufy_security", member: { admin_user_id: "invented-owner" }, params: [] };
    const parent = { device_sn: "invented-parent", device_model: "T8030", device_type: 18, category: "eufy_security",
      p2p_did: "TEST-12345678-TEST", p2p_conn: "invented", member: { admin_user_id: "invented-owner" }, params: [] };
    let reads = 0;
    context.mock.method(MegaClient.prototype, "inventory", async () => {
      reads++;
      return { devices: [parent, { ...child, ...(mode === "changed" && reads > 1 ? { device_channel: 3 } : {}) },
        ...(mode === "duplicate" && reads > 1 ? [child] : [])] };
    });
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ "invented-parent": { key: "invented", expiresAt: null } }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => undefined);
    context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [] }));
    context.mock.method(HomeBasePpcsSession.prototype, "close", () => undefined);
    const controller = new AbortController();
    const start = context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => { if (mode === "cancelled") controller.abort(); });
    let release: (() => void) | undefined;
    const summary = { scope: "one_history_page" as const, records: 1, personCrops: 1, recordsWithFamiliarNames: 1, unresolvedPersonCrops: 0 };
    const query = context.mock.method(FirstPartyPpcsSession.prototype, "readEventNameHistory", async () => {
      if (mode === "busy") await new Promise<void>(resolve => { release = resolve; });
      return summary;
    });
    const close = context.mock.method(FirstPartyPpcsSession.prototype, "close", function(this: FirstPartyPpcsSession) { this.output.end(); });
    const drained = context.mock.method(FirstPartyPpcsSession.prototype, "waitUntilClosed", async () => undefined);
    const provider = new EufyProvider({ username: "invented", password: "invented", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, apiAuthenticationConfigured: mode !== "unauthenticated" });
    const detections: string[] = [];
    const events = new Proxy({}, { get: (_target, key) => (..._values: unknown[]) => {
      if (key === "personName" || key === "person") detections.push(String(key));
    } }) as ProviderEvents;
    try {
      await provider.start(events); await new Promise(resolve => setImmediate(resolve));
      const operation = provider.diagnoseEventNames("invented-child", "2026-10-31", "0", controller.signal);
      if (mode === "valid" || mode === "busy") {
        if (mode === "busy") {
          for (let i = 0; i < 20 && !release; i++) await new Promise(resolve => setImmediate(resolve));
          assert.ok(release);
          await assert.rejects(provider.diagnoseEventNames("invented-child", "2026-10-31", "0", controller.signal), /busy/);
          release();
        }
        assert.deepEqual(await operation, summary); assert.equal(query.mock.callCount(), 1);
        assert.equal(close.mock.callCount(), 1); assert.equal(drained.mock.callCount(), 1);
      } else {
        await assert.rejects(operation, /unavailable|cancelled/);
        assert.equal(query.mock.callCount(), 0);
        if (mode === "cancelled") { assert.ok(close.mock.callCount() >= 1); assert.equal(drained.mock.callCount(), 1); }
        else assert.equal(start.mock.callCount(), 0);
      }
      assert.deepEqual(detections, []); assert.equal(network.mock.callCount(), 0);
    } finally { release?.(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
