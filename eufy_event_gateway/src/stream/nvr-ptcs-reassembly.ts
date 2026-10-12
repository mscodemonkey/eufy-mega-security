/**
 * Reassembles the sender-derived PTCS data-fragment candidate offline. A future
 * RTC adapter must own session identity, cross-frame ordering and recovery.
 * This layer has no observed receive confirmation, FEC, NACK or retransmission
 * contract and is deliberately separate from PPCS video access-unit assembly.
 */

const PACKET_BYTES = 1028;
const HEADER_BYTES = 28;
const FRAGMENT_BYTES = 1000;

/** Independent allocation and replay-history budgets for one owned session. */
export interface NvrPtcsReassemblyLimits {
  readonly maxFrameBytes: number;
  readonly maxBufferedBytes: number;
  readonly maxPendingFrames: number;

  /** Oldest replay or poison history is evicted when this separate cap fills. */
  readonly maxCompletedTombstones: number;
  readonly expiryMilliseconds: number;
}

/** Structural rejection categories contain no account, device or frame contents. */
export type NvrPtcsRejection = "packet-geometry" | "magic" | "type" | "flags" | "length" | "index"
  | "final-marker" | "channel" | "frame-too-large" | "metadata-conflict" | "duplicate-conflict"
  | "replay" | "capacity" | "poisoned";

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
  readonly frame: Buffer;
  readonly received: Uint8Array;
  remaining: number;
}

interface Tombstone {
  readonly firstArrival: number;
  readonly reason: "replay" | "poisoned";
}

/**
 * Owns bounded fragment buffers and replay history for one caller-owned session.
 * The caller supplies a monotonic millisecond clock and clears state at retirement.
 * Only complete type-3 fragment sets are accepted. Missing fragments expire,
 * unsupported recovery packets are rejected, and no live transport consumes this
 * candidate yet. A completed Buffer is mutable and owned solely by the caller.
 */
export class NvrPtcsReassembler {
  readonly #limits: NvrPtcsReassemblyLimits;
  readonly #pending = new Map<string, PendingFrame>();
  readonly #tombstones = new Map<string, Tombstone>();
  readonly #rejected: Partial<Record<NvrPtcsRejection, number>> = {};
  #bufferedBytes = 0;
  #lastNow = 0;

  /** Reject invalid budgets before retaining any packet or allocating a frame. */
  constructor(limits: Partial<NvrPtcsReassemblyLimits> = {}) {
    this.#limits = { maxFrameBytes: 4 * 1024 * 1024, maxBufferedBytes: 8 * 1024 * 1024,
      maxPendingFrames: 64, maxCompletedTombstones: 256, expiryMilliseconds: 1000, ...limits };
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
    if (packet.length !== PACKET_BYTES) return this.#reject("packet-geometry");
    if (!packet.subarray(0, 4).equals(Buffer.from("PTCS"))) return this.#reject("magic");
    if (packet[4] !== 3) return this.#reject("type");
    const channel = packet[5]!;
    if (channel > 5) return this.#reject("channel");
    if (packet.subarray(20, HEADER_BYTES).some(byte => byte !== 0)) return this.#reject("packet-geometry");
    const sequence = packet.readUInt16LE(6), timestamp = packet.readUInt32LE(8);
    const total = packet.readUInt32LE(12), index = packet.readUInt16LE(16), flags = packet.readUInt16LE(18);
    if ((flags & ~0x47ff) !== 0 || (flags & 0x4000) === 0) return this.#reject("flags");
    if (total > this.#limits.maxFrameBytes) return this.#reject("frame-too-large");
    const count = Math.max(1, Math.ceil(total / FRAGMENT_BYTES));
    if (count > 65536) return this.#reject("frame-too-large");
    if (index >= count) return this.#reject("index");
    const final = index === count - 1;
    if (Boolean(flags & 0x0400) !== final) return this.#reject("final-marker");
    const length = flags & 0x03ff;
    if (length !== Math.min(FRAGMENT_BYTES, total - index * FRAGMENT_BYTES)) return this.#reject("length");
    const key = `${channel}:${sequence}:${timestamp}`;
    const tombstone = this.#tombstones.get(key);
    if (tombstone) return this.#reject(tombstone.reason);
    let pending = this.#pending.get(key);
    if (pending && pending.total !== total) return this.#poison(key, pending, "metadata-conflict");
    if (!pending) {
      if (this.#pending.size >= this.#limits.maxPendingFrames
        || total > this.#limits.maxBufferedBytes - this.#bufferedBytes) return this.#reject("capacity");
      pending = { total, firstArrival: nowMilliseconds, frame: Buffer.alloc(total),
        received: new Uint8Array(count), remaining: count };
      this.#pending.set(key, pending);
      this.#bufferedBytes += total;
    }
    const offset = index * FRAGMENT_BYTES;
    const part = packet.subarray(HEADER_BYTES, HEADER_BYTES + length);
    if (pending.received[index]) {
      if (!pending.frame.subarray(offset, offset + length).equals(part)) return this.#poison(key, pending, "duplicate-conflict");
      return { status: "incomplete" };
    }
    part.copy(pending.frame, offset);
    pending.received[index] = 1;
    if (--pending.remaining !== 0) return { status: "incomplete" };
    this.#release(key, pending);
    this.#remember(key, { firstArrival: pending.firstArrival, reason: "replay" });
    return { status: "complete", channel, sequence, timestamp, frame: pending.frame };
  }

  #release(key: string, pending: PendingFrame): void {
    this.#pending.delete(key);
    this.#bufferedBytes -= pending.total;
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

  #poison(key: string, pending: PendingFrame, reason: "metadata-conflict" | "duplicate-conflict"): NvrPtcsReassemblyResult {
    this.#release(key, pending);
    this.#remember(key, { firstArrival: pending.firstArrival, reason: "poisoned" });
    return this.#reject(reason);
  }

  #reject(reason: NvrPtcsRejection): NvrPtcsReassemblyResult {
    this.#rejected[reason] = Math.min(Number.MAX_SAFE_INTEGER, (this.#rejected[reason] ?? 0) + 1);
    return { status: "rejected", reason };
  }
}
