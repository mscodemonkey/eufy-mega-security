/**
 * Tests camera startup independently of Firebase availability.
 * Each test owns offline prototype mocks and retires the provider and its timers.
 */
import assert from "node:assert/strict";
import test, { afterEach, beforeEach, type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GatewayState } from "../src/domain/gateway-state.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { PushClient } from "../src/mega/android-push/push-client.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { LiveStreamManager } from "../src/stream/live-stream-manager.js";

// Keep filesystem polling independent of the synthetic retry clock.
const pollTimeout = globalThis.setTimeout;

const unhandled: unknown[] = [];
const networkMocks: { mock: { callCount(): number } }[] = [];
const onUnhandled = (error: unknown): void => { unhandled.push(error); };
beforeEach(() => { networkMocks.length = 0; unhandled.length = 0; process.on("unhandledRejection", onUnhandled); });
afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, []);
  for (const network of networkMocks) assert.equal(network.mock.callCount(), 0);
});

/** Own one synthetic provider with no camera peer capable of opening a socket. */
function fixture(context: TestContext, directory = "/nonexistent/fixture") {
  const network = context.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
  networkMocks.push(network);
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{
    device_sn: "camera", device_model: "T8214", device_type: 94, category: "eufy_security",
  }] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
  const state = new GatewayState();
  const connections: { state: string; detail: string }[] = [];
  const events = new Proxy({
    camera: (camera: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(camera),
    connection: (status: string, detail: string) => connections.push({ state: status, detail }),
    eventReceiverState: (status: Parameters<ProviderEvents["eventReceiverState"]>[0]) => state.recordEventReceiverState(status),
  }, { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU",
    persistentDirectory: directory, maxStreamSeconds: 120 });
  return { provider, events, state, connections, network };
}

/** Count owned retry handles without counting the Firebase login deadline. */
function retryTimers(context: TestContext) {
  const schedule = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const active = new Set<ReturnType<typeof setTimeout>>();
  const delays = new Set([15_000, 30_000, 60_000, 120_000, 300_000]);
  context.mock.method(globalThis, "setTimeout", (callback: () => void, delay?: number) => {
    const handle = schedule(() => { active.delete(handle); callback(); }, delay);
    if (delay !== undefined && delays.has(delay)) active.add(handle);
    return handle;
  });
  context.mock.method(globalThis, "clearTimeout", (handle: ReturnType<typeof setTimeout> | undefined) => {
    if (handle !== undefined) active.delete(handle);
    clear(handle);
  });
  return active;
}

for (const code of [-1]) {
  test(`camera startup survives unexpected push start rejection ${code}`, async (context) => {
    const f = fixture(context);
    context.mock.method(MegaPushReceiver.prototype, "start", async () => {
      throw new Error(`Security push activation failed (${code})`);
    });
    const intervals = context.mock.method(globalThis, "setInterval");
    try {
      await assert.doesNotReject(f.provider.start(f.events));
      await Promise.resolve();
      assert.equal(f.connections.at(-1)?.state, "connected");
      assert.equal(f.connections.at(-1)?.detail, "Cameras and snapshots are ready. Push event delivery is reported separately.");
      await assert.rejects(f.provider.startStream("camera"), /transport is unavailable/);
      const streams = new LiveStreamManager(f.state, {} as never, f.provider, 10);
      try { await assert.rejects(streams.captureSnapshot("camera", 10), /transport is unavailable/); }
      finally { await streams.close(); }
      assert.equal(f.network.mock.callCount(), 0);
      assert.equal(intervals.mock.callCount(), 2);
    } finally { await f.provider.close(); }
  });
}

test("pending push startup does not delay camera readiness", async (context) => {
  const f = fixture(context);
  const intervals = context.mock.method(globalThis, "setInterval");
  const clear = context.mock.method(globalThis, "clearInterval");
  context.mock.method(MegaPushReceiver.prototype, "start", () => new Promise<void>(() => undefined));
  try {
    const ready = await Promise.race([f.provider.start(f.events).then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50))]);
    assert.equal(ready, true);
    assert.equal(f.connections.at(-1)?.state, "connected");
    await assert.rejects(f.provider.startStream("camera"), /transport is unavailable/);
    assert.equal(f.network.mock.callCount(), 0);
    assert.equal(intervals.mock.callCount(), 2);
    await f.provider.close();
    for (const call of intervals.mock.calls) assert.ok(clear.mock.calls.some(({ arguments: args }) => args[0] === call.result));
  } finally { await f.provider.close(); }
});

for (const step of ["inventory", "dskKeys"] as const) {
  test(`close during ${step} retires startup before a receiver is created`, async (context) => {
    const f = fixture(context);
    let entered!: () => void;
    let finish!: (value: unknown) => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise((resolve) => { finish = resolve; });
    if (step === "dskKeys") context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{
      device_sn: "camera", device_model: "T8214", device_type: 94, category: "eufy_security", p2p_did: "synthetic",
    }] }));
    context.mock.method(MegaClient.prototype, step, () => { entered(); return pending; });
    const startPush = context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    try {
      const starting = f.provider.start(f.events);
      await entering;
      await f.provider.close();
      finish(step === "inventory" ? { devices: [] } : {});
      await assert.doesNotReject(starting);
      assert.equal(startPush.mock.callCount(), 0);
      assert.equal(f.connections.length, 0);
      assert.equal(f.network.mock.callCount(), 0);
    } finally { await f.provider.close(); }
  });
}

