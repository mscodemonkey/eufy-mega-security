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
