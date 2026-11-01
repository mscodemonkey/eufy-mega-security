/**
 * Verifies startup conclusions from synthetic PPCS counters and header shapes.
 * Fixtures own all state and never open a socket or imply hardware recovery.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ppcsSourceDiagnostic } from "../src/diagnostics/ppcs-source-diagnostic.js";

function fixture(): Parameters<typeof ppcsSourceDiagnostic>[0] {
  return { camId: 0, gatewayInfo: 0, level2: 0, cameraInfoFrames: 0, foreignVideoFrames: 0,
    gatewayInfoAcknowledged: 0, gatewayInfoRetransmitted: 0, gatewayInfoExpired: 0,
    mediaStartAttempts: 0, mediaStartAcknowledged: 0, mediaStartRetransmitted: 0, mediaStartExpired: 0,
    dataDatagrams: 0, frameHeaders: 0, videoFrames: 0, videoOutputFrames: 0, sequenceGaps: 0,
    sequenceRestarts: 0, duplicateDatagrams: 0, staleDatagrams: 0, parserResyncs: 0, pendingBytes: 0,
    incompleteAccessUnits: 0, incompleteAccessUnitBytes: 0, frameShapes: [] };
}

test("startup boundaries separate request dispatch, transport ACK and usable output", () => {
  const stats = fixture();
  const boundary = () => ppcsSourceDiagnostic(stats, 42).startupBoundary;
  assert.equal(boundary(), "lookup");
  stats.camId = 1;
  assert.equal(boundary(), "start-not-sent");
  stats.mediaStartAttempts = 1;
  assert.equal(boundary(), "start-unacknowledged");
  stats.mediaStartAcknowledged = 1;
  assert.equal(boundary(), "start-acknowledged-no-video");
  stats.videoFrames = 1;
  assert.equal(boundary(), "video-without-output");
  stats.videoOutputFrames = 1;
  assert.equal(boundary(), "output");
  stats.mediaStartAcknowledged = NaN;
  assert.equal(boundary(), "unknown");
});

test("complete frame kinds omit payload sizes, deduplicate and bound malformed input", () => {
  const stats = fixture();
  stats.frameShapes = ["1100:1:120:0", "1100:1:999:0", "1300:8:65535:1", "50000:200:4:65000",
    "65536:0:1:1", "1300:256:1:1", "1300:8:1:65536", "PRIVATE_PAYLOAD"];
  const result = ppcsSourceDiagnostic({ ...stats, firstDataHex: "PRIVATE_PREFIX", privateKey: "PRIVATE_KEY" } as never, 99);
  assert.deepEqual(result.frameKinds, [
    { kind: "gateway-info", command: 1100, signCode: 1, transportType: 0 },
    { kind: "video", command: 1300, signCode: 8, transportType: 1 },
    { kind: "other", command: 50000, signCode: 200, transportType: 65000 },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|65535|999|frameShapes|firstDataHex|privateKey/);
  stats.frameShapes = Array.from({ length: 50 }, (_, index) => `${index}:0:1:1`);
  assert.equal(ppcsSourceDiagnostic(stats, 1).frameKinds!.length, 20);
  assert.equal(ppcsSourceDiagnostic(stats, NaN).sourceAttempt, undefined);
});

test("a projection freezes the observation rather than borrowing mutable source arrays", () => {
  const stats = fixture();
  stats.frameHeaders = 5;
  stats.frameShapes = ["1350:1:16:0"];
  const before = ppcsSourceDiagnostic(stats, 4);
  stats.frameHeaders = 0;
  stats.frameShapes.length = 0;
  assert.equal(before.counters.frameHeaders, 5);
  assert.equal(before.frameKinds!.length, 1);
});