test("replacement startup ignores superseded inventory", async (context) => {
  const f = fixture(context);
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => { finish = resolve; });
  let reads = 0;
  context.mock.method(MegaClient.prototype, "inventory", () => ++reads === 1 ? pending : Promise.resolve({ devices: [] }));
  const startPush = context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
  try {
    const first = f.provider.start(f.events);
    await Promise.resolve();
    await f.provider.start(f.events);
    finish({ devices: [] });
    await first;
    assert.equal(startPush.mock.callCount(), 1);
    assert.equal(f.connections.length, 1);
  } finally { await f.provider.close(); }
});

test("close during verification cannot restart a retired provider", async (context) => {
  const f = fixture(context);
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "verification-required" }));
  const startPush = context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => { finish = resolve; });
  try {
    await f.provider.start(f.events);
    context.mock.method(MegaClient.prototype, "connect", () => pending);
    const verifying = f.provider.submitVerification("synthetic");
    await f.provider.close();
    finish({ state: "authenticated" });
    await assert.doesNotReject(verifying);
    assert.equal(startPush.mock.callCount(), 0);
    assert.equal(f.connections.some(({ state }) => state === "connected"), false);
  } finally { await f.provider.close(); }
});

for (const replacement of ["restart", "verification"] as const) {
test(`provider ${replacement} retires the old receiver and retry before replacement`, async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const timers = retryTimers(context);
  const directory = await mkdtemp(join(tmpdir(), "eufy-provider-push-"));
  await writeFile(join(directory, "mega-push.json"), JSON.stringify({ version: 2, persistentIds: [], credentials: {
    fid: "synthetic", androidId: "123", securityToken: "456", fcmToken: "synthetic", createdAt: 1,
  } }));
  const f = fixture(context, directory);
  const live = new Set<PushClient>();
  const closed = new Map<PushClient, number>();
  context.mock.method(PushClient.prototype, "connect", function (this: PushClient) { live.add(this); this.emit("connect"); });
  context.mock.method(PushClient.prototype, "close", function (this: PushClient) {
    live.delete(this); closed.set(this, (closed.get(this) ?? 0) + 1); this.emit("disconnect");
  });
  f.events.eventReceiverState = (state) => {
    if (state === "degraded") throw new Error("PRIVATE_PROVIDER_CALLBACK_MARKER");
    f.state.recordEventReceiverState(state);
  };
  let calls = 0;
  let entered!: () => void;
  let reject!: (error: Error) => void;
  const entering = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<{ activated: boolean; code: number | null }>((_resolve, failed) => { reject = failed; });
  context.mock.method(MegaClient.prototype, "registerPushToken", async () => {
    if (++calls === 3) { entered(); return pending; }
    return { activated: false, code: -1 };
  });
  const logs: string[] = [];
  context.mock.method(process.stderr, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
  try {
    await f.provider.start(f.events);
    for (let i = 0; i < 500 && calls < 1; ++i) await new Promise<void>((resolve) => pollTimeout(resolve, 10));
    assert.equal(calls, 1);
    assert.equal(live.size, 1);
    assert.equal(timers.size, 1);
    if (replacement === "verification") {
      context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "verification-required" }));
      await f.provider.start(f.events);
      assert.equal(live.size, 1);
      assert.equal(timers.size, 1);
      context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
      await f.provider.submitVerification("synthetic");
    } else await f.provider.start(f.events);
    for (let i = 0; i < 500 && calls < 2; ++i) await new Promise<void>((resolve) => pollTimeout(resolve, 10));
    assert.equal(calls, 2);
    assert.equal(live.size, 1);
    assert.equal(timers.size, 1);
    assert.deepEqual([...closed.values()], [1]);
    context.mock.timers.tick(15_000);
    await entering;
    assert.equal(calls, 3);
    const failures = logs.filter((line) => line.includes("event=push_registration_degraded")).length;
    await assert.doesNotReject(f.provider.close());
    reject(new Error("Private late registration failure"));
    context.mock.timers.tick(1_000_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 3);
    assert.equal(logs.filter((line) => line.includes("event=push_registration_degraded")).length, failures);
    assert.equal(f.state.eventDeliveryDiagnostic().receiverState, "stopped");
    assert.equal(f.network.mock.callCount(), 0);
    assert.equal(live.size, 0);
    assert.equal(timers.size, 0);
    assert.deepEqual([...closed.values()], [1, 1]);
    assert.equal(logs.some((line) => line.includes("PRIVATE_PROVIDER_CALLBACK_MARKER")), false);
  } finally { await f.provider.close(); await rm(directory, { recursive: true, force: true }); }
});
}

for (const step of ["connect", "inventory"] as const) {
  test(`${step} failures still reject camera startup`, async (context) => {
    const f = fixture(context);
    context.mock.method(MegaClient.prototype, step, async () => { throw new Error("Synthetic fatal failure"); });
    try {
      await assert.rejects(f.provider.start(f.events), /Synthetic fatal failure/);
      assert.equal(f.connections.some(({ state }) => state === "connected"), false);
    } finally { await f.provider.close(); }
  });
}

