/**
 * Exercises which NVR views may move a call through real provider and media
 * manager boundaries. The session is synthetic, and Eufy is never contacted.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { LiveStreamManager } from "../src/stream/live-stream-manager.js";
import { NvrTrialError } from "../src/stream/nvr-protocol.js";
import { NvrRtcSession, type NvrRtcOptions, type NvrSwitchTarget } from "../src/stream/nvr-rtc-session.js";

const a = "synthetic-camera-a", b = "synthetic-camera-b", view = (name: string) => `synthetic-view-${name}-0000`;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const settled = async () => { for (let index = 0; index < 20; index++) await tick(); };

/** A viewer response the manager can write to and end. */
function viewer() {
  const response = new PassThrough() as PassThrough & { writeHead: (status: number, headers?: unknown) => void; ended: boolean };
  response.writeHead = () => {}; response.ended = false; response.resume();
  response.once("end", () => { response.ended = true; });
  return response;
}

async function fixture(context: TestContext, parent: "T8N00" | "T9000" = "T8N00") {
  const directory = await mkdtemp(join(tmpdir(), "nvr-switch-"));
  context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.getter(MegaClient.prototype, "isAuthenticated", () => true);
  const model = parent === "T8N00" ? { device_model: "T8E00", device_type: 301 } : { device_model: "T8140-Z", device_type: 14 };
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
    { device_sn: "synthetic-station", device_model: parent, device_type: parent === "T8N00" ? 300 : 27, category: "eufy_security", member: { admin_user_id: "synthetic-owner" } },
    ...[a, b].map((device_sn, device_channel) => ({ device_sn, ...model, category: "eufy_security", parent_sn: "synthetic-station", device_channel, member: { admin_user_id: "synthetic-owner" } })),
  ] }));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
  
  context.mock.method(process.stderr, "write", (() => true) as typeof process.stderr.write);
  let joins = 0, failSwitch = false;
  const sessions: NvrRtcSession[] = [], switches: NvrSwitchTarget[] = [];
  context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => {
    joins++;
    return { host: "security-smart-ie.eufylife.com", region: "IE", authToken: "synthetic", gtoken: "synthetic", sign: "synthetic" };
  });
  context.mock.method(NvrRtcSession.prototype, "start", async function(this: NvrRtcSession) {
    sessions.push(this);
    (Reflect.get(this, "options") as NvrRtcOptions).ready(this.output, () => "h264");
    this.output.write(Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 0x1e, 0x80]));
  });
  context.mock.getter(NvrRtcSession.prototype, "switchable", () => true);
  context.mock.method(NvrRtcSession.prototype, "switchCamera", async function(this: NvrRtcSession, target: NvrSwitchTarget) {
    switches.push(target);
    const next = new PassThrough();

    // Retiring the synthetic call ends its output and detaches the old owner's abort, as a move does.
    void this.close();
    Reflect.set(this, "options", { ...Reflect.get(this, "options") as NvrRtcOptions, ...target });
    context.mock.getter(this, "output", () => next);
    await tick();
    if (failSwitch) throw new NvrTrialError("video", "switch_no_picture");
    target.ready(next, () => "h264");
    next.write(Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 0x1e, 0x80]));
    return 140;
  });
  const state = new GatewayState();
  let manager!: LiveStreamManager;
  const events = new Proxy({
    camera: (value: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(value),
    streamStarted: (id: string, output: PassThrough, codec: () => "h264") => manager.attachSource(id, output, codec),
    streamStopped: (id: string) => manager.markStopped(id),
  }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: directory,
    maxStreamSeconds: 120, experimentalNvrLive: true, normalNvrLive: true });
  const fakeProcess = () => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as ChildProcessWithoutNullStreams;
  manager = new LiveStreamManager(state, {} as never, provider, 5, undefined, fakeProcess, fakeProcess);
  manager.on("warning", () => {});
  provider.setNvrLiveMediaChecks({ viewer: serial => manager.hasActiveViewer(serial), active: serial => manager.hasActiveSession(serial),
    recording: serial => manager.hasActiveRecording(serial), yieldable: serial => manager.canYieldSource(serial) });
  await provider.start(events);
  return { manager, provider, sessions, switches, joins: () => joins, failSwitch: () => { failSwitch = true; },
    close: async () => { await manager.close(); await provider.close(); await tick(); await rm(directory, { recursive: true, force: true }); } };
}

const open = async (value: Awaited<ReturnType<typeof fixture>>, serial: string, mark?: string) => {
  const response = viewer();
  await value.manager.addClient(serial, response as never, "native", mark);
  await settled();
  return response;
};

