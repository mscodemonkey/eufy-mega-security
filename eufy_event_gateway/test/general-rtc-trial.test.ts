/**
 * Exercises raw camera proof, PIN limits and preparation using offline client
 * and session owners. Fixtures retain no real account values, publish no state
 * and verify parent reservations survive transport retirement until recheck.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import type { MegaClient } from "../src/mega/client.js";
import type { MegaInventory } from "../src/mega/types.js";
import { parseMegaInventory } from "../src/provider/eufy-provider.js";
import { GeneralRtcPinLimiter, GeneralRtcTrial, generalRtcBinding } from "../src/provider/general-rtc-trial.js";
import { GeneralRtcError } from "../src/stream/general-rtc-protocol.js";
import type { GeneralRtcSession } from "../src/stream/general-rtc-session.js";

/** Fresh synthetic native rows retain separate child ownership and channel proof. */
function inventory(): MegaInventory {
  return { groups: [], devices: [
    { device_sn: "synthetic-parent", device_model: "T8030", device_type: 18, category: "eufy_security", member: { admin_user_id: "synthetic-owner" } },
    { device_sn: "synthetic-child", device_model: "T8171", device_type: 88, category: "eufy_security", parent_sn: "synthetic-parent",
      device_channel: 3, member: { admin_user_id: "synthetic-owner" } },
  ] };
}

/** Build one lease whose clients and media owners are entirely fixture-owned. */
function fixture(context: TestContext, mode = "valid") {
  let raw = inventory(), now = 0, current = true, released = 0, retired = 0, dispatched = 0, closed = 0, sessionCount = 0;
  const calls: string[] = [], controller = new AbortController(), output = new PassThrough(); output.on("error", () => undefined);
  const limiter = new GeneralRtcPinLimiter(() => now);
  const account = { userId: "synthetic-owner", securityHost: "security-app-ie.eufylife.com", smartHost: "security-smart-ie.eufylife.com",
    country: "AU", token: "synthetic-token", cipher: { bindingKey: "synthetic-binding", encrypt: (s: string) => s, decrypt: (s: string) => s } };
  const client = {
    generalRtcAccount: () => ({ ...account, cipher: { ...account.cipher } }),
    generalRtcInventory: async () => { calls.push("inventory"); if (mode === "paged") now += 2000; return raw; },
    generalRtcHubs: async (page: number) => {
      calls.push(`hub${page}`);
      if (mode === "paged") now += 1000;
      if (mode === "full-pages" || mode === "paged" && page < 4) return Array.from({ length: 100 }, (_, index) => ({ station_sn: `synthetic-${page}-${index}` }));
      return [{ station_sn: "synthetic-parent", is_support_web_rtc_stream: mode === "no-rtc" ? false : true }];
    },
    generalRtcParams: async () => {
      calls.push("params");
      if (mode === "slow-pre-pin") now = 30_001;
      if (mode === "preflight") return [{ param_value: JSON.stringify({ need_start_pn: ["synthetic"] }) }];
      if (mode === "bad-preflight") return [{ param_value: JSON.stringify({ need_start_pn: 1 }) }];
      return [];
    },
    generalRtcVerifyPin: async (_pin: string, signal: AbortSignal, onDispatch: () => void) => {
      calls.push("pin");
      if (mode === "pre-dispatch") throw new GeneralRtcError("pin", "native_identity_missing");
      onDispatch(); dispatched++;
      if (mode === "pin-rejected") throw new GeneralRtcError("pin", "response");
      if (mode === "pin-cancelled") { controller.abort(); signal.throwIfAborted(); }
    },
    generalRtcSign: async () => { calls.push("sign"); return "synthetic-sign"; },
  } as unknown as MegaClient;
  const initial = generalRtcBinding(raw, "synthetic-child", account.userId, parseMegaInventory);
  const lease = new GeneralRtcTrial({ client, initial, limiter, signal: controller.signal, current: () => current,
    normalize: parseMegaInventory, now: () => now, releaseReservation: () => { released++; }, retired: () => { retired++; },
    createSession: options => {
      calls.push("socket"); sessionCount++;
      assert.equal(calls.at(-2), "sign"); assert.equal(options.parent, "synthetic-parent"); assert.equal(options.child, "synthetic-child");
      return { start: async () => { options.ready(output); }, close: async () => { closed++; output.end(); } } as unknown as GeneralRtcSession;
    } });
  context.after(() => lease.release().catch(() => undefined));
  return { lease, limiter, calls, controller, account, setInventory: (value: MegaInventory) => { raw = value; },
    invalidate: () => { current = false; }, advance: (milliseconds: number) => { now += milliseconds; },
    elapsed: () => now,
    counts: () => ({ released, retired, dispatched, closed, sessionCount }) };
}

test("raw ownership and duplicate topology are never repaired by normalized inheritance", () => {
  const raw = inventory();
  for (const changed of [
    { ...raw, devices: [...raw.devices, raw.devices[1]!] },
    { ...raw, devices: [...raw.devices, raw.devices[0]!] },
    { ...raw, devices: [raw.devices[0]!, { ...raw.devices[1]!, member: {} }] },
    { ...raw, devices: [raw.devices[0]!, { ...raw.devices[1]!, member: { admin_user_id: "guest" } }] },
    { ...raw, devices: [...raw.devices, { ...raw.devices[1]!, device_sn: "synthetic-other" }] },
    { ...raw, devices: [raw.devices[0]!, { ...raw.devices[1]!, device_channel: 255 }] },
    { ...raw, devices: [raw.devices[0]!, { ...raw.devices[1]!, channel: 2 }] },
  ]) assert.throws(() => generalRtcBinding(changed, "synthetic-child", "synthetic-owner", parseMegaInventory), GeneralRtcError);
  const standalone: MegaInventory = { groups: [], devices: [{ ...raw.devices[1]!, parent_sn: "", device_channel: 0 }] };
  assert.equal(generalRtcBinding(standalone, "synthetic-child", "synthetic-owner", parseMegaInventory).child.channel, 0);
  assert.throws(() => generalRtcBinding({ ...standalone, devices: [...standalone.devices,
    { ...raw.devices[1]!, device_sn: "synthetic-other", parent_sn: "synthetic-child", device_channel: 1 }] }, "synthetic-child", "synthetic-owner", parseMegaInventory), GeneralRtcError);
});

