/**
 * Exercises media lifecycle policy above a fake provider byte stream.
 *
 * The cases cover one shared source for multiple consumers, fresh JPEG capture,
 * bounded MP4 recording, idle grace cleanup, and failure propagation without
 * opening a real PPCS socket.
 */
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";

import { GatewayState } from "../src/domain/gateway-state.js";
import {
  LiveStreamManager,
  SNAPSHOT_CAPTURE_TIMEOUT_MILLISECONDS,
  StreamCadenceTracker,
  terminateMediaProcess,
  VideoParameterSetCache,
  type ViewerClientSummary,
  type ViewerDeliverySummary,
  type ViewerTranscoderSummary,
} from "../src/stream/live-stream-manager.js";

const camera = {
  serial: "camera-1",
  name: "Doorbell",
  model: "T8210",
  stationSerial: "homebase-1",
  streamSupported: true,
  doorbellSupported: true,
};

test("ends both viewers and releases a source that stops producing bytes without reopening it", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const state = new GatewayState();
  state.registerCamera(camera);
  const snapshot = { capturedAt: new Date().toISOString(), contentType: "image/jpeg", source: "live" as const, revision: 1 };
  state.updateSnapshot(camera.serial, snapshot);
  let starts = 0;
  let stops = 0;
  let source = new PassThrough();
  let manager: LiveStreamManager;
  manager = new LiveStreamManager(state, {} as never, {
    async startStream() {
      starts++;
      source = new PassThrough();
      manager.attachSource(camera.serial, source);
    },
    async stopStream() { stops++; },
  }, 5, undefined, undefined, undefined, 15);
  const warnings: Error[] = [];
  manager.on("warning", (error: Error) => warnings.push(error));
  const first = new PassThrough() as unknown as ServerResponse;
  const second = new PassThrough() as unknown as ServerResponse;
  await manager.addClient(camera.serial, first);
  await manager.addClient(camera.serial, second);
  source.write(Buffer.from([1]));
  context.mock.timers.tick(35);
  assert.equal(first.writableEnded, true);
  assert.equal(second.writableEnded, true);
  assert.equal(starts, 1);
  assert.equal(stops, 1);
  assert.equal(warnings.length, 1);
  assert.deepEqual(state.getCamera(camera.serial).snapshot, snapshot);
  const retry = new PassThrough() as unknown as ServerResponse;
  await manager.addClient(camera.serial, retry);
  assert.equal(starts, 2);
  source.write(Buffer.from([2]));
  await manager.close();
  context.mock.timers.tick(25);
  assert.equal(warnings.length, 1, "closed or replaced sources must not fire stale timers");
});

test("source activity resets the quiet deadline and idle cleanup cancels it", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const state = new GatewayState();
  state.registerCamera(camera);
  let source = new PassThrough();
  let stops = 0;
  let manager: LiveStreamManager;
  manager = new LiveStreamManager(state, {} as never, {
    async startStream() { manager.attachSource(camera.serial, source); },
    async stopStream() { stops++; },
  }, 5, undefined, undefined, undefined, 40);
  const response = new PassThrough() as unknown as ServerResponse;
  const warnings: Error[] = [];
  manager.on("warning", (error: Error) => warnings.push(error));
  await manager.addClient(camera.serial, response);
  for (let index = 0; index < 4; index++) {
    source.write(Buffer.from([index]));
    context.mock.timers.tick(15);
    assert.equal(response.writableEnded, false);
  }
  response.emit("close");
  context.mock.timers.tick(55);
  await Promise.resolve();
  assert.equal(stops, 1);
  assert.deepEqual(warnings, []);
  await manager.close();
});

test("allows slower cameras 30 seconds to produce a fresh snapshot", () => {
  assert.equal(SNAPSHOT_CAPTURE_TIMEOUT_MILLISECONDS, 30_000);
});

test("summarizes stream cadence without retaining timestamps", () => {
  const tracker = new StreamCadenceTracker();
  for (const timestamp of [100, 300, 900, 2_000, 4_300]) tracker.record(timestamp);

  assert.deepEqual(tracker.summary, {
    samples: 5,
    durationMilliseconds: 4_200,
    maximumGapMilliseconds: 2_300,
    gapsAtLeast500Milliseconds: 3,
    gapsAtLeast1000Milliseconds: 2,
    gapsAtLeast2000Milliseconds: 1,
  });
});

function annexBNal(type: number, ...body: number[]): Buffer {
  return Buffer.from([0, 0, 0, 1, type, ...body]);
}

test("retains SPS and PPS split across arbitrary source chunks", () => {
  const cache = new VideoParameterSetCache();
  const sps = annexBNal(0x67, 0x42, 0x00, 0x1f);
  const pps = annexBNal(0x68, 0xce, 0x06);
  const idr = annexBNal(0x65, 0x88);
  const stream = Buffer.concat([sps, pps, idr]);

  cache.push(stream.subarray(0, sps.length + 2));
  assert.equal(cache.bootstrap, null);
  cache.push(stream.subarray(sps.length + 2));

  assert.deepEqual(cache.bootstrap, Buffer.concat([sps, pps]));
  assert.deepEqual(cache.startup, Buffer.concat([sps, pps, idr]));
  cache.push(annexBNal(0x41, 0x9a, 0x22));
  assert.equal(cache.codec, "h264");
  assert.deepEqual(cache.bootstrap, Buffer.concat([sps, pps]));
});

