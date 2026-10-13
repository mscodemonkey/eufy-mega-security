/**
 * Reassembles bounded PTCS sender and receive fragments for an owned NVR RTC
 * session. The RTC adapter owns session identity, cross-frame ordering and
 * recovery. This layer is separate from PPCS video access-unit assembly.
 */

import { zstdDecompressSync } from "node:zlib";

const PACKET_BYTES = 1028;
const HEADER_BYTES = 28;
const FRAGMENT_BYTES = 1000;
const COMPRESSED_FLAG = 0x0800;
const FINAL_FLAG = 0x0400;
const REQUIRED_FLAG = 0x4000;

/** Independent allocation and replay-history budgets for one owned session. */
export interface NvrPtcsReassemblyLimits {
  readonly maxFrameBytes: number;
  readonly maxBufferedBytes: number;
  readonly maxPendingFrames: number;

  /** Caps per-frame object overhead independently of retained payload bytes. */
  readonly maxFragmentsPerFrame: number;

  /** Caps fragment-object overhead across every pending frame in the session. */
  readonly maxRetainedFragments: number;

  /** Limits synchronous Zstandard output independently of compressed input. */
  readonly maxDecompressedBytes: number;

  /** Oldest replay or poison history is evicted when this separate cap fills. */
  readonly maxCompletedTombstones: number;
  readonly expiryMilliseconds: number;
}

/** Structural rejection categories contain no account, device or frame contents. */
export type NvrPtcsRejection = "packet-geometry" | "magic" | "type" | "flags" | "length" | "index"
  | "final-marker" | "channel" | "frame-too-large" | "metadata-conflict" | "duplicate-conflict"
  | "decompression" | "replay" | "capacity" | "poisoned";

/** Complete frames transfer ownership to the caller, which must sequence them. */
export type NvrPtcsReassemblyResult =
  | { readonly status: "incomplete" }
  | { readonly status: "rejected"; readonly reason: NvrPtcsRejection }
  | { readonly status: "complete"; readonly channel: number; readonly sequence: number;
    readonly timestamp: number; readonly frame: Buffer };

/** Snapshot of reserved bytes and bounded history, without packet contents. */
export interface NvrPtcsReassemblyStats {
  readonly bufferedBytes: number;
  readonly pendingFrames: number;
  readonly tombstones: number;
  readonly rejected: Readonly<Partial<Record<NvrPtcsRejection, number>>>;
}

interface PendingFrame {
  readonly total: number;
  readonly firstArrival: number;
  readonly compressed: boolean;
  readonly fragments: Map<number, { readonly bytes: Buffer; readonly final: boolean }>;
  receivedBytes: number;
  finalIndex: number | null;
}

interface Tombstone {
  readonly firstArrival: number;
  readonly reason: "replay" | "poisoned";
}

/**
 * Owns bounded fragment buffers and replay history for one caller-owned session.
 * The caller supplies a monotonic millisecond clock and clears state at retirement.
 * Only complete type-3 fragment sets are accepted. Missing fragments expire,
 * unsupported recovery packets are rejected, and completed application frames
 * transfer to the RTC session. A completed Buffer is mutable and owned solely by
 * the caller.
 */
export class NvrPtcsReassembler {
  readonly #limits: NvrPtcsReassemblyLimits;
  readonly #pending = new Map<string, PendingFrame>();
  readonly #tombstones = new Map<string, Tombstone>();
  readonly #rejected: Partial<Record<NvrPtcsRejection, number>> = {};
  #bufferedBytes = 0;
  #retainedFragments = 0;
  #lastNow = 0;