for (const [mode, stage] of [["no-rtc", "inventory"], ["full-pages", "inventory"], ["preflight", "preflight_required"],
  ["bad-preflight", "preflight"], ["slow-pre-pin", "budget"]]) {
  test(`pre-PIN refusal ${mode} causes no dispatch, cooldown or socket`, async context => {
    const f = fixture(context, mode);
    await assert.rejects(f.lease.prepare("1234"), (error: unknown) => error instanceof GeneralRtcError && error.stage === stage);
    assert.equal(f.counts().dispatched, 0); assert.equal(f.counts().sessionCount, 0);
    assert.doesNotThrow(() => f.limiter.check("synthetic-owner"));
    if (mode === "full-pages") assert.equal(f.calls.filter(value => value.startsWith("hub")).length, 5);
  });
}

for (const mode of ["pre-dispatch", "pin-rejected", "pin-cancelled"]) test(`PIN accounting distinguishes ${mode}`, async context => {
  const f = fixture(context, mode);
  await assert.rejects(f.lease.prepare("1234"), GeneralRtcError);
  assert.equal(f.counts().dispatched, mode === "pre-dispatch" ? 0 : 1);
  if (mode === "pre-dispatch") assert.doesNotThrow(() => f.limiter.check("synthetic-owner"));
  else assert.throws(() => f.limiter.check("synthetic-owner"), (error: unknown) => error instanceof GeneralRtcError && error.stage === "cooldown");
  assert.equal(f.calls.includes("sign"), false); assert.equal(f.counts().sessionCount, 0);
});

test("PIN limiter keeps cooldown after success, resets consecutive failures and locks on the third rejection", () => {
  let now = 0; const limiter = new GeneralRtcPinLimiter(() => now);
  limiter.dispatch("owner"); limiter.reject("owner");
  assert.throws(() => limiter.check("owner")); now += 60_000;
  limiter.dispatch("owner"); limiter.confirm("owner");
  assert.throws(() => limiter.check("owner"));
  for (let i = 0; i < 3; i++) { now += 60_000; limiter.dispatch("owner"); limiter.reject("owner"); }
  now += 60_000; assert.throws(() => limiter.check("owner"), (error: unknown) => error instanceof GeneralRtcError && error.stage === "locked");
});

test("eight locked identities are never evicted for a ninth user", () => {
  let now = 0; const limiter = new GeneralRtcPinLimiter(() => now);
  for (let user = 0; user < 8; user++) for (let i = 0; i < 3; i++) {
    now += 60_000; limiter.dispatch(`owner${user}`); limiter.reject(`owner${user}`);
  }
  assert.throws(() => limiter.check("ninth"));
  for (let user = 0; user < 8; user++) assert.throws(() => limiter.check(`owner${user}`), (error: unknown) => error instanceof GeneralRtcError && error.stage === "locked");
});

test("media stop preserves reservation through fresh recheck and exact release is idempotent", async context => {
  const f = fixture(context); const prepared = await f.lease.prepare("1234");
  assert.deepEqual(f.calls, ["inventory", "hub0", "params", "pin", "sign", "socket"]);
  let attached = 0; await f.lease.start(() => { attached++; }); assert.equal(attached, 1);
  await assert.rejects(f.lease.start(() => {}), GeneralRtcError);
  await prepared.stop(); assert.equal(f.counts().released, 0);
  await prepared.verify(); assert.deepEqual(f.calls.slice(-2), ["inventory", "hub0"]);
  assert.equal(f.counts().released, 0);
  const first = f.lease.release(); assert.equal(f.lease.release(), first); await first;
  assert.equal(f.counts().released, 1); assert.equal(f.counts().retired, 1);
});

test("changed fresh ownership discards the result and never sends another PIN", async context => {
  const f = fixture(context); const prepared = await f.lease.prepare("1234");
  const raw = inventory(); f.setInventory({ ...raw, devices: [raw.devices[0]!, { ...raw.devices[1]!, device_channel: 4 }] });
  await assert.rejects(prepared.verify(), (error: unknown) => error instanceof GeneralRtcError && error.stage === "binding");
  assert.equal(f.counts().dispatched, 1);
});

test("account or cached binding changes stop subsequent trial stages", async context => {
  const f = fixture(context); f.invalidate();
  await assert.rejects(f.lease.prepare("1234"), GeneralRtcError);
  assert.deepEqual(f.calls, []);
  const second = fixture(context); second.account.token = "changed-token";
  await assert.rejects(second.lease.prepare("1234"), GeneralRtcError); assert.deepEqual(second.calls, []);
});

test("the maximum seven-request final recheck remains within its thirty-second stage with request spacing", async context => {
  const f = fixture(context, "paged"), prepared = await f.lease.prepare("1234");
  await prepared.stop(); const start = f.elapsed(), before = f.calls.length;
  await prepared.verify();
  assert.deepEqual(f.calls.slice(before), ["inventory", "hub0", "hub1", "hub2", "hub3", "hub4"]);
  assert.equal(f.elapsed() - start, 7000);
  assert.equal(f.counts().dispatched, 1); assert.equal(f.counts().released, 0);
});