test("starts H.264 decoding at a clean IDR instead of preceding delta frames", () => {
  const cache = new VideoParameterSetCache();
  const delta = annexBNal(0x41, 0x9a, 0x22);
  const sps = annexBNal(0x67, 0x42, 0x00, 0x1f);
  const pps = annexBNal(0x68, 0xce, 0x06);
  const idr = annexBNal(0x65, 0x88);

  cache.push(Buffer.concat([delta, sps, pps]));
  assert.equal(cache.startup, null);
  cache.push(delta);
  assert.equal(cache.startup, null);
  cache.push(idr);

  const startup = cache.startup as Buffer | null;
  assert.deepEqual(startup, Buffer.concat([sps, pps, idr]));
  assert.equal(startup?.includes(delta), false);
});

test("retains H.265 VPS, SPS, and PPS in decoder order", () => {
  const cache = new VideoParameterSetCache();
  const vps = annexBNal(0x40, 0x01, 0x0c);
  const sps = annexBNal(0x42, 0x01, 0x01);
  const pps = annexBNal(0x44, 0x01, 0xc0);
  const idr = annexBNal(0x26, 0x01, 0xaa);

  cache.push(Buffer.concat([vps, sps, pps, idr]));

  assert.equal(cache.codec, "h265");
  assert.deepEqual(cache.bootstrap, Buffer.concat([vps, sps, pps]));
  assert.deepEqual(cache.startup, Buffer.concat([vps, sps, pps, idr]));
});

test("starts H.265 decoding from the latest random-access frame", () => {
  const cache = new VideoParameterSetCache();
  const vps = annexBNal(0x40, 0x01, 0x0c);
  const sps = annexBNal(0x42, 0x01, 0x01);
  const pps = annexBNal(0x44, 0x01, 0xc0);
  const olderIdr = annexBNal(0x26, 0x01, 0xaa);
  const delta = annexBNal(0x02, 0x01, 0xbb);
  const latestIdr = annexBNal(0x28, 0x01, 0xcc);

  cache.push(Buffer.concat([vps, sps, pps, olderIdr, delta, latestIdr]), "h265");

  assert.deepEqual(cache.startup, Buffer.concat([vps, sps, pps, latestIdr]));
});

test("moves the decoder start to each new keyframe as the stream continues", () => {
  const cache = new VideoParameterSetCache();
  const vps = annexBNal(0x40, 0x01, 0x0c);
  const sps = annexBNal(0x42, 0x01, 0x01);
  const pps = annexBNal(0x44, 0x01, 0xc0);
  const firstIdr = annexBNal(0x26, 0x01, 0xa1);
  const firstDelta = annexBNal(0x02, 0x01, 0xb1);
  const laterIdr = annexBNal(0x26, 0x01, 0xa2);
  const laterDelta = annexBNal(0x02, 0x01, 0xb2);

  cache.push(Buffer.concat([vps, sps, pps, firstIdr, firstDelta]), "h265");
  cache.push(firstDelta);
  cache.push(Buffer.concat([laterIdr, laterDelta]));
  cache.push(laterDelta);

  // A viewer joining now must not be fed the first group followed by unrelated live frames.
  assert.deepEqual(cache.startup, Buffer.concat([vps, sps, pps, laterIdr, laterDelta, laterDelta]));
  assert.equal(cache.startupIncludesLatest, true);
});

test("keeps every slice of a multi-slice keyframe", () => {
  const cache = new VideoParameterSetCache();
  const sps = annexBNal(0x67, 0x42, 0x00, 0x1f);
  const pps = annexBNal(0x68, 0xce, 0x06);
  const firstSlice = annexBNal(0x65, 0x88, 0x01);
  const secondSlice = annexBNal(0x65, 0x22, 0x02);

  cache.push(Buffer.concat([sps, pps, firstSlice]));
  cache.push(secondSlice);

  assert.deepEqual(cache.startup, Buffer.concat([sps, pps, firstSlice, secondSlice]));
});

test("keeps later H.265 slices attached to the first slice of their keyframe", () => {
  const cache = new VideoParameterSetCache();
  const headers = Buffer.concat([annexBNal(0x40, 1, 12), annexBNal(0x42, 1, 1), annexBNal(0x44, 1, 0xc0)]);
  const first = annexBNal(0x26, 1, 0x81, 0x11);
  const second = annexBNal(0x26, 1, 0x22, 0x33);
  cache.push(Buffer.concat([headers, first]), "h265");
  for (const byte of second) cache.push(Buffer.from([byte]));
  assert.deepEqual(cache.startup, Buffer.concat([headers, first, second]));
});

test("finds a keyframe whose start code is split across chunks", () => {
  const cache = new VideoParameterSetCache();
  const vps = annexBNal(0x40, 0x01, 0x0c);
  const sps = annexBNal(0x42, 0x01, 0x01);
  const pps = annexBNal(0x44, 0x01, 0xc0);
  const firstIdr = annexBNal(0x26, 0x01, 0xa1);
  const laterIdr = annexBNal(0x26, 0x01, 0xa2, 0x00);
  const stream = Buffer.concat([vps, sps, pps, firstIdr, laterIdr]);
  const split = vps.length + sps.length + pps.length + firstIdr.length + 2;

  cache.push(stream.subarray(0, split), "h265");
  cache.push(stream.subarray(split));

  assert.deepEqual(cache.startup, Buffer.concat([vps, sps, pps, laterIdr]));
});

