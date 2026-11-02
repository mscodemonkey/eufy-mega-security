/**
 * Exercises shared source startup and retirement through the public manager API.
 * Each case owns its fake provider, streams and responses. No device or FFmpeg
 * is opened, and late provider settlements cannot acquire a newer session.
 */
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import { LiveStreamManager, type StreamController } from "../src/stream/live-stream-manager.js";

const camera = { serial: "synthetic-camera", name: "Synthetic", model: "T8172", stationSerial: "synthetic-station",
  streamSupported: true, doorbellSupported: true };

/** Give each test explicit ownership of the simulated provider's completion. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

/** Flush response close events and promise observers without advancing deadlines. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index++) await new Promise<void>(resolve => setImmediate(resolve));
}

/** Register an isolated camera whose only effects are the supplied fake controller. */
function fixture(controller: StreamController, stopGraceMilliseconds = 5000) {
  const state = new GatewayState();
  state.registerCamera(camera);
  const manager = new LiveStreamManager(state, {} as never, controller, stopGraceMilliseconds);
  manager.on("warning", () => {});
  return { state, manager };
}

/** Use a writable response before headers or video bytes have been delivered. */
function response(): ServerResponse {
  return new PassThrough() as unknown as ServerResponse;
}

test("all concurrent viewers observe the same failed source start and can retry", async () => {
  const start = deferred();
  let starts = 0;
  const f = fixture({ startStream() {
    if (++starts === 1) return start.promise;
    f.manager.attachSource(camera.serial, new PassThrough());
    return Promise.resolve();
  }, async stopStream() {} });
  const first = response(), second = response();
  const pending = [f.manager.addClient(camera.serial, first), f.manager.addClient(camera.serial, second)];
  try {
    await settle();
    assert.equal(starts, 1);
    start.reject(new Error("synthetic-start-failure"));
    await Promise.all(pending); await settle();
    assert.equal(first.destroyed, true);
    assert.equal(second.destroyed, true);
    assert.equal(f.state.getCamera(camera.serial).stream.viewers, 0);
    const retry = response();
    await f.manager.addClient(camera.serial, retry);
    assert.equal(starts, 2);
    assert.equal(f.state.getCamera(camera.serial).stream.state, "streaming");
    assert.equal(retry.destroyed, false);
  } finally { start.reject(new Error("test-cleanup")); await Promise.allSettled(pending); await f.manager.close(); }
});

test("concurrent viewers wait for a shared successful start", async () => {
  const start = deferred();
  let starts = 0, completed = 0, stops = 0;
  const f = fixture({ startStream() { starts++; return start.promise; }, async stopStream() { stops++; } });
  const pending = [f.manager.addClient(camera.serial, response()), f.manager.addClient(camera.serial, response())]
    .map(async operation => { await operation; completed++; });
  try {
    await settle();
    assert.equal(starts, 1);
    assert.equal(completed, 0);
    f.manager.attachSource(camera.serial, new PassThrough());
    start.resolve(); await Promise.all(pending);
    assert.equal(completed, 2);
    assert.equal(f.state.getCamera(camera.serial).stream.state, "streaming");
    await f.manager.close();
    assert.equal(stops, 1);
  } finally { start.resolve(); await Promise.allSettled(pending); await f.manager.close(); }
});

for (const retirement of ["stopped", "closed", "source-error"] as const) test(`pending startup waiters settle after ${retirement}`, async () => {
  const start = deferred();
  let completed = 0;
  const source = new PassThrough();
  const f = fixture({ startStream() {
    if (retirement === "source-error") f.manager.attachSource(camera.serial, source);
    return start.promise;
  }, async stopStream() {} });
  const pending = [f.manager.addClient(camera.serial, response()), f.manager.addClient(camera.serial, response())]
    .map(async operation => { await operation; completed++; });
  try {
    await settle();
    if (retirement === "stopped") f.manager.markStopped(camera.serial);
    else if (retirement === "closed") await f.manager.close();
    else source.destroy(new Error("synthetic-source-error"));
    await settle();
    assert.equal(completed, 2);
    start.resolve(); await Promise.all(pending);
    assert.notEqual(f.state.getCamera(camera.serial).stream.state, "streaming");
  } finally { start.resolve(); await Promise.allSettled(pending); await f.manager.close(); }
});

