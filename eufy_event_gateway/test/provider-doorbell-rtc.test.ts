/**
 * Verifies exact native doorbell admission and exclusive diagnostic leases.
 * Each fixture owns synthetic inventory, timers and mocked transports. No
 * account, camera or household setting is contacted or changed by these tests.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { LiveStreamManager } from "../src/stream/live-stream-manager.js";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import { DoorbellRtcSession } from "../src/stream/doorbell-rtc-session.js";
import { DoorbellRtcError } from "../src/stream/doorbell-rtc-offer.js";
import { NvrTrialError } from "../src/stream/nvr-protocol.js";

const contextValue = { host: "security-smart-eu.eufylife.com", region: "EU" as const,
  authToken: "synthetic-token", gtoken: "synthetic-gtoken", sign: "synthetic-sign" };

/** Own one provider whose only doorbell has the documented missing-PPCS topology. */
async function fixture(context: TestContext, mode = "valid", withManager = false) {
  const directory = await mkdtemp(join(tmpdir(), "doorbell-provider-"));
  const network = context.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.getter(MegaClient.prototype, "isAuthenticated", () => mode !== "unauthenticated");
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{
    device_sn: "synthetic-doorbell", device_model: mode === "wrong-model" ? "T8223" : "T8224",
    device_type: mode === "wrong-type" ? 95 : 96, category: "eufy_security", device_channel: 0,
    parent_sn: mode === "attached" ? "other-station" : "synthetic-doorbell",
    ...(mode === "ppcs-ready" ? { p2p_conn: "synthetic-route", p2p_did: "synthetic-peer" } : {}),
    member: mode === "missing-owner" ? {} : { admin_user_id: "synthetic-owner" },
  }] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
  const state = new GatewayState();
  let manager: LiveStreamManager | undefined;
  const events = new Proxy({
    streamStarted: (serial: string, output: PassThrough, codec: () => "h264") => manager?.attachSource(serial, output, codec),
    streamStopped: (serial: string) => manager?.markStopped(serial),
    camera: (camera: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(camera) },
    { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU",
    persistentDirectory: directory, maxStreamSeconds: 120, experimentalDoorbellRtc: mode !== "disabled" });
  if (withManager) {
    manager = new LiveStreamManager(state, {} as never, provider, 10_000);
    manager.on("warning", () => {});
    provider.setNvrLiveMediaChecks({ viewer: serial => manager!.hasActiveViewer(serial), active: serial => manager!.hasActiveSession(serial),
      recording: serial => manager!.hasActiveRecording(serial), yieldable: serial => manager!.canYieldSource(serial),
      settling: serial => manager!.isSourceSettling(serial), retiring: serial => manager!.isSourceRetiring(serial) });
  }
  await provider.start(events);
  return { provider, state, network, manager, close: async () => {
    await manager?.close(); await provider.close(); assert.equal(network.mock.callCount(), 0); await rm(directory, { recursive: true, force: true });
  } };
}

for (const mode of ["disabled", "unauthenticated", "wrong-model", "wrong-type", "attached", "missing-owner", "ppcs-ready", "aborted"]) {
  test(`native doorbell refuses ${mode} without a cloud call`, async context => {
    const f = await fixture(context, mode);
    const sign = context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => contextValue);
    const controller = new AbortController(); if (mode === "aborted") controller.abort();
    try {
      assert.throws(() => f.provider.reserveDoorbellRtcTrial("synthetic-doorbell", controller.signal),
        error => error instanceof DoorbellRtcError && error.stage === "admission");
      assert.equal(sign.mock.callCount(), 0);
    } finally { await f.close(); }
  });
}