for (const codec of ["h264", "h265"] as const) {
  test(`discards oversized ${codec} history and recovers a byte-split keyframe`, () => {
    const cache = new VideoParameterSetCache();
    const headers = codec === "h264"
      ? Buffer.concat([annexBNal(0x67, 0x42, 0, 0x1f), annexBNal(0x68, 0xce, 6)])
      : Buffer.concat([annexBNal(0x40, 1, 12), annexBNal(0x42, 1, 1), annexBNal(0x44, 1, 0xc0)]);
    const first = codec === "h264" ? annexBNal(0x65, 0x81, 0x11) : annexBNal(0x26, 1, 0x81, 0x11);
    const later = codec === "h264" ? annexBNal(0x65, 0x82, 0x22) : annexBNal(0x26, 1, 0x82, 0x22);
    cache.push(Buffer.concat([headers, first]), codec);
    assert.notEqual(cache.startup, null);
    cache.push(Buffer.alloc(1024 * 1024 + 16, 0x55));
    assert.equal(cache.startup, null);
    assert.equal(cache.startupIncludesLatest, false);
    for (const byte of later) cache.push(Buffer.from([byte]));
    assert.deepEqual(cache.startup, Buffer.concat([headers, later]));
    assert.equal(cache.startupIncludesLatest, true);
  });
}

test("waits for a complete H.265 decoder start instead of probing vendor headers", () => {
  const cache = new VideoParameterSetCache();
  const vendorHeaders = Buffer.concat([
    annexBNal(0x66, 0x01, 0x01),
    annexBNal(0x68, 0x01, 0xc0),
    annexBNal(0x40, 0x01, 0x0c),
    annexBNal(0x02, 0x01, 0xaa),
  ]);

  cache.push(vendorHeaders);

  assert.equal(cache.codec, "h265");
  assert.equal(cache.bootstrap, null);
  assert.equal(cache.startup, null);
});

test("retains split H.265 configuration through the first IDR", () => {
  const cache = new VideoParameterSetCache();
  const vps = annexBNal(0x40, 0x01, 0x0c);
  const delta = annexBNal(0x02, 0x01, 0xaa);
  const sps = annexBNal(0x42, 0x01, 0x01);
  const pps = annexBNal(0x44, 0x01, 0xc0);
  const idr = annexBNal(0x26, 0x01, 0xbb);

  cache.push(Buffer.concat([vps, delta]), "h265");
  assert.equal(cache.bootstrap, null);
  assert.equal(cache.startup, null);
  cache.push(Buffer.concat([sps, pps]));
  assert.equal(cache.bootstrap, null);
  assert.equal(cache.startup, null);
  cache.push(idr);

  assert.deepEqual(cache.bootstrap, Buffer.concat([vps, sps, pps]));
  assert.deepEqual(cache.startup, Buffer.concat([vps, sps, pps, idr]));
});

test("uses the provider codec marker instead of a conflicting NAL-byte guess", () => {
  const cache = new VideoParameterSetCache();
  const h264Sps = annexBNal(0x67, 0x42, 0x00, 0x1f);
  const h264Pps = annexBNal(0x68, 0xce, 0x06);

  cache.push(Buffer.concat([annexBNal(0x40, 0x01), h264Sps, h264Pps, annexBNal(0x65, 0x88)]), "h264");

  assert.equal(cache.codec, "h264");
  assert.deepEqual(cache.bootstrap, Buffer.concat([h264Sps, h264Pps]));
});

test("bootstraps first and repeat HTTP viewers from the current keyframe", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  let manager: LiveStreamManager;
  let source: PassThrough;
  manager = new LiveStreamManager(
    state,
    {} as never,
    {
      async startStream() {
        source = new PassThrough();
        manager.attachSource(camera.serial, source);
      },
      async stopStream() {
        source.end();
      },
    },
    5,
  );

  const response = new PassThrough() as unknown as ServerResponse;
  response.writeHead = (() => response) as ServerResponse["writeHead"];
  const firstBytes: Buffer[] = [];
  response.on("data", (chunk: Buffer) => firstBytes.push(Buffer.from(chunk)));
  await manager.addClient(camera.serial, response);

  source!.write(annexBNal(0x41, 1, 2, 3));
  assert.equal(firstBytes.length, 0);
  const sps = annexBNal(0x67, 0x42, 0x00, 0x1f);
  const pps = annexBNal(0x68, 0xce, 0x06);
  const idr = annexBNal(0x65, 0x84, 5);
  source!.write(Buffer.concat([sps, pps, idr]));
  assert.deepEqual(
    Buffer.concat(firstBytes).subarray(0, sps.length + pps.length + idr.length),
    Buffer.concat([sps, pps, idr]),
  );

  const repeatResponse = new PassThrough() as unknown as ServerResponse;
  let repeatHeadersWritten = false;
  repeatResponse.writeHead = (() => {
    repeatHeadersWritten = true;
    return repeatResponse;
  }) as ServerResponse["writeHead"];
  const repeatWrite = repeatResponse.write.bind(repeatResponse);
  repeatResponse.write = ((chunk: Buffer) => {
    assert.equal(repeatHeadersWritten, true, "codec bootstrap must follow HTTP headers");
    return repeatWrite(chunk);
  }) as ServerResponse["write"];
  const repeatBytes: Buffer[] = [];
  repeatResponse.on("data", (chunk: Buffer) => repeatBytes.push(Buffer.from(chunk)));
  await manager.addClient(camera.serial, repeatResponse);

  // A viewer joining a running source receives the current keyframe, not only headers.
  assert.deepEqual(Buffer.concat(repeatBytes), Buffer.concat([sps, pps, idr]));

  const oversized = Buffer.alloc(1024 * 1024 + 16, 0x55);
  const delta = annexBNal(0x41, 0x9a, 0x22);
  const before = Buffer.concat(firstBytes).length;
  source!.write(oversized);
  source!.write(delta);
  assert.deepEqual(Buffer.concat(firstBytes).subarray(before), Buffer.concat([oversized, delta]));
  assert.deepEqual(Buffer.concat(repeatBytes).subarray(sps.length + pps.length + idr.length), Buffer.concat([oversized, delta]));
  await manager.close();
});

