/**
 * Checks camera-control ownership and fresh confirmation with offline peers.
 * The provider owns inventory and borrowed-stream selection. Tests replace
 * network/session effects and never actuate a camera or change an account.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EufyProvider, cameraEnableRawValue } from "../src/provider/eufy-provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";
import { CameraControlAcknowledgementTimeoutError, FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { observeLogEvents } from "../src/logging.js";

/** Own a normalized camera, confirmed settings and all synthetic session effects. */
async function fixture(context: TestContext, standalone = false, stationModel = "T8010", extra = false, stationSerial = "base", cameraChannel = standalone ? 0 : 1, chargingDays?: number, enableParam?: 1035 | 2001) {
  const directory = await mkdtemp(join(tmpdir(), "motion-reliability-"));
  let motion = true;
  let enabled: boolean | undefined = true;
  const sessions: FirstPartyPpcsSession[] = [];
  const closes: FirstPartyPpcsSession[] = [];
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  const inventory = context.mock.method(MegaClient.prototype, "inventory", async (_signal?: AbortSignal, options?: { includeChargingDays?: boolean }) => ({ devices: [
    ...(!standalone ? [{ device_sn: stationSerial, device_model: stationModel, device_type: stationModel === "T8010" ? 0 : 18,
      p2p_did: stationSerial === "base" ? "synthetic-peer" : "TEST-12345678-TEST", p2p_conn: "synthetic-route", category: "eufy_security", member: { admin_user_id: "owner" } }] : []),
    { ...(chargingDays !== undefined && options?.includeChargingDays !== false ? { charging_days: chargingDays } : {}),
      device_sn: "camera", device_model: standalone ? "T8171" : "T8113-Z", device_type: standalone ? 88 : 8,
      parent_sn: standalone ? "camera" : stationSerial, device_channel: cameraChannel,
      p2p_did: "synthetic-camera", p2p_conn: "synthetic-route", category: "eufy_security", member: { admin_user_id: "owner" },
      params: [{ param_type: standalone ? 6040 : 1011, param_value: motion ? "1" : "0" },
        ...(enableParam && enabled !== undefined ? [{ param_type: enableParam, param_value: String(enableParam === 2001 ? Number(enabled) : cameraEnableRawValue(8, enabled)) }] : []),
        ...(chargingDays !== undefined ? [{ param_type: 1101, param_value: "60" }] : [])] },
    ...(extra ? [
      { device_sn: "base2", device_model: "T8010", device_type: 0, p2p_did: "synthetic-peer2", p2p_conn: "synthetic-route", category: "eufy_security", member: { admin_user_id: "owner" } },
      ...["camera2", "camera3"].map(id => ({ device_sn: id, device_model: "T8113-Z", device_type: 8,
        parent_sn: id === "camera2" ? "base" : "base2", device_channel: id === "camera2" ? 2 : 1,
        category: "eufy_security", member: { admin_user_id: "owner" }, params: [{ param_type: 1011, param_value: motion ? "1" : "0" }] })),
    ] : []),
  ] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ base2: { key: "synthetic", expiresAt: null }, [stationSerial]: { key: "synthetic", expiresAt: null }, camera: { key: "synthetic", expiresAt: null } }));
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
  const published: unknown[][] = [];
  const events = new Proxy({}, { get: (_target, property) => property === "streamStarted"
    ? (...arguments_: unknown[]) => { published.push(arguments_); } : () => undefined }) as ProviderEvents;
  await provider.start(events); await new Promise(resolve => setImmediate(resolve));
  return { provider, sessions, closes, start, write, inventory, published, setMotion: (value: boolean) => { motion = value; }, setEnabled: (value: boolean | undefined) => { enabled = value; },
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

for (const stationModel of ["T8010", "T8030"]) {
  for (const acknowledgementLost of [false, true]) {
    test(`fresh motion inventory replaces the pre-write HomeBase cache: ${stationModel}, lost=${acknowledgementLost}`, async context => {
      const f = await fixture(context, false, stationModel, false, "synthetic-base");
      context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [
        { channel: 1, type: 1011, value: "1" },
        { channel: 1, type: 1101, value: "72" },
      ] }));
      try {
        await f.provider.refreshStation("synthetic-base");
        const reads = f.inventory.mock.callCount();
        const write = context.mock.method(FirstPartyPpcsSession.prototype, "writeMotionDetection", async (value: boolean, dispatched?: () => void) => {
          dispatched?.();
          f.setMotion(value);
          if (acknowledgementLost) throw new CameraControlAcknowledgementTimeoutError();
        });
        const result = await f.provider.setCameraMotionDetection("camera", false);
        assert.equal(result.motionDetectionEnabled, false);
        assert.equal(result.battery?.level, 72);
        assert.equal(write.mock.callCount(), 1);
        assert.equal(f.inventory.mock.callCount(), reads + 1);
      } finally { await f.dispose(); }
    });
  }
}

