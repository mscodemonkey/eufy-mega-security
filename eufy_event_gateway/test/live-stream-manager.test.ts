/**
 * Exercises media lifecycle policy above a fake provider byte stream.
 *
 * The cases cover one shared source for multiple consumers, fresh JPEG capture,
 * bounded MP4 recording, idle grace cleanup, and failure propagation without
 * opening a real PPCS socket.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import type { ServerResponse } from "node:http";
import { getPriority } from "node:os";
import { PassThrough } from "node:stream";
import test from "node:test";

import { GatewayState } from "../src/domain/gateway-state.js";
import {
  LiveStreamManager,
  h265ViewerTranscoderArguments,
  snapshotExtractorArguments,
  spawnH265ViewerTranscoder,
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

test("H.265 conversion runs below the gateway so it cannot starve live video", () => {
  const child = spawnH265ViewerTranscoder();
  try {
    assert.equal(getPriority(child.pid), 10);
  } finally {
    child.kill("SIGKILL");
  }
});

test("H.265 viewer output keeps keyframes close and follows the source's", () => {
  const args = h265ViewerTranscoderArguments();
  assert.match(args[args.indexOf("-x264-params") + 1]!, /keyint=10/);
  assert.equal(args[args.indexOf("-force_key_frames") + 1], "source");
  assert.equal(args[args.indexOf("-forced-idr") + 1], "1");
});

test("fixed H.265 viewer output adds a stable 1080p filter only when enabled", () => {
  const unchanged = h265ViewerTranscoderArguments();
  assert.equal(unchanged.includes("-vf"), false);

  const fixed = h265ViewerTranscoderArguments(true);
  const filterIndex = fixed.indexOf("-vf");
  assert.notEqual(filterIndex, -1);
  assert.equal(
    fixed[filterIndex + 1],
    "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
  );
});

test("the H.265 snapshot extractor decodes keyframes only and H.264's is unchanged", () => {
  const h265 = snapshotExtractorArguments("h265");
  assert.equal(h265[h265.indexOf("-skip_frame") + 1], "nokey");
  assert.equal(h265[h265.indexOf("-threads") + 1], "1");
  assert.equal(h265[h265.indexOf("-fps_mode") + 1], "passthrough");
  assert.equal(h265.includes("fps=1/2"), false);
  assert.deepEqual(snapshotExtractorArguments("h264"), [
    "-hide_banner", "-loglevel", "error", "-f", "h264", "-i", "pipe:0", "-vf", "fps=1/2", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
  ]);
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

for (const codec of ["h264", "h265"] as const) {
  test(`corrects a provisional codec to ${codec} across every header split`, () => {
    const headers = codec === "h264"
      ? Buffer.concat([annexBNal(0x67, 0x42), annexBNal(0x68, 0xce)])
      : Buffer.concat([annexBNal(0x40, 1), annexBNal(0x42, 1), annexBNal(0x44, 1)]);
    const picture = codec === "h264" ? annexBNal(0x65, 0x80) : annexBNal(0x26, 1, 0x80);
    const wire = Buffer.concat([headers, picture]);
    const wrong = codec === "h264" ? "h265" : "h264";
    for (let split = 0; split <= wire.length; split++) {
      const cache = new VideoParameterSetCache();
      cache.push(annexBNal(2, 1, 0x80), wrong);
      cache.push(wire.subarray(0, split), null);
      cache.push(wire.subarray(split), codec);

      // A late correction may have consumed headers under the provisional codec.
      // The next repeated decoder configuration must always recover the stream.
      cache.push(wire, codec);
      assert.equal(cache.codec, codec, `split=${split}`);
      assert.deepEqual(cache.bootstrap, headers, `split=${split}`);
      assert.deepEqual(cache.startup, wire, `split=${split}`);
      cache.push(annexBNal(2, 1, 0x80), wrong);
      assert.equal(cache.codec, codec, "verified bootstrap ignores later conflicting hints");
    }
  });
}

test("recovers split HEVC headers immediately when the provider corrects its initial hint", () => {
  const wire = Buffer.concat([annexBNal(0x40, 1), annexBNal(0x42, 1), annexBNal(0x44, 1), annexBNal(0x26, 1, 0x80)]);
  for (let split = 0; split < wire.length; split++) {
    const cache = new VideoParameterSetCache();
    cache.push(annexBNal(2, 1, 0x80), "h264");
    cache.push(wire.subarray(0, split), "h265");
    cache.push(wire.subarray(split), "h265");
    assert.deepEqual(cache.startup, wire, `split=${split}`);
    assert.equal(cache.diagnostics.randomAccessPictures, 1);
  }
});

test("recovers after provisional hints flap and ignores missing hints", () => {
  const cache = new VideoParameterSetCache();
  const vps = annexBNal(0x40, 1);
  const sps = annexBNal(0x42, 1);
  const pps = annexBNal(0x44, 1);
  const idr = annexBNal(0x26, 1, 0x80);
  cache.push(annexBNal(2, 1, 0x80), "h264");
  cache.push(Buffer.concat([vps, sps]), "h265");
  cache.push(annexBNal(2, 1, 0x80), "h264");
  assert.equal(cache.startup, null);
  cache.push(vps, "h265");
  cache.push(sps, null);
  cache.push(pps);
  cache.push(idr);
  assert.deepEqual(cache.startup, Buffer.concat([vps, sps, pps, idr]));
  assert.equal(cache.diagnostics.randomAccessPictures, 1);
});

test("complete H.264 wire headers override a repeated wrong H.265 hint", () => {
  const cache = new VideoParameterSetCache();
  const sps = annexBNal(0x67, 0x42, 0x00, 0x1f);
  const pps = annexBNal(0x68, 0xce, 0x06);
  const idr = annexBNal(0x65, 0x80, 0x01);
  cache.push(sps, "h265");
  cache.push(pps, "h265");
  cache.push(idr, "h265");
  cache.push(idr, "h265");
  assert.equal(cache.codec, "h264");
  assert.deepEqual(cache.bootstrap, Buffer.concat([sps, pps]));
  assert.deepEqual(cache.startup, Buffer.concat([sps, pps, idr]));
});

test("a changing provider hint reaches the shared HEVC viewer converter", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  const source = new PassThrough();
  let hint: "h264" | "h265" = "h264";
  let converter: ChildProcessWithoutNullStreams | undefined;
  let manager: LiveStreamManager;
  manager = new LiveStreamManager(state, {} as never, {
    async startStream() { manager.attachSource(camera.serial, source, () => hint); },
    async stopStream() {},
  }, 5, undefined, () => {
    converter = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
    }) as unknown as ChildProcessWithoutNullStreams;
    return converter;
  }, () => Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams);
  const response = new PassThrough();
  Object.assign(response, { writeHead: () => response });
  const received: Buffer[] = [];
  response.on("data", (chunk: Buffer) => received.push(chunk));
  await manager.addClient(camera.serial, response as unknown as ServerResponse);
  source.write(annexBNal(2, 1, 0x80));
  assert.equal(received.length, 0);
  hint = "h265";
  const wire = Buffer.concat([annexBNal(0x40, 1), annexBNal(0x42, 1), annexBNal(0x44, 1), annexBNal(0x26, 1, 0x80)]);
  for (const byte of wire) source.write(Buffer.from([byte]));
  assert.ok(converter, "corrected HEVC starts the converter");
  const output = Buffer.concat([annexBNal(0x67, 0x42), annexBNal(0x68, 0xce), annexBNal(0x65, 0x80)]);
  converter.stdout.emit("data", output);
  assert.ok(Buffer.concat(received).includes(output));
  await manager.close();
});

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

test("a new camera never receives pictures left in the previous camera's converter", async context => {
  const state = new GatewayState();
  const other = { ...camera, serial: "synthetic-camera-b" };
  for (const value of [camera, other]) state.registerCamera(value);
  const sources = new Map<string, PassThrough>();
  const converters: ChildProcessWithoutNullStreams[] = [];
  const fake = () => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kill: () => true }) as unknown as ChildProcessWithoutNullStreams;
  const create = () => { const child = fake(); (child.stdin as PassThrough).resume(); converters.push(child); return child; };
  let manager!: LiveStreamManager;
  manager = new LiveStreamManager(state, {} as never, {
    async startStream(serial: string) { const source = new PassThrough(); sources.set(serial, source); manager.attachSource(serial, source, () => "h265"); },
    async stopStream(serial: string) { sources.get(serial)?.end(); },
  }, 0, undefined, create, fake);
  context.after(() => manager.close());
  const open = async (serial: string) => {
    const response = new PassThrough() as unknown as ServerResponse;
    const bytes: Buffer[] = [];
    response.writeHead = (() => response) as ServerResponse["writeHead"];
    response.on("data", (chunk: Buffer) => bytes.push(Buffer.from(chunk)));
    await manager.addClient(serial, response);
    sources.get(serial)!.write(Buffer.concat([annexBNal(0x40, 0x01, 0x0c), annexBNal(0x42, 0x01, 0x01), annexBNal(0x44, 0x01, 0xc0), annexBNal(0x26, 0x01, 0xbb)]));
    return { response, bytes };
  };
  const first = await open(camera.serial);
  const old = converters[0]!;
  first.response.destroy();
  await new Promise(resolve => setTimeout(resolve, 20));
  const second = await open(other.serial);
  const oldPicture = Buffer.concat([annexBNal(0x67, 0x64, 0x00, 0x1f), annexBNal(0x68, 0xee, 0x3c), annexBNal(0x65, 0x88, 0x99)]);

  // Matching encoder headers and an IDR do not identify which camera produced queued output.
  old.stdout.emit("data", oldPicture);
  assert.equal(Buffer.concat(second.bytes).length, 0, "old converted camera bytes must not start the new view");
  assert.equal(converters.length, 2);
  const newPicture = Buffer.concat([annexBNal(0x67, 0x64, 0x00, 0x1f), annexBNal(0x68, 0xee, 0x3c), annexBNal(0x65, 0x88, 0xaa)]);
  converters[1]!.stdout.emit("data", newPicture);
  assert.ok(Buffer.concat(second.bytes).includes(annexBNal(0x65, 0x88, 0xaa)));
  assert.equal(Buffer.concat(second.bytes).includes(annexBNal(0x65, 0x88, 0x99)), false);
});

test("each stopped H.265 source retires its converter even when camera headers match", async () => {
  const state = new GatewayState();
  const other = { ...camera, serial: `${camera.serial}-other` }, third = { ...camera, serial: `${camera.serial}-third` };
  for (const value of [camera, other, third]) state.registerCamera(value);
  let manager: LiveStreamManager;
  const sources = new Map<string, PassThrough>();
  const made: ChildProcessWithoutNullStreams[] = [];
  const kills: ChildProcessWithoutNullStreams[] = [];
  const create = () => {
    const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null, kill: () => { kills.push(process); return true; } }) as unknown as ChildProcessWithoutNullStreams;
    (process.stdin as PassThrough).resume();
    made.push(process);
    return process;
  };
  manager = new LiveStreamManager(state, {} as never, {
    async startStream(serial: string) { const source = new PassThrough(); sources.set(serial, source); manager.attachSource(serial, source); },
    async stopStream(serial: string) { sources.get(serial)!.end(); },
  }, 0, undefined, create);
  const view = async (serial: string, sps: Buffer) => {
    const response = new PassThrough() as unknown as ServerResponse;
    response.writeHead = (() => response) as ServerResponse["writeHead"];
    (response as unknown as PassThrough).resume();
    await manager.addClient(serial, response);
    sources.get(serial)!.write(Buffer.concat([annexBNal(0x40, 0x01, 0x0c), sps, annexBNal(0x44, 0x01, 0xc0), annexBNal(0x26, 0x01, 0xbb)]));
    return response;
  };
  const closed = async (response: ServerResponse) => {
    response.destroy();
    await new Promise(resolve => setTimeout(resolve, 20));
  };
  const same = annexBNal(0x42, 0x01, 0x01), different = annexBNal(0x42, 0x01, 0x02);

  await closed(await view(camera.serial, same));
  assert.equal(made.length, 1);
  assert.deepEqual(kills, [made[0]]);

  await closed(await view(other.serial, same));
  assert.equal(made.length, 2, "matching headers do not permit another camera to borrow the conversion");

  const response = await view(third.serial, different);
  assert.equal(made.length, 3, "each new source owns a new encoder");
  assert.deepEqual(kills, [made[0], made[1]]);
  await closed(response);
  await manager.close();
  assert.deepEqual(kills, [made[0], made[1], made[2]]);
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
    inputSkips: 0,
    inputSkippedBytes: 0,
    maximumInputAgeMilliseconds: 0,
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

test("recovers initial silence and a later H.265 stall only from a new complete picture", async () => {
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
  (replacementViewer.stdout as PassThrough).write(h264);
  assert.equal(transcoders.length, 3, "healthy conversion must not restart");
  now = 23_000;
  source.write(annexBNal(0x02, 1, 0x80, 4));
  assert.equal(transcoders.length, 3, "a stale startup picture must not trigger stall recovery");
  source.write(annexBNal(0x26, 1, 0x80, 4));
  assert.equal(transcoders.length, 4, "a running converter that stopped output must recover from the next complete picture");
  replacementViewer.emit("close", 1);
  assert.equal(response.destroyed, false);
  (transcoders[3]!.stdout as PassThrough).write(h264);
  assert.ok(Buffer.concat(delivered).includes(h264));

  response.emit("close");
  assert.equal(summaries.at(-1)?.silentRestarts, 2);
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

/** A real child that never reads stdin, as FFmpeg behaves once it has stopped reading at SIGTERM. */
function nonReadingChild(): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"]);
}

