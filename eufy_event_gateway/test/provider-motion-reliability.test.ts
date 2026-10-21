/**
 * Checks motion connection ownership and fresh confirmation with offline peers.
 * The provider owns inventory and borrowed-stream selection. Tests replace
 * network/session effects and never actuate a camera or change an account.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";
import { CameraControlAcknowledgementTimeoutError, FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import type { ProviderEvents } from "../src/provider/provider.js";

/** Own a normalized camera, confirmed settings and all synthetic session effects. */
async function fixture(context: TestContext, standalone = false, stationModel = "T8010", extra = false) {
  const directory = await mkdtemp(join(tmpdir(), "motion-reliability-"));
  let motion = true;
  const sessions: FirstPartyPpcsSession[] = [];
  const closes: FirstPartyPpcsSession[] = [];
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  const inventory = context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
    ...(!standalone ? [{ device_sn: "base", device_model: stationModel, device_type: stationModel === "T8010" ? 0 : 18,
      p2p_did: "synthetic-peer", p2p_conn: "synthetic-route", category: "eufy_security", member: { admin_user_id: "owner" } }] : []),
    { device_sn: "camera", device_model: standalone ? "T8171" : "T8113-Z", device_type: standalone ? 88 : 8,
      parent_sn: standalone ? "camera" : "base", device_channel: standalone ? 0 : 1,
      p2p_did: "synthetic-camera", p2p_conn: "synthetic-route", category: "eufy_security", member: { admin_user_id: "owner" },
      params: [{ param_type: standalone ? 6040 : 1011, param_value: motion ? "1" : "0" }] },
    ...(extra ? [
      { device_sn: "base2", device_model: "T8010", device_type: 0, p2p_did: "synthetic-peer2", p2p_conn: "synthetic-route", category: "eufy_security", member: { admin_user_id: "owner" } },
      ...["camera2", "camera3"].map(id => ({ device_sn: id, device_model: "T8113-Z", device_type: 8,
        parent_sn: id === "camera2" ? "base" : "base2", device_channel: id === "camera2" ? 2 : 1,
        category: "eufy_security", member: { admin_user_id: "owner" }, params: [{ param_type: 1011, param_value: motion ? "1" : "0" }] })),
    ] : []),
  ] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ base2: { key: "synthetic", expiresAt: null }, base: { key: "synthetic", expiresAt: null }, camera: { key: "synthetic", expiresAt: null } }));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
  context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => undefined);
  context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [] }));
  context.mock.method(HomeBasePpcsSession.prototype, "close", () => undefined);
  const start = context.mock.method(FirstPartyPpcsSession.prototype, "start", async function (this: FirstPartyPpcsSession) {
    sessions.push(this); this.stats.camId = 1; this.stats.videoOutputFrames = 1;
  });
  context.mock.method(FirstPartyPpcsSession.prototype, "close", function (this: FirstPartyPpcsSession) {
    closes.push(this); this.stats.closeReason = "client_stop"; this.output.end();
  });
  const write = context.mock.method(FirstPartyPpcsSession.prototype, "writeMotionDetection", async (value: boolean, dispatched?: () => void) => { dispatched?.(); motion = value; });
  const schedule = globalThis.setTimeout;
  context.mock.method(globalThis, "setTimeout", (callback: () => void, milliseconds?: number) => schedule(callback, milliseconds === 2000 ? 0 : milliseconds));
  const provider = new EufyProvider({ username: "synthetic", password: "redacted", country: "AU", persistentDirectory: directory, maxStreamSeconds: 120 });
  const events = new Proxy({}, { get: () => () => undefined }) as ProviderEvents;
  await provider.start(events); await new Promise(resolve => setImmediate(resolve));
  return { provider, sessions, closes, start, write, inventory, setMotion: (value: boolean) => { motion = value; },
    dispose: async () => { await provider.close(); assert.equal(network.mock.callCount(), 0); await rm(directory, { recursive: true, force: true }); } };
}

