/**
 * Verifies exact C31 index binding and exclusive lifetime with fake cloud and
 * control sessions. The test owns synthetic inventory and performs no network.
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
import { C31IndexError } from "../src/stream/c31-recording-index.js";

for (const mode of ["valid", "disabled", "type", "model", "channel", "owner", "attached", "duplicate", "changed", "cancelled", "closed", "busy", "generation"]) {
  test(`manual index binding and recovery: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "index-provider-"));
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    const base = { device_sn: "camera", device_model: "T817L", device_type: 10031, device_channel: 0,
      category: "eufy_security", p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic", member: { admin_user_id: "synthetic-account" }, params: [] };
    let reads = 0;
    const device = { ...base, ...(mode === "type" ? { device_type: 88 } : {}), ...(mode === "model" ? { device_model: "T8171" } : {}),
      ...(mode === "channel" ? { device_channel: 1 } : {}), ...(mode === "owner" ? { member: {} } : {}), ...(mode === "attached" ? { parent_sn: "station" } : {}) };
    context.mock.method(MegaClient.prototype, "inventory", async () => {
      reads++; return { devices: mode === "duplicate" && reads > 1 ? [device, device] : [{ ...device,
        ...(mode === "changed" && reads > 2 ? { member: { admin_user_id: "changed" } } : {}) }] };
    });
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ camera: { key: "synthetic", expiresAt: null } }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => undefined);
    context.mock.method(FirstPartyPpcsSession.prototype, "readCameraInfo", async () => []);
    const controller = new AbortController();
    const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalModelControls: mode !== "disabled" });
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const query = context.mock.method(FirstPartyPpcsSession.prototype, "readC31RecordingIndex", async (_begin: number, _end: number, current: () => void) => {
      current(); entered();
      if (mode === "cancelled") controller.abort();
      if (mode === "closed") await provider.close();
      if (mode === "generation") await provider.start(new Proxy({}, { get: () => () => undefined }) as ProviderEvents);
      if (mode === "busy") await held;
      return { outcome: "empty" as const, windowMatches: true, ownerMatches: true, valid: 0, invalid: 0, overlapping: 0 };
    });
    try {
      await provider.start(new Proxy({}, { get: () => () => undefined }) as ProviderEvents);
      await new Promise(resolve => setImmediate(resolve));
      const operation = provider.readRecordingIndexTrial("camera", controller.signal);
      if (mode === "busy") { await waiting; await assert.rejects(provider.readRecordingIndexTrial("camera", new AbortController().signal), /busy/); release(); }
      if (["valid", "busy"].includes(mode)) {
        assert.equal((await operation).outcome, "empty");
        await assert.rejects(provider.readRecordingIndexTrial("camera", new AbortController().signal), /busy/);
        assert.equal(query.mock.callCount(), 1);
      } else await assert.rejects(operation, C31IndexError);
      assert.equal(network.mock.callCount(), 0);
    } finally { release(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