test("shares an H.264 fallback with viewers when a camera returns H.265", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  let manager: LiveStreamManager;
  let source: PassThrough;
  const transcoder = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  const transcoderInput: Buffer[] = [];
  transcoder.stdin.on("data", (chunk: Buffer) => transcoderInput.push(Buffer.from(chunk)));
  manager = new LiveStreamManager(
    state,
    {} as never,
    {
      async startStream() {
        source = new PassThrough();
        manager.attachSource(camera.serial, source);
      },
      async stopStream() {
        source.end();
      },
    },
    5,
    undefined,
    () => transcoder,
  );
  const response = new PassThrough() as unknown as ServerResponse;
  let contentType = "";
  response.writeHead = ((_status: number, headers: Record<string, string>) => {
    contentType = headers["Content-Type"] ?? "";
    return response;
  }) as ServerResponse["writeHead"];
  const bytes: Buffer[] = [];
  const summaries: ViewerTranscoderSummary[] = [];
  const clientSummaries: ViewerClientSummary[] = [];
  const deliverySummaries: ViewerDeliverySummary[] = [];
  manager.on("viewer-transcoder-stopped", (summary) => summaries.push(summary));
  manager.on("viewer-client-stopped", (summary) => clientSummaries.push(summary));
  manager.on("viewer-delivery-stopped", (summary) => deliverySummaries.push(summary));
  response.on("data", (chunk: Buffer) => bytes.push(Buffer.from(chunk)));
  await manager.addClient(camera.serial, response);

  source!.write(annexBNal(0x02, 0x01, 0xaa));
  assert.equal(bytes.length, 0);
  const vps = annexBNal(0x40, 0x01, 0x0c);
  const sps = annexBNal(0x42, 0x01, 0x01);
  const pps = annexBNal(0x44, 0x01, 0xc0);
  const sourceChunk = Buffer.concat([vps, sps, pps, annexBNal(0x26, 0x01, 0xbb)]);
  source!.write(sourceChunk);
  assert.ok(Buffer.concat(transcoderInput).includes(vps));

  // The cached decoder start already ends with this chunk, so FFmpeg receives it once.
  assert.deepEqual(Buffer.concat(transcoderInput), sourceChunk);
  assert.equal(bytes.length, 0);

  const h264Sps = annexBNal(0x67, 0x42, 0x00, 0x1f);
  const h264Pps = annexBNal(0x68, 0xce, 0x06);
  (transcoder.stdout as PassThrough).write(Buffer.concat([h264Sps, h264Pps, annexBNal(0x65, 0x88)]));

  assert.equal(contentType, "video/h264");
  assert.ok(Buffer.concat(bytes).includes(h264Sps));
  response.emit("close");
  assert.equal(clientSummaries.length, 1);
  assert.deepEqual(
    {
      model: clientSummaries[0]?.model,
      sourceCodec: clientSummaries[0]?.sourceCodec,
      sourceActive: clientSummaries[0]?.sourceActive,
      deliveryStarted: clientSummaries[0]?.deliveryStarted,
      deliveredBytes: clientSummaries[0]?.deliveredBytes,
      deliveredChunks: clientSummaries[0]?.deliveredChunks,
      backpressureEvents: clientSummaries[0]?.backpressureEvents,
      sourceChunks: clientSummaries[0]?.sourceChunks,
    },
    {
      model: "T8210",
      sourceCodec: "h265",
      sourceActive: true,
      deliveryStarted: true,
      deliveredBytes: h264Sps.length + h264Pps.length + annexBNal(0x65, 0x88).length
        + h264Sps.length + h264Pps.length,
      deliveredChunks: 2,
      backpressureEvents: 0,
      sourceChunks: 2,
    },
  );
  assert.deepEqual(summaries, [{
    inputBytes: Buffer.concat(transcoderInput).length,
    outputBytes: h264Sps.length + h264Pps.length + annexBNal(0x65, 0x88).length,
    outputChunks: 1,
    bootstrapReady: true,
    silentRestarts: 0,
    inputCadence: {
      samples: 1,
      durationMilliseconds: 0,
      maximumGapMilliseconds: 0,
      gapsAtLeast500Milliseconds: 0,
      gapsAtLeast1000Milliseconds: 0,
      gapsAtLeast2000Milliseconds: 0,
    },
    outputCadence: {
      samples: 1,
      durationMilliseconds: 0,
      maximumGapMilliseconds: 0,
      gapsAtLeast500Milliseconds: 0,
      gapsAtLeast1000Milliseconds: 0,
      gapsAtLeast2000Milliseconds: 0,
    },
    clientBackpressureEvents: 0,
    maximumClientWritableBytes: 0,
  }]);
  await manager.close();
  assert.equal(deliverySummaries.length, 1);
  assert.equal(deliverySummaries[0]?.model, "T8210");
  assert.equal(deliverySummaries[0]?.sourceCodec, "h265");
  assert.equal(deliverySummaries[0]?.sourceChunks, 2);
  assert.equal(deliverySummaries[0]?.viewerChunks, 1);
  assert.equal(deliverySummaries[0]?.clientStarts, 1);
  assert.equal(deliverySummaries[0]?.clientWrites, 1);
  assert.equal(deliverySummaries[0]?.clientBackpressureEvents, 0);
});