test("HB2 stops live media before its owned motion session and confirms fresh inventory", async context => {
  const f = await fixture(context);
  try {
    await f.provider.startStream("camera");
    const original = f.sessions[0]!;
    const reads = f.inventory.mock.callCount();
    const write = context.mock.method(FirstPartyPpcsSession.prototype, "writeMotionDetection", async function (this: FirstPartyPpcsSession, value: boolean) {
      assert.ok(f.closes.includes(original));
      assert.notEqual(this, original);
      f.setMotion(value);
    });
    assert.equal((await f.provider.setCameraMotionDetection("camera", false)).motionDetectionEnabled, false);
    assert.equal(f.start.mock.callCount(), 2);
    assert.equal(write.mock.callCount(), 1);
    assert.ok(f.closes.includes(f.sessions[1]!));
    assert.ok(f.inventory.mock.callCount() > reads);
  } finally { await f.dispose(); }
});

for (const mode of ["confirmed", "ack-lost", "readback-mismatch", "hard-error"]) {
  test(`motion confirmation outcome: ${mode}`, async context => {
    const f = await fixture(context);
    try {
      const write = context.mock.method(FirstPartyPpcsSession.prototype, "writeMotionDetection", async (value: boolean) => {
        if (mode === "hard-error") throw Error("rejected");
        if (mode !== "readback-mismatch") f.setMotion(value);
        if (mode !== "confirmed") throw new CameraControlAcknowledgementTimeoutError();
      });
      if (mode === "hard-error") await assert.rejects(f.provider.setCameraMotionDetection("camera", false), /rejected/);
      else if (mode === "readback-mismatch") await assert.rejects(f.provider.setCameraMotionDetection("camera", false), /not confirmed/);
      else assert.equal((await f.provider.setCameraMotionDetection("camera", false)).motionDetectionEnabled, false);
      assert.equal(write.mock.callCount(), 1);
      assert.ok(f.closes.includes(f.sessions[0]!));
    } finally { await f.dispose(); }
  });
}

for (const cancel of [false, true]) {
  test(`viewer reconnect waits for control cleanup, cancelled=${cancel}`, async context => {
    const f = await fixture(context);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    context.mock.method(FirstPartyPpcsSession.prototype, "writeMotionDetection", async (value: boolean) => { await held; f.setMotion(value); });
    try {
      const command = f.provider.setCameraMotionDetection("camera", false);
      await new Promise(resolve => setImmediate(resolve));
      const viewer = f.provider.startStream("camera");
      const checked = cancel ? assert.rejects(viewer, /stream start cancelled/) : viewer;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.start.mock.callCount(), 1);
      if (cancel) { await f.provider.stopStream("camera"); await checked; }
      release(); await command; await checked;
      assert.equal(f.start.mock.callCount(), cancel ? 1 : 2);
      assert.ok(f.closes.includes(f.sessions[0]!));
    } finally { release(); await f.dispose(); }
  });
}

for (const standalone of [false, true]) {
  test(`released non-HB2 behavior stays owned, standalone=${standalone}`, async context => {
    const f = await fixture(context, standalone, "T8030");
    try {
      await f.provider.startStream("camera");
      const original = f.sessions[0]!;
      assert.equal((await f.provider.setCameraMotionDetection("camera", false)).motionDetectionEnabled, false);
      assert.equal(f.start.mock.callCount(), 2);
      assert.equal(f.closes.includes(original), standalone);
      assert.ok(f.closes.includes(f.sessions[1]!));
    } finally { await f.dispose(); }
  });
}