test("a retired startup failure cannot overwrite a replacement source", async () => {
  const old = deferred();
  let starts = 0, stops = 0;
  const f = fixture({ startStream() {
    if (++starts === 1) return old.promise;
    f.manager.attachSource(camera.serial, new PassThrough());
    return Promise.resolve();
  }, async stopStream() { stops++; } });
  const pending = f.manager.addClient(camera.serial, response());
  try {
    f.manager.markStopped(camera.serial);
    const replacement = response();
    await f.manager.addClient(camera.serial, replacement);
    assert.equal(f.state.getCamera(camera.serial).stream.state, "streaming");
    old.reject(new Error("synthetic-late-failure"));
    await pending; await settle();
    assert.equal(f.state.getCamera(camera.serial).stream.state, "streaming");
    assert.equal(replacement.destroyed, false);
    await f.manager.close();
    assert.equal(stops, 1);
  } finally { old.reject(new Error("test-cleanup")); await pending; await f.manager.close(); }
});

test("a snapshot and viewer share a startup failure", async () => {
  const start = deferred();
  let starts = 0;
  const f = fixture({ startStream() { starts++; return start.promise; }, async stopStream() {} });
  const viewer = response();
  const opening = f.manager.addClient(camera.serial, viewer);
  const snapshot = assert.rejects(f.manager.captureSnapshot(camera.serial, 5000), /synthetic-start-failure/);
  try {
    await settle(); assert.equal(starts, 1);
    start.reject(new Error("synthetic-start-failure"));
    await Promise.all([opening, snapshot]);
    assert.equal(viewer.destroyed, true);
  } finally { start.reject(new Error("synthetic-start-failure")); await Promise.allSettled([opening, snapshot]); await f.manager.close(); }
});

test("failed startup detaches a partially attached source and every waiter", async () => {
  const start = deferred();
  const source = new PassThrough();
  const f = fixture({ startStream() { f.manager.attachSource(camera.serial, source); return start.promise; }, async stopStream() {} });
  const first = response(), second = response();
  const pending = [f.manager.addClient(camera.serial, first), f.manager.addClient(camera.serial, second)];
  try {
    assert.ok(source.listenerCount("data") > 0);
    start.reject(new Error("synthetic-partial-start-failure"));
    await Promise.all(pending); await settle();
    assert.equal(source.listenerCount("data"), 0);
    assert.equal(first.destroyed, true);
    assert.equal(second.destroyed, true);
    assert.equal(f.state.getCamera(camera.serial).stream.state, "error");
  } finally { start.reject(new Error("test-cleanup")); await Promise.allSettled(pending); source.destroy(); await f.manager.close(); }
});