for (const stationModel of ["T8010", "T8030"]) {
  test(`a matching old HomeBase cache cannot confirm an unchanged cloud setting: ${stationModel}`, async context => {
    const f = await fixture(context, false, stationModel, false, "synthetic-base");
    const timingLines = motionTimingLines(context);
    context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [
      { channel: 1, type: 1011, value: "0" },
    ] }));
    try {
      await f.provider.refreshStation("synthetic-base");
      const write = context.mock.method(FirstPartyPpcsSession.prototype, "writeMotionDetection", async (_value: boolean, dispatched?: () => void) => { dispatched?.(); });
      await assert.rejects(f.provider.setCameraMotionDetection("camera", false), /not confirmed by readback/);
      assert.equal(write.mock.callCount(), 1);
      assert.equal(timingLines.length, 1);
      assert.match(timingLines[0]!, /outcome=failed failure_phase=readback/);
      assert.match(timingLines[0]!, /connections=1 readback_attempts=12/);
    } finally { await f.dispose(); }
  });
}

for (const stationModel of ["T8010", "T8030"]) {
  for (const enableParam of [1035, 2001] as const) {
    for (const acknowledgementLost of [false, true]) {
      for (const desired of [false, true]) {
        test(`fresh enablement replaces the HomeBase cache: ${stationModel}, param=${enableParam}, lost=${acknowledgementLost}, enabled=${desired}`, async context => {
          const f = await fixture(context, false, stationModel, false, "synthetic-base", 1, undefined, enableParam);
          context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [
            { channel: 1, type: enableParam, value: String(enableParam === 2001 ? Number(!desired) : cameraEnableRawValue(8, !desired)) },
            { channel: 1, type: 1011, value: "0" },
            { channel: 1, type: 1101, value: "72" },
          ] }));
          try {
            await f.provider.refreshStation("synthetic-base");
            const reads = f.inventory.mock.callCount();
            const write = context.mock.method(FirstPartyPpcsSession.prototype, "writeCameraEnabled", async (value: number) => {
              assert.equal(value, cameraEnableRawValue(8, desired));
              f.setEnabled(desired);
              if (acknowledgementLost) throw new CameraControlAcknowledgementTimeoutError();
            });
            const result = await f.provider.setCameraEnabled("camera", desired);
            assert.equal(result.enabled, desired);
            assert.equal(result.motionDetectionEnabled, false);
            assert.equal(result.battery?.level, 72);
            assert.equal(write.mock.callCount(), 1);
            assert.equal(f.inventory.mock.callCount(), reads + 1);
          } finally { await f.dispose(); }
        });
      }
    }
  }
}

for (const freshValue of [true, undefined]) {
  test(`a matching old enablement cache cannot replace fresh confirmation: value=${freshValue}`, async context => {
    const f = await fixture(context, false, "T8030", false, "synthetic-base", 1, undefined, 1035);
    context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [
      { channel: 1, type: 1035, value: "1" },
    ] }));
    try {
      await f.provider.refreshStation("synthetic-base");
      const write = context.mock.method(FirstPartyPpcsSession.prototype, "writeCameraEnabled", async () => { f.setEnabled(freshValue); });
      await assert.rejects(f.provider.setCameraEnabled("camera", false), /not confirmed by readback/);
      assert.equal(write.mock.callCount(), 1);
    } finally { await f.dispose(); }
  });
}

test("successful camera startup emits the closed stage-timing event", async context => {
  const observed: string[] = [];
  const stopObserving = observeLogEvents((component, event) => { observed.push(`${component}:${event}`); });
  const f = await fixture(context);
  try {
    await f.provider.startStream("camera");
    assert.ok(observed.includes("provider:camera_stream_start_timings"));
  } finally {
    stopObserving();
    await f.dispose();
  }
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
  const timingLines = motionTimingLines(context);
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
    assert.equal(timingLines.length, 1);
    assert.match(timingLines[0]!, /outcome=failed failure_phase=queue/);
    assert.match(timingLines[0]!, /connections=0 readback_attempts=0/);
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
    const timingLines = motionTimingLines(context);
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
      assert.equal(timingLines.length, 1);
      assert.ok(timingLines[0]!.includes(`outcome=failed failure_phase=${phase === "lookup" ? "connect" : phase === "ack" ? "write" : "readback"}`));
      assert.ok(f.closes.includes(phase === "lookup" ? owned : f.sessions[0]!));
      const starts = f.start.mock.callCount();
      release(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.start.mock.callCount(), starts);
      if (phase === "lookup") assert.equal(f.write.mock.callCount(), 0);
    } finally { release(); await f.dispose(); }
  });
}

