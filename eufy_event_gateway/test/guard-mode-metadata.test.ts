/**
 * Verifies unknown custom-mode schemas remain diagnostics, not labels.
 * Synthetic metadata owns these fixtures and cannot authorize security writes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { guardModeMetadataShape, guardModeMetadataStructure } from "../src/mega/guard-mode-metadata.js";

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

test("preserves nested mode relationships with document-local pseudonyms", () => {
  const data = JSON.stringify({ mode: 3, modes: [
    { mode_id: "003", mode: "private label", secret: "private label" },
    { mode_id: 4, name: "second label", secret: "other value" },
  ] });
  const expected = "{mode:num:3,modes:[{mode_id:str:3,mode:text1,field1:text1},{mode_id:num:4,name:text2,field1:text3}]}";
  assert.equal(guardModeMetadataStructure(data), expected);
  assert.equal(guardModeMetadataStructure(Buffer.from(data).toString("base64")), expected);
  assert.doesNotMatch(expected, /private|secret|label|other/);
  assert.equal(guardModeMetadataStructure('{"different key":"different value"}'), "{field1:text1}");
});

test("keeps only canonical mode IDs and fixed scalar types", () => {
  const data = JSON.stringify([
    { id: -0 }, { mode: "003" }, { mode_id: 1e0 }, { mode_type: 5 },
    ...["+3", " 3", "0003", "3.0", "7", "abc"].map((id) => ({ id })),
    ...[6, -1, 1.5, 123456789].map((id) => ({ id })),
    { name: 123456789, mode: true, modes: null },
  ]);
  assert.equal(guardModeMetadataStructure(data),
    "[{id:num:0},{mode:str:3},{mode_id:num:1},{mode_type:num:5},"
    + "{id:text1},{id:text2},{id:text3},{id:text4},{id:text5},{id:text6},"
    + "{id:number},{id:number},{id:number},{id:number},{name:number,mode:boolean,modes:null}]");
  assert.equal(guardModeMetadataStructure(undefined), "missing");
  for (const value of [null, {}, 3, "not json", "Infinity"]) {
    assert.equal(guardModeMetadataStructure(value), "invalid");
  }
  assert.equal(guardModeMetadataStructure("x".repeat(16_385)), "oversized");
});

test("marks every traversal and output limit explicitly", () => {
  assert.match(guardModeMetadataStructure("[".repeat(8_000) + "0" + "]".repeat(8_000)), /capped:depth/);
  assert.equal(guardModeMetadataStructure(JSON.stringify(Array(17).fill(null))),
    `[${Array(16).fill("null").join(",")},capped:entries]`);
  assert.match(guardModeMetadataStructure(JSON.stringify(Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [`secret${index}`, null]),
  ))), /capped:entries/);
  assert.match(guardModeMetadataStructure(JSON.stringify(Array(16).fill(Array(16).fill(null)))), /capped:nodes/);
  const large = Array.from({ length: 16 }, (_, outer) => Object.fromEntries(
    Array.from({ length: 16 }, (_, inner) => [`private${outer}_${inner}`, `secret${outer}_${inner}`]),
  ));
  const bounded = guardModeMetadataStructure(JSON.stringify(large));
  assert.match(bounded, /capped:nodes/);
  assert.ok(bounded.length <= 2_048);
});

test("untrusted keys and values cannot enter the structural grammar", () => {
  const data = '{"__proto__":{"constructor":"private"},"field1":"other","evil}:mode:num:5":"private","123456789":123456789}';
  const result = guardModeMetadataStructure(data);
  assert.equal(result, "{field1:number,field2:{field3:text1},field4:text2,field5:text1}");
  assert.doesNotMatch(result, /private|other|evil|constructor|__proto__|123456789/);
  for (let index = 0; index < 100; index++) {
    const value = JSON.stringify({ [`\u0000\n\"\\${index}☃`]: [`private ${index}`, index, { mode_id: index }] });
    assert.match(guardModeMetadataStructure(value), /^[a-z0-9_,:{}\[\]]+$/);
    assert.ok(guardModeMetadataStructure(value).length <= 2_048);
  }
});