test("normal media uses the opted-in RTC path and cleanup retains the exclusive lease", async context => {
  const f = await fixture(context);
  let finish!: () => void;
  const closing = new Promise<void>(resolve => { finish = resolve; });
  const starts = context.mock.method(DoorbellRtcSession.prototype, "start", async () => undefined);
  const closes = context.mock.method(DoorbellRtcSession.prototype, "close", () => closing);
  const sign = context.mock.method(MegaClient.prototype, "nvrSignallingContext", async (serial: string) => {
    assert.equal(serial, "synthetic-doorbell"); return contextValue;
  });
  try {
    assert.equal(f.state.getCamera("synthetic-doorbell").streamSupported, true);
    await f.provider.startStream("synthetic-doorbell");
    assert.equal(starts.mock.callCount(), 1); assert.equal(sign.mock.callCount(), 1);
    const first = f.provider.stopStream("synthetic-doorbell");
    assert.throws(() => f.provider.reserveDoorbellRtcTrial("synthetic-doorbell", new AbortController().signal));
    finish(); await first; assert.equal(closes.mock.callCount(), 1);
    const next = f.provider.reserveDoorbellRtcTrial("synthetic-doorbell", new AbortController().signal); await next();
    assert.equal(f.state.getCamera("synthetic-doorbell").streamSupported, true);
  } finally { finish(); await f.close(); }
});

test("disabled doorbell option keeps normal live media unavailable", async context => {
  const f = await fixture(context, "disabled");
  const sign = context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => contextValue);
  try {
    assert.equal(f.state.getCamera("synthetic-doorbell").streamSupported, false);
    await assert.rejects(f.provider.startStream("synthetic-doorbell"), /unavailable/);
    assert.equal(sign.mock.callCount(), 0);
  } finally { await f.close(); }
});

test("stopping a pending sign prevents late media and releases only the original trial", async context => {
  const f = await fixture(context);
  let finish!: (value: typeof contextValue) => void, entered!: () => void;
  const pending = new Promise<typeof contextValue>(resolve => { finish = resolve; });
  const entering = new Promise<void>(resolve => { entered = resolve; });
  context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => { entered(); return pending; });
  const starts = context.mock.method(DoorbellRtcSession.prototype, "start", async () => undefined);
  try {
    const release = f.provider.reserveDoorbellRtcTrial("synthetic-doorbell", new AbortController().signal);
    const failed = assert.rejects(f.provider.startStream("synthetic-doorbell"), error => error instanceof DoorbellRtcError && error.stage === "cancelled");
    await entering; await f.provider.stopStream("synthetic-doorbell");
    const next = f.provider.reserveDoorbellRtcTrial("synthetic-doorbell", new AbortController().signal);
    finish(contextValue); await failed; await release();
    assert.throws(() => f.provider.reserveDoorbellRtcTrial("synthetic-doorbell", new AbortController().signal));
    assert.equal(starts.mock.callCount(), 0); await next();
  } finally { finish(contextValue); await f.close(); }
});

for (const mode of ["unauthorized", "forbidden", "cancelled", "network"] as const) {
  test(`doorbell signing ${mode} retains safe diagnostics and releases its lease`, async context => {
    const f = await fixture(context);
    const status = mode === "unauthorized" ? 401 : mode === "forbidden" ? 403 : undefined;
    const received = status ? new NvrTrialError("region_or_authorization_rejected", "unspecified", status)
      : mode === "cancelled" ? new NvrTrialError("cancelled") : new Error("private-vendor-body synthetic-token");
    context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => { throw received; });
    const starts = context.mock.method(DoorbellRtcSession.prototype, "start", async () => undefined);
    try {
      await assert.rejects(f.provider.startStream("synthetic-doorbell"), error => {
        assert.ok(error instanceof DoorbellRtcError);
        assert.equal(error.stage, mode === "cancelled" ? "cancelled" : "sign");
        assert.equal(error.reason, status ? "region_or_authorization_rejected" : "unspecified");
        assert.equal(error.httpStatus, status);
        assert.ok(!JSON.stringify(error).includes("synthetic-token"));
        assert.ok(!error.message.includes("private-vendor-body"));
        return true;
      });
      assert.equal(starts.mock.callCount(), 0);
      const next = f.provider.reserveDoorbellRtcTrial("synthetic-doorbell", new AbortController().signal);
      await next();
    } finally { await f.close(); }
  });
}


