/**
 * Exercises NVR lease retirement and viewer handoff through real provider and
 * media-manager boundaries. Fixtures own fake cloud/session/process effects.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import { LiveStreamManager } from "../src/stream/live-stream-manager.js";
import { NvrRtcSession } from "../src/stream/nvr-rtc-session.js";
import { NvrTrialError } from "../src/stream/nvr-protocol.js";

const serial = "synthetic-camera";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** Build an offline normal-route provider with an optionally real media manager. */
async function fixture(context: TestContext, withManager = false) {
  const directory = await mkdtemp(join(tmpdir(), "nvr-reopen-"));
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.getter(MegaClient.prototype, "isAuthenticated", () => true);
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
    { device_sn: "synthetic-station", device_model: "T8N00", device_type: 300, category: "eufy_security", member: { admin_user_id: "synthetic-owner" } },
    { device_sn: serial, device_model: "T8E00", device_type: 301, category: "eufy_security", parent_sn: "synthetic-station", device_channel: 3, member: { admin_user_id: "synthetic-owner" } },
  ] }));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
  let joins = 0, stopped = 0, held = false, failClose = false, enterClose!: () => void, finishClose!: () => void;
  const closing = new Promise<void>(resolve => { finishClose = resolve; });
  const closeEntered = new Promise<void>(resolve => { enterClose = resolve; });
  const sessions: NvrRtcSession[] = [], closed: NvrRtcSession[] = [], logs: string[] = [], unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  context.mock.method(process.stderr, "write", ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stderr.write);
  context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => {
    joins++;
    return { host: "security-smart-ie.eufylife.com", region: "IE", authToken: "synthetic", gtoken: "synthetic", sign: "synthetic" };
  });
  context.mock.method(NvrRtcSession.prototype, "start", async function(this: NvrRtcSession) {
    sessions.push(this);
    const options = Reflect.get(this, "options") as { ready: (output: PassThrough, codec: () => "h264") => void };
    options.ready(this.output, () => "h264");
  });
  const retireSession = NvrRtcSession.prototype.close;
  context.mock.method(NvrRtcSession.prototype, "close", async function(this: NvrRtcSession) {
    const retired = retireSession.call(this);
    closed.push(this);
    if (this === sessions[0]) {
      enterClose();
      if (held) await closing;
      if (failClose) throw Error("Synthetic cleanup failure");
    }
    await retired;
  });
  const state = new GatewayState();
  let manager: LiveStreamManager | undefined;
  const events = new Proxy({
    camera: (value: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(value),
    streamStarted: (id: string, output: PassThrough, codec: () => "h264") => manager?.attachSource(id, output, codec),
    streamStopped: (id: string) => { stopped++; manager?.markStopped(id); },
  }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: directory,
    maxStreamSeconds: 120, experimentalNvrLive: true, normalNvrLive: true });
  if (withManager) {
    const fakeProcess = () => Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;
    manager = new LiveStreamManager(state, {} as never, provider, 5, undefined, fakeProcess, fakeProcess);
    manager.on("warning", () => {});
  }
  await provider.start(events);
  return { provider, events, manager, sessions, closed, closeEntered, state,
    joins: () => joins, stopped: () => stopped, hold: () => { held = true; }, finish: () => finishClose(), failClose: () => { failClose = true; },
    close: async () => {
      finishClose();
      try { await manager?.close(); await provider.close(); await tick(); }
      finally {
        process.off("unhandledRejection", onUnhandled);
        await rm(directory, { recursive: true, force: true });
      }
      assert.equal(network.mock.callCount(), 0);
      assert.deepEqual(unhandled, []);
      assert.ok(logs.every(line => !line.includes(serial) && !line.includes("synthetic-station")));
    },
  };
}

for (const event of ["error", "end", "close", "finish"] as const) {
  test(`${event} retires an established normal NVR lease before reopen`, async context => {
    const f = await fixture(context);
    try {
      await f.provider.startStream(serial);
      const old = f.sessions[0]!;
      if (event === "error") old.output.destroy(new NvrTrialError("video", "signalling_closed"));
      else if (event === "end") { old.output.resume(); await old.close(); }
      else if (event === "finish") await old.close();
      else old.output.destroy();
      await tick(); await tick();
      await f.provider.startStream(serial);
      assert.equal(f.joins(), 2);
      assert.equal(f.sessions.length, 2);
      assert.notEqual(f.sessions[0], f.sessions[1]);
    } finally { await f.close(); }
  });
}

