/**
 * Checks fixed E10 signalling failures without accepting new wire shapes.
 * Synthetic values stay in this test. The session consumes only the resulting
 * object or closed diagnostic reason, never a received value in an error.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { nvrJson, NvrTrialError } from "../src/stream/nvr-protocol.js";

for (const boundary of ["outer", "inner", "payload"] as const) {
  for (const [kind, value] of [["size", "sensitive".repeat(9000)], ["json", "{sensitive"],
    ["shape", "[\"sensitive\"]"]] as const) {
    test(`E10 ${boundary} rejects ${kind} without including received content`, () => {
      assert.throws(() => nvrJson(value, boundary), error => {
        assert.ok(error instanceof NvrTrialError);
        assert.equal(error.stage, "framing");
        assert.equal(error.reason, `e10_signal_${boundary}_${kind}`);
        assert.equal(error.message.includes("sensitive"), false);
        assert.equal(JSON.stringify(error).includes("sensitive"), false);
        assert.equal(error.cause, undefined);
        return true;
      });
    });
  }

  test(`E10 ${boundary} preserves valid object and nested-string parsing`, () => {
    const object = { action: 2, code: 200 };
    assert.equal(nvrJson(object, boundary), object);
    assert.deepEqual(nvrJson(JSON.stringify(object) + "\0\0", boundary), object);
    for (const value of [null, undefined, [], 1, "null", "1"]) {
      assert.throws(() => nvrJson(value, boundary), error => error instanceof NvrTrialError
        && error.reason === `e10_signal_${boundary}_shape`);
    }
  });
}

test("other NVR parsers retain their original rejection and exact byte limit", () => {
  for (const value of ["x".repeat(65537), "[", null]) {
    assert.throws(() => nvrJson(value), error => error instanceof NvrTrialError
      && error.stage === "framing" && error.reason === "unspecified");
  }
  const atLimit = JSON.stringify({ value: "x".repeat(65524) });
  assert.equal(Buffer.byteLength(atLimit), 65536);
  assert.equal(nvrJson(atLimit, "outer").value, "x".repeat(65524));
  assert.throws(() => nvrJson(atLimit + " ", "outer"), error => error instanceof NvrTrialError
    && error.reason === "e10_signal_outer_size");
});