for (const code of [-1, 10003]) {
  test(`camera readiness survives returned unconfirmed activation ${code}`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "eufy-provider-activation-"));
    await writeFile(join(directory, "mega-push.json"), JSON.stringify({ version: 2, persistentIds: [], credentials: {
      fid: "synthetic", androidId: "123", securityToken: "456", fcmToken: "synthetic", createdAt: 1,
    } }));
    const f = fixture(context, directory);
    const live = new Set<PushClient>();
    let closed = 0;
    context.mock.method(PushClient.prototype, "connect", function (this: PushClient) { live.add(this); this.emit("connect"); });
    context.mock.method(PushClient.prototype, "close", function (this: PushClient) { live.delete(this); ++closed; this.emit("disconnect"); });
    const register = context.mock.method(MegaClient.prototype, "registerPushToken", async () => ({ activated: false, code }));
    const logs: string[] = [];
    context.mock.method(process.stderr, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
    const timers = retryTimers(context);
    try {
      await f.provider.start(f.events);
      for (let i = 0; i < 500 && !logs.some((line) => line.includes("push_registration_degraded")); ++i) await new Promise<void>((resolve) => pollTimeout(resolve, 10));
      assert.equal(f.connections.at(-1)?.state, "connected");
      assert.equal(f.connections.at(-1)?.detail, "Cameras and snapshots are ready. Push event delivery is reported separately.");
      assert.equal(register.mock.callCount(), 1);
      assert.equal(live.size, 1);
      assert.equal(timers.size, 1);
      const diagnostic = f.state.eventDeliveryDiagnostic();
      assert.equal(diagnostic.receiverState, "degraded");
      assert.equal(diagnostic.connectionCount, 0);
      assert.equal(diagnostic.disconnectionCount, 0);
      assert.equal(f.network.mock.callCount(), 0);
    } finally { await f.provider.close(); await rm(directory, { recursive: true, force: true }); }
    assert.equal(live.size, 0);
    assert.equal(timers.size, 0);
    assert.equal(closed, 1);
  });
}

test("camera readiness keeps a restored Mega registration stably degraded", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const directory = await mkdtemp(join(tmpdir(), "eufy-provider-mega-restored-"));
  await writeFile(join(directory, "mega-push.json"), JSON.stringify({ version: 2, persistentIds: [], credentials: {
    fid: "synthetic", androidId: "123", securityToken: "456", fcmToken: "synthetic", createdAt: 1,
  } }));
  const f = fixture(context, directory);
  const live = new Set<PushClient>();
  context.mock.method(PushClient.prototype, "connect", function (this: PushClient) { live.add(this); this.emit("connect"); });
  context.mock.method(PushClient.prototype, "close", function (this: PushClient) { live.delete(this); this.emit("disconnect"); });
  const register = context.mock.method(MegaClient.prototype, "registerPushToken", async () => ({
    activated: false, code: 10003, failedSecurityStage: "activation" as const, megaRegistrationRestored: true,
  }));
  const timers = retryTimers(context);
  try {
    await f.provider.start(f.events);
    for (let i = 0; i < 500 && register.mock.callCount() === 0; ++i) {
      await new Promise<void>((resolve) => pollTimeout(resolve, 10));
    }
    assert.equal(f.connections.at(-1)?.state, "connected");
    assert.equal(register.mock.callCount(), 1);
    assert.equal(f.state.eventDeliveryDiagnostic().receiverState, "degraded");
    assert.equal(live.size, 1);
    assert.equal(timers.size, 0);
    context.mock.timers.tick(1_000_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(register.mock.callCount(), 1);
  } finally { await f.provider.close(); await rm(directory, { recursive: true, force: true }); }
  assert.equal(live.size, 0);
  assert.equal(timers.size, 0);
});

for (const outcome of ["success", "second401", "login401", "transport", "captcha-required", "verification-required", "cancel-before-login", "close-after-login"] as const) {
  test(`inventory HTTP401 recovery ${outcome}`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "eufy-provider-session-"));
    const sentinel = "untouched saved session";
    const path = join(directory, "mega-session.json");
    await writeFile(path, sentinel);
    const f = fixture(context, directory);
    let connects = 0;
    const connect = context.mock.method(MegaClient.prototype, "connect", async () => {
      if (++connects === 1) return { state: "authenticated" };
      if (outcome === "login401") throw new Error("Mega request failed (HTTP 401)");
      if (outcome === "transport") throw new Error("Mega request failed (transport)");
      if (outcome === "close-after-login") queueMicrotask(() => { void f.provider.close(); });
      if (outcome === "captcha-required" || outcome === "verification-required") return { state: outcome, captcha: { captchaId: "synthetic", image: "" } };
      return { state: "authenticated" };
    });
    let reads = 0;
    const inventory = context.mock.method(MegaClient.prototype, "inventory", async () => {
      if (++reads === 1) {
        if (outcome === "cancel-before-login") void f.provider.close();
        throw new Error("Mega request failed (HTTP 401)");
      }
      if (outcome === "second401") throw new Error("Mega request failed (HTTP 401)");
      return { devices: [{ device_sn: "camera", device_model: "T8214", device_type: 94, category: "eufy_security" }] };
    });
    const push = context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    const intervals = context.mock.method(globalThis, "setInterval");
    try {
      if (["second401", "login401", "transport"].includes(outcome)) await assert.rejects(f.provider.start(f.events));
      else await assert.doesNotReject(f.provider.start(f.events));
      assert.equal(connect.mock.callCount(), outcome === "cancel-before-login" ? 1 : 2);
      if (outcome !== "cancel-before-login") assert.deepEqual(connect.mock.calls[1]!.arguments, [undefined, undefined, true]);
      assert.equal(inventory.mock.callCount(), ["success", "second401"].includes(outcome) ? 2 : 1);
      assert.equal(push.mock.callCount(), outcome === "success" ? 1 : 0);
      assert.equal(intervals.mock.callCount(), outcome === "success" ? 2 : 0);
      if (outcome === "success") assert.equal(f.connections.at(-1)?.state, "connected");
      if (outcome.endsWith("required")) assert.equal(f.connections.at(-1)?.state, "authentication-required");
      assert.equal(await readFile(path, "utf8"), sentinel);
      assert.equal(f.network.mock.callCount(), 0);
    } finally { await f.provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

for (const challenge of ["captcha", "verification"] as const) {
  test(`concurrent ${challenge} replies create only one replacement startup`, async (context) => {
    const f = fixture(context);
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: `${challenge}-required`, captcha: { captchaId: "synthetic", image: "" } }));
    const push = context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    const inventory = context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [] }));
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    try {
      await f.provider.start(f.events);
      context.mock.method(MegaClient.prototype, "connect", () => pending);
      const first = challenge === "captcha" ? f.provider.submitCaptcha("synthetic") : f.provider.submitVerification("synthetic");
      const second = challenge === "captcha" ? f.provider.submitCaptcha("synthetic") : f.provider.submitVerification("synthetic");
      finish({ state: "authenticated" });
      await Promise.all([first, second]);
      assert.equal(inventory.mock.callCount(), 1);
      assert.equal(push.mock.callCount(), 1);
      assert.equal(f.connections.filter(({ state }) => state === "connected").length, 1);
      assert.equal(f.network.mock.callCount(), 0);
    } finally { await f.provider.close(); }
  });
}