test("HB2 handoff waits for both old media and owned control disconnect sends", async context => {
  const f = await fixture(context);
  let release!: () => void;
  let held = new Promise<void>(resolve => { release = resolve; });
  let waiting = 0;
  const retired = new Map<FirstPartyPpcsSession, Promise<void>>();
  context.mock.method(FirstPartyPpcsSession.prototype, "waitUntilClosed", function (this: FirstPartyPpcsSession) {
    if (!retired.has(this)) { waiting++; retired.set(this, held); }
    return retired.get(this)!;
  });
  try {
    await f.provider.startStream("camera");
    const motion = f.provider.setCameraMotionDetection("camera", false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(waiting, 1);
    assert.equal(f.start.mock.callCount(), 1);
    assert.equal(f.write.mock.callCount(), 0);
    release();
    held = new Promise<void>(resolve => { release = resolve; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(waiting, 2);
    const reopened = f.provider.startStream("camera");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.start.mock.callCount(), 2);
    release();
    await motion;
    await reopened;
    assert.equal(f.start.mock.callCount(), 3);
  } finally { release(); await f.dispose(); }
});

test("HomeBase read ownership waits for disconnect completion before the next read", async context => {
  const f = await fixture(context, false, "T8010", false, "synthetic-base");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let waits = 0;
  const connect = context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => undefined);
  context.mock.method(HomeBasePpcsSession.prototype, "waitUntilClosed", () => ++waits === 1 ? held : Promise.resolve());
  try {
    const first = f.provider.refreshStation("synthetic-base");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(waits, 1);
    const next = f.provider.refreshStation("synthetic-base");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(connect.mock.callCount(), 1);
    release();
    await Promise.all([first, next]);
    assert.equal(connect.mock.callCount(), 2);
  } finally { release(); await f.dispose(); }
});

for (const cancel of [false, true]) test(`HomeBase read disconnect gates pending media, cancel=${cancel}`, async context => {
  const f = await fixture(context, false, "T8010", false, "synthetic-base");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let waits = 0;
  context.mock.method(HomeBasePpcsSession.prototype, "waitUntilClosed", () => { waits++; return held; });
  try {
    const refresh = f.provider.refreshStation("synthetic-base");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(waits, 1);
    const media = f.provider.startStream("camera");
    const rejected = cancel ? assert.rejects(media, /cancelled/) : undefined;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.start.mock.callCount(), 0);
    if (cancel) await f.provider.stopStream("camera");
    release();
    await refresh;
    if (cancel) await rejected;
    else await media;
    assert.equal(f.start.mock.callCount(), cancel ? 0 : 1);
  } finally { release(); await f.dispose(); }
});

test("pending child media prevents a new background station reader from opening", async context => {
  const f = await fixture(context, false, "T8010", false, "synthetic-base");
  const connect = context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => undefined);
  try {
    const media = f.provider.startStream("camera");
    const refresh = f.provider.refreshStation("synthetic-base");
    await Promise.all([media, refresh]);
    assert.equal(connect.mock.callCount(), 0);
    assert.equal(f.start.mock.callCount(), 1);
  } finally { await f.dispose(); }
});

test("HomeBase station disconnect gates a motion handoff without dispatching early", async context => {
  const f = await fixture(context, false, "T8010", false, "synthetic-base");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  context.mock.method(HomeBasePpcsSession.prototype, "waitUntilClosed", () => held);
  try {
    const refresh = f.provider.refreshStation("synthetic-base");
    await new Promise(resolve => setImmediate(resolve));
    const motion = f.provider.setCameraMotionDetection("camera", true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.write.mock.callCount(), 0);
    assert.equal(f.start.mock.callCount(), 0);
    release();
    await Promise.all([refresh, motion]);
    assert.equal(f.write.mock.callCount(), 1);
  } finally { release(); await f.dispose(); }
});

test("owned motion prevents a background station reader from opening", async context => {
  const f = await fixture(context, false, "T8010", false, "synthetic-base");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const connect = context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => undefined);
  context.mock.method(FirstPartyPpcsSession.prototype, "writeMotionDetection", async () => held);
  try {
    const motion = f.provider.setCameraMotionDetection("camera", true);
    await new Promise(resolve => setImmediate(resolve));
    await f.provider.refreshStation("synthetic-base");
    assert.equal(connect.mock.callCount(), 0);
    release();
    await motion;
  } finally { release(); await f.dispose(); }
});

