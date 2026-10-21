/**
 * Protects source-video isolation above test-owned camera streams and media
 * processes. The manager owns viewer lifetimes, while these fixtures expose
 * byte delivery, conversion use and independent client retirement.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { VideoCodec } from "../src/domain/types.js";
import { LiveStreamManager, type ViewerClientSummary } from "../src/stream/live-stream-manager.js";

function media(codec: VideoCodec): Buffer {
  const nal = (...bytes: number[]): Buffer => Buffer.from([0, 0, 0, 1, ...bytes]);
  return codec === "h265"
    ? Buffer.concat([nal(0x40, 1, 12), nal(0x42, 1, 1), nal(0x44, 1, 0xc0), nal(0x26, 1, 0x80)])
    : Buffer.concat([nal(0x67, 0x42, 0, 0x1f), nal(0x68, 0xce, 6), nal(0x65, 0x80)]);
}

function response(): { sink: ServerResponse; bytes: Buffer[]; headers: string[] } {
  const sink = new PassThrough() as unknown as ServerResponse;
  const bytes: Buffer[] = [], headers: string[] = [];
  sink.on("data", (chunk: Buffer) => bytes.push(Buffer.from(chunk)));
  sink.on("error", () => {});
  sink.writeHead = ((_status: number, values: Record<string, string>) => {
    headers.push(values["Content-Type"]!);
    Object.defineProperty(sink, "headersSent", { configurable: true, value: true });
    return sink;
  }) as ServerResponse["writeHead"];
  return { sink, bytes, headers };
}

function fixture(initialCodec: VideoCodec) {
  const state = new GatewayState();
  state.registerCamera({ serial: "fixture", name: "Synthetic", model: "T8171", stationSerial: "fixture",
    streamSupported: true, doorbellSupported: false });
  let codec = initialCodec;
  let starts = 0, conversions = 0, kills = 0;
  const source = new PassThrough();
  const process = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { kills++; return true; } }) as unknown as ChildProcessWithoutNullStreams;
  const snapshot = (): ChildProcessWithoutNullStreams => Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  const manager = new LiveStreamManager(state, {} as never, {
    async startStream() { starts++; manager.attachSource("fixture", source, () => codec); },
    async stopStream() { source.end(); },
  }, 5, undefined, () => { conversions++; return process; }, snapshot);
  manager.on("warning", () => {});
  return { manager, source, process, get starts() { return starts; }, get conversions() { return conversions; }, get kills() { return kills; },
    setCodec(value: VideoCodec) { codec = value; } };
}

for (const codec of ["h264", "h265"] as const) test(`native-only ${codec} starts and late-joins without conversion or duplicate input`, async () => {
  const f = fixture(codec), first = response(), late = response();
  const summaries: ViewerClientSummary[] = [];
  f.manager.on("viewer-client-stopped", value => summaries.push(value));
  try {
    await f.manager.addClient("fixture", first.sink, "native");
    const bytes = media(codec);
    f.source.write(bytes);
    assert.deepEqual(Buffer.concat(first.bytes), bytes);
    assert.deepEqual(first.headers, [`video/${codec}`]);
    await f.manager.addClient("fixture", late.sink, "native");
    assert.deepEqual(Buffer.concat(late.bytes), bytes);
    assert.equal(f.conversions, 0);
    assert.equal(f.starts, 1);
    first.sink.emit("close");
    assert.equal(summaries[0]?.profile, "native");
    assert.equal(late.sink.destroyed, false);
  } finally { await f.manager.close(); }
});

test("mixed H.265 viewers get only their own encoding and native survives a conversion failure", async () => {
  const f = fixture("h265"), native = response(), compatible = response(), late = response();
  try {
    await f.manager.addClient("fixture", native.sink, "native");
    await f.manager.addClient("fixture", compatible.sink);
    const sourceBytes = media("h265"), converted = media("h264");
    f.source.write(sourceBytes);
    assert.deepEqual(Buffer.concat(native.bytes), sourceBytes);
    assert.equal(compatible.bytes.length, 0);
    assert.equal(f.conversions, 1);
    (f.process.stdout as PassThrough).write(converted);
    assert.deepEqual(Buffer.concat(native.bytes), sourceBytes);
    assert.ok(Buffer.concat(compatible.bytes).includes(converted));
    await f.manager.addClient("fixture", late.sink, "native");
    assert.deepEqual(Buffer.concat(late.bytes), sourceBytes);
    f.process.emit("error", new Error("synthetic converter failure"));
    assert.equal(native.sink.destroyed, false);
    assert.equal(late.sink.destroyed, false);
    assert.equal(compatible.sink.destroyed, true);
    f.source.write(Buffer.from([0, 0, 0, 1, 2, 1, 0x80]));
    assert.equal(f.conversions, 1);
    assert.ok(Buffer.concat(native.bytes).length > sourceBytes.length);
  } finally { await f.manager.close(); }
});

test("the last compatible viewer retires its converter while native remains", async () => {
  const f = fixture("h265"), native = response(), compatible = response();
  try {
    await f.manager.addClient("fixture", native.sink, "native");
    await f.manager.addClient("fixture", compatible.sink);
    f.source.write(media("h265"));
    compatible.sink.emit("close");
    assert.ok(f.kills > 0);
    assert.equal(native.sink.destroyed, false);
    assert.equal(f.conversions, 1);
  } finally { await f.manager.close(); }
});

test("a native codec change ends the old response before incompatible bytes", async () => {
  const f = fixture("h265"), native = response();
  try {
    await f.manager.addClient("fixture", native.sink, "native");
    const original = media("h265");
    f.source.write(original);
    f.setCodec("h264");
    f.source.write(media("h264"));
    assert.equal(native.sink.writableEnded, true);
    assert.deepEqual(native.headers, ["video/h265"]);
    assert.deepEqual(Buffer.concat(native.bytes), original);
  } finally { await f.manager.close(); }
});