test("close during CAPTCHA cannot restart a retired provider", async (context) => {
  const f = fixture(context);
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "captcha-required", captcha: { captchaId: "synthetic", image: "" } }));
  const push = context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => { finish = resolve; });
  try {
    await f.provider.start(f.events);
    context.mock.method(MegaClient.prototype, "connect", () => pending);
    const submitting = f.provider.submitCaptcha("synthetic");
    await f.provider.close();
    finish({ state: "authenticated" });
    await assert.doesNotReject(submitting);
    assert.equal(push.mock.callCount(), 0);
    assert.equal(f.connections.some(({ state }) => state === "connected"), false);
    assert.equal(f.network.mock.callCount(), 0);
  } finally { await f.provider.close(); }
});

for (const rejected of [false, true]) {
  test(`close retires forced login ${rejected ? "rejection" : "success"}`, async (context) => {
    const f = fixture(context);
    context.mock.method(MegaClient.prototype, "inventory", async () => { throw new Error("Mega request failed (HTTP 401)"); });
    let finish!: (value: unknown) => void;
    let fail!: (error: Error) => void;
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    let calls = 0;
    context.mock.method(MegaClient.prototype, "connect", () => ++calls === 1 ? Promise.resolve({ state: "authenticated" }) : (entered(), pending));
    const push = context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    try {
      const starting = f.provider.start(f.events);
      await entering;
      await f.provider.close();
      if (rejected) fail(new Error("Private superseded login"));
      else finish({ state: "authenticated" });
      await assert.doesNotReject(starting);
      assert.equal(push.mock.callCount(), 0);
      assert.equal(f.connections.some(({ state }) => state === "connected"), false);
      assert.equal(f.network.mock.callCount(), 0);
    } finally { await f.provider.close(); }
  });
}

test("throwing stopped callback cannot interrupt provider timer cleanup", async (context) => {
  const f = fixture(context);
  const intervals = context.mock.method(globalThis, "setInterval");
  const clear = context.mock.method(globalThis, "clearInterval");
  context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
  f.events.eventReceiverState = (state) => { f.state.recordEventReceiverState(state); throw new Error("PRIVATE_STOP_MARKER"); };
  try {
    await f.provider.start(f.events);
    await assert.doesNotReject(f.provider.close());
    assert.equal(f.state.eventDeliveryDiagnostic().receiverState, "stopped");
    assert.equal(intervals.mock.callCount(), 2);
    for (const call of intervals.mock.calls) assert.ok(clear.mock.calls.some(({ arguments: args }) => args[0] === call.result));
    assert.equal(f.network.mock.callCount(), 0);
  } finally { await f.provider.close(); }
});

/** Collect refresh publications while keeping all station transports offline. */
function discoveryFixture(context: TestContext) {
  const f = fixture(context);
  const intervals = context.mock.method(globalThis, "setInterval");
  const push = context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
  context.mock.method(EufyProvider.prototype, "refreshStation", async () => { throw new Error("Offline station"); });
  const observations = { publications: 0, motion: [] as string[] };
  const events = new Proxy({
    camera: (row: Parameters<ProviderEvents["camera"]>[0]) => { ++observations.publications; f.state.registerCamera(row); },
    sensor: (row: Parameters<ProviderEvents["sensor"]>[0]) => f.state.registerSensor(row),
    station: (row: Parameters<ProviderEvents["station"]>[0]) => f.state.registerStation(row),
    inventory: (rows: Parameters<ProviderEvents["inventory"]>[0]) => f.state.updateInventoryDiagnostics(rows),
    cameraCapabilities: (rows: Parameters<ProviderEvents["cameraCapabilities"]>[0]) => f.state.updateCameraCapabilities(rows),
    deviceCapabilities: (rows: Parameters<ProviderEvents["deviceCapabilities"]>[0]) => f.state.updateDeviceCapabilities(rows),
    sensorMotion: (serial: string) => observations.motion.push(serial),
  }, { get: (target, key) => Reflect.get(target, key) ?? Reflect.get(f.events, key) }) as unknown as ProviderEvents;
  return { ...f, events, observations, intervals, push };
}

