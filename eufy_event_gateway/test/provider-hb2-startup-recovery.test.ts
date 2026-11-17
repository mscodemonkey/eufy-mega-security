/**
 * Qualifies the provider's default-off HB2 no-frame recovery with synthetic peers.
 * Fixtures own cloud responses, clocks and transport teardown. No real camera,
 * account or audio setting is read or changed by these ownership regressions.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider, supportsExperimentalHb2StartupRecovery } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";

/** Let ownership promises settle without advancing fake camera time. */
async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
}

/** Own one provider, two child routes and independently controllable teardown. */
async function fixture(context: TestContext, enabled = true, model = "T8140-Z") {
  const directory = await mkdtemp(join(tmpdir(), "hb2-startup-"));
  context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.getter(MegaClient.prototype, "isAuthenticated", () => true);
  context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (owner: string) => owner === "owner");
  const rows = [{ device_sn: "base", device_model: "T8010", device_type: 0, category: "eufy_security",
    member: { admin_user_id: "owner" }, p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic" },
  ...["camera", "sibling"].map((serial, channel) => ({ device_sn: serial, device_model: model,
    device_type: model === "T8210" ? 7 : 14, category: "eufy_security", parent_sn: "base",
    device_channel: channel + 1, member: { admin_user_id: "owner" } }))];
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: rows }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ base: { key: "synthetic", expiresAt: null } }));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
  context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => {});
  context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [] }));
  context.mock.method(FirstPartyPpcsSession.prototype, "readCameraInfo", async () => []);
  const sessions: FirstPartyPpcsSession[] = [], order: string[] = [], published: unknown[][] = [];
  const control = { video: false, audio: false, reply: false, teardown: Promise.resolve(), release: () => {} };
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async function(this: FirstPartyPpcsSession) {
    sessions.push(this); order.push("start");
    Object.defineProperty(this, "stats", { value: { ...this.stats, camId: 1, mediaStartAcknowledged: 1, mediaStartAttempts: 1, gatewayInfoAcknowledged: 1,
      videoFrames: control.video ? 12 : 0, videoOutputFrames: control.video ? 12 : 0,
      audioFrames: control.audio ? 1 : 0, videoCodec: "h264" } });
    this.stats.commands.push(1100, ...(control.reply ? [1350] : []));
    this.stats.videoNalTypes.push(7, 8, 5);
  });
  context.mock.method(FirstPartyPpcsSession.prototype, "close", function(this: FirstPartyPpcsSession) {
    order.push("close"); this.stats.closeReason = "replaced"; this.output.end();
  });
  context.mock.method(FirstPartyPpcsSession.prototype, "waitUntilClosed", async () => { order.push("wait"); await control.teardown; });
  const events = new Proxy({}, { get: (_target, key) => key === "streamStarted"
    ? (...args: unknown[]) => { published.push(args); } : () => {} }) as ProviderEvents;
  const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory,
    maxStreamSeconds: 120, experimentalHb2StartupRecovery: enabled, apiAuthenticationConfigured: true });
  await provider.start(events); await flush(); sessions.length = 0; order.length = 0;
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1800000000000 });
  context.mock.method(performance, "now", () => Date.now());
  context.after(async () => { control.release(); await provider.close(); await rm(directory, { recursive: true, force: true }); });
  return { provider, sessions, order, published, control, rows };
}

test("recovery admission requires exact owned child, parent, type, channel and opt-in", () => {
  const peer = { model: "T8010", deviceType: 0, adminUserId: "owner" };
  const route = { homeBaseAttached: true, peer } as Parameters<typeof supportsExperimentalHb2StartupRecovery>[1];
  for (const identity of [{ model: "T8140-Z", deviceType: 14 }, { model: "T8210", deviceType: 7 }]) {
    const child = { ...identity, channel: 4, adminUserId: "owner" };
    assert.equal(supportsExperimentalHb2StartupRecovery(child, route, true, true), true);
    for (const changed of [{ model: "T8140" }, { model: "T8210X" }, { deviceType: 8 }, { deviceType: null },
      { channel: -1 }, { channel: 32 }, { channel: 1.5 }, { channel: null }, { adminUserId: "other" }, { adminUserId: null }]) {
      assert.equal(supportsExperimentalHb2StartupRecovery({ ...child, ...changed }, route, true, true), false);
    }
    assert.equal(supportsExperimentalHb2StartupRecovery(child, route, false, true), false);
    assert.equal(supportsExperimentalHb2StartupRecovery(child, route, true, false), false);
    for (const changed of [{ homeBaseAttached: false }, { peer: { ...peer, model: "T8030" } },
      { peer: { ...peer, deviceType: 18 } }, { peer: { ...peer, adminUserId: "other" } }]) {
      assert.equal(supportsExperimentalHb2StartupRecovery(child, { ...route!, ...changed } as typeof route, true, true), false);
    }
  }
});

