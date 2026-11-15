/**
 * Converts one negotiated PCMU microphone segment into bounded native C31 AAC.
 * The WebRTC owner supplies authenticated RTP and ends this segment on silence
 * or peer retirement. This module owns its FFmpeg child and pending audio only,
 * never a microphone device, camera connection or persistent recording.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { c31TalkbackFrames } from "./c31-talkback.js";
import { terminateMediaProcess } from "./live-stream-manager.js";

/** Content-free terminal reasons for this encoder, never inferred camera failures. */
export type C31MicrophoneOutcome = "receiving" | "silence" | "completed" | "invalid_packet" | "timestamp_gap"
  | "input_backpressure" | "encoder_unavailable" | "encoder_backlog" | "invalid_aac" | "cancelled";

/** Read-only counters for one microphone segment, without its contents or identity. */
export interface C31MicrophoneSummary {
  readonly outcome: C31MicrophoneOutcome;
  readonly receivedPackets: number;
  readonly duplicatePackets: number;

  /** Missing samples replaced with PCMU silence on the 8 kHz input clock. */
  readonly insertedSamples: number;
  readonly encodedFrames: number;
  readonly maximumQueuedFrames: number;
}

/** Retain at most one second of encoded audio while the speaker establishes its path. */
class AacQueue implements AsyncIterable<Buffer> {
  readonly #frames: Buffer[] = [];
  #waiting: { resolve: (item: IteratorResult<Buffer>) => void; reject: (error: Error) => void } | null = null;
  #ended = false;
  #error: Error | null = null;
  #claimed = false;

  /** Highest number of frames waiting for the one speaker consumer. */
  maximum = 0;