/** Drain asynchronous callbacks without advancing station transport timers. */
async function settleDiscovery(): Promise<void> {
  for (let index = 0; index < 20; ++index) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Exercise the second timer, which owns account inventory rather than PPCS reads. */
function pollDiscovery(f: ReturnType<typeof discoveryFixture>): void {
  assert.equal(f.intervals.mock.calls.length, 2);
  const call = f.intervals.mock.calls[1]!;
  assert.equal(call.arguments[1], 60_000);
  (call.arguments[0] as () => void)();
}

for (const outcome of ["success", "start-failure", "write-failure", "readback-failure", "mismatch"] as const) {
  test(`standalone night vision owns closure and fresh state on ${outcome}`, async (context) => {
    const f = discoveryFixture(context);
    let mode = 1;
    let reads = 0;
    let written = false;
    const rows = () => ({ devices: [{ device_sn: "camera", device_model: "T8171", device_type: 88,
      category: "eufy_security", device_channel: 0, p2p_did: "fixture-peer", p2p_conn: "fixture-route",
      member: { admin_user_id: "fixture-account" }, params: [{ param_type: 1277, param_value: String(mode) }] }] });
    context.mock.method(MegaClient.prototype, "inventory", async () => {
      ++reads;
      if (written && outcome === "readback-failure") throw new Error("Offline readback failed");
      return rows();
    });
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ camera: { key: "fixture-key", expiresAt: null } }));
    const stop = context.mock.method(f.provider, "stopStream", async () => undefined);
    context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => {
      assert.equal(stop.mock.callCount(), 1);
      if (outcome === "start-failure") throw new Error("Offline start failed");
    });
    context.mock.method(FirstPartyPpcsSession.prototype, "writeNightVision", async (value: number) => {
      written = true;
      assert.equal(f.state.getCamera("camera").nightVisionMode, 1);
      if (outcome === "write-failure") throw new Error("Offline write failed");
      if (outcome !== "mismatch") mode = value;
    });
    const close = context.mock.method(FirstPartyPpcsSession.prototype, "close", () => undefined);
    const schedule = globalThis.setTimeout;
    context.mock.method(globalThis, "setTimeout", (callback: () => void, milliseconds?: number) =>
      schedule(callback, milliseconds === 2_000 ? 0 : milliseconds));
    try {
      await f.provider.start(f.events);
      assert.equal(f.state.getCamera("camera").nightVisionControlSupported, true);
      if (outcome === "success") assert.equal((await f.provider.setCameraNightVision("camera", 3)).nightVisionMode, 3);
      else await assert.rejects(f.provider.setCameraNightVision("camera", 3), /Offline|not confirmed/);
      assert.equal(close.mock.callCount(), 1);
      if (outcome === "mismatch") assert.equal(reads, 13);
      await assert.rejects(f.provider.setCameraNightVision("camera", 2), /not supported/);
      await assert.rejects(f.provider.setCameraNightVision("camera", 4), /integer from 0 through 3/);
    } finally { await f.provider.close(); }
  });
}

test("standalone night vision serializes writes and confirms all supported modes", async (context) => {
  const f = discoveryFixture(context);
  let mode = 1;
  const writes: number[] = [];
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{
    device_sn: "camera", device_model: "T8171", device_type: 88, category: "eufy_security",
    device_channel: 0, p2p_did: "fixture-peer", p2p_conn: "fixture-route",
    member: { admin_user_id: "fixture-account" }, params: [{ param_type: 1277, param_value: String(mode) }],
  }] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ camera: { key: "fixture-key", expiresAt: null } }));
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => undefined);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  context.mock.method(FirstPartyPpcsSession.prototype, "writeNightVision", async (value: number) => {
    writes.push(value);
    if (writes.length === 1) await pending;
    mode = value;
  });
  try {
    await f.provider.start(f.events);
    const first = f.provider.setCameraNightVision("camera", 0);
    const second = f.provider.setCameraNightVision("camera", 3);
    await settleDiscovery();
    assert.deepEqual(writes, [0]);
    finish();
    assert.equal((await first).nightVisionMode, 0);
    assert.equal((await second).nightVisionMode, 3);
    assert.equal((await f.provider.setCameraNightVision("camera", 1)).nightVisionMode, 1);
    assert.deepEqual(writes, [0, 3, 1]);
  } finally { finish(); await f.provider.close(); }
});

for (const childFirst of [false, true]) {
  test(`runtime discovery adds devices with complete routing, child first=${childFirst}`, async (context) => {
    const f = discoveryFixture(context);
    try {
      await f.provider.start(f.events);
      f.state.updateStream("camera", "streaming", 1);
      const child = { device_sn: "child", device_model: "T8171", device_type: 88,
        category: "eufy_security", parent_sn: "peer", device_channel: 1 };
      const peer = { device_sn: "peer", device_model: "T8030", device_type: 18,
        category: "eufy_security", p2p_did: "fixture-peer", p2p_conn: "fixture-route" };
      context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
        ...(childFirst ? [child, peer] : [peer, child]),
        { device_sn: "pir", device_model: "T8910", device_type: 10, category: "eufy_security",
          params: [{ param_type: 1605, param_value: "1789500000" }] },
        { device_sn: "unknown", device_model: "T9999", device_type: 999, category: "eufy_security" },
      ] }));
      const keys = context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ peer: { key: "fixture-key", expiresAt: null } }));
      pollDiscovery(f);
      await settleDiscovery();
      assert.equal(f.state.getCamera("child").streamSupported, true);
      assert.equal(f.state.listSensors().length, 1);
      assert.equal(f.state.listStations().length, 1);
      assert.equal(f.state.listInventoryDiagnostics().length, 5);
      assert.equal(f.state.listCameraCapabilities().length, 5);
      assert.ok(f.state.listCameraCapabilities().some(({ serial }) => serial === "unknown"));
      assert.equal(f.state.hasCamera("unknown"), false);
      assert.equal(f.state.getCamera("camera").stream.state, "streaming");
      assert.deepEqual(f.observations.motion, []);
      assert.equal(f.push.mock.callCount(), 1);
      pollDiscovery(f);
      await settleDiscovery();
      assert.equal(f.state.listCameras().length, 2);
      assert.equal(keys.mock.callCount(), 1);
      assert.equal(f.state.listStations().length, 1);
    } finally { await f.provider.close(); }
  });
}

