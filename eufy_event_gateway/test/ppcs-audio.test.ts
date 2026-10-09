/**
 * Exercises clear AAC frame validation using synthetic ADTS payloads.
 * Tests own only in-memory bytes and reject framing that must never reach the
 * optional recording stream. Hardware capture and decoding remain separate QA.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { decodePpcsAac } from "../src/stream/ppcs-audio.js";

function frame(audio = Buffer.from([0xff, 0xf1, 0x60, 0x40, 0x01, 0x1f, 0xfc, 0x00])): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(audio.length);
  return Buffer.concat([header, audio]);
}

test("accepts complete mono AAC ADTS and returns independent owned bytes", () => {
  const input = frame();
  const audio = decodePpcsAac(input)!;
  assert.deepEqual(audio, input.subarray(16));
  input.fill(0);
  assert.equal(audio[0], 0xff);
});

test("validates every frame when one packet contains multiple AAC frames", () => {
  const audio = frame().subarray(16);
  assert.equal(decodePpcsAac(frame(Buffer.concat([audio, audio])))?.length, 16);
  assert.equal(decodePpcsAac(frame(Buffer.concat([audio, audio.subarray(0, 4)]))), null);
});

test("excludes truncated, mismatched, unsupported and invalid ADTS payloads", () => {
  const invalid = [Buffer.alloc(16), frame().subarray(0, 22)];
  for (const [offset, value] of [[0, 7], [5, 7], [16, 0], [17, 0xf7], [18, 0x7c], [19, 0], [20, 0xff]] as const) {
    const row = frame();
    row[offset] = value;
    invalid.push(row);
  }
  for (const row of invalid) assert.equal(decodePpcsAac(row), null);
});
