/**
 * Smooths one opt-in transport viewer using qualified video and AAC clocks.
 * The viewer owns this buffer and closes it on disconnect. Camera sessions,
 * snapshots, recordings and other viewers retain their original byte delivery.
 */
import { performance } from "node:perf_hooks";
import { parseAdtsAccessUnits } from "./ppcs-audio.js";
import { qualifiedLiveFrameClock } from "./live-frame-clock.js";

const BUFFER_MILLISECONDS = 6_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PACKETS = 1_024;

/** Content-free lifetime counters, including frames that outlive the measured jitter budget. */
export interface LivePacingSummary {
  readonly bufferMilliseconds: number;
  readonly latePackets: number;
  readonly maximumQueuedBytes: number;
  readonly videoPackets: number;
  readonly audioPackets: number;
}

interface PendingPacket {
  readonly at: number;
  readonly kind: "video" | "audio";
  readonly data: Buffer;
}

/**
 * Own one viewer's finite jitter queue, source epoch and timer until close.
 * Bootstrap bytes wait for the first qualified live unit. Invalid clocks and
 * queue pressure fail this experimental viewer rather than altering media.
 */
export class LiveFramePacer {
  readonly #queue: PendingPacket[] = [];
  readonly #bootstrap: Buffer[] = [];
  #bytes = 0;
  #maximumBytes = 0;
  #epoch: symbol | undefined;
  #previousTimestamp: number | undefined;
  #videoOrigin: number | undefined;
  #videoElapsed = 0;
  #audioOrigin: number | undefined;
  #audioElapsed = 0;
  #timer: NodeJS.Timeout | undefined;
  #admissionTimer: NodeJS.Timeout | undefined;
  #closed = false;
  #late = 0;
  #videoPackets = 0;
  #audioPackets = 0;

  /** Bind immutable-byte consumers and a monotonic viewer clock before accepting media. */
  constructor(
    private readonly video: (data: Buffer) => void,
    private readonly audio: (data: Buffer) => void,
    private readonly fail: (reason: string) => void,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.#admissionTimer = setTimeout(() => {
      if (this.#epoch === undefined) this.#reject("pacing_clock_missing");
    }, 10_000);
    this.#admissionTimer.unref();
  }

  /** Retain only bounded bootstrap bytes until a qualified unit establishes this viewer's epoch. */
  acceptVideo(data: Buffer): void {
    if (this.#closed || !data.length) return;
    const clock = qualifiedLiveFrameClock(data);
    if (!clock) {
      if (this.#epoch !== undefined) return this.#reject("pacing_clock_missing");
      if (this.#bytes + data.length > MAX_BYTES || this.#queue.length + this.#bootstrap.length >= MAX_PACKETS) {
        return this.#reject("pacing_input_limit");
      }
      this.#bootstrap.push(Buffer.from(data));
      this.#bytes += data.length;
      this.#checkLimit();
      return;
    }
    if (this.#epoch === undefined) {
      this.#epoch = clock.epoch;
      this.#previousTimestamp = clock.timestampMilliseconds;
      this.#videoOrigin = this.now();
      clearTimeout(this.#admissionTimer);
      this.#admissionTimer = undefined;
      for (const bootstrap of this.#bootstrap.splice(0)) {
        this.#bytes -= bootstrap.length;
        this.#enqueue("video", bootstrap, this.#videoOrigin + BUFFER_MILLISECONDS);
      }
    } else {
      if (clock.epoch !== this.#epoch) return this.#reject("pacing_epoch_changed");
      const step = (clock.timestampMilliseconds - this.#previousTimestamp!) >>> 0;
      if (step > 5_000) return this.#reject("pacing_clock_discontinuity");
      this.#videoElapsed += step;
      this.#previousTimestamp = clock.timestampMilliseconds;
    }
    this.#enqueue("video", data, this.#videoOrigin! + BUFFER_MILLISECONDS + this.#videoElapsed);
  }

  /** Preserve complete checked AAC batches on their existing sample clock. */
  acceptAudio(data: Buffer): void {
    if (this.#closed || !data.length) return;
    const units = parseAdtsAccessUnits(data);
    if (!units) return this.#reject("pacing_audio_invalid");
    this.#audioOrigin ??= this.now();
    const at = this.#audioOrigin + BUFFER_MILLISECONDS + this.#audioElapsed;
    this.#audioElapsed += units.reduce((total, unit) => total + unit.samples / unit.sampleRate * 1_000, 0);
    this.#enqueue("audio", data, at);
  }

  /** Cancel all owned callbacks and release retained media without delivering after disconnect. */
  close(): LivePacingSummary {
    this.#closed = true;
    clearTimeout(this.#timer);
    clearTimeout(this.#admissionTimer);
    this.#timer = undefined;
    this.#admissionTimer = undefined;
    this.#queue.length = 0;
    this.#bootstrap.length = 0;
    this.#bytes = 0;
    return { bufferMilliseconds: BUFFER_MILLISECONDS, latePackets: this.#late,
      maximumQueuedBytes: this.#maximumBytes, videoPackets: this.#videoPackets, audioPackets: this.#audioPackets };
  }

  #enqueue(kind: PendingPacket["kind"], data: Buffer, at: number): void {
    if (this.#closed) return;
    if (this.#bytes + data.length > MAX_BYTES || this.#queue.length + this.#bootstrap.length >= MAX_PACKETS) {
      return this.#reject("pacing_input_limit");
    }
    const packet = { kind, data: Buffer.from(data), at };
    const index = this.#queue.findIndex(item => item.at > at);
    if (index < 0) this.#queue.push(packet);
    else this.#queue.splice(index, 0, packet);
    this.#bytes += data.length;
    if (!this.#checkLimit()) return;
    if (at < this.now()) this.#late++;
    this.#arm();
  }

  #checkLimit(): boolean {
    this.#maximumBytes = Math.max(this.#maximumBytes, this.#bytes);
    if (this.#bytes > MAX_BYTES || this.#queue.length + this.#bootstrap.length > MAX_PACKETS) {
      this.#reject("pacing_input_limit");
      return false;
    }
    return true;
  }

  #arm(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#closed || !this.#queue.length || this.#epoch === undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      while (!this.#closed && this.#queue[0] && this.#queue[0].at <= this.now()) {
        const packet = this.#queue.shift()!;
        this.#bytes -= packet.data.length;
        if (packet.kind === "video") { this.#videoPackets++; this.video(packet.data); }
        else { this.#audioPackets++; this.audio(packet.data); }
      }
      this.#arm();
    }, Math.max(0, this.#queue[0]!.at - this.now()));
    this.#timer.unref();
  }

  #reject(reason: string): void {
    if (this.#closed) return;
    this.close();
    this.fail(reason);
  }
}