test("runtime discovery batches missing keys, throttles failures and restores readiness", async (context) => {
  const f = discoveryFixture(context);
  try {
    await f.provider.start(f.events);
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
      { device_sn: "peer", device_model: "T8030", device_type: 18, category: "eufy_security", p2p_did: "fixture-peer", p2p_conn: "fixture-route" },
      { device_sn: "child", device_model: "T8171", device_type: 88, category: "eufy_security", parent_sn: "peer", device_channel: 1 },
      { device_sn: "rtc", device_model: "T8N00", device_type: 300, category: "eufy_security", p2p_did: "fixture-rtc", p2p_conn: "fixture-route" },
    ] }));
    let recover = false;
    const keys = context.mock.method(MegaClient.prototype, "dskKeys", async (serials: readonly string[]) => {
      assert.deepEqual(serials, ["peer"]);
      if (!recover) throw new Error("Fixture key failure");
      return { peer: { key: "fixture-key", expiresAt: null } };
    });
    const logs: string[] = [];
    context.mock.method(process.stderr, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
    for (let index = 0; index < 16; ++index) { pollDiscovery(f); await settleDiscovery(); }
    assert.equal(keys.mock.callCount(), 16);
    assert.equal(logs.filter((line) => line.includes("inventory_dsk_unavailable")).length, 2);
    assert.equal(f.state.getCamera("child").streamSupported, false);
    assert.equal(f.state.listStations().find(({ serial }) => serial === "peer")?.cameraRouteReady, false);
    recover = true;
    pollDiscovery(f);
    await settleDiscovery();
    assert.equal(f.state.getCamera("child").streamSupported, true);
    assert.equal(f.state.listStations().find(({ serial }) => serial === "peer")?.cameraRouteReady, true);
    pollDiscovery(f);
    await settleDiscovery();
    assert.equal(keys.mock.callCount(), 17);
  } finally { await f.provider.close(); }
});

test("runtime discovery preserves state on failed, malformed and empty inventory", async (context) => {
  const f = discoveryFixture(context);
  try {
    await f.provider.start(f.events);
    const diagnostics = f.state.listInventoryDiagnostics();
    const manifests = f.state.listCameraCapabilities();
    const deviceManifests = f.state.listDeviceCapabilities();
    for (const response of [null, {}, { devices: [] }]) {
      context.mock.method(MegaClient.prototype, "inventory", async () => response as never);
      pollDiscovery(f);
      await settleDiscovery();
      assert.deepEqual(f.state.listInventoryDiagnostics(), diagnostics);
      assert.deepEqual(f.state.listCameraCapabilities(), manifests);
      assert.deepEqual(f.state.listDeviceCapabilities(), deviceManifests);
    }
    context.mock.method(MegaClient.prototype, "inventory", async () => { throw new Error("Fixture failure"); });
    pollDiscovery(f);
    await settleDiscovery();
    assert.equal(f.observations.publications, 1);
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
      { device_sn: "new", device_model: "T8171", device_type: 88, category: "eufy_security" },
    ] }));
    pollDiscovery(f);
    await settleDiscovery();
    assert.equal(f.state.listCameras().length, 2);
  } finally { await f.provider.close(); }
});

for (const stage of ["inventory", "keys"] as const) {
  for (const replacement of [false, true]) {
    test(`retired discovery ignores late ${stage}, replacement=${replacement}`, async (context) => {
      const f = discoveryFixture(context);
      try {
        await f.provider.start(f.events);
        let finish!: (value: never) => void;
        const pending = new Promise<never>((resolve) => { finish = resolve; });
        const rows = { devices: [{ device_sn: "late", device_model: "T8171", device_type: 88,
          category: "eufy_security", device_channel: 0, p2p_did: "fixture-peer", p2p_conn: "fixture-route" }] };
        context.mock.method(MegaClient.prototype, "inventory", async () => stage === "inventory" ? pending : rows);
        context.mock.method(MegaClient.prototype, "dskKeys", async () => pending);
        pollDiscovery(f);
        await settleDiscovery();
        const published = f.observations.publications;
        if (replacement) {
          context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [] }));
          context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
          await f.provider.start(f.events);
        } else await f.provider.close();
        finish((stage === "inventory" ? rows : { late: { key: "fixture-key", expiresAt: null } }) as never);
        await settleDiscovery();
        assert.equal(f.observations.publications, published);
        assert.equal(f.state.hasCamera("late"), false);
      } finally { await f.provider.close(); }
    });
  }
}

test("runtime timer polls coalesce and subsequent polls retry", async (context) => {
  const f = discoveryFixture(context);
  try {
    await f.provider.start(f.events);
    let finish!: (value: { devices: [] }) => void;
    const pending = new Promise<{ devices: [] }>((resolve) => { finish = resolve; });
    const inventory = context.mock.method(MegaClient.prototype, "inventory", async () => pending);
    pollDiscovery(f);
    pollDiscovery(f);
    await settleDiscovery();
    assert.equal(inventory.mock.callCount(), 1);
    finish({ devices: [] });
    await settleDiscovery();
    pollDiscovery(f);
    await settleDiscovery();
    assert.equal(inventory.mock.callCount(), 2);
  } finally { await f.provider.close(); }
});

