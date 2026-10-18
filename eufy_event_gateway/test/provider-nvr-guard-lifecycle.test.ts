/**
 * Exercises station reservation ownership and capacity through public provider
 * operations. Synthetic inventory, clocks and transport methods own every side
 * effect. No account, socket, camera or alarm is contacted.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import type { NvrGuardEffective } from "../src/provider/nvr-guard-schedule.js";
import { NvrGuardError } from "../src/provider/nvr-guard-trial.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { NvrRtcSession } from "../src/stream/nvr-rtc-session.js";

async function fixture(context: TestContext, count: number) {
  const directory = await mkdtemp(join(tmpdir(), "nvr-guard-lifecycle-"));
  let clock = 0, selected = 0, failRestore = false, writes = 0;
  const configured = Array<number>(count).fill(2), restored = Array<boolean>(count).fill(false);
  const schedule = Buffer.from(JSON.stringify({ schedules: Array.from({ length: 7 }, (_, week) => ({
    week, start_h: 0, start_m: 0, end_h: 23, end_m: 59, mode_id: 0,
  })) })).toString("base64");
  context.mock.method(Date, "now", () => Date.UTC(2026, 9, 18, 12) + clock);
  context.mock.method(performance, "now", () => clock);
  context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.method(MegaClient.prototype, "isAuthenticatedUser", () => true);
  const auth = Object.getOwnPropertyDescriptor(MegaClient.prototype, "isAuthenticated")!;
  Object.defineProperty(MegaClient.prototype, "isAuthenticated", { configurable: true, get: () => true });
  context.after(() => { Object.defineProperty(MegaClient.prototype, "isAuthenticated", auth); });
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: Array.from({ length: count }, (_, i) => [
    { device_sn: `synthetic-station-${i}`, device_model: "T8N00", device_type: 300, category: "eufy_security",
      member: { admin_user_id: "synthetic-owner" }, params: [
        { param_type: 1224, param_value: configured[i] }, { param_type: 1254, param_value: schedule },
      ] },
    { device_sn: `synthetic-camera-${i}`, device_model: "T8E00", device_type: 301, device_channel: 3,
      parent_sn: `synthetic-station-${i}`, category: "eufy_security", member: { admin_user_id: "synthetic-owner" } },
  ]).flat() }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
  context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => ({ host: "security-smart-ie.eufylife.com",
    region: "IE", authToken: "synthetic", gtoken: "synthetic", sign: "synthetic" }));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
  context.mock.method(NvrRtcSession.prototype, "prepareGuardTrial", async () => undefined);
  context.mock.method(NvrRtcSession.prototype, "validateGuardTrial", async () => undefined);
  context.mock.method(NvrRtcSession.prototype, "confirmGuardEffectiveTrial", async (expected: NvrGuardEffective) => {
    if (failRestore && restored[selected] && expected === 0) throw new NvrGuardError("identity");
  });
  context.mock.method(NvrRtcSession.prototype, "writeGuardTrial", async (mode: 1 | 2, signal: AbortSignal, dispatch: () => void) => {
    signal.throwIfAborted(); dispatch(); writes++; configured[selected] = mode; restored[selected] = mode === 2;
  });
  context.mock.method(NvrRtcSession.prototype, "close", async () => undefined);
  const create = (): EufyProvider => new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU",
    persistentDirectory: directory, maxStreamSeconds: 120, experimentalNvrControls: true,
    experimentalModelControls: true, experimentalNvrLive: true, normalNvrLive: true });
  const events = new Proxy({}, { get: () => () => undefined }) as ProviderEvents;
  const provider = create();
  await provider.start(events);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pump = async <T>(operation: Promise<T>): Promise<T> => {
    let settled = false;
    void operation.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 100 && !settled; i++) {
      await new Promise(resolve => setImmediate(resolve));
      clock += 2_000; context.mock.timers.tick(2_000);
    }
    assert.equal(settled, true);
    return operation;
  };
  context.after(async () => { await provider.close(); context.mock.timers.reset(); await rm(directory, { recursive: true, force: true }); });
  return { provider, create, events, pump, choose: (i: number) => { selected = i; }, fail: () => { failRestore = true; },
    recover: () => { failRestore = false; }, writes: () => writes,
    advance: (milliseconds: number) => { clock += milliseconds; context.mock.timers.tick(milliseconds); } };
}

test("stale release cannot clear a later guard reservation, and cooldown expires", async context => {
  const value = await fixture(context, 1);
  const oldRelease = value.provider.reserveNvrLiveTrial("synthetic-camera-0", new AbortController().signal);
  await oldRelease();
  const operation = value.provider.testNvrGuardMode("synthetic-camera-0", { target: "home", timeZone: "UTC" }, new AbortController().signal);
  await oldRelease();
  assert.throws(() => value.provider.reserveNvrLiveTrial("synthetic-camera-0", new AbortController().signal));
  await value.pump(operation);
  assert.throws(() => value.provider.reserveNvrLiveTrial("synthetic-camera-0", new AbortController().signal));
  value.advance(61_000);
  const release = value.provider.reserveNvrLiveTrial("synthetic-camera-0", new AbortController().signal);
  await release();
});

test("manual-recovery capacity fails closed and a new provider clears its latch", async context => {
  const value = await fixture(context, 101);
  value.fail();
  let rejected = -1;
  for (let i = 0; i < 101; i++) {
    value.choose(i);
    try { await value.pump(value.provider.testNvrGuardMode(`synthetic-camera-${i}`, { target: "home", timeZone: "UTC" }, new AbortController().signal)); }
    catch (error) {
      assert.ok(error instanceof NvrGuardError);
      if (error.stage === "busy") { rejected = i; break; }
      assert.equal(error.manualRestoreRequired, true);
    }
  }
  assert.ok(rejected > 0 && rejected <= 100);
  const writes = value.writes();
  value.choose(0); value.advance(61_000);
  await assert.rejects(value.provider.testNvrGuardMode("synthetic-camera-0", { target: "home", timeZone: "UTC" }, new AbortController().signal),
    error => error instanceof NvrGuardError && error.stage === "busy");
  assert.equal(value.writes(), writes);
  await value.provider.close();
  value.recover();
  const fresh = value.create();
  try {
    await fresh.start(value.events);
    await value.pump(fresh.testNvrGuardMode("synthetic-camera-0", { target: "home", timeZone: "UTC" }, new AbortController().signal));
    assert.equal(value.writes(), writes + 2);
  } finally { await fresh.close(); }
});