for (const model of ["T8140-Z", "T8210"]) test(`${model} silent startup waits for old teardown before one replacement`, async context => {
  const f = await fixture(context, true, model); let release!: () => void;
  f.control.teardown = new Promise<void>(resolve => { release = resolve; f.control.release = resolve; });
  const start = f.provider.startStream("camera"); await flush();
  context.mock.timers.tick(5999); await flush(); assert.equal(f.sessions.length, 1);
  context.mock.timers.tick(1); await flush(); assert.deepEqual(f.order, ["start", "close", "wait"]);
  f.control.video = true; release(); await flush(); context.mock.timers.tick(50); await start;
  assert.equal(f.sessions.length, 2);
  assert.equal(f.published[0]?.[1], f.sessions[1]!.output);
  assert.equal(f.published[0]?.[3], f.sessions[1]!.audioOutput);
});

test("default-off keeps the original silent session", async context => {
  const f = await fixture(context, false); await f.provider.startStream("camera");
  context.mock.timers.tick(12000); await flush(); assert.equal(f.sessions.length, 1); assert.equal(f.order.includes("close"), false);
});

for (const progress of ["video", "audio", "reply"] as const) test(`${progress} progress preserves the existing peer`, async context => {
  const f = await fixture(context); f.control[progress] = true;
  const start = f.provider.startStream("camera"); await flush(); context.mock.timers.tick(6000); await start;
  assert.equal(f.sessions.length, 1); assert.equal(f.order.includes("close"), false);
});

test("a second silent attempt cannot create a third peer", async context => {
  const f = await fixture(context); const start = f.provider.startStream("camera"); await flush();
  context.mock.timers.tick(6000); await flush(); assert.equal(f.sessions.length, 2);
  context.mock.timers.tick(6000); await start;
  assert.equal(f.sessions.length, 2); assert.equal(f.order.filter(x => x === "close").length, 1);
});

test("another local view prevents early recovery", async context => {
  const f = await fixture(context); f.control.video = true;
  const sibling = f.provider.startStream("sibling"); await flush(); context.mock.timers.tick(50); await sibling;
  f.control.video = false; await f.provider.startStream("camera");
  context.mock.timers.tick(6000); await flush(); assert.equal(f.sessions.length, 2); assert.equal(f.order.includes("close"), false);
});

test("cancellation during teardown cannot open another peer", async context => {
  const f = await fixture(context); let release!: () => void;
  f.control.teardown = new Promise<void>(resolve => { release = resolve; f.control.release = resolve; });
  const start = f.provider.startStream("camera"); const rejected = assert.rejects(start, /cancelled/); await flush();
  context.mock.timers.tick(6000); await flush(); const stopped = f.provider.stopStream("camera"); release();
  await stopped; await rejected; assert.equal(f.sessions.length, 1);
});

test("the original deadline still expires while teardown is pending", async context => {
  const f = await fixture(context); let release!: () => void;
  f.control.teardown = new Promise<void>(resolve => { release = resolve; f.control.release = resolve; });
  const start = f.provider.startStream("camera"); const rejected = assert.rejects(start, /deadline expired/); await flush();
  context.mock.timers.tick(6000); await flush(); context.mock.timers.tick(14001); release(); await rejected;
  assert.equal(f.sessions.length, 1);
});

test("a view that arrives during observation prevents early replacement", async context => {
  const f = await fixture(context); const start = f.provider.startStream("camera"); await flush();
  await f.provider.startStream("sibling"); context.mock.timers.tick(6000); await start;
  assert.equal(f.sessions.length, 2); assert.equal(f.order.includes("close"), false);
});


test("a shared account can recover its ordinary admitted live route once", async context => {
  const f = await fixture(context);
  context.mock.method(MegaClient.prototype, "isAuthenticatedUser", () => false);
  const start = f.provider.startStream("camera"); await flush();
  f.control.video = true;
  context.mock.timers.tick(6000); await flush(); context.mock.timers.tick(50); await start;
  assert.equal(f.sessions.length, 2);
  assert.equal(f.published[0]?.[1], f.sessions[1]!.output);
  assert.equal(f.published[0]?.[3], f.sessions[1]!.audioOutput);
});

test("authentication loss during observation prevents shared-account replacement", async context => {
  const f = await fixture(context);
  context.mock.method(MegaClient.prototype, "isAuthenticatedUser", () => false);
  const start = f.provider.startStream("camera");
  const rejected = assert.rejects(start, /authentication ended/);
  await flush();
  context.mock.getter(MegaClient.prototype, "isAuthenticated", () => false);
  context.mock.timers.tick(6000); await rejected;
  assert.equal(f.sessions.length, 1);
});

test("an unauthenticated session cannot opt into early replacement", async context => {
  const f = await fixture(context);
  context.mock.getter(MegaClient.prototype, "isAuthenticated", () => false);
  await f.provider.startStream("camera"); context.mock.timers.tick(6000); await flush();
  assert.equal(f.sessions.length, 1); assert.equal(f.order.includes("close"), false);
});

test("audio arriving during observation prevents replacement", async context => {
  const f = await fixture(context); const start = f.provider.startStream("camera"); await flush();
  context.mock.timers.tick(5999); f.sessions[0]!.stats.audioFrames = 1;
  context.mock.timers.tick(1); await start;
  assert.equal(f.sessions.length, 1); assert.equal(f.order.includes("close"), false);
});