test("restarts a silent H.265 transcoder from a later random-access picture", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  const source = new PassThrough();
  const transcoders: ChildProcessWithoutNullStreams[] = [];
  const createProcess = (): ChildProcessWithoutNullStreams => {
    const fake = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null as NodeJS.Signals | null,
      kill(signal: NodeJS.Signals) {
        fake.signalCode = signal;
        return true;
      },
    });
    const process = fake as unknown as ChildProcessWithoutNullStreams;
    transcoders.push(process);
    return process;
  };
  let now = 0;
  let manager: LiveStreamManager;
  manager = new LiveStreamManager(state, {} as never, {
    async startStream() { manager.attachSource(camera.serial, source, () => "h265"); },
    async stopStream() {},
  }, 5, undefined, createProcess, createProcess, 30_000, () => now);
  const response = new PassThrough() as unknown as ServerResponse;
  response.writeHead = (() => response) as ServerResponse["writeHead"];
  const delivered: Buffer[] = [];
  const summaries: ViewerTranscoderSummary[] = [];
  response.on("data", (chunk: Buffer) => delivered.push(Buffer.from(chunk)));
  manager.on("viewer-transcoder-stopped", (summary) => summaries.push(summary));
  await manager.addClient(camera.serial, response);

  const headers = Buffer.concat([
    annexBNal(0x40, 1, 12),
    annexBNal(0x42, 1, 1),
    annexBNal(0x44, 1, 0xc0),
  ]);
  source.write(Buffer.concat([headers, annexBNal(0x26, 1, 0x80, 1)]));
  assert.equal(transcoders.length, 2, "one viewer and one snapshot process should start");
  const firstViewer = transcoders[1]!;

  now = 6_000;
  source.write(annexBNal(0x26, 1, 0x80, 2));
  assert.equal(transcoders.length, 3, "a later complete picture should replace the silent viewer process");
  const replacementViewer = transcoders[2]!;
  firstViewer.emit("close", 1);
  assert.equal(response.destroyed, false, "a superseded process must not destroy the waiting viewer");

  const h264 = Buffer.concat([
    annexBNal(0x67, 0x42, 0x00, 0x1f),
    annexBNal(0x68, 0xce, 0x06),
    annexBNal(0x65, 0x88),
  ]);
  (replacementViewer.stdout as PassThrough).write(h264);
  now = 12_000;
  source.write(annexBNal(0x26, 1, 0x80, 3));
  assert.equal(transcoders.length, 3, "output from the replacement disables further silent recovery");
  assert.ok(Buffer.concat(delivered).includes(h264));

  response.emit("close");
  assert.equal(summaries.at(-1)?.silentRestarts, 1);
  await manager.close();
});

test("caps silent H.265 transcoder recovery within one source session", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  const source = new PassThrough();
  const viewerProcesses: ChildProcessWithoutNullStreams[] = [];
  const createViewer = (): ChildProcessWithoutNullStreams => {
    const fake = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null as NodeJS.Signals | null,
      kill(signal: NodeJS.Signals) {
        fake.signalCode = signal;
        return true;
      },
    });
    const process = fake as unknown as ChildProcessWithoutNullStreams;
    viewerProcesses.push(process);
    return process;
  };
  const createSnapshot = (): ChildProcessWithoutNullStreams => Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  let now = 0;
  let manager: LiveStreamManager;
  manager = new LiveStreamManager(state, {} as never, {
    async startStream() { manager.attachSource(camera.serial, source, () => "h265"); },
    async stopStream() {},
  }, 5, undefined, createViewer, createSnapshot, 30_000, () => now);
  const response = new PassThrough() as unknown as ServerResponse;
  response.writeHead = (() => response) as ServerResponse["writeHead"];
  await manager.addClient(camera.serial, response);
  source.write(Buffer.concat([
    annexBNal(0x40, 1, 12),
    annexBNal(0x42, 1, 1),
    annexBNal(0x44, 1, 0xc0),
    annexBNal(0x26, 1, 0x80, 1),
  ]));
  for (const version of [2, 3, 4]) {
    now += 6_000;
    source.write(annexBNal(0x26, 1, 0x80, version));
  }
  assert.equal(viewerProcesses.length, 3, "the initial decoder may be replaced at most twice");
  await manager.close();
});

test("keeps process pipe failures recoverable while an H.265 viewer is stopping", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  let manager: LiveStreamManager;
  let source: PassThrough;
  const viewer = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  const snapshot = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  manager = new LiveStreamManager(
    state,
    {} as never,
    {
      async startStream() {
        source = new PassThrough();
        manager.attachSource(camera.serial, source, () => "h265");
      },
      async stopStream() {
        source.end();
      },
    },
    5,
    undefined,
    () => viewer,
    () => snapshot,
  );
  const warnings: Error[] = [];
  manager.on("warning", (error: Error) => warnings.push(error));
  const response = new PassThrough() as unknown as ServerResponse;
  response.writeHead = (() => response) as ServerResponse["writeHead"];
  await manager.addClient(camera.serial, response);

  source!.write(Buffer.concat([
    annexBNal(0x40, 0x01, 0x0c),
    annexBNal(0x42, 0x01, 0x01),
    annexBNal(0x44, 0x01, 0xc0),
    annexBNal(0x26, 0x01, 0xaa),
  ]));
  const pipeError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  snapshot.stdin.emit("error", pipeError);
  response.emit("error", pipeError);

  assert.deepEqual(warnings, [pipeError, pipeError]);
  assert.equal(state.getCamera(camera.serial).stream.viewers, 0);
  await manager.close();
});

