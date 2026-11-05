/**
 * Tests universal selection, source-byte integrity and authenticated consent.
 * Synthetic inventory, clocks and streams own every input. Archive decoding
 * validates exported evidence without claiming real device playback success.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { BundleCapture, diagnosticTargets } from "../src/diagnostics/bundle-capture.js";
import { diagnosticsPage } from "../src/diagnostics/page.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import { createLogger } from "../src/logging.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { GatewayServer, createStreamToken } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import { LiveStreamManager } from "../src/stream/live-stream-manager.js";

function fixture(): GatewayState {
  const state = new GatewayState();
  for (const [serial, parent] of [["private-camera", "private-parent"], ["private-standalone", "private-standalone"]] as const) {
    state.registerCamera({ serial, name: "Private label", model: "T8171", stationSerial: parent,
      firmware: "1.2.3", streamSupported: true, liveAudioSupported: true, doorbellSupported: false });
  }
  state.updateInventoryDiagnostics([
    { serial: "private-camera", name: "Private label", model: "T8171", sources: ["mega"] as const,
      upstreamIsCamera: false, acceptedAsCamera: true, megaDeviceType: 88, category: "eufy_security",
      cameraSwitch1035: "structured" },
    { serial: "private-standalone", name: "Private label", model: "T8171", sources: ["mega"] as const,
      upstreamIsCamera: false, acceptedAsCamera: true, megaDeviceType: 88, category: "eufy_security",
      cameraSwitch1035: "missing" },
    ...[["private-parent", "T8030", 18], ["private-nvr", "T8N00", 300], ["private-sensor", "T8900", 10]].map(([serial, model, type]) => ({
      serial: String(serial), name: "Private label", model: String(model), sources: ["mega"] as const,
      upstreamIsCamera: false, acceptedAsCamera: false, megaDeviceType: Number(type), category: null,
      cameraSwitch1035: "missing" as const,
    })),
  ]);
  return state;
}

function decode(capture: BundleCapture) { return JSON.parse(gunzipSync(capture.archive(fixture())!).toString()); }

test("one metadata projection covers attached and standalone cameras, stations, NVR and sensors without identities", () => {
  const state = fixture();
  assert.equal(diagnosticTargets(state).length, 5);
  const capture = new BundleCapture({ target: null, seconds: 30, media: false });
  try {
    capture.event({ type: "connection-updated", state: "error", detail: "secret https://private.invalid/?token=private" });
    const archive = decode(capture);
    assert.equal(archive.summary.devices.length, 5);
    const attached = archive.summary.devices.find((row: { topology: string }) => row.topology === "attached");
    assert.deepEqual(attached.cameraEnableReport, { normalized: null, source1035: "structured" });
    assert.equal(archive.summary.devices.find((row: { model: string }) => row.model === "T8030").id, attached.parent);
    assert.equal(archive.stages.nvrRtc, false);
    assert.doesNotMatch(JSON.stringify(archive), /private-|Private|secret|invalid|serial|personName|token=/);
    assert.equal(archive.records[0].code, "error");
  } finally { capture.clear(); }
});

test("source video and audio retain exact bytes, codec, relative timing and checksums after caller mutation", () => {
  let now = 100;
  const capture = new BundleCapture({ target: "private-camera", seconds: 30, media: true }, () => now);
  capture.select("private-camera");
  try {
    now += 17;
    const video = Buffer.from([0, 0, 0, 1, 0x65, 42]);
    capture.media({ serial: "private-camera", kind: "video", codec: "h264", data: video });
    video.fill(9);
    capture.media({ serial: "private-camera", kind: "audio", codec: "aac", data: Buffer.from([0xff, 0xf1, 2]) });
    capture.media({ serial: "private-standalone", kind: "video", codec: "h265", data: Buffer.from([1]) });
    const archive = decode(capture);
    assert.equal(archive.media.length, 2);
    assert.equal(archive.media[0].offsetMs, 17);
    const bytes = Buffer.from(archive.media[0].base64, "base64");
    assert.deepEqual(bytes, Buffer.from([0, 0, 0, 1, 0x65, 42]));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), archive.media[0].sha256);
    assert.equal(archive.media[1].codec, "aac");
    assert.deepEqual(Buffer.from(archive.media[1].base64, "base64"), Buffer.from([0xff, 0xf1, 2]));
    assert.equal(archive.summary.devices.length, 1);
  } finally { capture.clear(); }
});

test("consent, deadlines, size and record caps, stop and expiry are enforced synchronously", () => {
  let now = 0;
  const metadata = new BundleCapture({ target: null, seconds: 30, media: false }, () => now);
  const capture = new BundleCapture({ target: null, seconds: 60, media: true }, () => now);
  const records = new BundleCapture({ target: null, seconds: 30, media: false });
  try {
    metadata.media({ serial: "fixture", kind: "audio", codec: "aac", data: Buffer.from([1]) });
    assert.equal(metadata.status().mediaBytes, 0);
    now = 30_000;
    metadata.record("late");
    assert.equal(metadata.status().state, "duration_limit");
    assert.equal(metadata.status().records, 0);
    const block = Buffer.alloc(8 * 1024 * 1024, 1);
    for (let i = 0; i < 8; i++) capture.media({ serial: "fixture", kind: "video", codec: "h264", data: block });
    capture.media({ serial: "fixture", kind: "video", codec: "h264", data: Buffer.from([2]) });
    assert.equal(capture.status().state, "size_limit");
    assert.equal(capture.status().mediaBytes, 64 * 1024 * 1024);
    capture.clear();
    assert.equal(capture.status().mediaBytes, 0);
    assert.equal(capture.archive(fixture()), null);
    now = 600_000;
    assert.equal(metadata.status().state, "expired");
    assert.equal(metadata.archive(fixture()), null);
    for (let i = 0; i <= 20_000; i++) records.record("fixture");
    assert.equal(records.status().state, "record_limit");
    assert.equal(records.status().records, 20_000);
  } finally { metadata.clear(); capture.clear(); records.clear(); }
});

test("HTTP consent and token checks, station children, log privacy and subscription cleanup", async () => {
  const state = fixture(), streams = new EventEmitter();
  const server = new GatewayServer({ ...loadConfig({}), apiToken: "synthetic-token", port: 0 }, state,
    new SnapshotStore("unused"), streams as LiveStreamManager, {} as CameraProvider, null);
  const headers = { authorization: "Bearer synthetic-token", "content-type": "application/json" };
  try {
    await server.listen();
    const path = `http://127.0.0.1:${server.port}/api/diagnostics/bundle`;
    assert.equal((await fetch(path)).status, 401);
    const signed = createStreamToken("private-camera", Math.floor(Date.now() / 1000) + 60, "synthetic-token");
    assert.equal((await fetch(path + "?access_token=" + signed)).status, 401);
    const post = (body: unknown) => fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal((await post({ target: null, seconds: 30, media: true })).status, 400);
    assert.equal((await post({ target: null, seconds: 900, media: false })).status, 400);
    assert.equal((await post({ target: "missing", seconds: 30, media: false })).status, 404);
    assert.equal((await post({ target: null, seconds: 30, media: false, unknown: true })).status, 400);
    assert.equal((await post({ target: "private-parent", seconds: 30, media: true, consentPrivateMedia: true })).status, 201);
    assert.equal((await post({ target: null, seconds: 30, media: false })).status, 409);
    streams.emit("diagnostic-media", { serial: "private-camera", kind: "audio", codec: "aac", data: Buffer.from([1, 2, 3]) });
    streams.emit("diagnostic-media", { serial: "private-standalone", kind: "audio", codec: "aac", data: Buffer.from([9]) });
    createLogger("fixture").warn("synthetic_failure", "Private label secret token=foo https://private.invalid");
    const result = await fetch(path + "/export", { method: "POST", headers });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
    const data = JSON.parse(gunzipSync(Buffer.from(await result.arrayBuffer())).toString());
    assert.equal(data.media.length, 1);
    assert.equal(data.summary.devices.length, 2);
    assert.ok(data.records.some((row: { event: string }) => row.event === "log:fixture:synthetic_failure"));
    assert.doesNotMatch(JSON.stringify(data), /Private|private-|secret|token=|invalid/);
    assert.equal(streams.listenerCount("diagnostic-media"), 0);
    assert.equal(state.listenerCount("event"), 0);
    await fetch(path, { method: "DELETE", headers });
    assert.equal((await fetch(path + "/export", { method: "POST", headers })).status, 410);
    assert.equal((await post({ target: null, seconds: 30, media: false })).status, 201);
    assert.equal(streams.listenerCount("diagnostic-media"), 0);
  } finally { await server.close(); assert.equal(state.listenerCount("event"), 0); }
});

test("unconfigured credentials refuse diagnostics and page script parses without token persistence", async () => {
  const server = new GatewayServer({ ...loadConfig({}), apiToken: "", port: 0 }, fixture(),
    new SnapshotStore("unused"), new EventEmitter() as LiveStreamManager, {} as CameraProvider, null);
  try {
    await server.listen();
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/diagnostics/summary`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/diagnostics`)).status, 200);
    const page = diagnosticsPage();
    assert.doesNotThrow(() => new Function(page.slice(page.indexOf("<script>") + 8, page.lastIndexOf("</script>"))));
    assert.doesNotMatch(page, /localStorage|sessionStorage|access_token/);
  } finally { await server.close(); }
});


test("the real stream manager tap sees original bytes without starting a viewer or transcoder", async () => {
  const state = fixture();
  let starts = 0;
  const manager = new LiveStreamManager(state, {} as SnapshotStore, {
    async startStream() { starts++; }, async stopStream() {},
  }, 1);
  const capture = new BundleCapture({ target: null, seconds: 30, media: true });
  const source = new PassThrough(), audio = new PassThrough();
  manager.on("diagnostic-media", sample => capture.media(sample));
  try {
    manager.attachSource("private-camera", source, () => "h265", audio);
    source.write(Buffer.from([0, 0, 1, 0x02, 0x01, 42]));
    audio.write(Buffer.from([0xff, 0xf1, 9]));
    const result = decode(capture);
    assert.equal(starts, 0);
    assert.equal(result.media[0].codec, "h265");
    assert.deepEqual(Buffer.from(result.media[0].base64, "base64"), Buffer.from([0, 0, 1, 0x02, 0x01, 42]));
    assert.deepEqual(Buffer.from(result.media[1].base64, "base64"), Buffer.from([0xff, 0xf1, 9]));
  } finally { await manager.close(); capture.clear(); }
});

test("transport evidence rejects private extras and invalid numeric counter values", () => {
  const capture = new BundleCapture({ target: null, seconds: 30, media: false });
  try {
    capture.transport("private-camera", { stage: "first-frame", counters: {
      dataDatagrams: 12, frameHeaders: 2, videoFrames: 0, videoOutputFrames: 0,
      sequenceGaps: 4, sequenceRestarts: 0, duplicateDatagrams: 5, staleDatagrams: 1,
      parserResyncs: NaN, pendingBytes: -1, incompleteAccessUnits: 0, incompleteAccessUnitBytes: 0,
      privateKey: "secret", firstDataHex: "private-prefix",
    } } as never);
    const row = decode(capture).records[0];
    assert.equal(row.code, "first-frame");
    assert.equal(row.counters.sequenceGaps, 4);
    assert.equal(row.counters.duplicateDatagrams, 5);
    assert.equal(row.counters.parserResyncs, undefined);
    assert.equal(row.counters.pendingBytes, undefined);
    assert.doesNotMatch(JSON.stringify(row), /secret|private-|privateKey|firstDataHex/);
  } finally { capture.clear(); }
});

test("captures renumber sources independently and keep startup evidence within closed fields", () => {
  const first = new BundleCapture({ target: null, seconds: 30, media: false });
  const second = new BundleCapture({ target: null, seconds: 30, media: false });
  const counters = { dataDatagrams: 5, frameHeaders: 5, videoFrames: 0, videoOutputFrames: 0,
    sequenceGaps: 0, sequenceRestarts: 0, duplicateDatagrams: 0, staleDatagrams: 0,
    parserResyncs: 0, pendingBytes: 0, incompleteAccessUnits: 0, incompleteAccessUnitBytes: 0,
    mediaStartAcknowledged: 1, mediaStartAttempts: 1 };
  const diagnostic = { stage: "first-frame", sourceAttempt: 99, startupBoundary: "start-acknowledged-no-video", counters,
    frameKinds: [{ kind: "response", command: 1350, signCode: 1, transportType: 0, payload: "PRIVATE" },
      { kind: "PRIVATE", command: 1, signCode: 0, transportType: 0 },
      { kind: "other", command: 65536, signCode: 0, transportType: 0 }] };
  try {
    first.transport("private-camera", diagnostic as never);
    first.transport("private-camera", diagnostic as never);
    first.transport("private-camera", { ...diagnostic, sourceAttempt: 101 } as never);
    second.transport("private-camera", { ...diagnostic, sourceAttempt: 101 } as never);
    const rows = decode(first).records;
    assert.deepEqual(rows.map((value: { sourceAttempt: number }) => value.sourceAttempt), [1, 1, 2]);
    assert.equal(decode(second).records[0].sourceAttempt, 1);
    assert.equal(rows[0].counters.mediaStartAcknowledged, 1);
    assert.equal(rows[0].startupBoundary, "start-acknowledged-no-video");
    assert.deepEqual(rows[0].frameKinds, [{ kind: "response", command: 1350, signCode: 1, transportType: 0 }]);
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|payload|65536|private-camera/);
  } finally { first.clear(); second.clear(); }
});

test("HTTP capture snapshots a retiring source before its replacement resets counters", async () => {
  const state = fixture(), streams = new EventEmitter();
  const counters = { dataDatagrams: 5, frameHeaders: 5, videoFrames: 0, videoOutputFrames: 0,
    sequenceGaps: 0, sequenceRestarts: 0, duplicateDatagrams: 0, staleDatagrams: 0,
    parserResyncs: 0, pendingBytes: 0, incompleteAccessUnits: 0, incompleteAccessUnitBytes: 0,
    mediaStartAcknowledged: 1, mediaStartAttempts: 1 };
  let source = { stage: "first-frame", sourceAttempt: 42, counters };
  const provider = { streamDiagnostic: (serial: string) => serial === "private-camera" ? source : null } as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), apiToken: "synthetic-token", port: 0 }, state,
    new SnapshotStore("unused"), streams as LiveStreamManager, provider, null);
  const headers = { authorization: "Bearer synthetic-token", "content-type": "application/json" };
  try {
    await server.listen();
    const path = `http://127.0.0.1:${server.port}/api/diagnostics/bundle`;
    assert.equal((await fetch(path, { method: "POST", headers,
      body: JSON.stringify({ target: "private-camera", seconds: 30, media: false }) })).status, 201);
    source.counters = { ...counters, frameHeaders: 6 };
    createLogger("provider").info("camera_stream_closed", "synthetic close boundary");
    source = { stage: "first-frame", sourceAttempt: 43, counters: { ...counters, frameHeaders: 0 } };
    createLogger("provider").info("camera_stream_start_failed", "synthetic replacement boundary");
    const response = await fetch(path + "/export", { method: "POST", headers });
    const archive = JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString());
    const rows = archive.records.filter((value: { event: string }) => value.event === "source-transport");
    assert.deepEqual([...new Set(rows.map((value: { sourceAttempt: number }) => value.sourceAttempt))], [1, 2]);
    const retiring = rows.findIndex((value: { sourceAttempt: number; counters: { frameHeaders: number } }) => value.sourceAttempt === 1 && value.counters.frameHeaders === 6);
    const replacement = rows.findIndex((value: { sourceAttempt: number }) => value.sourceAttempt === 2);
    assert.ok(retiring >= 0 && replacement > retiring);
    assert.ok(rows.filter((value: { sourceAttempt: number }) => value.sourceAttempt === 2)
      .every((value: { counters: { frameHeaders: number } }) => value.counters.frameHeaders === 0));
    assert.equal(archive.media.length, 0);
    assert.doesNotMatch(JSON.stringify(archive), /synthetic close|synthetic replacement|private-camera/);
  } finally { await server.close(); }
});
