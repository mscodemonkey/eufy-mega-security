/**
 * Verifies exact manual-light admission and exclusive lifetime with synthetic cloud
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
import type { ModelControlTrial, ModelControlRoute } from "../src/provider/model-control-trials.js";
import type { ProviderEvents } from "../src/provider/provider.js";


for (const mode of ["valid", "off", "hung", "shutdown", "account", "disabled", "model", "type", "channel", "owner", "parent", "duplicate", "changed", "cancelled", "closed", "busy", "generation"]) {
  test(`manual light binding and cleanup: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "light-provider-"));
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (value: string) => mode !== "account" && value === "synthetic-owner");
    const sensor = { device_sn: "sensor", device_model: "T81A0", device_type: 10005, device_channel: 3, parent_sn: "station",
      category: "eufy_security", member: { admin_user_id: "synthetic-owner" }, params: [],
      ...(mode === "model" ? { device_model: "T84A0" } : {}), ...(mode === "type" ? { device_type: 127 } : {}),
      ...(mode === "channel" ? { device_channel: 255 } : {}), ...(mode === "owner" ? { member: { admin_user_id: "other" } } : {}) };
    const station = { device_sn: "station", device_model: "T8030", device_type: mode === "parent" ? 0 : 18,
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
    let cameraEvents = 0;
    const events = new Proxy({}, { get: (_target, key) => key === "camera" ? () => { cameraEvents++; } : () => undefined }) as ProviderEvents;
    const start = context.mock.method(FirstPartyPpcsSession.prototype, "start", async function(this: FirstPartyPpcsSession) {
      if (mode === "hung") await new Promise<void>(() => undefined);
      if (mode === "shutdown") await provider.close();
      if (mode === "cancelled") controller.abort();
      if (mode === "closed") { this.stats.closeReason = "client_stop"; this.output.end(); }
      if (mode === "generation") await provider.start(events);
    });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const write = context.mock.method(FirstPartyPpcsSession.prototype, "writeModelControlTrial", async (_request: ModelControlTrial, _route: ModelControlRoute, current?: () => void) => {
      current!(); if (mode === "busy") await held; current!();
    });
    const close = context.mock.method(FirstPartyPpcsSession.prototype, "close", function(this: FirstPartyPpcsSession) { this.output.end(); });
    try {
      await provider.start(events); await new Promise(resolve => setImmediate(resolve));
      context.mock.timers.enable({ apis: ["setTimeout"] });
      const baseline = cameraEvents;
      const request = { action: "manualLight" as const, enabled: mode !== "off" };
      const operation = provider.performModelControlTrial("sensor", request, controller.signal);
      const expected = ["valid", "off", "busy"].includes(mode) ? operation : assert.rejects(operation, /Manual light test did not confirm the light state/);
      for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve));
      if (mode === "busy") {
        await assert.rejects(provider.performModelControlTrial("sensor", request), /Manual light test/);
        await assert.rejects(provider.startStream("camera"), /recording retrieval/);
        for (const operation of [() => provider.setCameraEnabled("camera", true),
          () => provider.setCameraMotionDetection("camera", true), () => provider.setCameraAudioRecording("camera", true),
          () => provider.setCameraStreamingQuality("camera", 1), () => provider.setCameraNightVision("camera", 1),
          () => provider.setCameraLight("camera", true), () => provider.setCameraSiren("camera", 2)]) {
          await assert.rejects(async () => operation(), /trial|recording retrieval|busy/);
        }
        await provider.refreshStation("station");
        release();
      }
      if (mode === "hung") context.mock.timers.tick(60_000);
      if (["valid", "off", "busy"].includes(mode)) {
        assert.deepEqual(await expected, { outcome: "acknowledged", physicalConfirmationRequired: true });
        assert.equal(cameraEvents, baseline); assert.equal(write.mock.callCount(), 1);
        assert.equal(start.mock.callCount(), 1); assert.ok(close.mock.callCount() >= 1);
      } else { await expected; assert.equal(write.mock.callCount(), 0); }
      assert.equal(network.mock.callCount(), 0);
    } finally { release(); context.mock.timers.reset(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
