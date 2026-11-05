/**
 * Tests synthetic NVR broadcasts and query errors at the checked wire boundary.
 * Fixtures own all bytes. No device, setting or security action is contacted.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { nvrApplication } from "../src/stream/nvr-protocol.js";
import { nvrEffectiveModeBroadcast } from "../src/stream/nvr-effective-mode.js";

function broadcast(mode: number, length = 8): Buffer {
  const value = Buffer.alloc(16 + length);
  value.write("XZYH"); value.writeUInt16LE(1151, 4); value.writeUInt32LE(length, 6);
  value[12] = 255; value[15] = 2; value.writeInt32LE(mode, 16);
  return value;
}

test("mode broadcasts preserve concrete values and invalidate policy or unknown values", () => {
  for (const mode of [0, 1, 3, 4, 5, 63]) {
    assert.deepEqual(nvrEffectiveModeBroadcast(nvrApplication(broadcast(mode)), 2), { mode });
  }
  for (const mode of [2, 6, 47, -106, -1, 7, 2147483647]) {
    assert.deepEqual(nvrEffectiveModeBroadcast(nvrApplication(broadcast(mode)), 2), { mode: null });
  }
});

test("query replies and wrong headers cannot masquerade as broadcasts", () => {
  for (const channel of [0, 1, 3, 4, 5]) {
    assert.equal(nvrEffectiveModeBroadcast(nvrApplication(broadcast(1)), channel), null);
  }
  for (const [offset, value] of [[4, 1], [11, 1], [12, 3], [14, 1], [20, 1]]) {
    const raw = broadcast(1); raw[offset!] = value!;
    assert.equal(nvrEffectiveModeBroadcast(nvrApplication(raw), 2), null);
  }
  for (const length of [4, 12, 132]) {
    const error = broadcast(-106, length); error[14] = 1;
    assert.equal(nvrEffectiveModeBroadcast(nvrApplication(error), 2), null);
  }
  const truncated = broadcast(1).subarray(0, 20);
  assert.throws(() => nvrApplication(truncated));
});