for (const acknowledged of [0, 1]) test(`silent owned HB2 startup drains before replacement and publishes only the replacement: ack=${acknowledged}`, async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1800000000000 });
  context.mock.method(performance, "now", () => Date.now());
  const f = await fixture(context, false, "T8010", false, "synthetic-base", 0);
  const attempts: FirstPartyPpcsSession[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const published = f.published;
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async function (this: FirstPartyPpcsSession) {
    attempts.push(this);
    Object.defineProperty(this, "stats", { value: { ...this.stats, camId: 1, mediaStartAcknowledged: acknowledged, mediaStartAttempts: 2, gatewayInfoAcknowledged: 1, commands: [1100] } });
    if (attempts.length > 1) { this.stats.videoOutputFrames = 15; this.stats.videoCodec = "h264"; this.stats.videoNalTypes = [7, 8, 5]; }
  });
  context.mock.method(FirstPartyPpcsSession.prototype, "waitUntilClosed", function (this: FirstPartyPpcsSession) {
    return this === attempts[0] ? held : Promise.resolve();
  });
  try {
    const startup = f.provider.startStream("camera");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts.length, 1);
    context.mock.timers.tick(6000);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.closes.includes(attempts[0]!));
    assert.equal(attempts.length, 1);
    assert.equal(published.length, 0);
    release();
    await startup;
    assert.equal(attempts.length, 2);
    assert.equal(published.length, 1);
    assert.equal(published[0]![1], attempts[1]!.output);
  } finally { release(); await f.dispose(); }
});

test("cancellation during a silent peer retirement never opens its replacement", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1800000000000 });
  context.mock.method(performance, "now", () => Date.now());
  const f = await fixture(context, false, "T8010", false, "synthetic-base", 0);
  const attempts: FirstPartyPpcsSession[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async function (this: FirstPartyPpcsSession) {
    attempts.push(this);
    Object.defineProperty(this, "stats", { value: { ...this.stats, camId: 1, mediaStartAcknowledged: 1, commands: [1100] } });
  });
  context.mock.method(FirstPartyPpcsSession.prototype, "waitUntilClosed", () => held);
  try {
    const startup = assert.rejects(f.provider.startStream("camera"), /cancelled/);
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(6000);
    await new Promise(resolve => setImmediate(resolve));
    const stopped = f.provider.stopStream("camera");
    release();
    await Promise.all([startup, stopped]);
    assert.equal(attempts.length, 1);
  } finally { release(); await f.dispose(); }
});

test("owned silence recovery stops after two replacements within one startup", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1800000000000 });
  context.mock.method(performance, "now", () => Date.now());
  const f = await fixture(context, false, "T8010", false, "synthetic-base", 0);
  let attempts = 0;
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async function (this: FirstPartyPpcsSession) {
    attempts++;
    Object.defineProperty(this, "stats", { value: { ...this.stats, camId: 1, mediaStartAcknowledged: 1, commands: [1100] } });
  });
  try {
    const startup = f.provider.startStream("camera");
    await new Promise(resolve => setImmediate(resolve));
    for (let index = 0; index < 3; index++) {
      context.mock.timers.tick(6000);
      await new Promise(resolve => setImmediate(resolve));
    }
    await startup;
    assert.equal(attempts, 3);
    assert.equal(f.published.length, 1);
    context.mock.timers.tick(2000);
    assert.equal(attempts, 3);
  } finally { await f.dispose(); }
});

for (const [station, channel] of [["T8010", 1], ["T8030", 0]] as const) test(`silent adjacent route keeps its existing startup policy: ${station}/${channel}`, { timeout: 2000 }, async context => {
  const f = await fixture(context, false, station, false, "synthetic-base", channel);
  let attempts = 0;
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async function (this: FirstPartyPpcsSession) {
    attempts++;
    Object.defineProperty(this, "stats", { value: { ...this.stats, camId: 1, mediaStartAcknowledged: 1, commands: [1100] } });
  });
  try {
    await f.provider.startStream("camera");
    assert.equal(attempts, 1);
    assert.equal(f.published.length, 1);
  } finally { await f.dispose(); }
});

