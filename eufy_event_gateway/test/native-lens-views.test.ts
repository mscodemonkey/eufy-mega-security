/**
 * Tests native pane ownership with synthetic calls and viewers only.
 * The fake provider call owns the bytes and hang-up count. Nothing here
 * qualifies NVR hardware, lens order or the NVR's call limit.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import { LiveStreamManager, VideoParameterSetCache } from "../src/stream/live-stream-manager.js";
import { NativeLensView, type NativeLensCloseReason, type NvrLensCall } from "../src/stream/native-lens-views.js";
import type { VideoViewerResponse } from "../src/stream/live-transport-muxer.js";
import type { SharedLens } from "../src/stream/shared-lens-views.js";

/** Owns one response's bytes and headers without a network client. */
class Viewer extends PassThrough implements VideoViewerResponse {
  headersSent = false;
  contentType: unknown = null;
  readonly chunks: Buffer[] = [];
  constructor() { super(); this.on("data", (chunk: Buffer) => this.chunks.push(Buffer.from(chunk))); }
  writeHead(_status: number, headers: Record<string, unknown>): this { this.headersSent = true; this.contentType = headers["Content-Type"]; return this; }
}

/** One synthetic lens call that counts its hang-ups. */
function callFixture() {
  const output = new PassThrough();
  let closes = 0;
  const call: NvrLensCall = { output, codec: () => "h265", close: async () => { closes++; output.end(); } };
  return { call, output, closes: () => closes };
}

const keyframe = Buffer.from([0,0,0,1,0x40,1,0xaa, 0,0,0,1,0x42,1,0xbb, 0,0,0,1,0x44,1,0xcc, 0,0,0,1,0x26,1,0xdd]);
const delta = Buffer.from([0,0,0,1,0x02,1,0xee]);
const settle = async (): Promise<void> => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

function viewFixture(open: () => Promise<NvrLensCall>, admitted = () => true) {
  const reasons: NativeLensCloseReason[] = [];
  const view = new NativeLensView("fixed", open, new VideoParameterSetCache(), 10_000, admitted, reason => reasons.push(reason));
  return { view, reasons };
}

test("viewers share one native call, join at the current keyframe and get H.265 unconverted", async () => {
  const fake = callFixture(), { view } = viewFixture(async () => fake.call);
  const first = new Viewer(), late = new Viewer();
  try {
    await view.add(first);
    fake.output.write(keyframe); fake.output.write(delta); await settle();
    assert.equal(first.contentType, "video/h265");
    assert.deepEqual(Buffer.concat(first.chunks), Buffer.concat([keyframe, delta]));
    await view.add(late);
    assert.ok(Buffer.concat(late.chunks).subarray(0, keyframe.length).equals(keyframe), "a late viewer starts from the keyframe");
    fake.output.write(delta); await settle();
    assert.ok(Buffer.concat(late.chunks).subarray(-delta.length).equals(delta));
    assert.equal(fake.closes(), 0);
  } finally { view.close(); }
});

test("the last viewer leaving hangs up after the idle grace, and a return within it keeps the call", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = callFixture(), { view, reasons } = viewFixture(async () => fake.call);
  const first = new Viewer();
  await view.add(first);
  first.destroy(); await settle();
  context.mock.timers.tick(9_999); assert.equal(fake.closes(), 0);
  const second = new Viewer(); await view.add(second);
  context.mock.timers.tick(10_000); assert.equal(fake.closes(), 0, "a viewer inside the grace keeps the call");
  second.destroy(); await settle();
  context.mock.timers.tick(10_000); await settle();
  assert.equal(fake.closes(), 1); assert.deepEqual(reasons, ["clients_closed"]); assert.equal(view.closed, true);
});

test("a slow viewer closes alone without growing a response queue", async () => {
  const fake = callFixture(), { view } = viewFixture(async () => fake.call);
  const slow = new Viewer(), steady = new Viewer();
  try {
    await view.add(slow); await view.add(steady);
    Object.defineProperty(slow, "writableLength", { get: () => 4 * 1024 * 1024 });
    fake.output.write(keyframe); await settle();
    assert.equal(slow.destroyed, true); assert.equal(steady.destroyed, false);
    assert.ok(steady.chunks.length > 0); assert.equal(fake.closes(), 0);
  } finally { view.close(); }
});

