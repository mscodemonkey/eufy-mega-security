/**
 * Checks the offline sender-derived PTCS candidate with synthetic packets.
 * These tests own all bytes and clocks. They establish no receive interoperability,
 * FEC, retransmission, cross-frame ordering or NVR hardware support.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { NvrPtcsReassembler, type NvrPtcsRejection } from "../src/stream/nvr-ptcs-reassembly.js";

function packet(total: number, index = 0, sequence = 1, channel = 0, timestamp = 7): Buffer {
  const output = Buffer.alloc(1028);
  output.write("PTCS"); output[4] = 3; output[5] = channel;
  output.writeUInt16LE(sequence, 6); output.writeUInt32LE(timestamp, 8);
  output.writeUInt32LE(total, 12); output.writeUInt16LE(index, 16);
  const count = Math.max(1, Math.ceil(total / 1000));
  const length = Math.min(1000, Math.max(0, total - 1000 * index));
  output.writeUInt16LE(0x4000 | (index === count - 1 ? 0x400 : 0) | length, 18);
  for (let i = 0; i < length; i++) output[28 + i] = (index * 1000 + i) % 251;
  return output;
}

function rejection(receiver: NvrPtcsReassembler, input: Buffer, reason: NvrPtcsRejection, now = 0): void {
  assert.deepEqual(receiver.push(input, now), { status: "rejected", reason });
}

test("literal PTCS header retains identity, ignores padding and transfers dedicated output", () => {
  const input = Buffer.alloc(1028, 0xaa);
  Buffer.from("505443530302fffffeffffff01000000000001440000000000000000", "hex").copy(input);
  input[28] = 42;
  const receiver = new NvrPtcsReassembler();
  const result = receiver.push(input, 0);
  assert.equal(result.status, "complete");
  if (result.status !== "complete") throw Error("Expected complete");
  assert.equal(result.channel, 2); assert.equal(result.sequence, 65535); assert.equal(result.timestamp, 0xfffffffe);
  assert.deepEqual(result.frame, Buffer.from([42]));
  assert.notEqual(result.frame.buffer, input.buffer);
  assert.equal(result.frame.buffer.byteLength, 1);
  input[28] = 9; assert.equal(result.frame[0], 42);
  assert.equal(receiver.stats.bufferedBytes, 0);
  rejection(receiver, input, "replay");
});

test("fragment geometry covers empty, partial and exact multiples in reordered sets", () => {
  for (const total of [0, 1, 999, 1000, 1001, 2000, 4017, 4 * 1024 * 1024]) {
    const receiver = new NvrPtcsReassembler();
    const count = Math.max(1, Math.ceil(total / 1000));
    const order = Array.from({ length: count }, (_, i) => i);
    let seed = 17;
    for (let i = count - 1; i > 0; i--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const target = seed % (i + 1); [order[i], order[target]] = [order[target]!, order[i]!];
    }
    for (let n = 0; n < count; n++) {
      const result = receiver.push(packet(total, order[n]!), 0);
      if (n < count - 1) assert.equal(result.status, "incomplete");
      else {
        assert.equal(result.status, "complete");
        if (result.status !== "complete") throw Error("Expected complete");
        assert.deepEqual(result.frame, Buffer.from(Array.from({ length: total }, (_, i) => i % 251)));
      }
    }
  }
  const receiver = new NvrPtcsReassembler();
  assert.equal(receiver.push(packet(1001, 1), 0).status, "incomplete");
  assert.equal(receiver.push(packet(1001), 0).status, "complete");
});

test("rejects malformed headers and geometry before reserving bytes", () => {
  const cases: Array<[Buffer, NvrPtcsRejection]> = [
    [Buffer.alloc(1027), "packet-geometry"], [Buffer.alloc(1029), "packet-geometry"],
    [packet(0xffffffff), "frame-too-large"],
  ];
  for (let i = 0; i < 4; i++) { const p = packet(1); p[i] = 0; cases.push([p, "magic"]); }
  const type = packet(1); type[4] = 4; cases.push([type, "type"]);
  const channel = packet(1); channel[5] = 6; cases.push([channel, "channel"]);
  for (const bit of [0x0800, 0x1000, 0x2000, 0x8000]) {
    const p = packet(1); p.writeUInt16LE(p.readUInt16LE(18) | bit, 18); cases.push([p, "flags"]);
  }
  const flag = packet(1); flag.writeUInt16LE(0x401, 18); cases.push([flag, "flags"]);
  for (let i = 20; i < 28; i++) { const p = packet(1); p[i] = 1; cases.push([p, "packet-geometry"]); }
  const index = packet(1001); index.writeUInt16LE(2, 16); cases.push([index, "index"]);
  const nonFinal = packet(1001); nonFinal.writeUInt16LE(0x47e8, 18); cases.push([nonFinal, "final-marker"]);
  const final = packet(1001, 1); final.writeUInt16LE(0x4001, 18); cases.push([final, "final-marker"]);
  const short = packet(1001); short.writeUInt16LE(0x43e7, 18); cases.push([short, "length"]);
  const long = packet(1); long.writeUInt16LE(0x47ff, 18); cases.push([long, "length"]);
  for (const [p, reason] of cases) {
    const receiver = new NvrPtcsReassembler(); rejection(receiver, p, reason);
    assert.equal(receiver.stats.bufferedBytes, 0); assert.equal(receiver.stats.pendingFrames, 0);
    assert.deepEqual(receiver.stats.rejected, { [reason]: 1 });
  }
});

test("duplicate fragments do not extend expiry and conflicting data poisons a frame", () => {
  const receiver = new NvrPtcsReassembler();
  const first = packet(1001);
  assert.equal(receiver.push(first, 0).status, "incomplete");
  assert.equal(receiver.push(first, 999).status, "incomplete");
  assert.equal(receiver.push(packet(1001, 1), 1000).status, "incomplete");
  assert.equal(receiver.stats.bufferedBytes, 1001);
  receiver.clear();
  receiver.push(first, 1000);
  const conflict = Buffer.from(first); conflict[28] = 255;
  rejection(receiver, conflict, "duplicate-conflict", 1000);
  assert.equal(receiver.stats.bufferedBytes, 0);
  rejection(receiver, packet(1001, 1), "poisoned", 1000);
  assert.equal(receiver.push(first, 2000).status, "incomplete");
  receiver.clear(); receiver.push(packet(2000), 2000);
  rejection(receiver, packet(1001), "metadata-conflict", 2000);
  rejection(receiver, packet(2000, 1), "poisoned", 2000);
});

test("retained bytes survive input mutation and identities isolate channels and wrap values", () => {
  const receiver = new NvrPtcsReassembler();
  const first = packet(1001); receiver.push(first, 0); first.fill(255, 28);
  const result = receiver.push(packet(1001, 1), 0);
  assert.equal(result.status, "complete");
  if (result.status === "complete") assert.equal(result.frame[0], 0);
  for (const [sequence, timestamp, channel] of [[65535, 0xffffffff, 0], [0, 0, 0], [0, 0, 1], [0, 0, 5]]) {
    assert.equal(receiver.push(packet(1, 0, sequence!, channel!, timestamp!), 0).status, "complete");
  }
});

test("reservations and pending caps protect existing frames and release deterministically", () => {
  const receiver = new NvrPtcsReassembler({ maxFrameBytes: 2000, maxBufferedBytes: 2500, maxPendingFrames: 2 });
  receiver.push(packet(2000), 0);
  rejection(receiver, packet(1001, 0, 2), "capacity");
  assert.equal(receiver.stats.bufferedBytes, 2000);
  assert.equal(receiver.push(packet(2000, 1), 0).status, "complete");
  receiver.push(packet(1001, 0, 2), 0); receiver.push(packet(1001, 0, 3), 0);
  rejection(receiver, packet(0, 0, 4), "capacity");
  receiver.expire(1000); assert.equal(receiver.stats.bufferedBytes, 0);
  assert.equal(receiver.stats.pendingFrames, 0); assert.equal(receiver.stats.tombstones, 0);
  receiver.push(packet(2000), 1000); receiver.clear();
  assert.equal(receiver.stats.bufferedBytes, 0); assert.equal(receiver.stats.pendingFrames, 0);
  assert.equal(receiver.push(packet(1), 1000).status, "complete");
});

test("bounded tombstones suppress replay without consuming pending capacity", () => {
  const receiver = new NvrPtcsReassembler({ maxCompletedTombstones: 2, maxPendingFrames: 1 });
  for (let sequence = 0; sequence < 100; sequence++) assert.equal(receiver.push(packet(1, 0, sequence), sequence).status, "complete");
  assert.equal(receiver.stats.tombstones, 2);
  assert.equal(receiver.push(packet(1001, 0, 100), 100).status, "incomplete");
  rejection(receiver, packet(1, 0, 99), "replay", 100);
  assert.equal(receiver.push(packet(1001, 1, 100), 100).status, "complete");
  assert.equal(receiver.push(packet(1, 0, 0), 100).status, "complete");
  assert.equal(receiver.push(packet(1, 0, 0), 1100).status, "complete");
});

test("invalid limits and clocks leave owned state intact and keep the floor after clear", () => {
  for (const key of ["maxFrameBytes", "maxBufferedBytes", "maxPendingFrames", "maxCompletedTombstones", "expiryMilliseconds"] as const) {
    for (const value of [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => new NvrPtcsReassembler({ [key]: value }), RangeError);
    }
  }
  assert.throws(() => new NvrPtcsReassembler({ maxFrameBytes: 999 }), RangeError);
  assert.throws(() => new NvrPtcsReassembler({ maxFrameBytes: 2000, maxBufferedBytes: 1000 }), RangeError);
  const receiver = new NvrPtcsReassembler(); receiver.push(packet(1001), 10);
  const before = receiver.stats;
  for (const time of [NaN, -1, Infinity, 9, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => receiver.push(packet(1001, 1), time), RangeError);
    assert.deepEqual(receiver.stats, before);
  }
  assert.equal(receiver.push(packet(1001, 1), 10).status, "complete");
  receiver.clear(); assert.throws(() => receiver.push(packet(1), 9), RangeError);
  assert.equal(receiver.push(packet(1), 10).status, "complete");
  const stats = receiver.stats;
  assert.deepEqual(Object.keys(stats).sort(), ["bufferedBytes", "pendingFrames", "rejected", "tombstones"]);
  assert.deepEqual(stats.rejected, {});
});

test("history eviction uses first arrival even when frame completion is reordered", () => {
  const receiver = new NvrPtcsReassembler({ maxCompletedTombstones: 2 });
  receiver.push(packet(1001), 0);
  assert.equal(receiver.push(packet(1, 0, 2), 100).status, "complete");
  assert.equal(receiver.push(packet(1001, 1), 200).status, "complete");
  assert.equal(receiver.push(packet(1, 0, 3), 300).status, "complete");
  rejection(receiver, packet(1, 0, 2), "replay", 300);
  assert.equal(receiver.push(packet(1001), 300).status, "incomplete");
  const snapshot = receiver.stats;
  (snapshot.rejected as Partial<Record<NvrPtcsRejection, number>>).replay = 99;
  assert.equal(receiver.stats.rejected.replay, 1);
});
