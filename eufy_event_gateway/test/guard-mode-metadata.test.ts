/**
 * Verifies unknown custom-mode schemas remain diagnostics, not labels.
 * Synthetic metadata owns these fixtures and cannot authorize security writes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { guardModeMetadataShape } from "../src/mega/guard-mode-metadata.js";

test("custom-mode diagnostics expose no account labels or arbitrary keys", () => {
  const data = JSON.stringify([{ id: 3, name: "private name", "private key": "private value" }, { mode_id: 5, name: "another private name" }]);
  assert.equal(guardModeMetadataShape(data), "root=array objects=2 arrays=1 fields=id,mode_id,name explicit_ids=3,5");
  assert.equal(guardModeMetadataShape(Buffer.from(data).toString("base64")), guardModeMetadataShape(data));
  assert.doesNotMatch(guardModeMetadataShape(data), /private|another/);
  assert.equal(guardModeMetadataShape(undefined), "missing");
  assert.equal(guardModeMetadataShape("not metadata"), "invalid");
  assert.equal(guardModeMetadataShape("x".repeat(16_385)), "invalid");
  assert.match(guardModeMetadataShape('[{"name":"secret"}]'), /explicit_ids=none$/);
});