test("a new marked view moves the call and ends the old view cleanly", async context => {
  const value = await fixture(context);
  try {
    const first = await open(value, a, view("a"));
    assert.equal(value.manager.canYieldSource(a), true);
    const second = await open(value, b, view("b"));
    assert.equal(value.joins(), 1);
    assert.deepEqual(value.switches.map(row => row.camera), [b]);
    assert.equal(first.ended, true); assert.equal(first.destroyed && !first.ended, false);
    assert.equal(second.destroyed, false);
    assert.equal(value.manager.hasActiveSession(a), false);
    assert.equal(value.manager.hasActiveViewer(b), true);
  } finally { await value.close(); }
});

test("a camera that lost the call cannot take it back with its old URL", async context => {
  const value = await fixture(context);
  try {
    await open(value, a, view("a"));
    const second = await open(value, b, view("b"));
    const retry = await open(value, a, view("a"));
    assert.equal(retry.destroyed, true);
    assert.equal(value.switches.length, 1);
    assert.equal(second.destroyed, false);

    // A person opening that camera again carries a new mark and does take it.
    const reopened = await open(value, a, view("a-again"));
    assert.equal(reopened.destroyed, false);
    assert.deepEqual(value.switches.map(row => row.camera), [b, a]);
  } finally { await value.close(); }
});

test("a refused view keeps its mark for Home Assistant's retry", async context => {
  const value = await fixture(context);
  try {
    await open(value, a, view("a"));
    let release!: () => void;
    const held = value.manager.withActiveViewer(a, () => new Promise<void>(resolve => { release = resolve; }));
    await settled();
    const refused = await open(value, b, view("b"));
    assert.equal(refused.destroyed, true);
    release(); await held; await settled();
    const retried = await open(value, b, view("b"));
    assert.equal(retried.destroyed, false);
    assert.deepEqual(value.switches.map(row => row.camera), [b]);
  } finally { await value.close(); }
});

test("an unmarked viewer keeps the call and an unmarked open never takes it", async context => {
  const value = await fixture(context);
  try {
    const unmarked = await open(value, a);
    assert.equal(value.manager.canYieldSource(a), false);
    const marked = await open(value, b, view("b"));
    assert.equal(marked.destroyed, true);
    assert.equal(unmarked.destroyed, false);
    assert.equal(value.switches.length, 0);
    unmarked.destroy(); await settled();
  } finally { await value.close(); }
  const other = await fixture(context);
  try {
    const watched = await open(other, a, view("a"));
    const plain = await open(other, b);
    assert.equal(plain.destroyed, true);
    assert.equal(watched.destroyed, false);
    assert.equal(other.switches.length, 0);
  } finally { await other.close(); }
});

test("a lease or a recording keeps the call", async context => {
  const value = await fixture(context);
  try {
    const first = await open(value, a, view("a"));
    let release!: () => void;
    const held = value.manager.withActiveViewer(a, () => new Promise<void>(resolve => { release = resolve; }));
    await settled();
    assert.equal(value.manager.canYieldSource(a), false);
    const refused = await open(value, b, view("b"));
    assert.equal(refused.destroyed, true);
    assert.equal(first.destroyed, false);
    release(); await held; await settled();
    assert.equal(value.manager.canYieldSource(a), true);

    const clip = value.manager.recordClip(a, 5).catch(() => undefined);
    await settled();
    assert.equal(value.manager.canYieldSource(a), false);
    const blocked = await open(value, b, view("b-again"));
    assert.equal(blocked.destroyed, true);
    assert.equal(value.switches.length, 0);
    first.destroy(); await value.close(); await clip;
  } finally { await value.close(); }
});

test("a HomeBase route has no call to move", async context => {
  const value = await fixture(context, "T9000");
  try {
    await open(value, a, view("a"));
    const refused = await open(value, b, view("b"));
    assert.equal(refused.destroyed, true);
    assert.equal(value.switches.length, 0);
  } finally { await value.close(); }
});

test("a failed move closes the call and opens a fresh one for the new viewer", async context => {
  const value = await fixture(context);
  try {
    const first = await open(value, a, view("a"));
    value.failSwitch();
    const second = await open(value, b, view("b"));
    await settled();
    assert.equal(first.ended, true);
    assert.equal(second.destroyed, false);
    assert.equal(value.joins(), 2);
    assert.equal(value.sessions.length, 2);
    assert.equal(value.manager.hasActiveViewer(b), true);
  } finally { await value.close(); }
});