for (const restart of [false, true]) {
  test(`provider retirement aborts owned motion immediately, restart=${restart}`, async context => {
    const f = await fixture(context);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    context.mock.method(FirstPartyPpcsSession.prototype, "writeMotionDetection", async () => { await held; });
    try {
      const result = assert.rejects(f.provider.setCameraMotionDetection("camera", false), /No change|outcome is unknown/);
      await new Promise(resolve => setImmediate(resolve));
      if (restart) await f.provider.start(new Proxy({}, { get: () => () => undefined }) as ProviderEvents);
      else await f.provider.close();
      await result;
      assert.ok(f.closes.includes(f.sessions[0]!));
    } finally { release(); await f.dispose(); }
  });
}

test("an expired queued member never releases its running predecessor", async context => {
  const f = await fixture(context);
  const deadlines: (() => void)[] = [];
  const schedule = globalThis.setTimeout;
  context.mock.method(globalThis, "setTimeout", (callback: () => void, milliseconds?: number) => {
    if (milliseconds === 90000) deadlines.push(callback);
    return schedule(callback, milliseconds);
  });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const values: boolean[] = [];
  context.mock.method(FirstPartyPpcsSession.prototype, "writeMotionDetection", async (value: boolean) => {
    values.push(value);
    if (values.length === 1) await held;
    f.setMotion(value);
  });
  try {
    const first = f.provider.setCameraMotionDetection("camera", false);
    await new Promise(resolve => setImmediate(resolve));
    const second = assert.rejects(f.provider.setCameraMotionDetection("camera", true), /No change was sent/);
    deadlines[1]!(); await second;
    const third = f.provider.setCameraMotionDetection("camera", true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(values, [false]);
    release(); await first; await third;
    assert.deepEqual(values, [false, true]);
  } finally { release(); await f.dispose(); }
});

for (const samePeer of [false, true]) {
  test(`two-camera motion ownership, samePeer=${samePeer}`, async context => {
    const f = await fixture(context, false, "T8010", true);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let writes = 0;
    context.mock.method(FirstPartyPpcsSession.prototype, "writeMotionDetection", async (value: boolean) => {
      if (++writes === 1) await held;
      f.setMotion(value);
    });
    try {
      const first = f.provider.setCameraMotionDetection("camera", false);
      await new Promise(resolve => setImmediate(resolve));
      const second = f.provider.setCameraMotionDetection(samePeer ? "camera2" : "camera3", false);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(writes, samePeer ? 1 : 2);
      release(); await first; await second;
      assert.equal(writes, 2);
    } finally { release(); await f.dispose(); }
  });
}

for (const phase of ["lookup", "ack", "readback"]) {
  test(`deadline retires the owned ${phase} phase with no later write`, async context => {
    const f = await fixture(context);
    const timers: (() => void)[] = [];
    const schedule = globalThis.setTimeout;
    context.mock.method(globalThis, "setTimeout", (callback: () => void, milliseconds?: number) => {
      if (milliseconds === 90000) timers.push(callback);
      return schedule(callback, milliseconds);
    });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let owned!: FirstPartyPpcsSession;
    if (phase === "lookup") context.mock.method(FirstPartyPpcsSession.prototype, "start", async function (this: FirstPartyPpcsSession) { owned = this; await held; });
    if (phase === "ack") context.mock.method(FirstPartyPpcsSession.prototype, "writeMotionDetection", async (_value: boolean, dispatched?: () => void) => { dispatched?.(); await held; });
    if (phase === "readback") context.mock.method(MegaClient.prototype, "inventory", async () => { await held; return { devices: [] }; });
    try {
      const result = assert.rejects(f.provider.setCameraMotionDetection("camera", false), phase === "lookup" ? /No change was sent/ : /outcome is unknown/);
      await new Promise(resolve => setImmediate(resolve));
      timers[0]!(); await result;
      assert.ok(f.closes.includes(phase === "lookup" ? owned : f.sessions[0]!));
      const starts = f.start.mock.callCount();
      release(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.start.mock.callCount(), starts);
      if (phase === "lookup") assert.equal(f.write.mock.callCount(), 0);
    } finally { release(); await f.dispose(); }
  });
}
