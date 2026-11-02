/**
 * Checks the C37's slot-array contract using synthetic, content-free replies.
 * The parser owns only projection. Session correlation and movement remain
 * provider responsibilities, and these fixtures establish no hardware result.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseC37PresetPositions } from "../src/stream/first-party-ppcs.js";

test("C37 preset slots retain occupancy and discard scene information", () => {
  assert.deepEqual(parseC37PresetPositions({ points: [
    { enable: 1, isdefault: 1, name: "synthetic-scene", coordinates: [1, 2], image: "synthetic-image" },
    { index: 1, enable: 0, isdefault: 0 },
  ] }), [{ index: 0, enabled: true, isDefault: true }, { index: 1, enabled: false, isDefault: false }]);
  assert.deepEqual(parseC37PresetPositions({ points: [] }), []);
});

test("C37 malformed or ambiguous occupancy is not an empty successful query", () => {
  for (const value of [null, {}, { points: null }, { points: "[]" }, { points: [{}] },
    { points: [{ enable: 2, isdefault: 0 }] }, { points: [{ enable: "1", isdefault: 0 }] },
    { points: [{ index: 1, enable: 1, isdefault: 1 }] },
    { points: Array.from({ length: 11 }, () => ({ enable: 0, isdefault: 0 })) }]) {
    assert.throws(() => parseC37PresetPositions(value), /unrecognised/);
  }
});
