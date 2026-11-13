/**
 * Verifies exact manual-light admission and exclusive lifetime with synthetic cloud
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


for (const family of ["s120", "e330"] as const) for (const entry of ["valid", "off", "button", "hung", "shutdown", "account", "disabled", "model", "type", "channel", "owner", "parent", "duplicate", "changed", "cancelled", "closed", "busy", "cleanup", "generation", "baseline_failed", "session_failed", "write_prepare_failed", "receipt_timeout", "cleanup_failed", "receipt_cleanup_failed", "button_receipt_timeout", "button_cleanup_failed"]) {
  const button = entry === "button" || entry.startsWith("button_");
  const mode = entry.replace(/^button_/, "");
  test(`${family} manual light binding and cleanup: ${entry}`, async context => {
    const logs: string[] = [];
    const stderr = process.stderr.write;
    context.mock.method(process.stderr, "write", ((value: unknown, ...args: unknown[]) => {
      if (String(value).includes("component=")) { logs.push(String(value)); return true; }
      return Reflect.apply(stderr, process.stderr, [value, ...args]);
    }) as typeof process.stderr.write);
    const directory = await mkdtemp(join(tmpdir(), "light-provider-"));
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (value: string) => mode !== "account" && value === "synthetic-owner");
    const sensor = { device_sn: "sensor", device_model: family === "e330" ? "T8600" : "T81A0", device_type: family === "e330" ? 24 : 10005, device_channel: 3, parent_sn: "station",
      category: "eufy_security", member: { admin_user_id: "synthetic-owner" }, params: [],
      ...(mode === "model" ? { device_model: "T84A0" } : {}), ...(mode === "type" ? { device_type: 127 } : {}),
      ...(mode === "channel" ? { device_channel: 255 } : {}), ...(mode === "owner" ? { member: { admin_user_id: "other" } } : {}) };
    const station = { device_sn: "station", device_model: "T8030", device_type: mode === "parent" ? 0 : 18,
      category: "eufy_security", p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic", member: { admin_user_id: "synthetic-owner" }, params: [] };
    const camera = { ...sensor, device_sn: "camera", device_model: "T8171", device_type: 88, device_channel: 1 };
    let reads = 0;
    context.mock.method(MegaClient.prototype, "inventory", async () => {
      reads++;
      if (mode === "baseline_failed" && reads > 1) throw Error("PRIVATE_BASELINE");
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
      maxStreamSeconds: 120, apiAuthenticationConfigured: button, experimentalModelControls: mode !== "disabled" });
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
    const receipt = { notificationFrames: 0, selectedNotifications: 0, resultFrames: 3, selectedFrames: 2, matchingFrames: 1, decodedFrames: 0, protection: "clear" as const };
    let receiptObserved = false;
    context.mock.method(FirstPartyPpcsSession.prototype, "controlReceiptEvidence", () => receiptObserved ? receipt : undefined);
    const write = context.mock.method(FirstPartyPpcsSession.prototype, "writeModelControlTrial", async (_request: ModelControlTrial, _route: ModelControlRoute, current?: () => void, onDispatch?: () => void) => {
      current!();
      if (mode === "write_prepare_failed") throw Error("PRIVATE_PREPARE");
      onDispatch?.();
      receiptObserved = family === "e330" && ["receipt_timeout", "receipt_cleanup_failed"].includes(mode);
      if (["receipt_timeout", "receipt_cleanup_failed"].includes(mode)) throw Error("PRIVATE_RECEIPT");
      if (mode === "busy") await held; current!();
    });
    const close = context.mock.method(FirstPartyPpcsSession.prototype, "close", function(this: FirstPartyPpcsSession) { this.output.end(); });
    try {
      await provider.start(events); await new Promise(resolve => setImmediate(resolve));
      context.mock.timers.enable({ apis: ["setTimeout"] });
      const baseline = cameraEvents;
      if (mode === "button") assert.equal(experimentalOffered, true);
      const request = { action: "manualLight" as const, enabled: mode !== "off" };
      const operation = button ? provider.setCameraLight("sensor", request.enabled)
        : provider.performModelControlTrial("sensor", request, controller.signal);
      const expected = ["valid", "off", "button", "busy", "cleanup"].includes(mode) ? operation : assert.rejects(operation, /Manual light test did not confirm the light state/);
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
      if (mode === "cleanup") {
        await assert.rejects(provider.performModelControlTrial("sensor", request), /Manual light test/);
        await assert.rejects(provider.startStream("camera"), /recording retrieval|Wait/i);
        release();
      }
      if (mode === "hung") context.mock.timers.tick(60_000);
      if (["valid", "off", "button", "busy", "cleanup"].includes(mode)) {
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
          assert.deepEqual(failure.receipt, receiptObserved ? receipt : undefined);
        }
        assert.equal(write.mock.callCount(), ["write_prepare_failed", "receipt_timeout", "cleanup_failed", "receipt_cleanup_failed"].includes(mode) ? 1 : 0);
      }
      const failures = logs.filter(line => line.includes("event=model_control_trial_failed"));
      if (button && ["receipt_timeout", "cleanup_failed"].includes(mode)) {
        assert.equal(failures.length, 1);
        assert.match(failures[0]!, new RegExp(`model=${family === "e330" ? "T8600" : "T81A0"} action=manualLight state=unknown`));
        assert.match(failures[0]!, mode === "receipt_timeout"
          ? /stage=write_receipt write_attempted=true acknowledgement_received=false cleanup_failed=false/
          : /stage=cleanup write_attempted=true acknowledgement_received=true cleanup_failed=true/);
        assert.doesNotMatch(failures[0]!, /PRIVATE_|synthetic|sensor|station/);
        if (receiptObserved) assert.match(failures[0]!, /result_frames=3 selected_result_frames=2 matching_result_frames=1 decoded_result_frames=0 result_protection=clear/);
      } else assert.equal(failures.length, 0);
      assert.equal(network.mock.callCount(), 0);
    } finally { release(); context.mock.timers.reset(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
