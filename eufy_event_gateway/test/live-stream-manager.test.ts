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

test("bootstraps first and repeat HTTP viewers with SPS and PPS", async () => {
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
  const idr = annexBNal(0x65, 4, 5);
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

  assert.deepEqual(Buffer.concat(repeatBytes), Buffer.concat([sps, pps]));
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
  const deliverySummaries: ViewerDeliverySummary[] = [];
  manager.on("viewer-transcoder-stopped", (summary) => summaries.push(summary));
  manager.on("viewer-delivery-stopped", (summary) => deliverySummaries.push(summary));
  response.on("data", (chunk: Buffer) => bytes.push(Buffer.from(chunk)));
  await manager.addClient(camera.serial, response);

  source!.write(annexBNal(0x02, 0x01, 0xaa));
  assert.equal(bytes.length, 0);
  const vps = annexBNal(0x40, 0x01, 0x0c);
  const sps = annexBNal(0x42, 0x01, 0x01);
  const pps = annexBNal(0x44, 0x01, 0xc0);
  source!.write(Buffer.concat([vps, sps, pps, annexBNal(0x26, 0x01, 0xbb)]));
  assert.ok(Buffer.concat(transcoderInput).includes(vps));
  assert.equal(bytes.length, 0);

  const h264Sps = annexBNal(0x67, 0x42, 0x00, 0x1f);
  const h264Pps = annexBNal(0x68, 0xce, 0x06);
  (transcoder.stdout as PassThrough).write(Buffer.concat([h264Sps, h264Pps, annexBNal(0x65, 0x88)]));

  assert.equal(contentType, "video/h264");
  assert.ok(Buffer.concat(bytes).includes(h264Sps));
  response.emit("close");
  assert.deepEqual(summaries, [{
    inputBytes: Buffer.concat(transcoderInput).length,
    outputBytes: h264Sps.length + h264Pps.length + annexBNal(0x65, 0x88).length,
    outputChunks: 1,
    bootstrapReady: true,
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