test("a brief startup bootstrap that stalls is retired before its replacement is published", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1800000000000 });
  context.mock.method(performance, "now", () => Date.now());
  const f = await fixture(context, false, "T8010", false, "synthetic-base", 0);
  const attempts: FirstPartyPpcsSession[] = [];
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async function (this: FirstPartyPpcsSession) {
    attempts.push(this);
    Object.defineProperty(this, "stats", { value: { ...this.stats, camId: 1, mediaStartAcknowledged: 1,
      commands: [1100, 1350, 1300], videoFrames: attempts.length === 1 ? 3 : 15,
      videoOutputFrames: attempts.length === 1 ? 3 : 15, videoCodec: "h264",
      videoNalTypes: attempts.length === 1 ? [1] : [7, 8, 5] } });
  });
  try {
    const startup = f.provider.startStream("camera");
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(6000);
    await startup;
    assert.equal(attempts.length, 2);
    assert.ok(f.closes.includes(attempts[0]!));
    assert.equal(f.published.length, 1);
    assert.equal(f.published[0]![1], attempts[1]!.output);
  } finally { await f.dispose(); }
});


test("motion readback skips optional charging history and retains its owned cached value", async context => {
  const f = await fixture(context, false, "T8010", false, "base", 1, 44);
  try {
    const camera = await f.provider.setCameraMotionDetection("camera", false);
    assert.equal(camera.motionDetectionEnabled, false);
    assert.equal(camera.battery?.lastChargingDays, 44);
    const confirmations = f.inventory.mock.calls.slice(1);
    assert.ok(confirmations.length > 0);
    assert.ok(confirmations.every(call => call.arguments[1]?.includeChargingDays === false));
    assert.equal(f.write.mock.callCount(), 1);
  } finally { await f.dispose(); }
});

/** Capture only the public timing event while retaining unrelated test output. */
function motionTimingLines(context: TestContext): string[] {
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  context.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    if (String(chunk).includes("event=camera_motion_control_timings ")) {
      lines.push(String(chunk)); return true;
    }
    return write(chunk);
  });
  return lines;
}

test("motion timings account for the owned phases without exposing identities or values", async context => {
  const f = await fixture(context);
  const lines = motionTimingLines(context);
  let now = 0;
  context.mock.method(performance, "now", () => now);
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => { now += 11; });
  context.mock.method(FirstPartyPpcsSession.prototype, "writeMotionDetection", async (value: boolean) => { now += 23; f.setMotion(value); });
  context.mock.method(FirstPartyPpcsSession.prototype, "waitUntilClosed", async () => { now += 17; });
  const inventory = MegaClient.prototype.inventory;
  context.mock.method(MegaClient.prototype, "inventory", async function (this: MegaClient, ...args: Parameters<typeof inventory>) {
    now += 37; return inventory.apply(this, args);
  });
  try {
    await f.provider.setCameraMotionDetection("camera", false);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /model=T8113-Z outcome=confirmed failure_phase=none total_ms=88 queue_ms=0 prepare_ms=0 connect_ms=11 write_ms=23 retire_ms=17 readback_ms=37 backoff_ms=0 connections=1 readback_attempts=1/);
    assert.doesNotMatch(lines[0]!, /synthetic|owner|camera=|serial|enabled|false|true/);
  } finally { await f.dispose(); }
});

test("failed motion writes report their failing phase after waiting for retirement", async context => {
  const f = await fixture(context);
  const lines = motionTimingLines(context);
  let now = 0;
  context.mock.method(performance, "now", () => now);
  context.mock.method(FirstPartyPpcsSession.prototype, "writeMotionDetection", async () => { now += 41; throw Error("rejected"); });
  context.mock.method(FirstPartyPpcsSession.prototype, "waitUntilClosed", async () => { now += 19; });
  try {
    await assert.rejects(f.provider.setCameraMotionDetection("camera", false), /rejected/);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /outcome=failed failure_phase=write total_ms=60/);
    assert.match(lines[0]!, /write_ms=41 retire_ms=19 readback_ms=0 backoff_ms=0 connections=1 readback_attempts=0/);
  } finally { await f.dispose(); }
});

test("motion timings distinguish same-peer waiting from a slow command", async context => {
  const f = await fixture(context, false, "T8010", true);
  const lines = motionTimingLines(context);
  let now = 0, release!: () => void, writes = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  context.mock.method(performance, "now", () => now);
  context.mock.method(FirstPartyPpcsSession.prototype, "writeMotionDetection", async (value: boolean) => {
    if (++writes === 1) await held;
    f.setMotion(value);
  });
  try {
    const first = f.provider.setCameraMotionDetection("camera", false);
    await new Promise(resolve => setImmediate(resolve));
    const second = f.provider.setCameraMotionDetection("camera2", false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes, 1);
    now = 73; release(); await first; await second;
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /queue_ms=0 prepare_ms=0 connect_ms=0 write_ms=73/);
    assert.match(lines[1]!, /queue_ms=73 prepare_ms=0 connect_ms=0 write_ms=0/);
  } finally { release(); await f.dispose(); }
});
