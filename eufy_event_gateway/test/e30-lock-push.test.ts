/**
 * Exercises notification-triggered E30 reads without broker or motor access.
 * Fixtures own clocks, status replies and deferred operations. The real push
 * parser and lock registry retain binding, throttling and shutdown boundaries.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { MegaClient } from "../src/mega/client.js";
import test, { type TestContext } from "node:test";
import { E30LockProvider } from "../src/provider/e30-lock-provider.js";
import { MegaPushReceiver, parsePushEvent, type MegaPushEvent } from "../src/mega/push.js";

const serial = "T85F100000000001";
const inventory = () => ({ device_model: "T85F1", device_type: 206, device_sn: serial, parent_sn: serial,
  member: { admin_user_id: "abcdefghijkl", short_user_id: "0001", nick_name: "Tester", member_type: 1 } });

/** Drain owned continuations without creating network timers or advancing the fake clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

/** Use the observed base64 wrapper shape, with deliberately irrelevant notification state. */
function hint(sentAt = Date.now()): MegaPushEvent {
  const event = parsePushEvent({ device_sn: serial, station_sn: serial, type: "206",
    payload: Buffer.from(JSON.stringify({ event_type: 257, device_sn: serial,
      params: [{ param_type: 6000, param_value: "4" }] })).toString("base64") });
  assert.ok(event);
  return { ...event, transportSentAtMilliseconds: sentAt };
}

/** Create an opted-in registry whose only network action is a fake read. */
async function fixture(context: TestContext) {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  let queries = 0, actuations = 0, rawState = 4, allowed = true, fail = false;
  let held = false, finish: (() => void) | undefined;
  const provider = new E30LockProvider({ credentials: async () => ({ host: "security-mqtt-us.anker.com",
    certificate: "unused", privateKey: "unused", userId: "abcdefghijkl", clientId: "unused" }), changed: () => {},
    backgroundReadAllowed: () => allowed,
    session: () => ({ open: async () => {}, query: async () => {
      queries++;
      const observed = rawState;
      if (held) await new Promise<void>(resolve => { finish = resolve; });
      if (fail) throw Error("Synthetic read failure");
      return { rawState: observed, batteryPercent: 75 };
    }, actuate: async () => { actuations++; throw Error("Actuation forbidden"); }, close: () => {} }) });
  context.after(() => provider.close());
  provider.inventory([inventory()], true);
  await settle();
  assert.equal(queries, 1);
  return { provider, queries: () => queries, actuations: () => actuations,
    state: (value: number) => { rawState = value; }, allow: (value: boolean) => { allowed = value; },
    fail: () => { fail = true; }, hold: () => { held = true; }, release: () => { held = false; finish?.(); } };
}

test("E30 status push triggers a fresh read and never publishes payload state", async context => {
  const f = await fixture(context);
  context.mock.timers.tick(11_000);
  f.state(3);
  assert.equal(f.provider.acceptPushHint(hint()), true);
  assert.equal(f.queries(), 1);
  context.mock.timers.tick(1); await settle();
  assert.equal(f.queries(), 2);
  assert.equal(f.provider.list()[0]?.state, "unlocked");
  assert.equal(f.actuations(), 0);
});

test("E30 duplicate and burst hints share the existing read throttle", async context => {
  const f = await fixture(context);
  context.mock.timers.tick(1_000);
  const first = hint();
  assert.equal(f.provider.acceptPushHint(first), true);
  assert.equal(f.provider.acceptPushHint(first), false);
  context.mock.timers.tick(2_000);
  assert.equal(f.provider.acceptPushHint(hint()), true);
  assert.equal(f.provider.acceptPushHint(first), false);
  context.mock.timers.tick(6_999); await settle();
  assert.equal(f.queries(), 1);
  f.state(3);
  context.mock.timers.tick(1); await settle();
  assert.equal(f.queries(), 2);
  assert.equal(f.provider.list()[0]?.state, "unlocked");
});

test("E30 rejects foreign, unsupported, stale and untrusted-clock hints", async context => {
  const f = await fixture(context);
  const event = hint();
  for (const patch of [{ cameraSerial: "foreign" }, { stationSerial: "foreign" }, { eventType: 1 },
    { eventType: null }, { transportSentAtMilliseconds: null },
    { transportSentAtMilliseconds: Date.now() - 60_001 }, { transportSentAtMilliseconds: Date.now() + 5_001 },
    { transportSentAtMilliseconds: Date.now() + 0.5 }]) {
    assert.equal(f.provider.acceptPushHint({ ...event, ...patch }), false);
  }
  const { transportSentAtMilliseconds: _clock, ...withoutClock } = event;
  assert.equal(f.provider.acceptPushHint(withoutClock), false);
  context.mock.timers.tick(20_000); await settle();
  assert.equal(f.queries(), 1);
});

