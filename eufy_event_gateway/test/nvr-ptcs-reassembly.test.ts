/**
 * Checks bounded NVR PTCS receive reassembly with synthetic sender and receiver
 * layouts. The tests own every byte and clock and make no hardware claim.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { NvrPtcsReassembler, type NvrPtcsRejection } from "../src/stream/nvr-ptcs-reassembly.js";

interface PacketOptions {
  readonly compressed?: boolean;
  readonly exact?: boolean;
  readonly metadata?: Buffer;
  readonly sequence?: number;
  readonly channel?: number;
  readonly timestamp?: number;
}

function packets(frame: Buffer, options: PacketOptions = {}): Buffer[] {
  const wire = options.compressed ? zstdCompressSync(frame) : frame;
  const count = Math.max(1, Math.ceil(wire.length / 1000));
  return Array.from({ length: count }, (_, index) => {
    const length = Math.min(1000, Math.max(0, wire.length - index * 1000));
    const output = Buffer.alloc(options.exact ? 28 + length : 1028, 0xaa);
    output.write("PTCS");
    output[4] = 3;
    output[5] = options.channel ?? 0;
    output.writeUInt16LE(options.sequence ?? 1, 6);
    output.writeUInt32LE(options.timestamp ?? 7, 8);
    output.writeUInt32LE(wire.length, 12);
    output.writeUInt16LE(index, 16);
    output.writeUInt16LE(0x4000 | (options.compressed ? 0x0800 : 0)
      | (index === count - 1 ? 0x0400 : 0) | length, 18);
    (options.metadata ?? Buffer.alloc(8)).copy(output, 20, 0, 8);
    wire.copy(output, 28, index * 1000, index * 1000 + length);
    return output;
  });
}

function rejection(receiver: NvrPtcsReassembler, input: Buffer, reason: NvrPtcsRejection, now = 0): void {
  assert.deepEqual(receiver.push(input, now), { status: "rejected", reason });
}

test("accepts exact receive fragments with metadata out of order and transfers ownership", () => {
  const source = Buffer.from(Array.from({ length: 2351 }, (_, index) => index % 251));
  const parts = packets(source, { exact: true, metadata: Buffer.from("metadata"), channel: 5 });
  const receiver = new NvrPtcsReassembler();
  assert.equal(receiver.push(parts[2]!, 0).status, "incomplete");
  assert.equal(receiver.push(parts[0]!, 0).status, "incomplete");
  const result = receiver.push(parts[1]!, 0);
  assert.equal(result.status, "complete");
  if (result.status !== "complete") throw Error("Expected complete frame");
  assert.equal(result.channel, 5);
  assert.deepEqual(result.frame, source);
  assert.equal(result.frame.buffer.byteLength, source.length);
  const retainedInput = parts[0]!;
  retainedInput[28] = retainedInput[28]! ^ 0xff;
  assert.deepEqual(result.frame, source);
  rejection(receiver, parts[1]!, "replay");
});

test("accepts legacy padded packets and empty final frames", () => {
  for (const size of [0, 1, 999, 1000, 1001, 2000, 4017]) {
    const frame = Buffer.alloc(size, size % 251);
    const receiver = new NvrPtcsReassembler();
    let result;
    for (const part of packets(frame)) result = receiver.push(part, 0);
    assert.equal(result!.status, "complete");
    if (result!.status === "complete") assert.deepEqual(result!.frame, frame);
  }
});

test("decompresses bounded Zstandard receive frames and poisons invalid streams", () => {
  const frame = Buffer.from(JSON.stringify({ cmd: 9100, payload: "x".repeat(5000) }));
  const receiver = new NvrPtcsReassembler();
  let result;
  for (const part of packets(frame, { compressed: true, exact: true })) result = receiver.push(part, 0);
  assert.equal(result!.status, "complete");
  if (result!.status === "complete") assert.deepEqual(result!.frame, frame);

  const invalid = packets(Buffer.from("not-zstd"), { exact: true });
  invalid[0]!.writeUInt16LE(invalid[0]!.readUInt16LE(18) | 0x0800, 18);
  const poisoned = new NvrPtcsReassembler();
  rejection(poisoned, invalid[0]!, "decompression");
  rejection(poisoned, invalid[0]!, "poisoned");

  const oversized = new NvrPtcsReassembler({ maxDecompressedBytes: 1000 });
  for (const part of packets(Buffer.alloc(1001), { compressed: true, exact: true })) {
    result = oversized.push(part, 0);
  }
  assert.deepEqual(result, { status: "rejected", reason: "decompression" });
});

test("rejects malformed receive geometry without retaining caller bytes", () => {
  const cases: Array<[Buffer, NvrPtcsRejection]> = [];
  const short = packets(Buffer.from([1]), { exact: true })[0]!;
  cases.push([short.subarray(0, 27), "packet-geometry"]);
  const magic = Buffer.from(short); magic[0] = 0; cases.push([magic, "magic"]);
  const type = Buffer.from(short); type[4] = 4; cases.push([type, "type"]);
  const channel = Buffer.from(short); channel[5] = 6; cases.push([channel, "channel"]);
  const flags = Buffer.from(short); flags.writeUInt16LE(flags.readUInt16LE(18) | 0x1000, 18); cases.push([flags, "flags"]);
  const missingRequired = Buffer.from(short); missingRequired.writeUInt16LE(0x0401, 18); cases.push([missingRequired, "flags"]);
  const wrongExact = Buffer.concat([short, Buffer.from([0])]); cases.push([wrongExact, "packet-geometry"]);
  const shortPadded = packets(Buffer.alloc(1001))[0]!; shortPadded.writeUInt16LE(0x43e7, 18); cases.push([shortPadded, "length"]);
  const emptyNonFinal = packets(Buffer.alloc(0), { exact: true })[0]!; emptyNonFinal.writeUInt16LE(0x4000, 18); cases.push([emptyNonFinal, "length"]);

  for (const [input, reason] of cases) {
    const receiver = new NvrPtcsReassembler();
    rejection(receiver, input, reason);
    assert.equal(receiver.stats.bufferedBytes, 0);
    assert.equal(receiver.stats.pendingFrames, 0);
  }
});

test("conflicting metadata, final markers and duplicates poison their frame identity", () => {
  const source = Buffer.alloc(1001, 7);
  const parts = packets(source, { exact: true });
  const receiver = new NvrPtcsReassembler();
  receiver.push(parts[0]!, 0);
  const changed = Buffer.from(parts[0]!); changed[28] = 8;
  rejection(receiver, changed, "duplicate-conflict");
  rejection(receiver, parts[1]!, "poisoned");

  const metadata = new NvrPtcsReassembler();
  metadata.push(parts[0]!, 0);
  const changedTotal = Buffer.from(parts[1]!); changedTotal.writeUInt32LE(1002, 12);
  rejection(metadata, changedTotal, "metadata-conflict");

  const final = new NvrPtcsReassembler();
  final.push(parts[1]!, 0);
  const later = Buffer.from(parts[0]!); later.writeUInt16LE(2, 16);
  rejection(final, later, "final-marker");
});

test("fragment budgets protect existing frames and release reservations", () => {
  const receiver = new NvrPtcsReassembler({ maxFrameBytes: 3000, maxBufferedBytes: 4000,
    maxPendingFrames: 2, maxFragmentsPerFrame: 3, maxRetainedFragments: 2 });
  const first = packets(Buffer.alloc(2001), { exact: true, sequence: 1 });
  receiver.push(first[0]!, 0);
  receiver.push(first[1]!, 0);
  rejection(receiver, packets(Buffer.alloc(1001), { exact: true, sequence: 2 })[0]!, "capacity");
  rejection(receiver, first[2]!, "capacity");
  assert.equal(receiver.stats.bufferedBytes, 0);
  assert.equal(receiver.stats.pendingFrames, 0);

  const index = packets(Buffer.alloc(1), { exact: true })[0]!;
  index.writeUInt16LE(3, 16);
  rejection(receiver, index, "index");
});

test("expiry, clear, limits and monotonic clocks preserve bounded accounting", () => {
  const receiver = new NvrPtcsReassembler({ expiryMilliseconds: 10 });
  receiver.push(packets(Buffer.alloc(1001), { exact: true })[0]!, 5);
  receiver.expire(15);
  assert.equal(receiver.stats.bufferedBytes, 0);
  receiver.push(packets(Buffer.alloc(1001), { exact: true })[0]!, 15);
  receiver.clear();
  assert.throws(() => receiver.push(packets(Buffer.alloc(1))[0]!, 14), RangeError);

  for (const key of ["maxFrameBytes", "maxBufferedBytes", "maxPendingFrames", "maxFragmentsPerFrame",
    "maxRetainedFragments", "maxDecompressedBytes", "maxCompletedTombstones", "expiryMilliseconds"] as const) {
    assert.throws(() => new NvrPtcsReassembler({ [key]: 0 }), RangeError);
  }
});
