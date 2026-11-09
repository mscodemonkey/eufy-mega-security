/**
 * Verifies the public S120 failure line excludes arbitrary provider errors.
 * Synthetic failures own all input and never open a session or write a device.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { S120LightTrialError, s120LightFailureDiagnostic } from "../src/provider/s120-light-diagnostic.js";


test("manual-light diagnostics retain dispatch uncertainty without exposing private failure text", () => {
  const failure = new S120LightTrialError("write_receipt", true, false);
  failure.message = "PRIVATE_URL_TOKEN_SERIAL";
  assert.equal(s120LightFailureDiagnostic(failure),
    "stage=write_receipt write_attempted=true acknowledgement_received=false cleanup_failed=false");
  assert.doesNotMatch(s120LightFailureDiagnostic(failure), /PRIVATE/);
});

test("unknown and malformed trial errors cannot add unreviewed diagnostic values", () => {
  for (const failure of [new Error("PRIVATE"), null, { stage: "write_receipt", writeAttempted: true },
    Object.assign(new S120LightTrialError("cleanup", false, false), { stage: "PRIVATE", writeAttempted: "PRIVATE" })]) {
    assert.equal(s120LightFailureDiagnostic(failure),
      "stage=unknown write_attempted=unknown acknowledgement_received=unknown cleanup_failed=unknown");
  }
});