test("concurrent reopen requests wait for delayed retirement and share one replacement", async context => {
  const f = await fixture(context);
  try {
    await f.provider.startStream(serial); f.hold();
    f.sessions[0]!.output.destroy(new NvrTrialError("video", "signalling_closed"));
    await f.closeEntered;
    const first = f.provider.startStream(serial), second = f.provider.startStream(serial);
    await tick(); assert.equal(f.sessions.length, 1);
    f.finish(); await Promise.all([first, second]);
    assert.equal(f.sessions.length, 2); assert.equal(f.joins(), 2);
    assert.equal(f.stopped(), 0, "old retirement must not reset a waiting media-manager start");
    f.sessions[0]!.output.emit("close"); f.sessions[0]!.output.emit("error", new NvrTrialError("video"));
    await tick();
    assert.equal(f.closed.filter(session => session === f.sessions[1]).length, 0);
    assert.equal(f.stopped(), 0);
  } finally { await f.close(); }
});

test("cleanup rejection retires the lease without an unhandled rejection", async context => {
  const f = await fixture(context);
  try {
    await f.provider.startStream(serial); f.failClose();
    f.sessions[0]!.output.destroy(new NvrTrialError("video"));
    await tick(); await tick();
    await f.provider.startStream(serial);
    assert.equal(f.sessions.length, 2);
  } finally { await f.close(); }
});

for (const interruption of ["stop", "shutdown", "generation"] as const) {
  test(`${interruption} during retirement prevents a stale reopen`, async context => {
    const f = await fixture(context);
    try {
      await f.provider.startStream(serial); f.hold();
      f.sessions[0]!.output.destroy(new NvrTrialError("video")); await f.closeEntered;
      const waiting = f.provider.startStream(serial);
      const rejected = assert.rejects(waiting, /cancelled/);
      const interruptionDone = interruption === "stop" ? f.provider.stopStream(serial)
        : interruption === "shutdown" ? f.provider.close() : f.provider.start(f.events);
      f.finish(); await rejected; await interruptionDone;
      assert.equal(f.sessions.length, 1);
    } finally { await f.close(); }
  });
}

test("a retiring diagnostic lease rejects without waiting or becoming normal routing", async context => {
  const f = await fixture(context);
  try {
    const release = f.provider.reserveNvrLiveTrial(serial, new AbortController().signal);
    await f.provider.startStream(serial); f.hold();
    const released = release(); await f.closeEntered;
    await assert.rejects(f.provider.startStream(serial), /cancelled/);
    assert.equal(f.sessions.length, 1);
    f.finish(); await released;
  } finally { await f.close(); }
});

test("real media manager keeps the replacement viewer owned and serving during cleanup handoff", async context => {
  const f = await fixture(context, true);
  const viewer = () => {
    const response = new PassThrough(); Object.assign(response, { writeHead: () => response });
    response.on("error", () => {});
    return response;
  };
  try {
    const first = viewer(); await f.manager!.addClient(serial, first as unknown as ServerResponse);
    f.hold(); f.sessions[0]!.output.resume(); const oldClosed = f.sessions[0]!.close(); await f.closeEntered; await tick();
    assert.equal(first.writableEnded, true);
    const next = viewer(), bytes: Buffer[] = [];
    next.on("data", (data: Buffer) => bytes.push(data));
    const opening = f.manager!.addClient(serial, next as unknown as ServerResponse);
    await tick(); f.finish(); await oldClosed; await opening;
    assert.equal(next.writableEnded, false);
    assert.equal(f.manager!.hasActiveSession(serial), true);
    const nal = (...data: number[]) => Buffer.from([0, 0, 0, 1, ...data]);
    f.sessions[1]!.output.write(Buffer.concat([nal(0x67, 0x42, 0, 0x1f), nal(0x68, 0xce), nal(0x65, 0x80)]));
    assert.ok(Buffer.concat(bytes).length > 0);
    assert.equal(f.stopped(), 0);
  } finally { await f.close(); }
});
