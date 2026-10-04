/**
 * Verifies unknown custom-mode schemas remain diagnostics, not labels.
 * Synthetic metadata owns these fixtures and cannot authorize security writes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { guardModeMetadataShape } from "../src/mega/guard-mode-metadata.js";

test("custom-mode diagnostics expose no account labels or arbitrary keys", () => {
  const data = JSON.stringify([{ id: 3, name: "private name", "private key": "private value" }, { mode_id: 5, name: "another private name" }]);
  assert.equal(
    guardModeMetadataShape(data),
    "root=array objects=2 arrays=1 fields=id,mode_id,name numeric_ids_3_to_5=3,5 array_objects=2 array_numbers=0 array_texts=0 array_other=0 array_entries_capped=false entries_with_id=2"
      + " id_types=id:number,mode_id:number text_ids_3_to_5=none other_ids=none unlisted_text_fields=1",
  );
  assert.equal(guardModeMetadataShape(Buffer.from(data).toString("base64")), guardModeMetadataShape(data));
  assert.doesNotMatch(guardModeMetadataShape(data), /private|another/);
  assert.equal(guardModeMetadataShape(undefined), "missing");
  assert.equal(guardModeMetadataShape("not metadata"), "invalid");
  assert.equal(guardModeMetadataShape("x".repeat(16_385)), "invalid");
  assert.match(guardModeMetadataShape('[{"name":"secret"}]'), /numeric_ids_3_to_5=none /);
});

test("distinguishes one numeric mode ID from three entries with text IDs", () => {

  // This shape logs the same first five fields as the HomeBase 3 report in
  // issue 288. numeric_ids_3_to_5=3 means the value 3 was seen, not three IDs.
  const data = JSON.stringify({ mode: 3, modes: [
    { mode_id: "3", mode: "private one" },
    { mode_id: "4", mode: "private two" },
    { mode_id: "5", mode: "private three" },
  ] });
  const shape = guardModeMetadataShape(data);

  assert.match(shape, /numeric_ids_3_to_5=3 /);
  assert.match(shape, /array_objects=3 array_numbers=0 array_texts=0 array_other=0 array_entries_capped=false entries_with_id=3 /);
  assert.match(shape, /text_ids_3_to_5=3,4,5 /);
  assert.match(shape, /id_types=mode:number,mode:text,mode_id:numeric_text /);
  assert.doesNotMatch(shape, /private/);
});

test("omits arbitrary numeric identifiers from custom-mode diagnostics", () => {
  const shape = guardModeMetadataShape(JSON.stringify([{ id: -123456789 }, { id: 123456789 }]));
  assert.match(shape, /other_ids=none /);
  assert.doesNotMatch(shape, /123456789/);
});


test("counts scalar array entries and signals capped traversal without exposing text", () => {
  const shape = guardModeMetadataShape(JSON.stringify({ custom_modes: [3, 4, 5, "private label", null, ["private nested"]] }));
  assert.match(shape, /array_objects=0 array_numbers=3 array_texts=2 array_other=2 array_entries_capped=false/);
  assert.doesNotMatch(shape, /private/);
  assert.match(guardModeMetadataShape(JSON.stringify(Array(20).fill({ id: 3 }))), /array_objects=16 .*array_entries_capped=true/);
  assert.match(guardModeMetadataShape(JSON.stringify(Array(16).fill(Array(16).fill(3)))), /array_entries_capped=true/);
});
