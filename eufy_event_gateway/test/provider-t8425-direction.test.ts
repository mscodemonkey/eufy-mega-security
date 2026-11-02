/**
 * Exercises standalone movement using synthetic inventories and owned sessions.
 * The fixture controls every side effect and forbids real network and device writes.
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

for (const mode of ["valid", "disabled", "no-api", "shared", "model", "type", "channel", "attached", "duplicate",
  "changed-route", "changed-owner", "changed-after-connect", "cancelled", "cancel-during-start", "shutdown", "closed",
  "write-failed", "cleanup", "hung"]) {
  test(`standalone movement admission and ownership: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "floodlight-direction-"));
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (id: string) => mode !== "shared" && id === "synthetic-owner");
    const row = { device_sn: "camera", device_model: mode === "model" ? "T8426" : "T8425", device_type: mode === "type" ? 87 : 47,
      category: "eufy_security", device_channel: mode === "channel" ? 1 : 0, p2p_did: "synthetic-peer", p2p_conn: "synthetic-route",
      member: { admin_user_id: "synthetic-owner" }, params: [], ...(mode === "attached" ? { parent_sn: "absent-parent" } : {}) };
    let inventories = 0;
    context.mock.method(MegaClient.prototype, "inventory", async () => {
      inventories++;
      return { devices: [{ ...row,
        ...(mode === "changed-route" && inventories > 1 ? { p2p_conn: "changed-route" } : {}),
        ...(mode === "changed-owner" && inventories > 1 ? { member: { admin_user_id: "other" } } : {}),
        ...(mode === "changed-after-connect" && inventories > 2 ? { device_type: 87 } : {}) },
      ...(mode === "duplicate" && inventories > 1 ? [row] : [])] };
    });
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ camera: { key: "synthetic-key", expiresAt: null } }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    const controller = new AbortController();
    const provider = new EufyProvider({ username: "fixture", password: "synthetic", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalModelControls: mode !== "disabled", apiAuthenticationConfigured: mode !== "no-api" });
    const starts = context.mock.method(FirstPartyPpcsSession.prototype, "start", async function(this: FirstPartyPpcsSession) {
      if (mode === "hung") await new Promise<void>(() => undefined);
      if (mode === "cancel-during-start") controller.abort();
      if (mode === "shutdown") await provider.close();
      if (mode === "closed") this.stats.closeReason = "client_stop";
    });
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
    context.mock.method(FirstPartyPpcsSession.prototype, "waitUntilClosed", async () => { if (mode === "cleanup") await cleanup; });
    context.mock.method(FirstPartyPpcsSession.prototype, "close", function(this: FirstPartyPpcsSession) { this.output.end(); });
    const writes = context.mock.method(FirstPartyPpcsSession.prototype, "writeModelControlTrial", async () => {
      if (mode === "write-failed") throw Error("private failure must not escape");
    });
    let published = 0;
    const events = new Proxy({}, { get: (_target, key) => key === "camera" ? () => { published++; } : () => undefined }) as ProviderEvents;
    try {
      await provider.start(events);
      await new Promise(resolve => setImmediate(resolve));
      const baseline = published;
      context.mock.timers.enable({ apis: ["setTimeout"] });
      if (mode === "cancelled") controller.abort();
      const trial = provider.performModelControlTrial("camera", { action: "ptz", direction: "left" }, controller.signal);
      const success = ["valid", "cleanup"].includes(mode);
      const result = success ? trial : assert.rejects(trial, /unavailable|Movement test did not confirm/);
      for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
      if (mode === "hung") context.mock.timers.tick(60_000);
      if (mode === "cleanup") {
        await assert.rejects(provider.performModelControlTrial("camera", { action: "ptz", direction: "right" }), /wait/i);
        await assert.rejects(provider.startStream("camera"), /Wait|recording retrieval/i);
        releaseCleanup();
      }
      if (success) {
        assert.deepEqual(await result, { outcome: "acknowledged", physicalConfirmationRequired: true });
        assert.equal(starts.mock.callCount(), 1); assert.equal(writes.mock.callCount(), 1); assert.equal(published, baseline);
      } else { await result; assert.equal(writes.mock.callCount(), mode === "write-failed" ? 1 : 0); }
      assert.equal(network.mock.callCount(), 0);
    } finally {
      releaseCleanup(); context.mock.timers.reset(); await provider.close(); await rm(directory, { recursive: true, force: true });
    }
  });
}
