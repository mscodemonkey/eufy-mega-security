/**
 * Verifies passive sensor admission and exclusive lifetime with synthetic cloud
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
import { LocalMotionError } from "../src/stream/local-motion-trial.js";

for (const mode of ["valid", "parent3", "hung", "shutdown", "disabled", "model", "type", "channel", "owner", "parent", "duplicate", "changed", "cancelled", "closed", "busy", "generation"]) {
  test(`local motion admission and cleanup: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "motion-provider-"));
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    const sensor = { device_sn: "sensor", device_model: "T8910", device_type: 10, device_channel: 3, parent_sn: "station",
      category: "eufy_security", member: { admin_user_id: "synthetic-owner" }, params: [],
      ...(mode === "model" ? { device_model: "T8911" } : {}), ...(mode === "type" ? { device_type: 127 } : {}),
      ...(mode === "channel" ? { device_channel: 255 } : {}), ...(mode === "owner" ? { member: { admin_user_id: "other" } } : {}) };
    const station = { device_sn: "station", device_model: mode === "parent" ? "T9000" : mode === "parent3" ? "T8030" : "T8010", device_type: mode === "parent3" ? 18 : 0,
      category: "eufy_security", p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic", member: { admin_user_id: "synthetic-owner" }, params: [] };
    const camera = { ...sensor, device_sn: "camera", device_model: "T8171", device_type: 88, device_channel: 1 };
    let reads = 0;
    context.mock.method(MegaClient.prototype, "inventory", async () => {
      reads++;
      return { devices: [station, camera, { ...sensor, ...(mode === "changed" && reads > 2 ? { device_channel: 4 } : {}) },
        ...(mode === "duplicate" && reads > 1 ? [{ ...sensor, device_sn: "other-sensor" }] : [])] };
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
    const close = context.mock.method(FirstPartyPpcsSession.prototype, "close", function(this: FirstPartyPpcsSession) { this.output.end(); });
    try {
      await provider.start(events); await new Promise(resolve => setImmediate(resolve));
      context.mock.timers.enable({ apis: ["setTimeout"] });
      const operation = provider.readLocalMotionTrial("sensor", controller.signal);
      const expected = ["valid", "parent3", "busy"].includes(mode) ? operation : assert.rejects(operation, LocalMotionError);
      for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve));
      if (mode === "busy") {
        await assert.rejects(provider.readLocalMotionTrial("sensor", new AbortController().signal), /busy/);
        await assert.rejects(provider.startStream("camera"), /recording retrieval/);
        for (const operation of [() => provider.setCameraEnabled("camera", true),
          () => provider.setCameraMotionDetection("camera", true), () => provider.setCameraAudioRecording("camera", true),
          () => provider.setCameraStreamingQuality("camera", 1), () => provider.setCameraNightVision("camera", 1),
          () => provider.setCameraLight("camera", true), () => provider.setCameraSiren("camera", 2)]) {
          await assert.rejects(async () => operation(), /trial|recording retrieval|busy/);
        }
        await provider.refreshStation("station");
      }
      context.mock.timers.tick(mode === "hung" ? 90_000 : 45_000);
      if (["valid", "parent3", "busy"].includes(mode)) {
        assert.deepEqual(await expected, { outcome: "inconclusive", candidates: 0 });
        await assert.rejects(provider.readLocalMotionTrial("sensor", new AbortController().signal), /busy/);
        assert.equal(start.mock.callCount(), 1); assert.ok(close.mock.callCount() >= 1);
      } else await expected;
      assert.equal(network.mock.callCount(), 0);
    } finally { context.mock.timers.reset(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
