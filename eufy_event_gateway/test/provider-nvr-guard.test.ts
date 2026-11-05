/**
 * Verifies exact T8N00 guard-trial admission, fresh inventory confirmation, and
 * station lease ownership with synthetic cloud rows. No socket or alarm mode is
 * accessed by these tests.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { NvrRtcSession } from "../src/stream/nvr-rtc-session.js";
import { NvrPowerError } from "../src/provider/nvr-power-trial.js";
import { NvrTrialError } from "../src/stream/nvr-protocol.js";
import { NvrGuardError } from "../src/provider/nvr-guard-trial.js";

for (const mode of ["valid", "controls-disabled", "wrong-model", "wrong-baseline", "schedule-changed", "duplicate-params", "restore-unknown", "shutdown", "canary", "bad-timezone", "transient-auth"]) {
  test(`NVR guard provider: ${mode}`, async context => {
    let clock = 0, authFailures = 0;
    const logs: string[] = [], snapshots: number[] = [];
    context.mock.method(process.stderr, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
    context.mock.method(Date, "now", () => Date.UTC(2026, 9, 18, 12) + clock);
    context.mock.method(performance, "now", () => clock);
    const directory = await mkdtemp(join(tmpdir(), "nvr-guard-provider-"));
    context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (id: string) => mode === "transient-auth" && writes === 1 && authFailures++ === 0 ? false : id === "synthetic-owner");
    const child = { device_sn: "synthetic-camera", device_model: "T8E00", device_type: 301, device_channel: 3,
      parent_sn: "synthetic-station", category: "eufy_security", member: { admin_user_id: "synthetic-owner" } };
    let guard = mode === "wrong-baseline" ? 1 : 2, writes = 0;
    const parent = () => ({ device_sn: "synthetic-station", device_model: mode === "wrong-model" ? "T9000" : "T8N00",
      device_type: 300, category: "eufy_security", member: { admin_user_id: "synthetic-owner", nick_name: "Synthetic" },
      params: [{ param_type: 1224, param_value: mode === "restore-unknown" && writes > 1 ? null : guard },
        { param_type: 1254, param_value: mode === "schedule-changed" && writes > 0 ? "changed" : Buffer.from(JSON.stringify({ canary: "PRIVATE-SCHEDULE", schedules: Array.from({ length: 7 }, (_, week) => ({ week, start_h: 0, start_m: 0, end_h: 23, end_m: 59, mode_id: 0 })) })).toString("base64") }] });
    context.mock.method(MegaClient.prototype, "inventory", async () => { snapshots.push(writes); if (mode === "canary" && snapshots.length > 1) throw Error("PRIVATE-CANARY"); const row = parent(); if (mode === "duplicate-params") row.params.push({ param_type: 1224, param_value: 1 }); return { devices: [row, child] }; });
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
    context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => ({ host: "security-smart-ie.eufylife.com",
      region: "IE", authToken: "synthetic", gtoken: "synthetic", sign: "synthetic" }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    const prepare = context.mock.method(NvrRtcSession.prototype, "prepareGuardTrial", async () => undefined);
    const validate = context.mock.method(NvrRtcSession.prototype, "validateGuardTrial", async () => undefined);
    const effective = context.mock.method(NvrRtcSession.prototype, "confirmGuardEffectiveTrial", async () => undefined);
    context.mock.method(NvrRtcSession.prototype, "writeGuardTrial", async (value: 1 | 2, signal: AbortSignal,
      mark: () => void) => { signal.throwIfAborted(); mark(); writes++; guard = value; if (mode === "shutdown" && value === 1) void provider.close(); });
    context.mock.method(NvrRtcSession.prototype, "preparePowerTrial", async () => { throw new NvrPowerError("baseline"); });
    const close = context.mock.method(NvrRtcSession.prototype, "close", async () => undefined);
    const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU",
      persistentDirectory: directory, maxStreamSeconds: 120, experimentalNvrControls: mode !== "controls-disabled",
      experimentalModelControls: true, experimentalNvrLive: true, normalNvrLive: true });
    const registry = new GatewayState();
    const events = new Proxy({ camera: (camera: Parameters<ProviderEvents["camera"]>[0]) => registry.registerCamera(camera) },
      { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) }) as unknown as ProviderEvents;
    try {
      await provider.start(events); context.mock.timers.enable({ apis: ["setTimeout"] });
      const operation = provider.testNvrGuardMode("synthetic-camera", { target: "home", timeZone: mode === "bad-timezone" ? "PRIVATE-TIMEZONE" : "UTC" }, new AbortController().signal);
      if (mode === "valid") {
        await assert.rejects(provider.testNvrGuardMode("synthetic-camera", { target: "home", timeZone: "UTC" }, new AbortController().signal),
          error => error instanceof NvrGuardError && error.stage === "busy");
        await assert.rejects(provider.startStream("synthetic-camera"), error => error instanceof NvrTrialError && error.stage === "admission");
      }
      let settled = false;
      void operation.then(() => { settled = true; }, () => { settled = true; });
      for (let index = 0; index < 100 && !settled; index++) {
        await new Promise(resolve => setImmediate(resolve));
        clock += 2_000; context.mock.timers.tick(2_000);
      }
      if (mode === "valid" || mode === "transient-auth") {
        const result = await operation; assert.equal(result.restored, true); assert.equal(result.scheduleUnchanged, true);
        assert.equal(guard, 2); assert.equal(writes, 2); assert.equal(prepare.mock.callCount(), 1);
        assert.ok(validate.mock.callCount() >= 2); assert.equal(effective.mock.callCount(), 4); assert.ok(close.mock.callCount() >= 1);
        assert.deepEqual(effective.mock.calls.map(call => call.arguments[0]), [0, 1, 0, 0]);
        assert.ok(snapshots.includes(1)); assert.ok(snapshots.filter(value => value === 2).length >= 2);
        clock += 61_000;
        await assert.rejects(provider.testNvrCameraPower("synthetic-camera", { originalPower: "on", target: "off" }, new AbortController().signal),
          error => error instanceof NvrPowerError && error.stage === "baseline");
      } else {
        await assert.rejects(operation, NvrGuardError);
        if (["controls-disabled", "wrong-model", "wrong-baseline", "duplicate-params", "canary", "bad-timezone"].includes(mode)) assert.equal(writes, 0);
        if (mode === "shutdown") {
          assert.equal(writes, 1);
          assert.equal(logs.filter(line => line.includes("event=nvr_guard_trial_failed")).length, 1);
          assert.ok(logs.some(line => line.includes("stage=shutdown manual_restore_required=true")));
        }
        if (mode === "restore-unknown" || mode === "schedule-changed") {
          clock += 61_000;
          await assert.rejects(provider.testNvrGuardMode("synthetic-camera", { target: "home", timeZone: "UTC" }, new AbortController().signal),
            error => error instanceof NvrGuardError && error.stage === "busy");
          await assert.rejects(provider.startStream("synthetic-camera"), error => error instanceof NvrTrialError && error.stage === "admission");
          await assert.rejects(provider.testNvrCameraPower("synthetic-camera", { originalPower: "on", target: "off" }, new AbortController().signal));
        }
      }
      assert.ok(logs.every(line => !/PRIVATE-(?:CANARY|SCHEDULE|TIMEZONE)/.test(line)));
    } finally {
      await provider.close(); context.mock.timers.tick(185_000);
      for (let index = 0; index < 10; index++) await new Promise(resolve => setImmediate(resolve));
      context.mock.timers.reset(); await rm(directory, { recursive: true, force: true });
    }
  });
}