test("force-kills a media child that ignores graceful termination", async () => {
  const signals: NodeJS.Signals[] = [];
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;

  terminateMediaProcess(process, 5);
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("cancels forced media termination after the child closes", async () => {
  const signals: NodeJS.Signals[] = [];
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;

  terminateMediaProcess(process, 5);
  process.emit("close", 0, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.deepEqual(signals, ["SIGTERM"]);
});

test("ignores callbacks from a replaced source generation", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  const manager = new LiveStreamManager(
    state,
    {} as never,
    { async startStream() {}, async stopStream() {} },
    5,
  );
  const oldSource = new PassThrough();
  const currentSource = new PassThrough();

  manager.attachSource(camera.serial, oldSource);
  manager.attachSource(camera.serial, currentSource);
  oldSource.end();

  assert.equal(state.getCamera(camera.serial).stream.state, "streaming");
  await manager.close();
});

test("holds an on-demand stream until a fresh snapshot arrives", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  let starts = 0;
  let stops = 0;
  const manager = new LiveStreamManager(
    state,
    {} as never,
    {
      async startStream() {
        starts += 1;
        setTimeout(() => state.updateSnapshot(camera.serial, {
          capturedAt: new Date().toISOString(),
          contentType: "image/jpeg",
          source: "live",
          revision: 1,
        }), 5);
      },
      async stopStream() {
        stops += 1;
      },
    },
    5,
  );

  const snapshot = await manager.captureSnapshot(camera.serial, 50);
  assert.equal(snapshot.revision, 1);
  assert.equal(starts, 1);

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(stops, 1);
  await manager.close();
});

test("ignores an event image while an on-demand live snapshot is pending", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  const manager = new LiveStreamManager(
    state,
    {} as never,
    {
      async startStream() {
        setTimeout(() => state.updateSnapshot(camera.serial, {
          capturedAt: new Date().toISOString(),
          contentType: "image/jpeg",
          source: "event",
          revision: 1,
        }), 2);
        setTimeout(() => state.updateSnapshot(camera.serial, {
          capturedAt: new Date().toISOString(),
          contentType: "image/jpeg",
          source: "live",
          revision: 2,
        }), 5);
      },
      async stopStream() {},
    },
    5,
  );

  const snapshot = await manager.captureSnapshot(camera.serial, 50);

  assert.equal(snapshot.source, "live");
  assert.equal(snapshot.revision, 2);
  await manager.close();
});

test("releases its state listener after a capture timeout", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  const manager = new LiveStreamManager(
    state,
    {} as never,
    { async startStream() {}, async stopStream() {} },
    5,
  );

  await assert.rejects(manager.captureSnapshot(camera.serial, 5), /Timed out/);
  assert.equal(state.listenerCount("event"), 0);
  await manager.close();
});

test("starts a live viewer after the provider closes a timed-out snapshot", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  let starts = 0;
  let stops = 0;
  const manager = new LiveStreamManager(
    state,
    {} as never,
    {
      async startStream() {
        starts += 1;
      },
      async stopStream() {
        stops += 1;
      },
    },
    20,
  );

  await assert.rejects(manager.captureSnapshot(camera.serial, 5), /Timed out/);
  manager.markStopped(camera.serial);
  await new Promise((resolve) => setTimeout(resolve, 30));

  const response = new PassThrough() as unknown as ServerResponse;
  response.writeHead = (() => response) as ServerResponse["writeHead"];
  await manager.addClient(camera.serial, response);

  assert.equal(starts, 2);
  assert.equal(stops, 0);
  assert.equal(state.getCamera(camera.serial).stream.state, "starting");
  await manager.close();
});

test("reports a frame timeout without an unhandled rejection during slow stream startup", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  const manager = new LiveStreamManager(
    state,
    {} as never,
    {
      async startStream() {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      async stopStream() {},
    },
    5,
  );

  await assert.rejects(manager.captureSnapshot(camera.serial, 5), /Timed out waiting for a fresh camera frame/);
  assert.equal(state.listenerCount("event"), 0);
  await manager.close();
});

test("cancels a pending snapshot promptly when the gateway closes", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  const manager = new LiveStreamManager(
    state,
    {} as never,
    { async startStream() {}, async stopStream() {} },
    5,
  );

  const capture = manager.captureSnapshot(camera.serial, 60_000);
  const rejected = assert.rejects(capture, /Gateway closed/);
  await new Promise((resolve) => setImmediate(resolve));
  await manager.close();
  await rejected;
  assert.equal(state.listenerCount("event"), 0);
});

test("releases a startup snapshot source before the next camera is warmed", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  let manager: LiveStreamManager;
  let stops = 0;
  manager = new LiveStreamManager(
    state,
    {} as never,
    {
      async startStream() {
        manager.attachSource(camera.serial, new PassThrough());
        setTimeout(() => state.updateSnapshot(camera.serial, {
          capturedAt: new Date().toISOString(),
          contentType: "image/jpeg",
          source: "live",
          revision: 1,
        }), 5);
      },
      async stopStream() {
        stops += 1;
        manager.markStopped(camera.serial);
      },
    },
    1_000,
  );

  const snapshot = await manager.captureStartupSnapshot(camera.serial, 50);
  assert.equal(snapshot.revision, 1);
  assert.equal(stops, 1);
  assert.equal(state.getCamera(camera.serial).stream.state, "idle");
  await manager.close();
});

test("records for a bounded duration and releases the on-demand stream", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  let manager: LiveStreamManager;
  let source: PassThrough;
  let writes: NodeJS.Timeout;
  let stops = 0;
  manager = new LiveStreamManager(
    state,
    {} as never,
    {
      async startStream() {
        source = new PassThrough();
        manager.attachSource(camera.serial, source);
        source.write(Buffer.from("h264"));
        writes = setInterval(() => source.write(Buffer.from("h264")), 10);
      },
      async stopStream() {
        stops += 1;
        source.end();
      },
    },
    5,
    async (h264) => Buffer.concat([Buffer.from("mp4:"), h264]),
  );

  const clip = await manager.recordClip(camera.serial, 1, 50);
  clearInterval(writes!);
  assert.match(clip.toString(), /^mp4:h264/);

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(stops, 1);
  await manager.close();
});