test("control readbacks share one fresh trailing refresh after a pending timer read", async (context) => {
  const f = discoveryFixture(context);
  const rows = (enabled: boolean) => ({ devices: ["camera", "second"].map((serial) => ({
    device_sn: serial, device_model: "T8171", device_type: 88, category: "eufy_security",
    device_channel: 0, p2p_did: "fixture-peer", p2p_conn: "fixture-route",
    member: { admin_user_id: "fixture-account" }, params: [{ param_type: 1035, param_value: enabled ? "0" : "1" }],
  })) });
  try {
    context.mock.method(MegaClient.prototype, "inventory", async () => rows(false));
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({
      camera: { key: "fixture-key", expiresAt: null }, second: { key: "fixture-key", expiresAt: null },
    }));
    context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => undefined);
    const writes = context.mock.method(FirstPartyPpcsSession.prototype, "writeCameraEnabled", async () => undefined);
    await f.provider.start(f.events);
    let finish!: (value: ReturnType<typeof rows>) => void;
    const pending = new Promise<ReturnType<typeof rows>>((resolve) => { finish = resolve; });
    let reads = 0;
    const inventory = context.mock.method(MegaClient.prototype, "inventory", async () =>
      ++reads === 1 ? pending : rows(true));
    pollDiscovery(f);
    const first = f.provider.setCameraEnabled("camera", true);
    const second = f.provider.setCameraEnabled("second", true);
    await settleDiscovery();
    assert.equal(writes.mock.callCount(), 2);
    assert.equal(inventory.mock.callCount(), 1);
    finish(rows(false));
    assert.equal((await first).enabled, true);
    assert.equal((await second).enabled, true);
    assert.equal(inventory.mock.callCount(), 2);
  } finally { await f.provider.close(); }
});

test("replacement startup gates old timer refresh until initial publication finishes", async (context) => {
  const f = discoveryFixture(context);
  try {
    await f.provider.start(f.events);
    let finish!: (value: { devices: [] }) => void;
    const pending = new Promise<{ devices: [] }>((resolve) => { finish = resolve; });
    const inventory = context.mock.method(MegaClient.prototype, "inventory", async () => pending);
    const start = f.provider.start(f.events);
    await settleDiscovery();
    pollDiscovery(f);
    await settleDiscovery();
    assert.equal(inventory.mock.callCount(), 1);
    assert.equal(f.observations.publications, 1);
    finish({ devices: [] });
    await start;
  } finally { await f.provider.close(); }
});

test("new PIR inventory establishes a motion baseline then publishes newer motion", async (context) => {
  const f = discoveryFixture(context);
  try {
    await f.provider.start(f.events);
    let timestamp = 1_789_500_000;
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{
      device_sn: "pir", device_model: "T8910", device_type: 10, category: "eufy_security",
      params: [{ param_type: 1605, param_value: String(timestamp) }],
    }] }));
    pollDiscovery(f);
    await settleDiscovery();
    assert.deepEqual(f.observations.motion, []);
    timestamp += 1;
    pollDiscovery(f);
    await settleDiscovery();
    assert.deepEqual(f.observations.motion, ["pir"]);
    pollDiscovery(f);
    await settleDiscovery();
    assert.deepEqual(f.observations.motion, ["pir"]);
  } finally { await f.provider.close(); }
});

test("runtime standalone discovery preserves camera-owned live reads", async (context) => {
  const f = discoveryFixture(context);
  try {
    await f.provider.start(f.events);
    const row = { device_sn: "direct", device_model: "T8171", device_type: 88, category: "eufy_security",
      device_channel: 0, p2p_did: "fixture-peer", p2p_conn: "fixture-route",
      member: { admin_user_id: "fixture-account" }, params: [{ param_type: 1101, param_value: "40" }] };
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [row] }));
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ direct: { key: "fixture-key", expiresAt: null } }));
    context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => undefined);
    context.mock.method(FirstPartyPpcsSession.prototype, "readCameraInfo", async () => [{ param_type: 1101, param_value: "85" }]);
    pollDiscovery(f);
    await settleDiscovery();
    assert.equal(f.state.getCamera("direct").streamSupported, true);
    await f.provider.refreshCameraCapabilities("direct");
    const live = f.state.getCamera("direct").battery;
    pollDiscovery(f);
    await settleDiscovery();
    assert.deepEqual(f.state.getCamera("direct").battery, live);
    assert.equal(f.state.getCamera("direct").battery?.level, 85);
  } finally { await f.provider.close(); }
});

test("SoloCam motion reads do not enable a route without ready session keys", async (context) => {
  const f = discoveryFixture(context);
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{
    device_sn: "camera", device_model: "T8171", device_type: 88, category: "eufy_security",
    device_channel: 0, p2p_did: "fixture-peer", p2p_conn: "fixture-route",
    member: { admin_user_id: "fixture-account" }, params: [{ param_type: 6040, param_value: "1" }],
  }] }));
  const write = context.mock.method(FirstPartyPpcsSession.prototype, "writeMotionDetection", async () => undefined);
  try {
    await f.provider.start(f.events);
    assert.equal(f.state.getCamera("camera").motionDetectionEnabled, true);
    assert.equal(f.state.getCamera("camera").motionDetectionControlSupported, false);
    await assert.rejects(f.provider.setCameraMotionDetection("camera", false), /unavailable/);
    assert.equal(write.mock.callCount(), 0);
  } finally { await f.provider.close(); }
});