test("E30 changed or removed bindings retire pending hints", async context => {
  const f = await fixture(context);
  assert.equal(f.provider.acceptPushHint(hint()), true);
  f.provider.inventory([{ ...inventory(), parent_sn: "foreign" }]);
  context.mock.timers.tick(20_000); await settle();
  assert.equal(f.queries(), 1);
  assert.equal(f.provider.list().length, 0);
});

test("E30 inventory failure and close cannot dispatch queued reads", async context => {
  const f = await fixture(context);
  f.provider.acceptPushHint(hint());
  f.provider.inventory([]);
  context.mock.timers.tick(20_000); await settle();
  assert.equal(f.queries(), 1);
  f.provider.inventory([inventory()]); await settle();
  f.provider.acceptPushHint(hint());
  f.provider.close();
  context.mock.timers.tick(20_000); await settle();
  assert.equal(f.queries(), 1);
});

test("E30 preparation reservations defer a hint but cannot keep it alive forever", async context => {
  const f = await fixture(context);
  context.mock.timers.tick(11_000); f.allow(false);
  f.provider.acceptPushHint(hint());
  context.mock.timers.tick(2_000); await settle();
  assert.equal(f.queries(), 1);
  f.allow(true); context.mock.timers.tick(1_000); await settle();
  assert.equal(f.queries(), 2);
  f.allow(false); context.mock.timers.tick(11_000);
  f.provider.acceptPushHint(hint());
  context.mock.timers.tick(61_001); await settle();
  f.allow(true); context.mock.timers.tick(1_000); await settle();
  assert.equal(f.queries(), 2);
});

test("E30 hints arriving during a status query retain one trailing read", async context => {
  const f = await fixture(context);
  context.mock.timers.tick(11_000); f.state(3); f.hold();
  const manual = f.provider.refresh(serial);
  await settle(); assert.equal(f.queries(), 2);
  context.mock.timers.tick(1_000);
  f.provider.acceptPushHint(hint());
  context.mock.timers.tick(1_000); await settle();
  assert.equal(f.queries(), 2);
  f.state(4); f.release(); await manual;
  context.mock.timers.tick(8_000); await settle();
  assert.equal(f.queries(), 3);
  assert.equal(f.provider.list()[0]?.state, "locked");
  assert.equal(f.actuations(), 0);
});

test("E30 failed hint reads do not retry without a new notification", async context => {
  const f = await fixture(context);
  context.mock.timers.tick(11_000); f.fail();
  f.provider.acceptPushHint(hint());
  context.mock.timers.tick(1); await settle();
  assert.equal(f.queries(), 2);
  assert.equal(f.provider.list()[0]?.available, false);
  context.mock.timers.tick(70_000); await settle();
  assert.equal(f.queries(), 2);
  assert.equal(f.actuations(), 0);
});

for (const enabled of [true, false]) test(`provider forwards lock hints only to its enabled adapter: ${enabled}`, async context => {
  const directory = await mkdtemp(join(tmpdir(), "lock-push-routing-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [inventory()] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
  context.mock.method(E30LockProvider.prototype, "inventory", () => {});
  const accepted = context.mock.method(E30LockProvider.prototype, "acceptPushHint", () => true);
  let deliver!: (event: MegaPushEvent) => void;
  context.mock.method(MegaPushReceiver.prototype, "start", async function(this: MegaPushReceiver) {
    deliver = Reflect.get(this, "onEvent") as typeof deliver;
  });
  const events = new Proxy({}, { get: () => () => undefined }) as ProviderEvents;
  const provider = new EufyProvider({ username: "fixture", password: "fixture", country: "AU",
    persistentDirectory: directory, maxStreamSeconds: 120, apiAuthenticationConfigured: true,
    experimentalE30Locks: enabled });
  try {
    await provider.start(events); await settle();
    const event = hint();
    deliver(event); await settle();
    assert.equal(accepted.mock.callCount(), enabled ? 1 : 0);
    if (enabled) assert.equal(accepted.mock.calls[0]?.arguments[0], event);
    assert.equal(network.mock.callCount(), 0);
  } finally { await provider.close(); }
});

for (const eventType of [257, 258, 259, 260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271]) {
  test(`E30 official lock or unlock method ${eventType} triggers only an independent query`, async context => {
    const f = await fixture(context);
    context.mock.timers.tick(11_000);
    f.state(3);
    assert.equal(f.provider.acceptPushHint({ ...hint(), eventType }), true);
    context.mock.timers.tick(1); await settle();
    assert.equal(f.queries(), 2);
    assert.equal(f.provider.list()[0]?.state, "unlocked");
    assert.equal(f.actuations(), 0);
  });
}

test("E30 alarm and battery notifications do not schedule state reads", async context => {
  const f = await fixture(context);
  for (const eventType of [256, 272, 513, 514, 515, 516, 517, 518, 519, 520, 521, 522, 534, 535]) {
    assert.equal(f.provider.acceptPushHint({ ...hint(), eventType }), false);
  }
  context.mock.timers.tick(20_000); await settle();
  assert.equal(f.queries(), 1);
});