  /** Refuse overflow rather than playing an old microphone backlog later. */
  push(frame: Buffer): void {
    if (this.#ended) return;
    if (this.#waiting) {
      const waiter = this.#waiting; this.#waiting = null;
      waiter.resolve({ done: false, value: frame });
    } else {
      if (this.#frames.length >= 16) throw new Error("Microphone audio backlog exceeded");
      this.#frames.push(frame); this.maximum = Math.max(this.maximum, this.#frames.length);
    }
  }

  /** Finish buffered input normally, or discard it on a failed or cancelled segment. */
  end(error?: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#error = error ?? null;
    if (error) this.#frames.length = 0;
    if (this.#waiting) {
      const waiter = this.#waiting; this.#waiting = null;
      if (error) waiter.reject(error);
      else waiter.resolve({ done: true, value: undefined });
    }
  }

  /** Supply one consumer, whose cancellation drops pending audio immediately. */
  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    if (this.#claimed) throw new Error("Microphone input already has a consumer");
    this.#claimed = true;
    return {
      next: async () => {
        if (this.#error) throw this.#error;
        const frame = this.#frames.shift();
        if (frame) return { done: false, value: frame };
        if (this.#ended) return { done: true, value: undefined };
        if (this.#waiting) throw new Error("Microphone input already has a consumer");
        return await new Promise<IteratorResult<Buffer>>((resolve, reject) => { this.#waiting = { resolve, reject }; });
      },
      return: async () => { this.end(); this.#frames.length = 0; return { done: true, value: undefined }; },
    };
  }
}

/** Fixed PCMU-to-AAC conversion. Its only input is a caller-owned pipe. */
export function c31MicrophoneArguments(): string[] {
  return ["-hide_banner", "-loglevel", "error", "-probesize", "32", "-analyzeduration", "0",
    "-f", "mulaw", "-ar", "8000", "-ac", "1", "-i", "pipe:0", "-vn", "-c:a", "aac",
    "-profile:a", "aac_low", "-ar", "16000", "-ac", "1", "-b:a", "32k", "-flush_packets", "1", "-f", "adts", "pipe:1"];
}

/**
 * Own one short live microphone segment and its encoder retirement.
 * Only 8 kHz mono PCMU RTP reaches this object. Small missing intervals become
 * silence, duplicates are ignored and larger discontinuities stop the segment.
 * Silence ends the encoder without opening a host audio device. The caller must
 * cancel its speaker operation and await `finished` before replacing this owner.
 */
export class C31MicrophoneInput {
  readonly #queue = new AacQueue();
  readonly #child: ChildProcessWithoutNullStreams;
  #buffer = Buffer.alloc(0);
  #idle: NodeJS.Timeout | undefined;
  #startup: NodeJS.Timeout;
  #finish: NodeJS.Timeout | undefined;
  #closed = false;
  #ending = false;
  #last: { sequence: number; timestamp: number; samples: number } | null = null;
  #received = 0;
  #duplicates = 0;
  #inserted = 0;
  #encoded = 0;
  #outcome: C31MicrophoneOutcome = "receiving";

  /** Native frames remain transient and have exactly one speaker consumer. */
  readonly frames: AsyncIterable<Buffer> = this.#queue;

  /** Settles only after the exact owned encoder has closed. */
  readonly finished: Promise<void>;

  /** Start an encoder with pipes only. No platform audio device is addressed. */
  constructor() {
    this.#child = spawn("ffmpeg", c31MicrophoneArguments(), { stdio: ["pipe", "pipe", "pipe"] });
    this.finished = new Promise(resolve => this.#child.once("close", (code: number | null) => {
      clearTimeout(this.#idle); clearTimeout(this.#startup); clearTimeout(this.#finish);
      if (!this.#closed) {
        this.#closed = true;
        const completed = this.#ending && this.#buffer.length === 0 && code === 0;
        if (!completed) this.#outcome = "encoder_unavailable";
        this.#queue.end(completed ? undefined : new Error("Microphone encoder ended"));
      }
      resolve();
    }));
    this.#startup = setTimeout(() => this.close("encoder_unavailable"), 5_000); this.#startup.unref();
    this.#child.on("error", () => this.close("encoder_unavailable"));
    this.#child.stdin.on("error", () => { if (!this.#ending) this.close("input_backpressure"); });
    this.#child.stderr.resume();
    this.#child.stdout.on("data", (chunk: Buffer) => {
      if (this.#closed) return;
      try {
        if (this.#buffer.length + chunk.length > 16 * 640) { this.close("encoder_backlog"); return; }
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        while (this.#buffer.length >= 7) {
          const length = ((this.#buffer[3]! & 3) << 11) | (this.#buffer[4]! << 3) | (this.#buffer[5]! >> 5);
          if (length < 7 || length > 640) { this.close("invalid_aac"); return; }
          if (this.#buffer.length < length) break;
          const frame = Buffer.from(this.#buffer.subarray(0, length));
          if (c31TalkbackFrames(frame).length !== 1) { this.close("invalid_aac"); return; }
          this.#buffer = this.#buffer.subarray(length);
          this.#queue.push(frame); this.#encoded++; clearTimeout(this.#startup);
        }
      } catch { this.close("encoder_backlog"); }
    });
  }

  /** Refuse new RTP while a muted segment flushes and its speaker owner retires. */
  get accepting(): boolean { return !this.#closed && !this.#ending; }

  /** Explain pacing and admission without exposing microphone data. */
  get summary(): C31MicrophoneSummary {
    return { outcome: this.#outcome, receivedPackets: this.#received, duplicatePackets: this.#duplicates, insertedSamples: this.#inserted,
      encodedFrames: this.#encoded, maximumQueuedFrames: this.#queue.maximum };
  }

  /** Admit negotiated 10 to 60 ms PCMU packets, preserving their single RTP clock. */
  push(payload: Buffer, sequence: number, timestamp: number): void {
    if (this.#closed || this.#ending) return;
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > 65535 || !Number.isInteger(timestamp)
      || timestamp < 0 || timestamp > 0xffff_ffff || payload.length < 80 || payload.length > 480 || payload.length % 80 !== 0) {
      this.close("invalid_packet"); return;
    }
    let gap = 0;
    if (this.#last) {
      const forward = (sequence - this.#last.sequence) & 0xffff;
      if (forward === 0 || forward >= 0x8000) { this.#duplicates++; return; }
      gap = (timestamp - this.#last.timestamp - this.#last.samples) >>> 0;
      if (forward > 16 || gap > 1600) { this.close("timestamp_gap"); return; }
    }
    this.#last = { sequence, timestamp, samples: payload.length };
    this.#received++; this.#inserted += gap;
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.end("silence"), 750); this.#idle.unref();
    if (gap && !this.#child.stdin.write(Buffer.alloc(gap, 0xff))) { this.close("input_backpressure"); return; }
    if (!this.#child.stdin.write(payload)) this.close("input_backpressure");
  }

  /** Flush a muted or ended microphone segment, with no trailing input accepted. */
  end(outcome: "completed" | "silence" = "completed"): void {
    if (this.#ending || this.#closed) return;
    this.#outcome = outcome;
    this.#ending = true; clearTimeout(this.#idle); this.#child.stdin.end();
    this.#finish = setTimeout(() => this.close("encoder_unavailable"), 2_000); this.#finish.unref();
  }

  /** Discard audio immediately and retire only this segment's exact encoder. */
  close(outcome: C31MicrophoneOutcome = "cancelled"): void {
    if (this.#closed) return;
    this.#outcome = outcome;
    this.#closed = true; clearTimeout(this.#idle); clearTimeout(this.#startup); clearTimeout(this.#finish);
    this.#queue.end(new Error("Microphone segment unavailable"));
    this.#buffer = Buffer.alloc(0); terminateMediaProcess(this.#child);
  }
}
