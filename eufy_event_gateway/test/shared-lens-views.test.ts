/**
 * Tests shared pane ownership and real crop output using synthetic media only.
 * Fake pipes own backpressure/lifecycle failures. Real FFmpeg fixtures qualify
 * layout and decodability, never NVR hardware, lens ordering or account access.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { decode } from "jpeg-js";
import { GatewayState } from "../src/domain/gateway-state.js";
import { LiveStreamManager, VideoParameterSetCache } from "../src/stream/live-stream-manager.js";
import { SharedLensSnapshotCache, SharedLensViews, sharedLensConverterArguments, sharedLensSnapshot, type SharedLensCloseReason } from "../src/stream/shared-lens-views.js";
import type { VideoViewerResponse } from "../src/stream/live-transport-muxer.js";

/** Owns one response's bytes without a network client. */
class Viewer extends PassThrough implements VideoViewerResponse {
  headersSent = false;
  readonly chunks: Buffer[] = [];
  constructor() { super(); this.on("data", (chunk: Buffer) => this.chunks.push(Buffer.from(chunk))); }
  writeHead(): this { this.headersSent = true; return this; }
}

function processFixture() {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(), movable = new PassThrough();
  stdin.resume();
  return Object.assign(new EventEmitter(), { stdin, stdout, stderr, stdio: [stdin, stdout, stderr, movable], kill: () => true }) as unknown as ChildProcess;
}

function pairFixture(admitted = () => true) {
  const process = processFixture(), reasons: SharedLensCloseReason[] = [];
  let made = 0, stopped = 0;
  const pair = new SharedLensViews(() => new VideoParameterSetCache(), () => { made++; return process; },
    () => { stopped++; }, reason => reasons.push(reason), admitted);
  const fixed = new Viewer(), movable = new Viewer();
  pair.add("fixed", fixed); pair.add("movable", movable);
  pair.input.writeHead(200, { "Content-Type": "video/h265" });
  return { pair, process, fixed, movable, reasons, made: () => made, stopped: () => stopped };
}

const h264 = Buffer.from([0,0,0,1,0x67,0x42,0,0x1f,0xaa,0,0,0,1,0x68,0xce,0,0,0,1,0x65,0xaa,0,0,0,1,0x09,0xf0]);
const h265 = Buffer.from([0,0,0,1,0x40,1,0xaa,0,0,0,1,0x42,1,0xbb,0,0,0,1,0x44,1,0xcc,0,0,0,1,0x26,1,0xdd,0,0,0,1,0x46,1,0]);

test("two pane groups share one decoder, close independently, and replay only their own startup", async () => {
  const h = pairFixture();
  try {
    h.process.stdout!.emit("data", h264);
    const bottom = Buffer.from(h264); bottom[bottom.length - 1] = 7;
    h.process.stdio[3]!.emit("data", bottom);
    assert.equal(h.made(), 1);
    assert.ok(Buffer.concat(h.fixed.chunks).includes(0xaa));
    assert.equal(Buffer.concat(h.movable.chunks).at(-1), 7);
    const late = new Viewer(); h.pair.add("movable", late);
    assert.equal(Buffer.concat(late.chunks).at(-1), 7);
    h.fixed.destroy(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.stopped(), 0); assert.equal(h.movable.destroyed, false);
    h.movable.destroy(); late.destroy(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.stopped(), 1); assert.equal(h.pair.input.destroyed, true);
    assert.deepEqual(h.reasons, ["clients_closed"]);
  } finally { h.pair.close(); }
});

test("a slow pane client does not close the other pane or grow a response queue", () => {
  const h = pairFixture();
  try {
    Object.defineProperty(h.fixed, "writableLength", { get: () => 1024 * 1024 });
    h.process.stdout!.emit("data", h264); h.process.stdio[3]!.emit("data", h264);
    assert.equal(h.fixed.destroyed, true); assert.equal(h.movable.destroyed, false);
    assert.ok(h.movable.chunks.length > 0);
  } finally { h.pair.close(); }
});

