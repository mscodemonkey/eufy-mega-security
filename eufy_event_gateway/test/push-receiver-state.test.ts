/**
 * Exercises receiver status across registration, reconnect and shutdown.
 * Synthetic credentials and an injected transport keep this lifecycle test offline.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach, afterEach, type TestContext } from "node:test";
import { MegaPushReceiver } from "../src/mega/push.js";
import { FcmRegistrar } from "../src/mega/android-push/fcm.js";
import type { PushClient } from "../src/mega/android-push/push-client.js";

const unhandled: unknown[] = [];
const onUnhandled = (error: unknown): void => { unhandled.push(error); };
let networkCalls = 0;

beforeEach((context) => {
  networkCalls = 0;
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  if (!("mock" in context)) throw new Error("Expected test context");
  context.mock.method(globalThis, "fetch", async () => { ++networkCalls; throw new Error("Network forbidden"); });
});

afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, []);
  assert.equal(networkCalls, 0);
});

/** Count only unfired, uncleared registration retry timers, excluding login waits. */
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

test("publishes registration once, restores connected after reconnect and leaves stopped last", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-push-state-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({ version: 2, persistentIds: [], credentials: {
    fid: "synthetic", androidId: "123", securityToken: "456", fcmToken: "synthetic", createdAt: 1,
  } }));
  const transport = Object.assign(new EventEmitter(), {
    setPersistentIds() {},
    connect() { transport.emit("connect"); },
    close() { queueMicrotask(() => transport.emit("disconnect")); },
  });
  const states: string[] = [];
  const receiver = new MegaPushReceiver({ registerPushToken: async () => ({ activated: true, code: 0 }) } as never, path,
    () => undefined, (state) => states.push(state), undefined, () => transport as unknown as PushClient);
  try {
    await receiver.start();
    transport.emit("disconnect");
    transport.emit("connect");
    await receiver.close();
    await Promise.resolve();
    assert.deepEqual(states, ["starting", "connected", "disconnected", "connected", "stopped"]);
  } finally {
    await receiver.close();
    await rm(directory, { recursive: true, force: true });
  }
});