test("rejects a recording when camera video never arrives", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  const manager = new LiveStreamManager(
    state,
    {} as never,
    { async startStream() {}, async stopStream() {} },
    5,
    async (h264) => h264,
  );

  await assert.rejects(manager.recordClip(camera.serial, 1, 5), /Timed out waiting for camera video/);
  await manager.close();
});

test("reports a video timeout without an unhandled rejection during slow stream startup", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  const manager = new LiveStreamManager(
    state,
    {} as never,
    {
      async startStream() {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      async stopStream() {},
    },
    5,
    async (h264) => h264,
  );

  await assert.rejects(manager.recordClip(camera.serial, 1, 5), /Timed out waiting for camera video/);
  await manager.close();
});


test("keeps headers paired with their retained picture until the next keyframe", () => {
  const cache = new VideoParameterSetCache();
  const headers1 = Buffer.concat([annexBNal(0x67, 0x42, 1), annexBNal(0x68, 0x11)]);
  const headers2 = Buffer.concat([annexBNal(0x67, 0x42, 2), annexBNal(0x68, 0x22)]);
  const idr1 = annexBNal(0x65, 0x80, 1);
  cache.push(Buffer.concat([headers1, idr1]), "h264");
  cache.push(Buffer.concat([headers2, annexBNal(0x06, 0x33)]));
  assert.deepEqual(cache.startup?.subarray(0, headers1.length), headers1);
  assert.deepEqual(cache.bootstrap, headers2);
  const idr2 = annexBNal(0x65, 0x80, 2);
  cache.push(idr2);
  assert.deepEqual(cache.startup, Buffer.concat([headers2, idr2]));
});

test("counts CRA, IDR and ordinary continuation slices once across byte-split headers", () => {
  const cache = new VideoParameterSetCache();
  const headers = Buffer.concat([annexBNal(0x40, 1, 12), annexBNal(0x42, 1, 1), annexBNal(0x44, 1, 0xc0)]);
  const cra = annexBNal(0x2a, 1, 0x80, 1);
  const continuation = annexBNal(0x2a, 1, 0x20, 2);
  const idr = annexBNal(0x26, 1, 0x80, 3);
  for (const byte of Buffer.concat([headers, cra, continuation, idr])) cache.push(Buffer.from([byte]), "h265");
  assert.deepEqual(cache.startup, Buffer.concat([headers, idr]));
  assert.deepEqual(cache.diagnostics, { randomAccessPictures: 2, keyframeContinuationNals: 1, startupGroupOverflows: 0 });
  cache.push(Buffer.alloc(1024 * 1024, 0x55));
  assert.equal(cache.diagnostics.startupGroupOverflows, 1);
});

test("does not concatenate the retained group on each source chunk", (context) => {
  const cache = new VideoParameterSetCache();
  cache.push(Buffer.concat([annexBNal(0x67, 0x42), annexBNal(0x68, 0x11), annexBNal(0x65, 0x80)]), "h264");
  const concatenate = Buffer.concat.bind(Buffer);
  let maximumJoinedBytes = 0;
  context.mock.method(Buffer, "concat", (chunks: readonly Uint8Array[], length?: number) => {
    maximumJoinedBytes = Math.max(maximumJoinedBytes, chunks.reduce((size, chunk) => size + chunk.length, 0));
    return concatenate(chunks, length);
  });
  const chunk = Buffer.alloc(1024, 0x55);
  annexBNal(0x41, 0x22).copy(chunk);
  for (let index = 0; index < 1000; index++) cache.push(chunk);
  assert.ok(maximumJoinedBytes < 4096);
  assert.ok(cache.startup!.length > 1000 * 1024);
});

test("delivers the completing keyframe chunk to an existing viewer before starting a pending viewer", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  const source = new PassThrough();
  let manager: LiveStreamManager;
  manager = new LiveStreamManager(state, {} as never, {
    async startStream() { manager.attachSource(camera.serial, source); },
    async stopStream() {},
  }, 5, undefined, undefined, () => Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams);
  const first = new PassThrough();
  const second = new PassThrough();
  Object.assign(first, { writeHead: () => first });
  Object.assign(second, { writeHead: () => second });
  const firstBytes: Buffer[] = [];
  const secondBytes: Buffer[] = [];
  first.on("data", (chunk: Buffer) => firstBytes.push(chunk));
  second.on("data", (chunk: Buffer) => secondBytes.push(chunk));
  await manager.addClient(camera.serial, first as unknown as ServerResponse);
  const headers = Buffer.concat([annexBNal(0x67, 0x42), annexBNal(0x68, 0x11)]);
  const prefix = Buffer.from([0, 0, 0, 1, 0x65]);
  source.write(Buffer.concat([headers, prefix]));
  await manager.addClient(camera.serial, second as unknown as ServerResponse);
  const completion = Buffer.from([0x80, 0x22]);
  source.write(completion);
  assert.deepEqual(Buffer.concat(firstBytes), Buffer.concat([headers, prefix, completion]));
  assert.deepEqual(Buffer.concat(secondBytes), Buffer.concat([headers, completion]));
  await manager.close();
});

