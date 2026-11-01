/**
 * Checks observer admission and retirement through the real provider boundary.
 * Fixtures replace account, inventory and native transport effects. No network
 * request or security write is allowed, and hardware behaviour remains unproven.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { NvrRtcSession, type NvrRtcOptions, type NvrSignallingContext } from "../src/stream/nvr-rtc-session.js";
import { NvrTrialError } from "../src/stream/nvr-protocol.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** Own fake cloud rows and output lifetimes, and expose only public provider operations. */
async function fixture(context: TestContext, enabled = true, authentication = true, variant = "normal") {
  const directory = await mkdtemp(join(tmpdir(), "nvr-mode-provider-"));
  const guard = { param_type: 1224, param_value: "2" };
  const raw = { devices: [
    { device_sn: "synthetic-station", device_model: "T8N00", device_type: 300, category: "eufy_security", member: { admin_user_id: "synthetic-owner" }, params: [guard] },
    { device_sn: "synthetic-camera", device_model: "T8E00", device_type: 301, category: "eufy_security", parent_sn: "synthetic-station", device_channel: 3, member: { admin_user_id: "synthetic-owner" }, params: [] as (typeof guard)[] },
  ] };
  if (variant === "wrong-station") raw.devices[0]!.device_model = "T9000";
  if (variant === "wrong-type") raw.devices[1]!.device_type = 302;
  if (variant === "owner") raw.devices[1]!.member.admin_user_id = "other-owner";
  if (variant === "channel") raw.devices.push({ ...raw.devices[1]!, device_sn: "other-camera" });
  if (variant === "ambiguous") raw.devices.push({ ...raw.devices[0]!, device_sn: "other-station" },
    { ...raw.devices[1]!, device_sn: "other-camera", parent_sn: "other-station" });
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  let connections = 0;
  context.mock.method(MegaClient.prototype, "connect", async () => { connections++; return { state: "authenticated" }; });
  context.mock.getter(MegaClient.prototype, "isAuthenticated", () => true);
  context.mock.method(MegaClient.prototype, "inventory", async () => raw);
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
  const intervals: (() => void)[] = [];
  context.mock.method(globalThis, "setInterval", (callback: () => void) => {
    intervals.push(callback); return { unref() {} } as NodeJS.Timeout;
  });
  let now = 0;
  context.mock.method(performance, "now", () => now);
  let signs = 0, video = 0, writes = 0;
  let finishContext: ((context: NvrSignallingContext) => void) | undefined;
  const contextValue: NvrSignallingContext = { host: "security-smart-ie.eufylife.com", region: "IE", authToken: "synthetic", gtoken: "synthetic", sign: "synthetic" };
  context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => {
    signs++;
    if (variant === "pending-context") return await new Promise<NvrSignallingContext>(resolve => { finishContext = resolve; });
    return contextValue;
  });
  const sessions: NvrRtcSession[] = [], viewers: NvrRtcSession[] = [];
  context.mock.method(NvrRtcSession.prototype, "observeEffectiveMode", async function(this: NvrRtcSession) { sessions.push(this); });
  context.mock.method(NvrRtcSession.prototype, "start", async function(this: NvrRtcSession) { video++; viewers.push(this); });
  context.mock.method(NvrRtcSession.prototype, "writeGuardTrial", async () => { writes++; });
  context.mock.method(NvrRtcSession.prototype, "writePowerTrial", async () => { writes++; });
  context.mock.method(NvrRtcSession.prototype, "close", async function(this: NvrRtcSession) {
    const options = Reflect.get(this, "options") as NvrRtcOptions;
    options.onEffectiveMode?.(null); this.output.end();
  });
  const stations: Parameters<ProviderEvents["station"]>[0][] = [];
  const events = new Proxy({ station: (value: Parameters<ProviderEvents["station"]>[0]) => stations.push(value) },
    { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "fixture", password: "synthetic", country: "AU", persistentDirectory: directory,
    maxStreamSeconds: 120, experimentalNvrModeObserver: enabled, apiAuthenticationConfigured: authentication,
    normalNvrLive: variant !== "observer-only", experimentalNvrLive: variant !== "observer-only",
    experimentalModelControls: variant !== "observer-only", experimentalNvrControls: variant !== "observer-only" });
  await provider.start(events); await tick();
  context.after(async () => { await provider.close(); await rm(directory, { recursive: true, force: true }); assert.equal(network.mock.callCount(), 0); });
  return { provider, events, raw, sessions, viewers, stations,
    setGuardMode: (value: string) => { guard.param_value = value; }, signs: () => signs, video: () => video, writes: () => writes, connections: () => connections,
    finishContext: () => finishContext?.(contextValue),
    clock: (value: number) => { now = value; }, refresh: async () => { intervals.at(-1)!(); await tick(); await tick(); } };
}