test("one doorbell startup failure is logged once across output and rejected start", async context => {
  const f = await fixture(context), logs: string[] = [];
  context.mock.method(process.stderr, "write", ((value: string | Uint8Array) => { logs.push(String(value)); return true; }) as typeof process.stderr.write);
  context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => contextValue);
  context.mock.method(DoorbellRtcSession.prototype, "start", async function(this: DoorbellRtcSession) {
    context.mock.getter(this, "callProgress", () => "pending");
    const failure = new DoorbellRtcError("deadline", "startup_call_timeout");
    this.output.destroy(failure);
    await new Promise(resolve => setImmediate(resolve));
    throw failure;
  });
  context.mock.method(DoorbellRtcSession.prototype, "close", async () => undefined);
  try {
    await assert.rejects(f.provider.startStream("synthetic-doorbell"), DoorbellRtcError);
    await new Promise(resolve => setImmediate(resolve));
    const failures = logs.filter(line => line.includes("event=doorbell_rtc_stream_failed"));
    assert.equal(failures.length, 1);
    assert.match(failures[0]!, /stage=deadline reason=startup_call_timeout call_progress=pending/);
    assert.doesNotMatch(failures[0]!, /synthetic|token|secret/);
  } finally { await f.close(); }
});

test("closing the actual pending doorbell viewer cancels startup and keeps cleanup exclusive", { timeout: 5000 }, async context => {
  const f = await fixture(context, "valid", true);
  let entered!: () => void, finishClose!: () => void;
  const starting = new Promise<void>(resolve => { entered = resolve; });
  const closing = new Promise<void>(resolve => { finishClose = resolve; });
  let signal!: AbortSignal;
  const sign = context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => contextValue);
  context.mock.method(DoorbellRtcSession.prototype, "start", async function(this: DoorbellRtcSession) {
    signal = (Reflect.get(this, "options") as { signal: AbortSignal }).signal;
    entered();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DoorbellRtcError("cancelled")), { once: true }));
  });
  const close = context.mock.method(DoorbellRtcSession.prototype, "close", () => closing);
  const response = new PassThrough() as PassThrough & { writeHead: () => void };
  response.writeHead = () => {}; response.resume();
  const opening = f.manager!.addClient("synthetic-doorbell", response as never, "native");
  try {
    await starting;
    response.destroy();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(signal.aborted, true, "viewer closure must not wait for the 35-second startup deadline");
    assert.equal(close.mock.callCount(), 1);
    assert.throws(() => f.provider.reserveDoorbellRtcTrial("synthetic-doorbell", new AbortController().signal));
    finishClose(); await opening;
    const release = f.provider.reserveDoorbellRtcTrial("synthetic-doorbell", new AbortController().signal); await release();
    assert.equal(sign.mock.callCount(), 1);
  } finally { finishClose(); await f.close(); await opening; }
});

test("doorbell media readiness retires the startup watcher and keeps normal idle grace", async context => {
  const f = await fixture(context, "valid", true);
  let signal!: AbortSignal;
  context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => contextValue);
  context.mock.method(DoorbellRtcSession.prototype, "start", async function(this: DoorbellRtcSession) {
    const options = Reflect.get(this, "options") as { signal: AbortSignal; ready: (output: PassThrough) => void };
    signal = options.signal; options.ready(this.output);
  });
  const close = context.mock.method(DoorbellRtcSession.prototype, "close", async () => undefined);
  const response = new PassThrough() as PassThrough & { writeHead: () => void };
  response.writeHead = () => {}; response.resume();
  try {
    await f.manager!.addClient("synthetic-doorbell", response as never, "native");
    response.destroy();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(signal.aborted, false);
    assert.equal(close.mock.callCount(), 0);
  } finally { await f.close(); }
});

test("explicit doorbell diagnostics keep their consented lease without a normal viewer", async context => {
  const f = await fixture(context);
  f.provider.setNvrLiveMediaChecks({ viewer: () => false, active: () => false, recording: () => false,
    yieldable: () => false, settling: () => false, retiring: () => true });
  context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => contextValue);
  context.mock.method(DoorbellRtcSession.prototype, "start", async function(this: DoorbellRtcSession) {
    const options = Reflect.get(this, "options") as { signal: AbortSignal; current: () => boolean };
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(options.signal.aborted, false);
    assert.equal(options.current(), true);
  });
  context.mock.method(DoorbellRtcSession.prototype, "close", async () => undefined);
  try {
    const release = f.provider.reserveDoorbellRtcTrial("synthetic-doorbell", new AbortController().signal);
    await f.provider.startStream("synthetic-doorbell");
    await release();
  } finally { await f.close(); }
});
