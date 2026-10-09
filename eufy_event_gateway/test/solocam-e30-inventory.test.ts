/**
 * Checks SoloCam T8171 inventory decoding against model-specific cloud fields.
 * Synthetic rows belong to these tests and exercise the provider boundary without
 * contacting an account or asserting that physical camera controls succeeded.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { safeInventoryReads } from "../src/provider/eufy-provider.js";

test("SoloCam T8171 detection reads take precedence over conflicting legacy bits", () => {
  for (const enabled of [0, 1]) {
    const reads = safeInventoryReads([
      { param_type: 6040, param_value: String(enabled) },
      { param_type: 1011, param_value: String(1 - enabled) },
    ], 88, "T8171");
    assert.equal(reads.motionDetectionEnabled, enabled === 1);
  }
});

test("SoloCam T8171 never guesses a missing or invalid detection state from a legacy bit", () => {
  for (const value of [undefined, null, "invalid", 2, -1, 0.5]) {
    const reads = safeInventoryReads([
      { param_type: 6040, param_value: value },
      { param_type: 1011, param_value: 1 },
    ], 88, "T8171");
    assert.equal(reads.motionDetectionEnabled, undefined);
  }
});

test("unverified E30 identities retain their existing legacy detection decoding", () => {
  for (const [deviceType, model] of [[34, "T8417"], [88, "T8417"], [34, "T8171"], [88, "T8171-X"]] as const) {
    const reads = safeInventoryReads([
      { param_type: 6040, param_value: 0 },
      { param_type: 1011, param_value: 1 },
    ], deviceType, model);
    assert.equal(reads.motionDetectionEnabled, true);
  }
});

test("SoloCam T8171 audio recording uses its enable bit rather than the legacy mute bit", () => {
  for (const enabled of [0, 1]) {
    const reads = safeInventoryReads([
      { param_type: 6012, param_value: String(enabled) },
      { param_type: 1288, param_value: String(enabled) },
    ], 88, "T8171");
    assert.equal(reads.audioRecordingEnabled, enabled === 1);
  }
});

test("missing and malformed SoloCam audio states remain unknown without changing other models", () => {
  for (const value of [undefined, null, "invalid", 2, -1, 0.5]) {
    const rows = [{ param_type: 6012, param_value: value }, { param_type: 1288, param_value: 0 }];
    assert.equal(safeInventoryReads(rows, 88, "T8171").audioRecordingEnabled, undefined);
    assert.equal(safeInventoryReads(rows, 34, "T8417").audioRecordingEnabled, true);
  }
});