for (const transport of [false, true]) for (const outcome of ["restart", "disconnected", "failed-stop", "gateway-closed"] as const) test(`a new viewer waits for the previous stop: ${outcome}, transport=${transport}`, async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const stopping = deferred();
  let starts = 0, stops = 0, opened = false;
  const f = fixture({ async startStream() { starts++; f.manager.attachSource(camera.serial, new PassThrough()); },
    async stopStream() {
      if (++stops === 1) await stopping.promise;
      f.manager.markStopped(camera.serial);
    } }, 5);
  const first = response(), next = response();
  await f.manager.addClient(camera.serial, first);
  first.destroy(); await settle();
  context.mock.timers.tick(6);
  assert.equal(stops, 1);
  const opening = (transport ? f.manager.addTransportClient(camera.serial, next) : f.manager.addClient(camera.serial, next))
    .then(() => { opened = true; });
  try {
    await settle();
    assert.equal(opened, false);
    assert.equal(starts, 1);
    if (outcome === "disconnected") next.destroy();
    const closing = outcome === "gateway-closed" ? f.manager.close() : Promise.resolve();
    if (outcome === "failed-stop") stopping.reject(new Error("synthetic-stop-failure"));
    else stopping.resolve();
    await Promise.all([opening, closing]); await settle();
    if (outcome === "gateway-closed") assert.equal(stops, 1);
    if (outcome === "restart") {
      assert.equal(starts, 2);
      assert.equal(next.destroyed, false);
      assert.equal(f.state.getCamera(camera.serial).stream.state, "streaming");
    } else {
      assert.equal(starts, 1);
      assert.equal(next.destroyed, true);
      if (outcome === "failed-stop") {
        const blocked = response();
        await f.manager.addClient(camera.serial, blocked);
        assert.equal(blocked.destroyed, true);
        assert.equal(starts, 1);
        f.manager.markStopped(camera.serial);
        await f.manager.addClient(camera.serial, response());
        assert.equal(starts, 2);
      }
    }
  } finally { stopping.resolve(); await opening; await f.manager.close(); }
});

test("a retiring private source still refuses public viewers immediately", async () => {
  const stopping = deferred();
  const abort = new AbortController();
  let starts = 0, refused = false;
  const f = fixture({ async startStream() { starts++; f.manager.attachSource(camera.serial, new PassThrough()); },
    async stopStream() { await stopping.promise; f.manager.markStopped(camera.serial); } });
  const recording = assert.rejects(f.manager.recordClip(camera.serial, 1, 5000, true, abort.signal));
  let opening: Promise<void> | undefined;
  try {
    await settle();
    await assert.rejects(f.manager.addClient(camera.serial, response()));
    abort.abort(); await settle();
    const next = response();
    opening = assert.rejects(f.manager.addClient(camera.serial, next), /private video test/)
      .then(() => { refused = true; });
    await settle();
    assert.equal(refused, true);
    assert.equal(f.state.getCamera(camera.serial).stream.viewers, 0);
    assert.equal(starts, 1);
    stopping.resolve(); await Promise.all([recording, opening]);
    const admitted = response();
    await f.manager.addClient(camera.serial, admitted);
    assert.equal(starts, 2);
    assert.equal(admitted.destroyed, false);
  } finally { abort.abort(); stopping.resolve(); await recording; await opening; await f.manager.close(); }
});

for (const transport of [false, true]) test(`viewer duration includes the retirement wait: transport=${transport}`, async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  context.mock.method(performance, "now", () => now);
  const stopping = deferred();
  const durations: number[] = [];
  const f = fixture({ async startStream() { f.manager.attachSource(camera.serial, new PassThrough()); },
    async stopStream() { await stopping.promise; f.manager.markStopped(camera.serial); } }, 5);
  f.manager.on("viewer-client-stopped", (summary: { durationMilliseconds: number }) => durations.push(summary.durationMilliseconds));
  const first = response();
  await f.manager.addClient(camera.serial, first);
  first.destroy(); await settle(); context.mock.timers.tick(6);
  now = 100;
  const next = response();
  const opening = transport ? f.manager.addTransportClient(camera.serial, next) : f.manager.addClient(camera.serial, next);
  try {
    await settle(); now = 1600; stopping.resolve(); await opening;
    now = 1610; next.destroy(); await settle();
    assert.equal(durations.at(-1), 1510);
  } finally { stopping.resolve(); await opening; await f.manager.close(); }
});

for (const transport of [false, true]) test(`an already disconnected viewer never starts a source: transport=${transport}`, async () => {
  let starts = 0;
  const f = fixture({ async startStream() { starts++; }, async stopStream() {} });
  const disconnected = response();
  disconnected.destroy();
  try {
    if (transport) await f.manager.addTransportClient(camera.serial, disconnected);
    else await f.manager.addClient(camera.serial, disconnected);
    assert.equal(starts, 0);
    assert.equal(f.state.getCamera(camera.serial).stream.viewers, 0);
  } finally { await f.manager.close(); }
});