/** Provide a stored synthetic identity and a fresh transport per start without network calls. */
async function receiverFixture(register: () => Promise<void | { activated: boolean; code: number | null }>, automaticLogin = true, storedCredentials = true,
  onState: (state: string) => void = () => undefined) {
  const directory = await mkdtemp(join(tmpdir(), "eufy-push-race-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({ version: 2, persistentIds: [], ...(storedCredentials ? { credentials: {
    fid: "synthetic", androidId: "123", securityToken: "456", fcmToken: "synthetic", createdAt: 1,
  } } : {}) }));
  const transports: (EventEmitter & { closed: boolean; closeCalls: number })[] = [];
  const states: string[] = [];
  const events: unknown[] = [];
  let created!: () => void;
  const ready = new Promise<void>((resolve) => { created = resolve; });
  const client = { registerPushToken: async () => (await register()) ?? { activated: true, code: 0 } };
  const receiver = new MegaPushReceiver(client as never, path, (event) => { events.push(event); },
    (state) => { states.push(state); onState(state); }, undefined, () => {
      const transport = Object.assign(new EventEmitter(), {
        closed: false, closeCalls: 0,
        setPersistentIds() {},
        connect() { created(); if (automaticLogin) transport.emit("connect"); },
        close() { transport.closed = true; ++transport.closeCalls; queueMicrotask(() => transport.emit("disconnect")); },
      });
      transports.push(transport);
      return transport as unknown as PushClient;
    });
  return { receiver, client, transports, states, events, ready, path, async cleanup() { await receiver.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("closing while registration is pending leaves stopped as the final state", async () => {
  let entered!: () => void;
  let finish!: () => void;
  const registering = new Promise<void>((resolve) => { entered = resolve; });
  const registration = new Promise<void>((resolve) => { finish = resolve; });
  const fixture = await receiverFixture(() => { entered(); return registration; });
  try {
    const starting = fixture.receiver.start();
    await registering;
    await fixture.receiver.close();
    finish();
    await starting;
    assert.deepEqual(fixture.states, ["starting", "stopped"]);
  } finally { await fixture.cleanup(); }
});

test("a disconnect during registration stays disconnected until the next login", async () => {
  let entered!: () => void;
  let finish!: () => void;
  const registering = new Promise<void>((resolve) => { entered = resolve; });
  const registration = new Promise<void>((resolve) => { finish = resolve; });
  const fixture = await receiverFixture(() => { entered(); return registration; });
  try {
    const starting = fixture.receiver.start();
    await registering;
    fixture.transports[0]!.emit("disconnect");
    finish();
    await starting;
    assert.deepEqual(fixture.states, ["starting", "disconnected"]);
    fixture.transports[0]!.emit("connect");
    assert.deepEqual(fixture.states, ["starting", "disconnected", "connected"]);
  } finally { await fixture.cleanup(); }
});

test("a stale registration rejection cannot clear a replacement receiver", async () => {
  let entered!: () => void;
  let reject!: (error: Error) => void;
  const registering = new Promise<void>((resolve) => { entered = resolve; });
  const registration = new Promise<void>((_resolve, failed) => { reject = failed; });
  let registrations = 0;
  const fixture = await receiverFixture(() => { if (++registrations === 1) { entered(); return registration; } return Promise.resolve(); });
  try {
    const starting = fixture.receiver.start();
    const settled = assert.doesNotReject(starting);
    await registering;
    await fixture.receiver.close();
    await fixture.receiver.start();
    fixture.transports[0]!.emit("connect");
    fixture.transports[0]!.emit("disconnect");
    reject(new Error("synthetic rejection"));
    await settled;
    fixture.transports[1]!.emit("disconnect");
    fixture.transports[1]!.emit("connect");
    assert.deepEqual(fixture.states, ["starting", "stopped", "starting", "connected", "disconnected", "connected"]);
  } finally { await fixture.cleanup(); }
});

test("closing while login is pending cannot publish a later state", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = await receiverFixture(async () => undefined, false);
  try {
    const starting = fixture.receiver.start();
    const settled = assert.doesNotReject(starting);
    await fixture.ready;
    await fixture.receiver.close();
    context.mock.timers.tick(20_000);
    await settled;
    assert.deepEqual(fixture.states, ["starting", "stopped"]);
  } finally { await fixture.cleanup(); }
});

for (const code of [-1, 10003]) {
  test(`activation ${code} retains notifications, retries exactly five times and stops`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const timers = retryTimers(context);
    const logs: string[] = [];
    context.mock.method(process.stderr, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
    let calls = 0;
    const fixture = await receiverFixture(async () => { ++calls; return { activated: false, code }; });
    try {
      await assert.doesNotReject(fixture.receiver.start());
      fixture.transports[0]!.emit("message", { payload: { device_sn: "camera", a: 3102 } });
      assert.equal(fixture.events.length, 1);
      assert.equal(fixture.states.at(-1), "degraded");
      for (const delay of [15_000, 30_000, 60_000, 120_000, 300_000]) {
        context.mock.timers.tick(delay - 1);
        const previous = calls;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(calls, previous);
        context.mock.timers.tick(1);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(calls, previous + 1);
      }
      context.mock.timers.tick(1_000_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 6);
      assert.equal(fixture.transports.length, 1);
      assert.equal(timers.size, 0);
      assert.equal(fixture.transports[0]!.closed, false);
      fixture.transports[0]!.emit("disconnect");
      assert.equal(fixture.states.at(-1), "disconnected");
      fixture.transports[0]!.emit("connect");
      assert.equal(fixture.states.at(-1), "degraded");
      const failures = logs.filter((line) => line.includes("event=push_registration_degraded"));
      assert.equal(failures.length, 6);
      assert.match(failures[0]!, new RegExp(`stage=activation code=${code} attempt=1 max_retries=5 next_retry_seconds=15`));
      assert.match(failures[5]!, /attempt=6 max_retries=5 exhausted=true/);
      await fixture.receiver.close();
      assert.equal(timers.size, 0);
      assert.equal(fixture.transports[0]!.closed, true);
      assert.equal(fixture.transports[0]!.closeCalls, 1);
    } finally { await fixture.cleanup(); }
  });
}

for (const failedSecurityStage of ["registration", "activation"] as const) {
  test(`restored Mega registration leaves ${failedSecurityStage} failure stably degraded without retries`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const timers = retryTimers(context);
    const logs: string[] = [];
    context.mock.method(process.stderr, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
    let calls = 0;
    const fixture = await receiverFixture(async () => {
      ++calls;
      return { activated: false, code: 10003, failedSecurityStage, megaRegistrationRestored: true };
    });
    try {
      await fixture.receiver.start();
      assert.equal(calls, 1);
      assert.equal(fixture.states.at(-1), "degraded");
      assert.equal(timers.size, 0);
      context.mock.timers.tick(1_000_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      fixture.transports[0]!.emit("disconnect");
      fixture.transports[0]!.emit("connect");
      assert.equal(fixture.states.at(-1), "degraded");
      const warning = logs.find((line) => line.includes("event=push_registration_degraded"));
      assert.match(warning ?? "", new RegExp(`stage=${failedSecurityStage} code=10003 .*restoration=mega retry=false`));
    } finally { await fixture.cleanup(); }
    assert.equal(timers.size, 0);
    assert.equal(fixture.transports[0]!.closeCalls, 1);
  });
}

test("a disconnected retry waits for login without consuming the registration budget", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const fixture = await receiverFixture(async () => { if (++calls === 1) return { activated: false, code: -1 }; });
  try {
    await fixture.receiver.start();
    fixture.transports[0]!.emit("disconnect");
    context.mock.timers.tick(15_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    context.mock.timers.tick(1_000_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    fixture.transports[0]!.emit("connect");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal(fixture.states.at(-1), "connected");
    assert.equal(fixture.states.filter((state) => state === "connected").length, 1);
  } finally { await fixture.cleanup(); }
});

test("close cancels a retry wait and leaves no later state or registration", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const fixture = await receiverFixture(async () => { ++calls; throw new Error("Rejected"); });
  try {
    await fixture.receiver.start();
    fixture.transports[0]!.emit("disconnect");
    context.mock.timers.tick(15_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await fixture.receiver.close();
    fixture.transports[0]!.emit("connect");
    context.mock.timers.tick(1_000_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(fixture.states.at(-1), "stopped");
    assert.equal(fixture.transports[0]!.listenerCount("connect"), 1);
  } finally { await fixture.cleanup(); }
});

test("registrar rejection recovers and resolved credentials are reused", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const logs: string[] = [];
  context.mock.method(process.stderr, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
  const registrar = context.mock.method(FcmRegistrar.prototype, "register", async () => {
    if (++calls === 1) throw new Error("Initialization failed with private details");
    return { fid: "synthetic", androidId: "123", securityToken: "456", fcmToken: "synthetic", createdAt: 1 };
  });
  let registrations = 0;
  const fixture = await receiverFixture(async () => { if (++registrations === 1) throw new Error("Rejected"); }, true, false);
  try {
    await fixture.receiver.start();
    assert.equal(fixture.states.at(-1), "degraded");
    assert.match(logs.find((line) => line.includes("event=push_registration_degraded"))!, /stage=initialization attempt=1/);
    context.mock.timers.tick(15_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    context.mock.timers.tick(30_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(registrar.mock.callCount(), 2);
    assert.equal(registrations, 2);
    assert.equal(fixture.states.at(-1), "connected");
  } finally { await fixture.cleanup(); }
});

test("state read failure creates no new Firebase identity", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-push-unreadable-"));
  const registrar = context.mock.method(FcmRegistrar.prototype, "register", async () => { throw new Error("Must not register"); });
  const states: string[] = [];
  const logs: string[] = [];
  context.mock.method(process.stderr, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
  const receiver = new MegaPushReceiver({} as never, directory, () => undefined, (state) => states.push(state));
  try {
    await assert.doesNotReject(receiver.start());
    assert.equal(states.at(-1), "degraded");
    assert.equal(registrar.mock.callCount(), 0);
    assert.match(logs.find((line) => line.includes("event=push_registration_degraded"))!, /stage=initialization attempt=1/);
  } finally { await receiver.close(); await rm(directory, { recursive: true, force: true }); }
});

test("throwing state callbacks cannot suppress retries or misclassify success", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const timers = retryTimers(context);
  const logs: string[] = [];
  context.mock.method(process.stderr, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
  let calls = 0;
  const fixture = await receiverFixture(async () => { if (++calls < 3) throw new Error("Rejected"); }, true, true,
    () => { throw new Error("PRIVATE_CALLBACK_MARKER"); });
  try {
    await assert.doesNotReject(fixture.receiver.start());
    assert.equal(timers.size, 1);
    context.mock.timers.tick(15_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal(timers.size, 1);
    context.mock.timers.tick(30_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 3);
    assert.equal(timers.size, 0);
    fixture.transports[0]!.emit("disconnect");
    fixture.transports[0]!.emit("connect");
    await assert.doesNotReject(fixture.receiver.close());
    assert.equal(fixture.states.at(-1), "stopped");
    assert.equal(logs.some((line) => line.includes("PRIVATE_CALLBACK_MARKER")), false);
    assert.equal(logs.filter((line) => line.includes("event=push_registration_degraded")).length, 2);
  } finally { await fixture.cleanup(); }
});

test("throwing success reports never repeat accepted registration", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const timers = retryTimers(context);
  const output = process.stdout.write.bind(process.stdout);
  context.mock.method(process.stdout, "write", ((chunk: unknown) => {
    if (/event=push_token_registered|event=push_receiver_ready/.test(String(chunk))) throw new Error("PRIVATE_LOG_MARKER");
    return output(String(chunk));
  }) as typeof process.stdout.write);
  let calls = 0;
  const fixture = await receiverFixture(async () => { ++calls; }, true, true, (state) => {
    if (state === "connected") throw new Error("PRIVATE_CALLBACK_MARKER");
  });
  try {
    await assert.doesNotReject(fixture.receiver.start());
    assert.equal(calls, 1);
    assert.equal(timers.size, 0);
    assert.equal(fixture.states.includes("degraded"), false);
    context.mock.timers.tick(1_000_000);
    assert.equal(calls, 1);
  } finally { await fixture.cleanup(); }
});

test("throwing failure logger still leaves the full retry chain armed", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const timers = retryTimers(context);
  context.mock.method(process.stderr, "write", (chunk: unknown) => {
    if (String(chunk).includes("event=push_registration_degraded")) throw new Error("PRIVATE_LOG_MARKER");
    return true;
  });
  let calls = 0;
  const fixture = await receiverFixture(async () => { ++calls; throw new Error("Rejected"); });
  try {
    await assert.doesNotReject(fixture.receiver.start());
    for (const delay of [15_000, 30_000, 60_000, 120_000, 300_000]) {
      assert.equal(timers.size, 1);
      context.mock.timers.tick(delay);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(calls, 6);
    assert.equal(timers.size, 0);
  } finally { await fixture.cleanup(); }
});

test("throwing transport close cannot interrupt restart or final shutdown", async () => {
  const fixture = await receiverFixture(async () => undefined);
  try {
    await fixture.receiver.start();
    Object.assign(fixture.transports[0]!, { close() { throw new Error("Private close failure"); } });
    await assert.doesNotReject(fixture.receiver.start());
    Object.assign(fixture.transports[1]!, { close() { throw new Error("Private close failure"); } });
    await assert.doesNotReject(fixture.receiver.close());
    assert.equal(fixture.states.at(-1), "stopped");
  } finally { await fixture.cleanup(); }
});

test("save failure and throwing logger cannot poison later persistence or close", async (context) => {
  const fixture = await receiverFixture(async () => undefined);
  let failed!: () => void;
  const failure = new Promise<void>((resolve) => { failed = resolve; });
  context.mock.method(process.stderr, "write", (chunk: unknown) => {
    if (String(chunk).includes("event=push_state_unavailable")) { failed(); throw new Error("Private save log failure"); }
    return true;
  });
  try {
    await fixture.receiver.start();
    await mkdir(`${fixture.path}.tmp`);
    fixture.transports[0]!.emit("message", { persistentId: "first", payload: { device_sn: "camera" } });
    await failure;
    await rm(`${fixture.path}.tmp`, { recursive: true });
    fixture.transports[0]!.emit("message", { persistentId: "second", payload: { device_sn: "camera" } });
    await assert.doesNotReject(fixture.receiver.close());
    assert.deepEqual(JSON.parse(await readFile(fixture.path, "utf8")).persistentIds, ["first", "second"]);
  } finally { await fixture.cleanup(); }
});

test("receiver construction failure is initialization and retries without private detail", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const directory = await mkdtemp(join(tmpdir(), "eufy-push-create-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({ version: 2, persistentIds: [], credentials: {
    fid: "synthetic", androidId: "123", securityToken: "456", fcmToken: "synthetic", createdAt: 1,
  } }));
  const logs: string[] = [];
  context.mock.method(process.stderr, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
  let calls = 0;
  const receiver = new MegaPushReceiver({} as never, path, () => undefined, undefined, undefined,
    () => { ++calls; throw new Error("PRIVATE_CONSTRUCTION_MARKER"); });
  try {
    await receiver.start();
    context.mock.timers.tick(15_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.ok(logs.every((line) => line.includes("stage=initialization") && !line.includes("PRIVATE_CONSTRUCTION_MARKER")));
  } finally { await receiver.close(); await rm(directory, { recursive: true, force: true }); }
});

test("synchronous transport connect failure is login and retries the same transport", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const directory = await mkdtemp(join(tmpdir(), "eufy-push-connect-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({ version: 2, persistentIds: [], credentials: {
    fid: "synthetic", androidId: "123", securityToken: "456", fcmToken: "synthetic", createdAt: 1,
  } }));
  const logs: string[] = [];
  context.mock.method(process.stderr, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
  let connects = 0;
  const transport = Object.assign(new EventEmitter(), { setPersistentIds() {}, close() {},
    connect() { if (++connects === 1) throw new Error("PRIVATE_CONNECT_MARKER"); transport.emit("connect"); } });
  const states: string[] = [];
  const receiver = new MegaPushReceiver({ registerPushToken: async () => ({ activated: true, code: 0 }) } as never, path,
    () => undefined, (state) => states.push(state), undefined, () => transport as unknown as PushClient);
  try {
    await receiver.start();
    assert.match(logs[0]!, /stage=login attempt=1/);
    context.mock.timers.tick(15_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(connects, 2);
    assert.equal(states.at(-1), "connected");
    assert.equal(logs.some((line) => line.includes("PRIVATE_CONNECT_MARKER")), false);
  } finally { await receiver.close(); await rm(directory, { recursive: true, force: true }); }
});

test("initial login times out safely and retains its transport for recovery", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const logs: string[] = [];
  context.mock.method(process.stderr, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
  let calls = 0;
  const fixture = await receiverFixture(async () => { ++calls; }, false);
  try {
    const starting = fixture.receiver.start();
    await fixture.ready;
    context.mock.timers.tick(20_000);
    await starting;
    assert.equal(fixture.states.at(-1), "degraded");
    assert.match(logs.find((line) => line.includes("event=push_registration_degraded"))!, /stage=login attempt=1/);
    context.mock.timers.tick(15_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
    fixture.transports[0]!.emit("connect");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(fixture.states.at(-1), "connected");
    assert.equal(fixture.transports.length, 1);
  } finally { await fixture.cleanup(); }
});

test("registration warnings contain only fixed fields and an allowlisted code", async (context) => {
  const logs: string[] = [];
  context.mock.method(process.stderr, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
  for (const message of ["Mega push registration failed (-1)", "Security push registration failed (10003)",
    "Security push activation failed (-1)", "private-secret https://private.invalid/token", "Security push activation failed (10000000000)"]) {
    const fixture = await receiverFixture(async () => { throw new Error(message); });
    try { await fixture.receiver.start(); }
    finally { await fixture.cleanup(); }
  }
  const failures = logs.filter((line) => line.includes("event=push_registration_degraded"));
  assert.equal(failures.length, 5);
  assert.match(failures[0]!, /stage=registration code=-1/);
  assert.match(failures[1]!, /stage=registration code=10003/);
  assert.match(failures[2]!, /stage=registration/);
  assert.equal(failures[2]!.includes("code="), false);
  for (const line of failures.slice(3)) {
    assert.match(line, /stage=registration attempt=1/);
    assert.equal(line.includes("code="), false);
    assert.equal(line.includes("private"), false);
    assert.equal(line.includes("synthetic"), false);
  }
});

for (const code of [-1, 10003]) {
  test(`returned activation ${code} recovers without replacing transport`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const timers = retryTimers(context);
    const logs: string[] = [];
    context.mock.method(process.stderr, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
    let calls = 0;
    const f = await receiverFixture(async () => ({ activated: ++calls > 1, code: calls === 1 ? code : 0 }));
    try {
      assert.equal(await f.receiver.start(), undefined);
      assert.equal(f.states.at(-1), "degraded");
      assert.equal(timers.size, 1);
      context.mock.timers.tick(15_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 2);
      assert.equal(f.states.at(-1), "connected");
      assert.equal(timers.size, 0);
      assert.equal(f.transports.length, 1);
      assert.equal(f.transports[0]!.closeCalls, 0);
      assert.match(logs.find((line) => line.includes("push_registration_degraded"))!, new RegExp(`stage=activation code=${code}`));
    } finally { await f.cleanup(); }
    assert.equal(f.transports[0]!.closeCalls, 1);
    assert.equal(timers.size, 0);
  });
}

for (const [label, result, printed] of [
  ["missing", undefined, undefined], ["null result", null, undefined],
  ...[null, 1.5, NaN, Infinity, 1e21, -1000000000, 1000000000, "private"].map((code) => [String(code), { activated: false, code }, undefined]),
  ["negative limit", { activated: false, code: -999999999 }, -999999999],
  ["positive limit", { activated: false, code: 999999999 }, 999999999],
  ["negative zero", { activated: false, code: -0 }, 0],
  ["truthy activation", { activated: 1, code: null }, undefined],
] as const) {
  test(`unconfirmed activation sanitizes ${label}`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const timers = retryTimers(context);
    const logs: string[] = [];
    context.mock.method(process.stderr, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
    context.mock.method(process.stdout, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
    const f = await receiverFixture(async () => undefined);
    context.mock.method(f.client, "registerPushToken", async () => result as never);
    try {
      await f.receiver.start();
      const failures = logs.filter((line) => line.includes("event=push_registration_degraded"));
      assert.equal(failures.length, 1);
      assert.match(failures[0]!, /stage=activation/);
      assert.equal(f.states.at(-1), "degraded");
      assert.equal(timers.size, 1);
      assert.equal(logs.some((line) => /event=push_token_registered|event=push_receiver_ready|event=push_activation_unconfirmed/.test(line)), false);
      if (printed === undefined) assert.equal(failures[0]!.includes("code="), false);
      else assert.ok(failures[0]!.includes(`code=${printed} `));
    } finally { await f.cleanup(); }
    assert.equal(timers.size, 0);
    assert.equal(f.transports[0]!.closeCalls, 1);
  });
}

test("unconfirmed receiver remains degraded across reconnects", async () => {
  const f = await receiverFixture(async () => ({ activated: false, code: -1 }));
  try {
    assert.equal(await f.receiver.start(), undefined);
    f.transports[0]!.emit("disconnect");
    f.transports[0]!.emit("connect");
    await f.receiver.close();
    assert.deepEqual(f.states, ["starting", "degraded", "disconnected", "degraded", "stopped"]);
  } finally { await f.cleanup(); }
});

test("unconfirmed result after disconnect counts once and waits for reconnect", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const timers = retryTimers(context);
  let finish!: (result: { activated: boolean; code: number }) => void;
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => { entered = resolve; });
  const result = new Promise<{ activated: boolean; code: number }>((resolve) => { finish = resolve; });
  let calls = 0;
  const logs: string[] = [];
  context.mock.method(process.stderr, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
  const f = await receiverFixture(async () => { ++calls; entered(); return result; });
  try {
    const starting = f.receiver.start();
    await entering;
    f.transports[0]!.emit("disconnect");
    finish({ activated: false, code: 10003 });
    await starting;
    assert.equal(f.states.at(-1), "disconnected");
    assert.match(logs.find((line) => line.includes("push_registration_degraded"))!, /attempt=1/);
    assert.equal(timers.size, 1);
    context.mock.timers.tick(15_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(timers.size, 0);
    f.transports[0]!.emit("connect");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal(timers.size, 1);
  } finally { await f.cleanup(); }
  assert.equal(timers.size, 0);
});

test("retry login timeout after connect throw retains the same transport", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const timers = retryTimers(context);
  const directory = await mkdtemp(join(tmpdir(), "eufy-push-login-retry-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({ version: 2, persistentIds: [], credentials: {
    fid: "synthetic", androidId: "123", securityToken: "456", fcmToken: "synthetic", createdAt: 1,
  } }));
  const logs: string[] = [];
  context.mock.method(process.stderr, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
  let connects = 0;
  let closes = 0;
  const states: string[] = [];
  const transport = Object.assign(new EventEmitter(), { setPersistentIds() {},
    close() { ++closes; }, connect() { if (++connects === 1) throw new Error("PRIVATE_CONNECT_MARKER"); } });
  const receiver = new MegaPushReceiver({ registerPushToken: async () => ({ activated: true, code: 0 }) } as never,
    path, () => undefined, (state) => states.push(state), undefined, () => transport as unknown as PushClient);
  try {
    await receiver.start();
    context.mock.timers.tick(15_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(connects, 2);
    assert.equal(timers.size, 0);
    context.mock.timers.tick(19_999);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(logs.length, 1);
    context.mock.timers.tick(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(logs.length, 2);
    assert.match(logs[1]!, /stage=login attempt=2/);
    assert.equal(logs.some((line) => line.includes("PRIVATE_CONNECT_MARKER")), false);
    assert.equal(timers.size, 1);
    assert.equal(closes, 0);
  } finally { await receiver.close(); await rm(directory, { recursive: true, force: true }); }
  assert.equal(timers.size, 0);
  assert.equal(closes, 1);
  const frozen = { logs: logs.length, states: [...states] };
  transport.emit("connect");
  context.mock.timers.tick(600_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(logs.length, frozen.logs);
  assert.deepEqual(states, frozen.states);
  assert.equal(timers.size, 0);
});
