/**
 * Exercises S100 trial ownership through the real provider with synthetic cloud
 * inventory and prepared transport. No external network or camera is available.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { GatewayState } from "../src/domain/gateway-state.js";

for (const mode of ["early-stop", "shutdown", "hung-shutdown", "preparing", "inventory-change", "preflight-failure"]) {
  test(`S100 provider ${mode} preserves exclusive ownership until original-session cleanup`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "eufy-s100-provider-"));
    context.mock.method(globalThis, "fetch", async () => { assert.fail("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    let connection = "synthetic-route";
    const refreshes: (() => void)[] = [];
    context.mock.method(globalThis, "setInterval", (callback: () => void) => { refreshes.push(callback); return { unref() {} } as unknown as ReturnType<typeof setInterval>; });
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ device_sn: "test camera", device_model: "T84A1", device_type: 151,
      category: "eufy_security", device_channel: 0, p2p_did: "test peer", p2p_conn: connection, member: { admin_user_id: "synthetic-owner" },
      params: [{ param_type: 6040, param_value: "1" }] }] }));
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ "test camera": { key: "synthetic-key", expiresAt: null } }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => undefined);
    const closes = context.mock.method(FirstPartyPpcsSession.prototype, "close");
    const reads = context.mock.method(FirstPartyPpcsSession.prototype, "readCameraInfo", async () => { assert.fail("Siren must not read settings"); });
    let stopEntered!: () => void;
    const cleanupEntered = new Promise<void>(resolve => { stopEntered = resolve; });
    let entered!: () => void, releaseStop!: () => void, starts = 0, stops = 0;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
    let prepared!: () => void, releasePreparation!: () => void;
    const preparationEntered = new Promise<void>(resolve => { prepared = resolve; });
    const preparationGate = new Promise<void>(resolve => { releasePreparation = resolve; });
    let stopping: Promise<void> | undefined;
    context.mock.method(FirstPartyPpcsSession.prototype, "prepareS100SirenTrial", async () => {
      if (mode === "preparing") { prepared(); await preparationGate; }
      if (mode === "preflight-failure") throw Error("private-key-failure-detail");
      return { start: async () => { starts++; entered(); }, stop: () => {
        stopping ??= (async () => { stops++; stopEntered(); await stopGate; })(); return stopping;
      } };
    });
    const warnings: string[] = [];
    context.mock.method(process.stderr, "write", (value: unknown) => { warnings.push(String(value)); return true; });
    const state = new GatewayState();
    const events = new Proxy({ camera: (value: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(value) },
      { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) }) as unknown as ProviderEvents;
    const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalModelControls: true });
    try {
      await provider.start(events);
      assert.deepEqual(provider.modelControlTrials("test camera"), ["motion", "siren", "sirenConnection"]);
      const before = state.getCamera("test camera");
      assert.equal(before.cameraSirenControlSupported, false);
      const running = provider.performModelControlTrial("test camera", { action: "siren", enabled: true });
      if (mode === "preflight-failure") {
        await assert.rejects(running, /session/);
        assert.equal(starts, 0); assert.equal(stops, 0); assert.equal(closes.mock.callCount(), 1);
      } else {
        const completion = running.then(value => ({ value }), error => ({ error }));
        if (mode === "preparing") {
          await preparationEntered;
          await assert.rejects(provider.performModelControlTrial("test camera", { action: "siren", enabled: false }), /wait/i);
          assert.equal(starts, 0); assert.equal(stops, 0);
          releasePreparation();
        }
        await started;
        await assert.rejects(provider.performModelControlTrial("other", { action: "siren", enabled: false }), /unavailable/);
        if (mode === "hung-shutdown") context.mock.timers.enable({ apis: ["setTimeout"] });
        await assert.rejects(provider.startStream("test camera"), /Wait/);
        await assert.rejects(provider.performModelControlTrial("test camera", { action: "siren", enabled: true }), /wait/i);
        if (mode === "inventory-change") { connection = "synthetic-replacement"; refreshes.at(-1)!(); await cleanupEntered; }
        const stoppingProvider = mode === "inventory-change" ? Promise.resolve() : (mode === "shutdown" || mode === "hung-shutdown") ? provider.close() : provider.performModelControlTrial("test camera", { action: "siren", enabled: false });
        const secondStop = mode === "early-stop" ? provider.performModelControlTrial("test camera", { action: "siren", enabled: false }) : Promise.resolve();
        await Promise.resolve(); await Promise.resolve();
        assert.equal(starts, 1); assert.equal(stops, 1); assert.equal(closes.mock.callCount(), 0);
        if (mode === "hung-shutdown") { context.mock.timers.tick(7000); await stoppingProvider; assert.equal(closes.mock.callCount(), 1); }
        releaseStop(); await stoppingProvider; await secondStop;
        const result = await completion;
        if (mode === "early-stop" || mode === "preparing") { assert.ok("value" in result); assert.equal(result.value.stoppedEarly, true); }
        else assert.ok("error" in result);
        assert.equal(closes.mock.callCount(), mode === "hung-shutdown" ? 2 : 1);
      }
      assert.deepEqual(state.getCamera("test camera"), before);
      assert.equal(reads.mock.callCount(), 0);
      assert.equal(warnings.some(line => /private-key-failure|test camera|synthetic-owner/.test(line)), false);
    } finally { releasePreparation(); releaseStop(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

for (const mode of ["prepared", "failure", "shutdown", "drift"]) {
  test(`S100 connection-only ${mode} never starts or stops a siren`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "eufy-s100-connection-"));
    context.mock.method(globalThis, "fetch", async () => { assert.fail("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    let connection = "synthetic-route";
    const refreshes: (() => void)[] = [];
    context.mock.method(globalThis, "setInterval", (callback: () => void) => { refreshes.push(callback); return { unref() {} } as unknown as ReturnType<typeof setInterval>; });
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ device_sn: "test camera", device_model: "T84A1", device_type: 151,
      category: "eufy_security", device_channel: 0, p2p_did: "test peer", p2p_conn: connection, member: { admin_user_id: "synthetic-owner" } }] }));
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ "test camera": { key: "synthetic-key", expiresAt: null } }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => undefined);
    const closes = context.mock.method(FirstPartyPpcsSession.prototype, "close");
    context.mock.method(FirstPartyPpcsSession.prototype, "readCameraInfo", async () => { assert.fail("Read forbidden"); });
    let entered!: () => void, resume!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    let calls = 0;
    context.mock.method(FirstPartyPpcsSession.prototype, "prepareS100SirenTrial", async (_profile: Parameters<FirstPartyPpcsSession["prepareS100SirenTrial"]>[0], enabled: boolean) => {
      assert.equal(enabled, false); calls++; entered(); await gate;
      if (mode === "failure") throw Error("private-negotiation-error");
      return { start: async () => { assert.fail("Start forbidden"); }, stop: async () => { assert.fail("Stop forbidden"); } };
    });
    const logs: string[] = [];
    context.mock.method(process.stderr, "write", (value: unknown) => { logs.push(String(value)); return true; });
    const events = new Proxy({}, { get: () => () => undefined }) as ProviderEvents;
    const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalModelControls: true });
    try {
      await provider.start(events);
      const controller = new AbortController();
      const running = provider.performModelControlTrial("test camera", { action: "sirenConnection", enabled: false }, controller.signal);
      const result = running.then(value => ({ value }), error => ({ error }));
      await preparing;
      for (const action of ["siren", "sirenConnection"] as const) await assert.rejects(provider.performModelControlTrial("test camera", { action, enabled: false }), /wait/i);
      await assert.rejects(provider.startStream("test camera"), /Wait/);
      controller.abort();
      if (mode === "shutdown") await provider.close();
      if (mode === "drift") { connection = "synthetic-new-route"; refreshes.at(-1)!(); await new Promise(resolve => setImmediate(resolve)); }
      resume();
      const settled = await result;
      if (mode === "prepared") {
        assert.ok("value" in settled);
        assert.deepEqual(settled.value, { outcome: "prepared", physicalConfirmationRequired: true });
        assert.equal(closes.mock.callCount(), 1);
        assert.equal((await provider.performModelControlTrial("test camera", { action: "sirenConnection", enabled: false })).outcome, "prepared");
        assert.equal(calls, 2);
      } else {
        assert.ok("error" in settled);
        assert.match(settled.error.message, /session_prepare/);
        assert.match(settled.error.message, /No siren command was sent/);
        assert.ok(logs.some(line => line.includes("stages=session_prepare")));
      }
      assert.equal(logs.some(line => /private-negotiation|synthetic-owner|test camera/.test(line)), false);
    } finally { resume(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
