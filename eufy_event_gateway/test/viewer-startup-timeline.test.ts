/**
 * Checks source/conversion separation against a controlled monotonic clock.
 * Timelines own no device or media state. These cases keep warm observations
 * and conversion retries from being mistaken for newly decoded pictures.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ViewerStartupTimeline } from "../src/stream/viewer-startup-timeline.js";

test("source bytes, random access and converted output remain distinct milestones", () => {
  let now = 100;
  const timeline = new ViewerStartupTimeline(() => now);
  timeline.sourceByte(); now = 300; timeline.sourceRandomAccess(); timeline.conversionStarted();
  now = 600; timeline.conversionOutput(); now = 800; timeline.conversionRandomAccess();
  assert.deepEqual(timeline.snapshot(0, true), {
    sourceFirstByteMilliseconds: 100, sourceRandomAccessMilliseconds: 300,
    conversionStartMilliseconds: 300, conversionFirstOutputMilliseconds: 600,
    viewerRandomAccessMilliseconds: 800, conversionAttempt: 1, warmSource: false, warmViewer: false,
  });
  now = 900; timeline.conversionStarted();
  const retried = timeline.snapshot(0, true);
  assert.equal(retried.conversionAttempt, 2); assert.equal(retried.conversionStartMilliseconds, 900);
  assert.equal(retried.conversionFirstOutputMilliseconds, null); assert.equal(retried.viewerRandomAccessMilliseconds, null);
});

test("native and warm viewers do not borrow another profile's conversion delay", () => {
  const timeline = new ViewerStartupTimeline(() => 100);
  timeline.sourceByte(); timeline.sourceRandomAccess(); timeline.conversionStarted();
  const native = timeline.snapshot(200, false);
  assert.equal(native.sourceFirstByteMilliseconds, 0); assert.equal(native.viewerRandomAccessMilliseconds, 0);
  assert.equal(native.conversionStartMilliseconds, null); assert.equal(native.conversionAttempt, 0);
  assert.equal(native.warmSource, true); assert.equal(native.warmViewer, true);
  const compatible = timeline.snapshot(200, true);
  assert.equal(compatible.warmViewer, false); assert.equal(compatible.viewerRandomAccessMilliseconds, null);
});