for (const mode of ["backlog", "admission", "source", "process"] as const) {
  test(`shared decoder retires both panes on ${mode} and ignores late output`, () => {
    let admitted = true;
    const h = pairFixture(() => admitted);
    if (mode === "backlog") h.pair.input.write(Buffer.alloc(2 * 1024 * 1024 + 1));
    if (mode === "admission") { admitted = false; h.process.stdout!.emit("data", h264); }
    if (mode === "source") h.pair.input.emit("end");
    if (mode === "process") h.process.emit("error", Error("PRIVATE-CANARY"));
    assert.equal(h.fixed.destroyed, true); assert.equal(h.movable.destroyed, true);
    assert.equal(h.stopped(), 1);
    h.process.stdout!.emit("data", h264); assert.equal(h.fixed.chunks.length, 0);
    assert.equal(h.reasons.length, 1); assert.doesNotMatch(JSON.stringify(h.reasons), /PRIVATE/);
  });
}

test("one missing branch retains the startup deadline and retires its source", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const h = pairFixture();
  h.process.stdout!.emit("data", h264);
  context.mock.timers.tick(30_001);
  assert.equal(h.stopped(), 1); assert.deepEqual(h.reasons, ["startup_timeout"]);
});

test("the manager shares one native source and protects its call until both panes leave", async () => {
  const state = new GatewayState();
  state.registerCamera({ serial: "test", name: "Synthetic", model: "T8E00", stationSerial: "station", streamSupported: true,
    doorbellSupported: false, nvrLiveControlsSupported: true, nvrSelectedView: 2 });
  const source = new PassThrough(); let starts = 0, stops = 0, decoders = 0;
  let manager: LiveStreamManager;
  const process = processFixture();
  manager = new LiveStreamManager(state, {} as never, {
    async startStream() { starts++; manager.attachSource("test", source); }, async stopStream() { stops++; },
  }, 0, undefined, undefined, () => processFixture() as never, 30_000, undefined, false, () => { decoders++; return process; });
  const fixed = new Viewer(), movable = new Viewer();
  try {
    await Promise.all([manager.addLensClient("test", "fixed", fixed), manager.addLensClient("test", "movable", movable)]);
    source.write(h265);
    assert.equal(starts, 1); assert.equal(decoders, 1);
    assert.equal(manager.canYieldSource("test"), false);
    fixed.destroy(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(stops, 0); assert.equal(movable.destroyed, false);
    await manager.close(); assert.equal(movable.destroyed, true);
  } finally { await manager.close(); }
});

/** Generate a real red top pane and blue bottom pane without any device pixels. */
function media(width = 1280, height = 1440, jpeg = false): Buffer {
  return execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    `color=red:size=${width}x${height}:rate=10,drawbox=x=0:y=${height / 2}:w=iw:h=${height / 2}:color=blue:t=fill`,
    "-frames:v", jpeg ? "1" : "12", ...(jpeg ? ["-c:v", "mjpeg", "-f", "image2pipe"]
      : ["-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error:pools=1:bframes=0", "-f", "hevc"]), "pipe:1"],
  { maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] });
}

function assertPane(bytes: Buffer, color: "red" | "blue", raw = false): void {
  const jpeg = raw ? execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "h264", "-i", "pipe:0",
    "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"], { input: bytes }) : bytes;
  const image = decode(jpeg); assert.deepEqual([image.width, image.height], [1280, 720]);
  const offset = (360 * 1280 + 640) * 4;
  assert.ok(image.data[offset + (color === "red" ? 0 : 2)]! > 200);
  assert.ok(image.data[offset + (color === "red" ? 2 : 0)]! < 30);
}

