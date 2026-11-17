/**
 * Checks the picture-recovery logging boundary with synthetic notification fields.
 * The normalizer owns reference values. These tests ensure its diagnostic
 * formatter emits only fixed categories consumed by provider failure logs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { pushRecordingReferenceDiagnostic, pushRecordingReferenceProblem, pushRecordingReferenceShape } from "../src/mega/push-recording-reference.js";

test("reference diagnostics distinguish unsupported paths and second-based clocks without leaking values", () => {
  const payload = { record_id: 42, file_path: "/private-camera/secret-clip.dat", trigger_time: 1_800_000_000 };
  const summary = pushRecordingReferenceDiagnostic(pushRecordingReferenceProblem(payload), pushRecordingReferenceShape(payload));
  assert.equal(summary, " reference_problem=path_unsupported reference_path_shape=absolute.other.other reference_calendar=unsupported reference_clock=seconds");
});

test("reference diagnostics reject unexpected runtime categories and oversized shape lists", () => {
  for (const pathShape of ["private-camera", "other\nsecret", Array(13).fill("other").join(".")]) {
    const summary = pushRecordingReferenceDiagnostic("private-reason", { pathShape, calendar: "private-calendar", clock: "private-clock" } as never);
    assert.equal(summary, " reference_problem=unknown reference_path_shape=unknown reference_calendar=unknown reference_clock=unknown");
  }
});
