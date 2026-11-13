/**
 * Checks content-free reply diagnostics with synthetic headers only. Tests own
 * counters and errors and never contact a device or permit a control response.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PpcsControlReceiptTrace, controlReceiptSummary, replyProtectionSummary } from "../src/stream/ppcs-reply-evidence.js";
import { CameraInfoReadError, cameraInfoFailureDiagnostic } from "../src/stream/camera-info-failure.js";

test("receipt observations distinguish missing, foreign and unreadable results after retirement", () => {
  const trace = new PpcsControlReceiptTrace(1400, 3);
  trace.frame(1400, 3, 1, false);
  trace.frame(1400, 4, 1, true);
  trace.frame(1403, 3, 8, true);
  trace.frame(1400, 3, 0, true);
  trace.frame(1351, 3, 1, false);
  const previous = trace.snapshot();
  assert.deepEqual(previous, { notificationFrames: 1, selectedNotifications: 1, resultFrames: 3, selectedFrames: 2, matchingFrames: 1,
    decodedFrames: 0, protection: "clear" });
  trace.frame(1400, 3, 1, true); trace.decoded();
  assert.equal(previous.protection, "clear");
  assert.equal(trace.snapshot().protection, "mixed");
  for (let i = 0; i < 70_000; i++) trace.frame(1400, 3, 1, true);
  assert.equal(trace.snapshot().resultFrames, 65_535);
});

test("failure summaries discard invalid fields and arbitrary private text", () => {
  assert.equal(replyProtectionSummary("PRIVATE"), "unobserved");
  const input = { notificationFrames: 0, selectedNotifications: 0, resultFrames: Infinity, selectedFrames: -1, matchingFrames: .5, decodedFrames: 100_000,
    protection: "legacy" as const, privateValue: "PRIVATE" };
  assert.equal(controlReceiptSummary(input), " result_frames=0 selected_result_frames=0 matching_result_frames=0 decoded_result_frames=65535 result_protection=legacy receipt_notify_frames=0 selected_receipt_notify_frames=0");
  assert.equal(cameraInfoFailureDiagnostic(new CameraInfoReadError("protection_mismatch", "level2_short")),
    "reason=protection_mismatch reply_protection=level2_short");
  assert.equal(cameraInfoFailureDiagnostic(Object.assign(new CameraInfoReadError("protection_mismatch"), { protection: "PRIVATE" })),
    "reason=protection_mismatch reply_protection=unobserved");
});