test("real shared decoding produces independent correct 720p panes and rejects another geometry", () => {
  const result = spawnSync("ffmpeg", sharedLensConverterArguments("h265"),
    { input: media(), stdio: ["pipe", "pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString());
  assertPane(result.stdout, "red", true); assertPane(result.output[3] as Buffer, "blue", true);
  const wrong = spawnSync("ffmpeg", sharedLensConverterArguments("h265"),
    { input: media(1280, 720), stdio: ["pipe", "pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  assert.notEqual(wrong.status, 0); assert.equal(wrong.stdout.length, 0); assert.equal((wrong.output[3] as Buffer).length, 0);
});

test("retained pane snapshots contain the right pixels and reject whole single-lens images", async () => {
  const jpeg = media(1280, 1440, true);
  assertPane((await sharedLensSnapshot(jpeg, "fixed"))!, "red");
  assertPane((await sharedLensSnapshot(jpeg, "movable"))!, "blue");
  assert.equal(await sharedLensSnapshot(media(1280, 720, true), "fixed"), null);
  assert.equal(await sharedLensSnapshot(Buffer.from("PRIVATE invalid JPEG"), "movable"), null);
});


test("snapshot crops deduplicate revisions, cap concurrent work, and discard late invalidated results", async () => {
  let made = 0;
  const releases: ((value: Buffer) => void)[] = [];
  const cache = new SharedLensSnapshotCache(async () => { made++; return await new Promise(resolve => releases.push(resolve)); });
  const first = cache.read("test", "1", Buffer.alloc(0), "fixed");
  const same = cache.read("test", "1", Buffer.alloc(0), "fixed");
  const second = cache.read("test", "1", Buffer.alloc(0), "movable");
  await Promise.resolve(); assert.equal(made, 2);
  assert.equal(await cache.read("other", "1", Buffer.alloc(0), "fixed"), null);
  assert.equal(await cache.read("test", "2", Buffer.alloc(0), "fixed"), null);
  cache.clear(); releases[0]!(Buffer.from("old")); releases[1]!(Buffer.from("old"));
  assert.deepEqual(await Promise.all([first, same, second]), [null, null, null]);
  const fresh = cache.read("test", "1", Buffer.alloc(0), "fixed");
  await Promise.resolve(); assert.equal(made, 3); releases[2]!(Buffer.from("new"));
  assert.equal((await fresh)?.toString(), "new");
});

test("closing the last pane preserves a recording lease on the physical source", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const state = new GatewayState();
  state.registerCamera({ serial: "test", name: "Synthetic", model: "T8E00", stationSerial: "station", streamSupported: true,
    doorbellSupported: false, nvrLiveControlsSupported: true, nvrSelectedView: 2 });
  const source = new PassThrough(); let starts = 0, stops = 0;
  let manager: LiveStreamManager;
  manager = new LiveStreamManager(state, {} as never, {
    async startStream() { starts++; manager.attachSource("test", source); },
    async stopStream() { stops++; source.end(); },
  }, 0, async video => video, undefined, () => processFixture() as never, 30_000, undefined, false, processFixture);
  const fixed = new Viewer(), movable = new Viewer();
  try {
    await Promise.all([manager.addLensClient("test", "fixed", fixed), manager.addLensClient("test", "movable", movable)]);
    source.write(h265);
    const recording = manager.recordClip("test", 1, 500);
    await Promise.resolve(); source.write(h265);
    fixed.destroy(); movable.destroy(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 1); assert.equal(stops, 0); assert.equal(manager.hasActiveSession("test"), true);
    context.mock.timers.tick(1000);
    assert.ok((await recording).length > 0);
    context.mock.timers.tick(1); await Promise.resolve();
    assert.equal(stops, 1);
  } finally { await manager.close(); }
});


test("continuously unread decoder input retires the pair after two seconds", () => {
  let now = 0;
  const process = processFixture(), reasons: SharedLensCloseReason[] = [];
  const input = process.stdin!;
  input.write = (() => false) as typeof input.write;
  const pair = new SharedLensViews(() => new VideoParameterSetCache(), () => process, () => {},
    reason => reasons.push(reason), () => true, 30_000, () => now);
  pair.add("fixed", new Viewer()); pair.input.writeHead(200, { "Content-Type": "video/h265" });
  pair.input.write(Buffer.alloc(100)); now = 2001; pair.input.write(Buffer.alloc(100));
  assert.deepEqual(reasons, ["input_backlog"]); assert.equal(pair.input.destroyed, true);
});