/** Resolve once the child has exited and its stdin has closed, by whichever route. */
async function reaped(child: ChildProcessWithoutNullStreams): Promise<void> {
  await Promise.all([
    child.exitCode !== null || child.signalCode !== null ? undefined : new Promise((resolve) => child.once("close", resolve)),
    child.stdin.closed ? undefined : new Promise((resolve) => child.stdin.once("close", resolve)),
  ]);
}

test("drops input a terminated media child has not read instead of failing it with EPIPE", async context => {
  const child = nonReadingChild();
  context.after(async () => { terminateMediaProcess(child); await reaped(child); });
  const errors: Error[] = [];
  child.stdin.on("error", (error) => errors.push(error));
  await once(child, "spawn");

  // More than a pipe holds, so the rest stays queued in the gateway when termination starts.
  child.stdin.write(Buffer.alloc(4 * 1024 * 1024));
  assert.ok(child.stdin.writableLength > 0);
  terminateMediaProcess(child);
  await reaped(child);

  assert.deepEqual(errors, []);
});

test("reports no pipeline warning for FFmpeg input left queued when a viewer leaves or the source closes", async context => {
  const state = new GatewayState();
  state.registerCamera(camera);
  const viewers: ChildProcessWithoutNullStreams[] = [];
  const extractors: ChildProcessWithoutNullStreams[] = [];
  let source: PassThrough;
  let manager: LiveStreamManager;

  // The long grace keeps the source open after the viewer leaves, as an NVR session holds it.
  manager = new LiveStreamManager(state, {} as never, {
    async startStream() {
      source = new PassThrough();
      manager.attachSource(camera.serial, source, () => "h265");
    },
    async stopStream() {
      source.end();
    },
  }, 60_000, undefined, () => {
    viewers.push(nonReadingChild());
    return viewers.at(-1)!;
  }, () => {
    extractors.push(nonReadingChild());
    return extractors.at(-1)!;
  });
  context.after(async () => {
    await manager.close();
    const children = [...viewers, ...extractors];
    for (const child of children) terminateMediaProcess(child);
    await Promise.all(children.map(reaped));
  });
  const warnings: Error[] = [];
  manager.on("warning", (error: Error) => warnings.push(error));
  const response = new PassThrough() as unknown as ServerResponse;
  response.writeHead = (() => response) as ServerResponse["writeHead"];
  await manager.addClient(camera.serial, response);
  source!.write(Buffer.concat([annexBNal(0x40, 0x01, 0x0c), annexBNal(0x42, 0x01, 0x01), annexBNal(0x44, 0x01, 0xc0), annexBNal(0x26, 0x01, 0xbb)]));
  for (let index = 0; index < 400; index++) source!.write(Buffer.concat([annexBNal(0x02, 0x01), Buffer.alloc(6_000, 0x55)]));
  const [viewer, extractor] = [viewers[0]!, extractors[0]!];
  assert.equal(viewers.length + extractors.length, 2);
  assert.ok(viewer.stdin.writableLength > 0 && extractor.stdin.writableLength > 0);

  response.emit("close");
  await reaped(viewer);
  assert.deepEqual(warnings, []);

  await manager.close();
  await reaped(extractor);
  assert.deepEqual(warnings, []);
});

