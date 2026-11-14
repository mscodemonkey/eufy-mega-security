/**
 * Verifies exact standalone L40 admission and exclusive lifetime with synthetic cloud
 * rows and sessions. The test forbids network and never writes to a device.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { S120LightTrialError } from "../src/provider/s120-light-diagnostic.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";
import type { ModelControlTrial, ModelControlRoute } from "../src/provider/model-control-trials.js";
import type { ProviderEvents } from "../src/provider/provider.js";


for (const mode of ["valid", "off", "button", "hung", "shutdown", "account", "disabled", "model", "type", "channel", "owner", "changed", "cancelled", "closed", "cleanup", "generation", "baseline_failed", "session_failed", "write_prepare_failed", "receipt_timeout", "cleanup_failed", "receipt_cleanup_failed"]) {
  test(`L40 manual light binding and cleanup: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "light-provider-"));
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (value: string) => mode !== "account" && value === "synthetic-owner");
    const sensor = { device_sn: "sensor", device_model: "T8123", device_type: 61, device_channel: 0, parent_sn: "sensor",
      p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic",
      category: "eufy_security", member: { admin_user_id: "synthetic-owner" }, params: [],
      ...(mode === "model" ? { device_model: "T84A0" } : {}), ...(mode === "type" ? { device_type: 127 } : {}),
      ...(mode === "channel" ? { device_channel: 255 } : {}), ...(mode === "owner" ? { member: { admin_user_id: "other" } } : {}) };
    let reads = 0;
    context.mock.method(MegaClient.prototype, "inventory", async () => {
      reads++;
      if (mode === "baseline_failed" && reads > 1) throw Error("PRIVATE_BASELINE");
      return { devices: [{ ...sensor, ...(mode === "changed" && reads > 2 ? { device_channel: 4 } : {}) }] };
    });
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ sensor: { key: "synthetic", expiresAt: null } }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => undefined);
    context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [] }));
    context.mock.method(HomeBasePpcsSession.prototype, "close", () => undefined);
    const controller = new AbortController();
    const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, apiAuthenticationConfigured: mode === "button", experimentalModelControls: mode !== "disabled" });
    let cameraEvents = 0, experimentalOffered = false;
    const events = new Proxy({}, { get: (_target, key) => key === "camera" ? (value: { serial: string; experimentalLightControlSupported?: boolean }) => {
      cameraEvents++;
      if (value.serial === "sensor") experimentalOffered = value.experimentalLightControlSupported === true;
    } : () => undefined }) as ProviderEvents;
    const start = context.mock.method(FirstPartyPpcsSession.prototype, "start", async function(this: FirstPartyPpcsSession) {
      if (mode === "session_failed") throw Error("PRIVATE_SESSION");
      if (mode === "hung") await new Promise<void>(() => undefined);
      if (mode === "shutdown") await provider.close();
      if (mode === "cancelled") controller.abort();
      if (mode === "closed") { this.stats.closeReason = "client_stop"; this.output.end(); }
      if (mode === "generation") await provider.start(events);
    });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    context.mock.method(FirstPartyPpcsSession.prototype, "waitUntilClosed", async () => {
      if (["cleanup_failed", "receipt_cleanup_failed"].includes(mode)) throw Error("PRIVATE_CLEANUP");
      if (mode === "cleanup") await held;
    });
    const write = context.mock.method(FirstPartyPpcsSession.prototype, "writeModelControlTrial", async (_request: ModelControlTrial, _route: ModelControlRoute, current?: () => void, onDispatch?: () => void) => {
      current!();
      if (mode === "write_prepare_failed") throw Error("PRIVATE_PREPARE");
      onDispatch?.();
      if (["receipt_timeout", "receipt_cleanup_failed"].includes(mode)) throw Error("PRIVATE_RECEIPT");
      current!();
    });
    const close = context.mock.method(FirstPartyPpcsSession.prototype, "close", function(this: FirstPartyPpcsSession) { this.output.end(); });
    try {
      await provider.start(events); await new Promise(resolve => setImmediate(resolve));
      context.mock.timers.enable({ apis: ["setTimeout"] });
      const baseline = cameraEvents;
      if (mode === "button") assert.equal(experimentalOffered, true);
      const request = { action: "manualLight" as const, enabled: mode !== "off" };
      const operation = mode === "button" ? provider.setCameraLight("sensor", request.enabled)
        : provider.performModelControlTrial("sensor", request, controller.signal);
      const expected = ["valid", "off", "button", "cleanup"].includes(mode) ? operation : assert.rejects(operation, /Manual light test did not confirm the light state/);
      for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve));
      if (mode === "cleanup") {
        await assert.rejects(provider.performModelControlTrial("sensor", request), error => {
          assert.ok(error instanceof S120LightTrialError);
          assert.equal(error.stage, "busy"); assert.equal(error.busyReason, "trial");
          assert.equal(error.writeAttempted, false);
          return true;
        });
        await assert.rejects(provider.startStream("sensor"), /recording retrieval|Wait/i);
        release();
      }
      if (mode === "hung") context.mock.timers.tick(60_000);
      if (["valid", "off", "button", "cleanup"].includes(mode)) {
        if (mode === "button") assert.equal(await expected, undefined);
        else assert.deepEqual(await expected, { outcome: "acknowledged", physicalConfirmationRequired: true });
        assert.equal(cameraEvents, baseline); assert.equal(write.mock.callCount(), 1);
        assert.equal(start.mock.callCount(), 1); assert.ok(close.mock.callCount() >= 1);
      } else {
        await expected;
        const phases = {
          baseline_failed: ["initial_inventory", false, false, false],
          session_failed: ["session_connect", false, false, false],
          write_prepare_failed: ["write_prepare", false, false, false],
          receipt_timeout: ["write_receipt", true, false, false],
          cleanup_failed: ["cleanup", true, true, true],
          receipt_cleanup_failed: ["write_receipt", true, false, true],
        } as const;
        if (mode in phases) {
          const failure = await operation.catch(error => error);
          assert.ok(failure instanceof S120LightTrialError);
          assert.deepEqual([failure.stage, failure.writeAttempted, failure.acknowledgementReceived, failure.cleanupFailed],
            phases[mode as keyof typeof phases]);
        }
        assert.equal(write.mock.callCount(), ["write_prepare_failed", "receipt_timeout", "cleanup_failed", "receipt_cleanup_failed"].includes(mode) ? 1 : 0);
      }
      assert.equal(network.mock.callCount(), 0);
    } finally { release(); context.mock.timers.reset(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
