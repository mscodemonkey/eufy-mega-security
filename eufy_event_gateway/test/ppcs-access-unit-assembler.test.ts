/**
 * Verifies PPCS transport chunks become complete access units before media
 * normalisation, including loss and interleaving boundaries.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePpcsVideoFrameHeader,
  PPCS_STATION_CHUNK_BYTES,
  PpcsAccessUnitAssembler,
} from "../src/stream/ppcs-access-unit-assembler.js";

const START_CODE = Buffer.from([0, 0, 0, 1]);

function frame(body: Buffer, options: { sequence?: number; timestamp?: number; keyframe?: boolean } = {}): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt32LE(body.length, 0);
  header[4] = options.keyframe === false ? 0 : 1;
  header.writeUInt16LE(options.sequence ?? 1, 6);
  header.writeInt16LE(1920, 10);
  header.writeInt16LE(1080, 12);
  header.writeUInt32LE(options.timestamp ?? 0x1000, 14);
  return Buffer.concat([header, body]);
}

test("parses the repeated access-unit identity and per-chunk length", () => {
  const payload = frame(Buffer.alloc(PPCS_STATION_CHUNK_BYTES), { sequence: 7, timestamp: 9 });
  assert.deepEqual(parsePpcsVideoFrameHeader(payload), {
    payloadLength: PPCS_STATION_CHUNK_BYTES,
    keyframe: true,
    sequence: 7,
    width: 1920,
    height: 1080,
    timestamp: 9,
  });
});

test("keeps a decoded non-empty unit when the transport length does not match", () => {
  const body = Buffer.concat([START_CODE, Buffer.from([0x65, 0x44])]);
  const payload = frame(body);
  payload.writeUInt32LE(body.length + 16, 0);
  const assembler = new PpcsAccessUnitAssembler();

  const units = assembler.push(payload, (value) => value.subarray(22));
  assert.equal(units.length, 1);
  assert.deepEqual(units[0]?.data, body);
});

test("joins a full chunk and a continuation into one access unit", () => {
  const head = Buffer.concat([START_CODE, Buffer.from([0x67, 0x42]), Buffer.alloc(PPCS_STATION_CHUNK_BYTES - 6, 0x11)]);
  const tail = Buffer.alloc(5, 0x22);
  const assembler = new PpcsAccessUnitAssembler();

  assert.deepEqual(assembler.push(frame(head), (payload) => payload.subarray(22)), []);
  const units = assembler.push(frame(tail), (payload) => payload.subarray(22));

  assert.equal(units.length, 1);
  assert.deepEqual(units[0]?.data, Buffer.concat([head, tail]));
  assert.equal(units[0]?.keyframe, true);
});

test("accepts a continuation without an Annex-B start code", () => {
  const head = Buffer.concat([START_CODE, Buffer.from([0x65]), Buffer.alloc(PPCS_STATION_CHUNK_BYTES - 5, 0x11)]);
  const tail = Buffer.alloc(3, 0x22);
  const assembler = new PpcsAccessUnitAssembler();

  assembler.push(frame(head), (payload) => payload.subarray(22));
  const units = assembler.push(frame(tail), (payload) => payload.subarray(22));

  assert.equal(units.length, 1);
  assert.equal(units[0]?.data.length, PPCS_STATION_CHUNK_BYTES + tail.length);
});

test("drops a lost continuation when the next full chunk starts another unit", () => {
  const drops: Array<{ carriedBytes: number; chunkCount: number; totalDropped: number }> = [];
  const first = Buffer.concat([START_CODE, Buffer.alloc(PPCS_STATION_CHUNK_BYTES - 4, 0x11)]);
  const next = Buffer.concat([START_CODE, Buffer.alloc(PPCS_STATION_CHUNK_BYTES - 4, 0x22)]);
  const assembler = new PpcsAccessUnitAssembler((drop) => drops.push(drop));

  assembler.push(frame(first, { timestamp: 1 }), (payload) => payload.subarray(22));
  assert.deepEqual(assembler.push(frame(next, { timestamp: 2 }), (payload) => payload.subarray(22)), []);

  assert.deepEqual(drops, [{ carriedBytes: PPCS_STATION_CHUNK_BYTES, chunkCount: 1, totalDropped: 1 }]);
});

test("does not merge a new access unit that happens to reuse the identity", () => {
  const first = Buffer.concat([START_CODE, Buffer.alloc(PPCS_STATION_CHUNK_BYTES - 4, 0x11)]);
  const next = Buffer.concat([START_CODE, Buffer.from([0x65, 0x33])]);
  const assembler = new PpcsAccessUnitAssembler();

  assembler.push(frame(first), (payload) => payload.subarray(22));
  const units = assembler.push(frame(next), (payload) => payload.subarray(22));

  assert.equal(units.length, 1);
  assert.deepEqual(units[0]?.data, next);
});

test("does not retain an incomplete unit after malformed input", () => {
  const drops: number[] = [];
  const head = Buffer.concat([START_CODE, Buffer.alloc(PPCS_STATION_CHUNK_BYTES - 4, 0x11)]);
  const assembler = new PpcsAccessUnitAssembler((drop) => drops.push(drop.carriedBytes));

  assembler.push(frame(head), (payload) => payload.subarray(22));
  assembler.push(Buffer.alloc(4), () => undefined);
  assert.deepEqual(drops, [PPCS_STATION_CHUNK_BYTES]);
});