/** Evaluate decoder startup by walking the full prefix in wire order, independently of chunk retention. */
function decoderStartupOracle(prefix: Buffer, codec: "h264" | "h265"): Buffer | null {
  const starts: Array<{ offset: number; payload: number }> = [];
  for (let index = 0; index + 3 < prefix.length; index++) {
    if (prefix[index] !== 0 || prefix[index + 1] !== 0) continue;
    const length = prefix[index + 2] === 1 ? 3 : prefix[index + 2] === 0 && prefix[index + 3] === 1 ? 4 : 0;
    if (!length) continue;
    starts.push({ offset: index, payload: index + length });
    index += length - 1;
  }
  const headers = new Map<number, Buffer>();
  const bootstrap = (): Buffer | null => {
    const types = codec === "h264" ? [7, 8] : [32, 33, 34];
    return types.every((type) => headers.has(type)) ? Buffer.concat(types.map((type) => headers.get(type)!)) : null;
  };
  let picture = -1;
  let pictureHeaders: Buffer | null = null;
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index]!;
    const header = prefix[start.payload];
    if (header === undefined) continue;
    const type = codec === "h264" ? header & 31 : (header >> 1) & 63;
    const slice = prefix[start.payload + (codec === "h264" ? 1 : 2)];
    if ((codec === "h264" ? type === 5 : type >= 19 && type <= 21) && slice !== undefined && (slice & 128)) {
      picture = start.offset;
      pictureHeaders = bootstrap();
    }
    const end = starts[index + 1]?.offset;
    if (end !== undefined && (codec === "h264" ? type === 7 || type === 8 : type >= 32 && type <= 34)) {
      headers.set(type, prefix.subarray(start.offset, end));
    }
  }
  const configuration = pictureHeaders ?? bootstrap();
  return picture >= 0 && configuration ? Buffer.concat([configuration, prefix.subarray(picture)]) : null;
}

for (const codec of ["h264", "h265"] as const) {
  test(`${codec} snapshots headers in stream order across multiple changes within one chunk`, () => {
    const headers = (version: number): Buffer => codec === "h264"
      ? Buffer.concat([annexBNal(0x67, 0x42, version), annexBNal(0x68, version)])
      : Buffer.concat([annexBNal(0x40, 1, version), annexBNal(0x42, 1, version), annexBNal(0x44, 1, version)]);
    const picture = (version: number): Buffer => codec === "h264" ? annexBNal(0x65, 0x80, version) : annexBNal(0x26, 1, 0x80, version);
    const delta = codec === "h264" ? annexBNal(0x41, 0x22) : annexBNal(0x02, 1, 0x22);
    const first = Buffer.concat([headers(1), picture(1), delta]);
    const changes = Buffer.concat([headers(2), delta]);
    const many = Buffer.concat([headers(2), headers(3), headers(4), headers(5), delta]);
    for (const chunks of [[Buffer.concat([first, changes])], [headers(1), Buffer.concat([picture(1), delta, changes])],
      [first, changes], [Buffer.concat([first, many])]]) {
      const cache = new VideoParameterSetCache();
      for (const chunk of chunks) cache.push(chunk, codec);
      assert.deepEqual(cache.startup?.subarray(0, headers(1).length), headers(1));
    }
    const cache = new VideoParameterSetCache();
    cache.push(Buffer.concat([first, changes, picture(2)]), codec);
    assert.deepEqual(cache.startup, Buffer.concat([headers(2), picture(2)]));
  });

  test(`${codec} startup matches an independent position oracle for split and combined chunks`, () => {
    for (const startLength of [3, 4]) {
      const nal = (...bytes: number[]): Buffer => Buffer.from([...(startLength === 3 ? [0, 0, 1] : [0, 0, 0, 1]), ...bytes]);
      const headers = (version: number): Buffer => codec === "h264"
        ? Buffer.concat([nal(0x67, 0x42, version), nal(0x68, version)])
        : Buffer.concat([nal(0x40, 1, version), nal(0x42, 1, version), nal(0x44, 1, version)]);
      const picture = (version: number): Buffer => codec === "h264" ? nal(0x65, 0x80, version) : nal(version % 2 ? 0x26 : 0x2a, 1, 0x80, version);
      const continuation = codec === "h264" ? nal(0x65, 0x22) : nal(0x26, 1, 0x22);
      const delta = codec === "h264" ? nal(0x41, 0x22) : nal(0x02, 1, 0x22);
      const stream = Buffer.concat([headers(1), picture(1), continuation, delta, headers(2), delta, picture(2),
        headers(3), headers(4), headers(5), delta, picture(3), delta]);
      for (const declared of [false, true]) for (const size of [1, 2, 9, 40, 150, 600]) {
        const cache = new VideoParameterSetCache();
        for (let offset = 0; offset < stream.length; offset += size) {
          cache.push(stream.subarray(offset, offset + size), declared ? codec : undefined);
          const prefix = stream.subarray(0, offset + size);
          assert.deepEqual(cache.startup, decoderStartupOracle(prefix, codec), `${codec} prefix=${prefix.length} chunk=${size} start=${startLength} declared=${declared}`);
        }
      }
    }
  });
}

test("does not materialise source startup while an H.265 viewer waits on a running transcoder", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  const source = new PassThrough();
  const process = (): ChildProcessWithoutNullStreams => Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  let manager: LiveStreamManager;
  manager = new LiveStreamManager(state, {} as never, {
    async startStream() { manager.attachSource(camera.serial, source, () => "h265"); }, async stopStream() {},
  }, 5, undefined, process, process);
  const response = new PassThrough() as unknown as ServerResponse;
  await manager.addClient(camera.serial, response);
  source.write(Buffer.concat([annexBNal(0x40, 1, 12), annexBNal(0x42, 1, 1), annexBNal(0x44, 1, 0xc0), annexBNal(0x26, 1, 0x80)]));
  const original = Object.getOwnPropertyDescriptor(VideoParameterSetCache.prototype, "startup")!;
  let reads = 0;
  Object.defineProperty(VideoParameterSetCache.prototype, "startup", { ...original, get() { reads++; return original.get!.call(this); } });
  try {
    for (let index = 0; index < 10; index++) source.write(annexBNal(0x02, 1, 0x22));
    assert.equal(reads, 0);
  } finally {
    Object.defineProperty(VideoParameterSetCache.prototype, "startup", original);
    await manager.close();
  }
});