  /** Reject invalid budgets before retaining any packet or allocating a frame. */
  constructor(limits: Partial<NvrPtcsReassemblyLimits> = {}) {
    this.#limits = { maxFrameBytes: 4 * 1024 * 1024, maxBufferedBytes: 8 * 1024 * 1024,
      maxPendingFrames: 64, maxFragmentsPerFrame: 8192, maxRetainedFragments: 32768,
      maxDecompressedBytes: 1572864, maxCompletedTombstones: 256, expiryMilliseconds: 1000, ...limits };
    if (Object.values(this.#limits).some(value => !Number.isSafeInteger(value) || value <= 0)
      || this.#limits.maxFrameBytes < FRAGMENT_BYTES || this.#limits.maxFrameBytes > this.#limits.maxBufferedBytes) {
      throw new RangeError("Invalid PTCS reassembly limits");
    }
  }

  /** Return copied counters so callers cannot mutate the instance's accounting. */
  get stats(): NvrPtcsReassemblyStats {
    return { bufferedBytes: this.#bufferedBytes, pendingFrames: this.#pending.size,
      tombstones: this.#tombstones.size, rejected: { ...this.#rejected } };
  }

  /** Release all retained data while preserving the monotonic clock floor. */
  clear(): void {
    this.#pending.clear();
    this.#tombstones.clear();
    this.#bufferedBytes = 0;
    this.#retainedFragments = 0;
  }

  /** Expire idle state without a timer. Invalid clocks leave every entry intact. */
  expire(nowMilliseconds: number): void {
    if (!Number.isSafeInteger(nowMilliseconds) || nowMilliseconds < this.#lastNow) {
      throw new RangeError("PTCS clock must be non-negative and monotonic");
    }
    this.#lastNow = nowMilliseconds;
    for (const [key, pending] of this.#pending) {
      if (nowMilliseconds - pending.firstArrival >= this.#limits.expiryMilliseconds) this.#release(key, pending);
    }
    for (const [key, tombstone] of this.#tombstones) {
      if (nowMilliseconds - tombstone.firstArrival >= this.#limits.expiryMilliseconds) this.#tombstones.delete(key);
    }
  }

  /** Validate geometry before reservation, retaining only copied declared bytes. */
  push(packet: Buffer, nowMilliseconds: number): NvrPtcsReassemblyResult {
    this.expire(nowMilliseconds);
    if (packet.length < HEADER_BYTES || packet.length > PACKET_BYTES) return this.#reject("packet-geometry");
    if (!packet.subarray(0, 4).equals(Buffer.from("PTCS"))) return this.#reject("magic");
    if (packet[4] !== 3) return this.#reject("type");
    const channel = packet[5]!;
    if (channel > 5) return this.#reject("channel");
    const sequence = packet.readUInt16LE(6), timestamp = packet.readUInt32LE(8);
    const total = packet.readUInt32LE(12), index = packet.readUInt16LE(16), flags = packet.readUInt16LE(18);
    if ((flags & ~0x4fff) !== 0 || (flags & REQUIRED_FLAG) === 0) return this.#reject("flags");
    const length = flags & 0x03ff, final = Boolean(flags & FINAL_FLAG), compressed = Boolean(flags & COMPRESSED_FLAG);
    if (length > FRAGMENT_BYTES) return this.#reject("length");
    const exactReceivePacket = packet.length === HEADER_BYTES + length;
    if (!exactReceivePacket && packet.length !== PACKET_BYTES) return this.#reject("packet-geometry");
    if (!exactReceivePacket && !final && length !== FRAGMENT_BYTES) return this.#reject("length");
    if (length === 0 && !(total === 0 && index === 0 && final)) return this.#reject("length");
    if (total > this.#limits.maxFrameBytes) return this.#reject("frame-too-large");
    if (index >= this.#limits.maxFragmentsPerFrame) return this.#reject("index");
    const key = `${channel}:${sequence}:${timestamp}`;
    const tombstone = this.#tombstones.get(key);
    if (tombstone) return this.#reject(tombstone.reason);
    let pending = this.#pending.get(key);
    if (pending && (pending.total !== total || pending.compressed !== compressed)) {
      return this.#poison(key, pending, "metadata-conflict");
    }
    if (!pending) {
      if (this.#pending.size >= this.#limits.maxPendingFrames
        || total > this.#limits.maxBufferedBytes - this.#bufferedBytes
        || this.#retainedFragments >= this.#limits.maxRetainedFragments) return this.#reject("capacity");
      pending = { total, firstArrival: nowMilliseconds, compressed, fragments: new Map(),
        receivedBytes: 0, finalIndex: null };
      this.#pending.set(key, pending);
      this.#bufferedBytes += total;
    }
    if (pending.finalIndex !== null && (index > pending.finalIndex || final && index !== pending.finalIndex)) {
      return this.#poison(key, pending, "final-marker");
    }
    const part = packet.subarray(HEADER_BYTES, HEADER_BYTES + length), retained = pending.fragments.get(index);
    if (retained) {
      if (retained.final !== final || !retained.bytes.equals(part)) return this.#poison(key, pending, "duplicate-conflict");
      return { status: "incomplete" };
    }
    if (this.#retainedFragments >= this.#limits.maxRetainedFragments) return this.#poison(key, pending, "capacity");
    const copy = Buffer.alloc(length);
    part.copy(copy);
    pending.fragments.set(index, { bytes: copy, final });
    pending.receivedBytes += length;
    this.#retainedFragments++;
    if (pending.receivedBytes > total) return this.#poison(key, pending, "length");
    if (final) {
      pending.finalIndex = index;
      if ([...pending.fragments.keys()].some(fragmentIndex => fragmentIndex > index)) {
        return this.#poison(key, pending, "final-marker");
      }
    }
    if (pending.finalIndex === null) return { status: "incomplete" };
    for (let fragmentIndex = 0; fragmentIndex <= pending.finalIndex; fragmentIndex++) {
      if (!pending.fragments.has(fragmentIndex)) return { status: "incomplete" };
    }
    if (pending.receivedBytes !== total) return this.#poison(key, pending, "length");
    const frame = Buffer.alloc(total);
    let offset = 0;
    for (let fragmentIndex = 0; fragmentIndex <= pending.finalIndex; fragmentIndex++) {
      const bytes = pending.fragments.get(fragmentIndex)!.bytes;
      bytes.copy(frame, offset);
      offset += bytes.length;
    }
    this.#release(key, pending);
    let output = frame;
    if (compressed) {
      try {
        const decompressed = zstdDecompressSync(frame, { maxOutputLength: this.#limits.maxDecompressedBytes });
        output = Buffer.alloc(decompressed.length);
        decompressed.copy(output);
      } catch {
        this.#remember(key, { firstArrival: pending.firstArrival, reason: "poisoned" });
        return this.#reject("decompression");
      }
    }
    this.#remember(key, { firstArrival: pending.firstArrival, reason: "replay" });
    return { status: "complete", channel, sequence, timestamp, frame: output };
  }

  #release(key: string, pending: PendingFrame): void {
    this.#pending.delete(key);
    this.#bufferedBytes -= pending.total;
    this.#retainedFragments -= pending.fragments.size;
  }

  #remember(key: string, tombstone: Tombstone): void {
    if (this.#tombstones.size >= this.#limits.maxCompletedTombstones) {
      let oldestKey = "", oldestArrival = Infinity;
      for (const [candidate, entry] of this.#tombstones) {
        if (entry.firstArrival < oldestArrival) {
          oldestKey = candidate;
          oldestArrival = entry.firstArrival;
        }
      }
      this.#tombstones.delete(oldestKey);
    }
    this.#tombstones.set(key, tombstone);
  }

  #poison(key: string, pending: PendingFrame, reason: NvrPtcsRejection): NvrPtcsReassemblyResult {
    this.#release(key, pending);
    this.#remember(key, { firstArrival: pending.firstArrival, reason: "poisoned" });
    return this.#reject(reason);
  }

  #reject(reason: NvrPtcsRejection): NvrPtcsReassemblyResult {
    this.#rejected[reason] = Math.min(Number.MAX_SAFE_INTEGER, (this.#rejected[reason] ?? 0) + 1);
    return { status: "rejected", reason };
  }
}