for (const variant of ["disabled", "api", "wrong-station", "wrong-type", "owner", "channel", "ambiguous"]) {
  test(`observer refuses ${variant} before requesting credentials`, async context => {
    const f = await fixture(context, variant !== "disabled", variant !== "api", variant);
    assert.equal(f.signs(), 0); assert.equal(f.sessions.length, 0); assert.equal(f.writes(), 0);
  });
}

test("the opted-in watcher receives without a viewer and coexists with an explicit live view", async context => {
  const f = await fixture(context);
  assert.equal(f.sessions.length, 1); assert.equal(f.video(), 0);
  const options = Reflect.get(f.sessions[0]!, "options") as NvrRtcOptions;
  assert.equal(options.modeObserver, true); assert.equal(options.maximumLifetimeMilliseconds, null);
  assert.equal(options.liveControls, undefined);
  options.onEffectiveMode!({ mode: 3 });
  assert.equal(f.stations.at(-1)!.effectiveMode, 3); assert.equal(f.stations.at(-1)!.effectiveModeSource, "nvr_rtc");
  await f.refresh(); assert.equal(f.sessions.length, 1);
  await f.provider.startStream("synthetic-camera"); await tick();
  assert.equal(f.video(), 1); assert.equal(f.sessions.length, 1);
  await f.provider.stopStream("synthetic-camera");
  assert.equal(f.stations.at(-1)!.effectiveMode, 3);
  await assert.rejects(f.provider.testNvrCameraPower("synthetic-camera", { originalPower: "on", target: "off" }, new AbortController().signal), { stage: "busy" });
  await assert.rejects(f.provider.testNvrGuardMode("synthetic-camera", { target: "home", timeZone: "Europe/London" }, new AbortController().signal), { stage: "busy" });
  assert.equal(f.writes(), 0);
  await f.provider.close();
  assert.equal(f.stations.at(-1)!.effectiveMode, null);
  options.onEffectiveMode!({ mode: 1 }); assert.equal(f.stations.at(-1)!.effectiveMode, null);
});

test("a connected RTC reading survives a configured-mode refresh and clears when its source retires", async context => {
  const f = await fixture(context);
  const options = Reflect.get(f.sessions[0]!, "options") as NvrRtcOptions;
  options.onEffectiveMode!({ mode: 3 });

  // The app moved the configured mode without changing the effective one, so no broadcast came.
  f.setGuardMode("3"); await f.refresh();
  assert.equal(f.stations.at(-1)!.guardMode, 3); assert.equal(f.stations.at(-1)!.effectiveMode, 3);
  assert.equal(f.stations.at(-1)!.effectiveModeSource, "nvr_rtc");
  f.sessions[0]!.output.destroy(new NvrTrialError("cancelled")); await tick();
  assert.equal(f.stations.at(-1)!.effectiveMode, null);
  f.setGuardMode("2"); await f.refresh();
  assert.equal(f.stations.at(-1)!.guardMode, 2); assert.equal(f.stations.at(-1)!.effectiveMode, null);
});