test("a conversion and snapshot extractor that fall behind skip to the next keyframe instead of queueing", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  let now = 0;

  // Fake children whose pipes hold everything until the test lets them read.
  class HeldInput extends EventEmitter {
    writable = true;
    writableLength = 0;
    readonly writes: Buffer[] = [];
    write(data: Buffer): boolean { this.writes.push(Buffer.from(data)); this.writableLength += data.length; return true; }
    destroy(): void { this.writable = false; }
  }
  const child = (): ChildProcessWithoutNullStreams => Object.assign(new EventEmitter(), {
    stdin: new HeldInput(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true, exitCode: null, signalCode: null,
  }) as unknown as ChildProcessWithoutNullStreams;
  const transcoder = child(), extractor = child();
  const conversionInput = transcoder.stdin as unknown as HeldInput, snapshotInput = extractor.stdin as unknown as HeldInput;
  const source = new PassThrough();
  let manager: LiveStreamManager;
  manager = new LiveStreamManager(state, {} as never, {
    async startStream() { manager.attachSource(camera.serial, source, () => "h265"); }, async stopStream() {},
  }, 5, undefined, () => transcoder, () => extractor, 30_000, () => now);
  const transcoderSummaries: ViewerTranscoderSummary[] = [];
  const deliverySummaries: ViewerDeliverySummary[] = [];
  manager.on("viewer-transcoder-stopped", (summary) => transcoderSummaries.push(summary));
  manager.on("viewer-delivery-stopped", (summary) => deliverySummaries.push(summary));
  const response = new PassThrough() as unknown as ServerResponse;
  response.writeHead = (() => response) as ServerResponse["writeHead"];
  await manager.addClient(camera.serial, response);

  const keyframe = Buffer.concat([annexBNal(0x40, 0x01, 0x0c), annexBNal(0x42, 0x01, 0x01), annexBNal(0x44, 0x01, 0xc0), annexBNal(0x26, 0x01, 0x80)]);
  const picture = Buffer.concat([annexBNal(0x02, 0x01, 0x80), Buffer.alloc(1_000, 0x55)]);
  source.write(keyframe);
  for (now = 100; now <= 2_000; now += 100) source.write(picture);
  assert.equal(conversionInput.writes.length, 21);
  assert.equal(snapshotInput.writes.length, 21);

  // The keyframe written at 0 ms is now unread for more than two seconds.
  source.write(picture);
  source.write(keyframe);
  assert.equal(conversionInput.writes.length, 21, "nothing more queues behind unread input");
  assert.equal(snapshotInput.writes.length, 21);

  // Once both have read what they held, they start again at the next keyframe, not at the picture before it.
  conversionInput.writableLength = 0;
  snapshotInput.writableLength = 0;
  now += 100;
  source.write(picture);
  source.write(keyframe);
  const endOfSequence = Buffer.from([0, 0, 0, 1, 0x48, 0x01]);
  for (const input of [conversionInput, snapshotInput]) assert.deepEqual(input.writes.slice(21), [endOfSequence, keyframe]);

  await manager.close();
  assert.equal(transcoderSummaries.length, 1);
  assert.deepEqual(
    [transcoderSummaries[0]!.inputSkips, transcoderSummaries[0]!.inputSkippedBytes, transcoderSummaries[0]!.inputBytes],
    [1, 2 * picture.length + keyframe.length, keyframe.length + 20 * picture.length + endOfSequence.length + keyframe.length],
  );
  assert.ok(transcoderSummaries[0]!.maximumInputAgeMilliseconds > 2_000);
  assert.equal(deliverySummaries[0]!.snapshotInputSkips, 1);
  assert.ok(deliverySummaries[0]!.maximumSnapshotInputAgeMilliseconds > 2_000);
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

test("collects audio only inside the video recording interval and detaches it on cleanup", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const state = new GatewayState();
  state.registerCamera(camera);
  const source = new PassThrough();
  const audio = new PassThrough();
  let recordedAudio: Buffer | undefined;
  let manager!: LiveStreamManager;
  manager = new LiveStreamManager(state, {} as never, {
    async startStream() { manager.attachSource(camera.serial, source, () => null, audio); },
    async stopStream() { source.end(); audio.end(); },
  }, 5, async (video, _codec, sound) => {
    recordedAudio = sound;
    return video;
  });
  const recording = manager.recordClip(camera.serial, 1, 50);
  await Promise.resolve();
  audio.write(Buffer.from("before-video"));
  source.write(Buffer.from("video"));
  audio.write(Buffer.from("included"));
  context.mock.timers.tick(1_000);
  await recording;
  audio.write(Buffer.from("after-video"));
  assert.equal(recordedAudio?.toString(), "included");
  await manager.close();
  assert.equal(audio.listenerCount("data"), 0);
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


test("retains a decoded source beyond idle grace until a camera operation finishes", async () => {
  const state = new GatewayState();
  state.registerCamera(camera);
  let stops = 0;
  const manager = new LiveStreamManager(state, {} as never, {
    async startStream() {
      setTimeout(() => state.updateSnapshot(camera.serial, {
        capturedAt: new Date().toISOString(), contentType: "image/jpeg", source: "live", revision: 1,
      }), 1);
    },
    async stopStream() { stops++; },
  }, 5);
  try {
    const result = await manager.withLiveSource(camera.serial, async () => {
      assert.equal(state.getCamera(camera.serial).snapshot?.revision, 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(stops, 0);
      return "movement-complete";
    });
    assert.equal(result, "movement-complete");
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(stops, 1);
  } finally { await manager.close(); }
});

test("releases the camera operation lease when movement or source startup fails", async () => {
  for (const startupFails of [false, true]) {
    const state = new GatewayState();
    state.registerCamera(camera);
    let stops = 0;
    let called = false;
    const manager = new LiveStreamManager(state, {} as never, {
      async startStream() {
        if (startupFails) throw new Error("source-unavailable");
        setTimeout(() => state.updateSnapshot(camera.serial, {
          capturedAt: new Date().toISOString(), contentType: "image/jpeg", source: "live", revision: 1,
        }), 1);
      },
      async stopStream() { stops++; },
    }, 5);
    try {
      await assert.rejects(manager.withLiveSource(camera.serial, async () => {
        called = true;
        throw new Error("movement-failed");
      }), startupFails ? /source-unavailable/ : /movement-failed/);
      assert.equal(called, !startupFails);
      assert.equal(state.listenerCount("event"), 0);
      await new Promise((resolve) => setTimeout(resolve, 15));
      if (!startupFails) assert.equal(stops, 1);
    } finally { await manager.close(); }
  }
});

test("active-viewer lease never waits for a fresh image or captures a snapshot", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const state = new GatewayState(); state.registerCamera(camera);
  let snapshots = 0, manager: LiveStreamManager;
  const source = new PassThrough();
  manager = new LiveStreamManager(state, { write: async () => { snapshots++; } } as never, {
    async startStream() { manager.attachSource(camera.serial, source); }, async stopStream() {},
  }, 5, undefined, undefined, (() => { throw Error("Unexpected snapshot extractor"); }) as never, 90000);
  try {
    await assert.rejects(manager.withActiveViewer(camera.serial, async () => true));
    const viewer = new PassThrough() as unknown as ServerResponse;
    await manager.addClient(camera.serial, viewer);
    source.write(Buffer.from([1])); context.mock.timers.tick(31000);
    assert.equal(manager.hasActiveViewer(camera.serial), true);
    assert.equal(await manager.withActiveViewer(camera.serial, async () => "accepted"), "accepted");
    assert.equal(snapshots, 0);
  } finally { await manager.close(); }
});
