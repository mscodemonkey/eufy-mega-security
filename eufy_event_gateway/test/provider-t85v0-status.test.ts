/**
 * Verifies read-only FamiLock admission and exclusive lifetime with synthetic cloud
 * rows and sessions. The test forbids network and never writes to a device.
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
import { T85V0StatusError, type T85V0StatusIdentity } from "../src/provider/t85v0-status.js";

for (const mode of ["valid", "hung", "shutdown", "disabled", "model", "type", "channel", "owner", "shared", "parent", "parent-type", "serial", "after-reply", "raw-duplicate", "duplicate", "changed", "cancelled", "closed", "busy", "generation"]) {
  test(`FamiLock status admission and cleanup: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "motion-provider-"));
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (id: string) => mode !== "shared" && id === "synthetic-owner");
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    const sensor = { device_sn: mode === "serial" ? "short" : "SYNTHETICLOCK001", device_model: "T85V0", device_type: 203, device_channel: 3, parent_sn: "station",
      category: "eufy_security", member: { admin_user_id: "synthetic-owner" }, params: [],
      ...(mode === "model" ? { device_model: "T85V1" } : {}), ...(mode === "type" ? { device_type: 127 } : {}),
      ...(mode === "channel" ? { device_channel: 255 } : {}), ...(mode === "owner" ? { member: { admin_user_id: "other" } } : {}) };
    const station = { device_sn: "station", device_model: mode === "parent" ? "T9000" : "T8030", device_type: mode === "parent-type" ? 0 : 18,
      category: "eufy_security", p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic", member: { admin_user_id: "synthetic-owner" }, params: [] };
    const camera = { ...sensor, device_sn: "camera", device_model: "T8171", device_type: 88, device_channel: 1 };
    let reads = 0;
    context.mock.method(MegaClient.prototype, "inventory", async () => {
      reads++;
      return { devices: [station, camera, { ...sensor, ...(((mode === "changed" && reads > 2) || (mode === "after-reply" && reads > 3)) ? { device_channel: 4 } : {}) },
        ...(mode === "duplicate" && reads > 1 ? [{ ...sensor, device_sn: "other-sensor" }] : []),
        ...(mode === "raw-duplicate" && reads > 1 ? [{ ...sensor }] : [])] };
    });
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ station: { key: "synthetic", expiresAt: null } }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => undefined);
    context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [] }));
    context.mock.method(HomeBasePpcsSession.prototype, "close", () => undefined);
    const controller = new AbortController();
    const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalModelControls: mode !== "disabled" });
    const events = new Proxy({}, { get: () => () => undefined }) as ProviderEvents;
    const start = context.mock.method(FirstPartyPpcsSession.prototype, "start", async function(this: FirstPartyPpcsSession) {
      if (mode === "hung") await new Promise<void>(() => undefined);
      if (mode === "shutdown") await provider.close();
      if (mode === "cancelled") controller.abort();
      if (mode === "closed") { this.stats.closeReason = "client_stop"; this.output.end(); }
      if (mode === "generation") await provider.start(events);
    });
    const query = context.mock.method(FirstPartyPpcsSession.prototype, "readT85V0Status", async function(_identity: T85V0StatusIdentity, _time: number, _sequence: number, current: () => void) {
      current();
      if (mode === "busy") await new Promise<void>(resolve => setTimeout(resolve, 500));
      return { reportedState: "locked" as const, batteryPercent: 77, physicalConfirmationRequired: true as const };
    });
    const close = context.mock.method(FirstPartyPpcsSession.prototype, "close", function(this: FirstPartyPpcsSession) { this.output.end(); });
    try {
      await provider.start(events); await new Promise(resolve => setImmediate(resolve));
      context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
      const operation = provider.readT85V0StatusTrial("SYNTHETICLOCK001", controller.signal);
      const expected = ["valid", "busy"].includes(mode) ? operation : assert.rejects(operation, T85V0StatusError);
      for (let index = 0; index < 15; index++) await new Promise(resolve => setImmediate(resolve));
      if (mode === "busy") {
        await assert.rejects(provider.readT85V0StatusTrial("SYNTHETICLOCK001", new AbortController().signal), /busy/);
        await assert.rejects(provider.startStream("camera"), /recording retrieval/);
        for (const operation of [() => provider.setCameraEnabled("camera", true),
          () => provider.setCameraMotionDetection("camera", true), () => provider.setCameraAudioRecording("camera", true),
          () => provider.setCameraStreamingQuality("camera", 1), () => provider.setCameraNightVision("camera", 1),
          () => provider.setCameraLight("camera", true), () => provider.setCameraSiren("camera", 2)]) {
          await assert.rejects(async () => operation(), /trial|recording retrieval|busy/);
        }
        await provider.refreshStation("station");
      }
      context.mock.timers.tick(mode === "hung" ? 60_000 : 500);
      if (["valid", "busy"].includes(mode)) {
        assert.deepEqual(await expected, { reportedState: "locked", batteryPercent: 77, physicalConfirmationRequired: true });
        await assert.rejects(provider.readT85V0StatusTrial("SYNTHETICLOCK001", new AbortController().signal), /busy/);
        assert.equal(start.mock.callCount(), 1); assert.equal(query.mock.callCount(), 1); assert.ok(close.mock.callCount() >= 1);
        if(mode === "valid") {
          context.mock.timers.tick(10_000);
          await provider.readT85V0StatusTrial("SYNTHETICLOCK001", new AbortController().signal);
          const first=query.mock.calls[0]!.arguments, second=query.mock.calls[1]!.arguments;
          assert.ok(second[1]! > first[1]!); assert.ok(second[2]! > first[2]!);
        }
      } else { await expected; if (mode === "after-reply") assert.equal(query.mock.callCount(),1); }
      assert.equal(network.mock.callCount(), 0);
    } finally { context.mock.timers.reset(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