for (const first of ["observer", "viewer"] as const) {
  test(`a live view and the observer share a reading the ${first} reported first`, async context => {
    const f = await fixture(context);
    await f.provider.startStream("synthetic-camera"); await tick();
    const observer = Reflect.get(f.sessions[0]!, "options") as NvrRtcOptions;
    const viewer = Reflect.get(f.viewers[0]!, "options") as NvrRtcOptions;
    const [owner, joiner] = first === "observer" ? [observer, viewer] : [viewer, observer];
    owner.onEffectiveMode!({ mode: 3 });
    const published = f.stations.length;
    joiner.onEffectiveMode!({ mode: 3 });
    assert.equal(f.stations.length, published);
    owner.onEffectiveMode!(null);
    assert.equal(f.stations.at(-1)!.effectiveMode, 3);
    joiner.onEffectiveMode!(null);
    assert.equal(f.stations.at(-1)!.effectiveMode, null);
    await f.provider.stopStream("synthetic-camera");
  });
}

test("a new mode from one source replaces the shared reading", async context => {
  const f = await fixture(context);
  await f.provider.startStream("synthetic-camera"); await tick();
  const observer = Reflect.get(f.sessions[0]!, "options") as NvrRtcOptions;
  const viewer = Reflect.get(f.viewers[0]!, "options") as NvrRtcOptions;
  observer.onEffectiveMode!({ mode: 3 }); viewer.onEffectiveMode!({ mode: 3 });
  viewer.onEffectiveMode!({ mode: 1 });
  assert.equal(f.stations.at(-1)!.effectiveMode, 1);
  viewer.onEffectiveMode!(null);
  assert.equal(f.stations.at(-1)!.effectiveMode, null);
  observer.onEffectiveMode!({ mode: 1 });
  await f.provider.stopStream("synthetic-camera");
  assert.equal(f.stations.at(-1)!.effectiveMode, 1);
});

test("watching modes does not require enabling video or model controls", async context => {
  const f = await fixture(context, true, true, "observer-only");
  assert.equal(f.sessions.length, 1); assert.equal(f.video(), 0); assert.equal(f.writes(), 0);
});

test("provider shutdown cannot resume a late credential response", async context => {
  const f = await fixture(context, true, true, "pending-context");
  assert.equal(f.signs(), 1); assert.equal(f.sessions.length, 0);
  await f.provider.close(); f.finishContext(); await tick();
  assert.equal(f.sessions.length, 0); assert.equal(f.video(), 0); assert.equal(f.writes(), 0);
});

test("shutdown during watcher retirement cannot revive provider startup", async context => {
  const f = await fixture(context);
  const restarting = f.provider.start(f.events);
  await f.provider.close(); await restarting;
  assert.equal(f.connections(), 1); assert.equal(f.signs(), 1); assert.equal(f.sessions.length, 1);
});

test("removed or stale inventory cannot preserve a watcher-owned mode", async context => {
  const f = await fixture(context);
  const options = Reflect.get(f.sessions[0]!, "options") as NvrRtcOptions;
  options.onEffectiveMode!({ mode: 3 });
  f.clock(180_001); assert.equal(options.current(), false);
  f.sessions[0]!.output.destroy(new NvrTrialError("cancelled")); await tick();
  assert.equal(f.stations.at(-1)!.effectiveMode, null);
  await f.refresh(); assert.equal(f.sessions.length, 2);
  const replacement = Reflect.get(f.sessions[1]!, "options") as NvrRtcOptions;
  replacement.onEffectiveMode!({ mode: 1 });
  f.raw.devices.length = 0; await f.refresh();
  assert.equal(f.stations.at(-1)!.effectiveMode, null);
});


test("uncertain observer cleanup keeps manual security trials blocked after shutdown", async context => {
  const f = await fixture(context);
  context.mock.method(NvrRtcSession.prototype, "close", async () => { throw new Error("PRIVATE_CLEANUP_FAILURE"); });
  await f.provider.close();
  await assert.rejects(f.provider.testNvrCameraPower("synthetic-camera", { originalPower: "on", target: "off" }, new AbortController().signal), { stage: "busy" });
  await assert.rejects(f.provider.testNvrGuardMode("synthetic-camera", { target: "home", timeZone: "Europe/London" }, new AbortController().signal), { stage: "busy" });
  assert.equal(f.writes(), 0);
});