for (const childFirst of [false, true]) {
  test(`existing camera moves to HomeBase and back without restarting, child first=${childFirst}`, async (context) => {
    const f = discoveryFixture(context);
    const direct = { device_sn: "camera", device_name: "Direct camera", device_model: "T8171", device_type: 88,
      category: "eufy_security", parent_sn: "camera", device_channel: 0, p2p_did: "direct-peer", p2p_conn: "direct-route",
      member: { admin_user_id: "fixture-account" }, params: [{ param_type: 1277, param_value: "1" }] };
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [direct] }));
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ camera: { key: "direct-key", expiresAt: null }, peer: { key: "station-key", expiresAt: null } }));
    const starts = context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => undefined);
    const closes = context.mock.method(FirstPartyPpcsSession.prototype, "close");
    context.mock.method(FirstPartyPpcsSession.prototype, "readCameraInfo", async () => [{ param_type: 1277, param_value: "3" }]);
    f.events.streamStopped = (serial) => f.state.updateStream(serial, "idle", 0);
    try {
      await f.provider.start(f.events);
      await f.provider.refreshCameraCapabilities("camera");
      assert.equal(f.state.getCamera("camera").nightVisionMode, 3);
      assert.equal(f.state.getCamera("camera").storedRecordingsSupported, true);
      await f.provider.startStream("camera");
      f.state.updateStream("camera", "streaming", 1);
      const closeCount = closes.mock.callCount();
      context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ ...direct, device_name: "Renamed direct" }] }));
      pollDiscovery(f); await settleDiscovery();
      assert.equal(f.state.getCamera("camera").name, "Renamed direct");
      assert.equal(f.state.getCamera("camera").stream.viewers, 1);
      assert.equal(f.state.getCamera("camera").nightVisionMode, 3);
      assert.equal(closes.mock.callCount(), closeCount);
      const peer = { device_sn: "peer", device_model: "T8030", device_type: 18, category: "eufy_security",
        p2p_did: "station-peer", p2p_conn: "station-route", member: { admin_user_id: "fixture-account" } };
      const child = { ...direct, device_name: "Attached camera", parent_sn: "peer", device_channel: 2,
        p2p_did: "", p2p_conn: "", params: [{ param_type: 1277, param_value: "0" }] };
      context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: childFirst ? [child, peer] : [peer, child] }));
      pollDiscovery(f); await settleDiscovery();
      const attached = f.state.getCamera("camera");
      assert.equal(attached.name, "Attached camera"); assert.equal(attached.stationSerial, "peer");
      assert.equal(attached.streamSupported, true); assert.equal(attached.storedRecordingsSupported, false);
      assert.equal(attached.audioRecordingControlSupported, false); assert.equal(attached.streamingQualityControlSupported, false);
      assert.equal(attached.nightVisionMode, 0);
      assert.equal(attached.stream.viewers, 0); assert.equal(attached.stream.state, "idle");
      assert.equal(closes.mock.callCount(), closeCount + 1);
      const startCount = starts.mock.callCount();
      context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ ...direct, device_name: "Renamed direct" }, peer] }));
      pollDiscovery(f); await settleDiscovery();
      const restored = f.state.getCamera("camera");
      assert.equal(restored.name, "Renamed direct"); assert.equal(restored.stationSerial, "camera");
      assert.equal(restored.streamSupported, true); assert.equal(restored.storedRecordingsSupported, true);
      assert.equal(restored.nightVisionMode, 1);
      assert.equal(starts.mock.callCount(), startCount);
      assert.equal(f.push.mock.callCount(), 1); assert.equal(f.connections.filter(({ state }) => state === "connected").length, 1);
    } finally { await f.provider.close(); }
  });
}

test("binding changes retire owned recording sessions and reject late old-route results", async (context) => {
  const f = discoveryFixture(context);
  const direct = { device_sn: "camera", device_model: "T8171", device_type: 88, category: "eufy_security",
    parent_sn: "camera", device_channel: 0, p2p_did: "direct-peer", p2p_conn: "direct-route",
    member: { admin_user_id: "fixture-account" } };
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [direct] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ camera: { key: "direct-key", expiresAt: null }, peer: { key: "station-key", expiresAt: null } }));
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => undefined);
  const closes = context.mock.method(FirstPartyPpcsSession.prototype, "close");
  let finish!: (records: readonly never[]) => void;
  const pending = new Promise<readonly never[]>((resolve) => { finish = resolve; });
  context.mock.method(FirstPartyPpcsSession.prototype, "listStoredRecordings", () => pending);
  try {
    await f.provider.start(f.events);
    const listing = f.provider.listStoredRecordings("camera", "2026-10-09");
    const rejected = assert.rejects(listing, /connection changed/);
    await settleDiscovery();
    const closeCount = closes.mock.callCount();
    const peer = { device_sn: "peer", device_model: "T8030", device_type: 18, category: "eufy_security",
      p2p_did: "station-peer", p2p_conn: "station-route", member: { admin_user_id: "fixture-account" } };
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ ...direct, parent_sn: "peer", device_channel: 1 }, peer] }));
    pollDiscovery(f); await settleDiscovery();
    assert.equal(closes.mock.callCount(), closeCount + 1);
    finish([]); await rejected;
    assert.equal(f.state.getCamera("camera").storedRecordingsSupported, false);
  } finally { finish([]); await f.provider.close(); }
});