for (const mode of ["end", "error", "admission"] as const) {
  test(`the call ending by ${mode} closes every viewer and hangs up once`, async () => {
    let admitted = true;
    const fake = callFixture(), { view, reasons } = viewFixture(async () => fake.call, () => admitted);
    const viewer = new Viewer();
    await view.add(viewer);
    if (mode === "end") fake.output.end();
    if (mode === "error") fake.output.destroy(new Error("synthetic loss"));
    if (mode === "admission") { admitted = false; fake.output.write(keyframe); }
    await settle();
    assert.equal(viewer.destroyed, true); assert.equal(view.closed, true);
    assert.deepEqual(reasons, [mode === "admission" ? "admission_changed" : "source_ended"]);
    view.close(); assert.equal(fake.closes(), 1);
  });
}

test("a refused or failed start destroys the waiting viewer and leaves no call", async () => {
  const { view, reasons } = viewFixture(async () => { throw new Error("call_budget"); });
  const viewer = new Viewer();
  await assert.rejects(view.add(viewer), /call_budget/);
  assert.equal(viewer.destroyed, true); assert.equal(view.closed, true); assert.deepEqual(reasons, ["start_failed"]);
});

test("a call that answers after its viewers have gone is hung up at once", async () => {
  const fake = callFixture();
  let answer!: (call: NvrLensCall) => void;
  const { view } = viewFixture(() => new Promise(resolve => { answer = resolve; }));
  const viewer = new Viewer();
  const added = view.add(viewer);
  view.close("gateway_closed");
  answer(fake.call); await added; await settle();
  assert.equal(fake.closes(), 1);
});

test("the manager gives each lens its own call, and closing one pane leaves the other running", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const state = new GatewayState();
  state.registerCamera({ serial: "test", name: "Synthetic", model: "T8E00", stationSerial: "station", streamSupported: true,
    doorbellSupported: false, nvrLiveControlsSupported: true, nvrSelectedView: 2 });
  const calls = new Map<SharedLens, ReturnType<typeof callFixture>>();
  let starts = 0;
  const manager = new LiveStreamManager(state, {} as never, {
    async startStream() { starts++; }, async stopStream() {},
    async openNvrLensCall(serial: string, lens: SharedLens) { assert.equal(serial, "test"); const fake = callFixture(); calls.set(lens, fake); return fake.call; },
  }, 10_000);
  const closed: unknown[] = [];
  manager.on("native-lens-closed", detail => closed.push(detail));
  try {
    const fixed = new Viewer(), movable = new Viewer(), secondFixed = new Viewer();
    await Promise.all([manager.addNativeLensClient("test", "fixed", fixed), manager.addNativeLensClient("test", "movable", movable),
      manager.addNativeLensClient("test", "fixed", secondFixed)]);
    assert.deepEqual([...calls.keys()].sort(), ["fixed", "movable"], "one call per lens, shared by that lens's viewers");
    assert.equal(starts, 0, "panes never open the camera's ordinary source");
    calls.get("fixed")!.output.write(keyframe); calls.get("movable")!.output.write(keyframe); await settle();
    fixed.destroy(); secondFixed.destroy(); await settle();
    context.mock.timers.tick(10_000); await settle();
    assert.equal(calls.get("fixed")!.closes(), 1); assert.equal(calls.get("movable")!.closes(), 0);
    calls.get("movable")!.output.write(delta); await settle();
    assert.equal(movable.destroyed, false); assert.ok(Buffer.concat(movable.chunks).subarray(-delta.length).equals(delta));
    assert.deepEqual(closed, [{ model: "T8E00", lens: "fixed", reason: "clients_closed" }]);
    const again = new Viewer(); await manager.addNativeLensClient("test", "fixed", again);
    assert.equal(calls.get("fixed")!.closes(), 0, "a fresh call after the old one closed");
    state.registerCamera({ ...state.getCamera("test"), nvrSelectedView: 1 });
    await assert.rejects(manager.addNativeLensClient("test", "movable", new Viewer()), /Both view/);
  } finally { await manager.close(); }
  assert.equal(calls.get("movable")!.closes(), 1, "shutdown hangs up every pane call");
});
