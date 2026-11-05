/**
 * Paces bounded C31 speaker audio inside a provider-owned live PPCS session.
 * This module owns AAC admission, retry limits and cancellation. The session
 * owns encryption, socket lifetime and explicit native start/stop commands.
 */
import { setTimeout as delay } from "node:timers/promises";
import { parseAdtsAccessUnits } from "./ppcs-audio.js";

/** Validate a short native AAC-LC 16 kHz mono clip before opening any camera session. */
export function c31TalkbackFrames(audio: Buffer): readonly Buffer[] {
  if (!audio.length || audio.length > 320_000) throw new SyntaxError("Speaker audio exceeds its size limit");
  const units = parseAdtsAccessUnits(audio);
  if (!units || units.length > 312) throw new SyntaxError("Speaker audio must contain at most 20 seconds of complete AAC");
  const frames: Buffer[] = [];
  let offset = 0;
  for (const unit of units) {
    const end = unit.payload.byteOffset - audio.byteOffset + unit.payload.length;
    if (unit.configuration !== 0x1408 || unit.samples !== 1024 || end - offset > 640) {
      throw new SyntaxError("Speaker audio requires AAC-LC 16 kHz mono frames of at most 640 bytes");
    }
    frames.push(Buffer.from(audio.subarray(offset, end)));
    offset = end;
  }
  return frames;
}

/** Build the app-observed audio metadata without exposing transport sequence or peer identity. */
export function c31TalkbackBody(frame: Buffer): Buffer {
  const units = c31TalkbackFrames(frame);
  if (units.length !== 1) throw new SyntaxError("Speaker packets require one complete AAC frame");
  const header = Buffer.alloc(16);
  header.writeUInt32LE(frame.length);
  return Buffer.concat([header, frame]);
}

/** Session-owned effects borrowed for one bounded speaker operation. */
export interface C31TalkbackSink {
  start(): void;
  stop(): void;
  send(frame: Buffer, retrySequence?: number): number;
}

/**
 * Own one paced clip and its acknowledgement window. The owning session routes
 * video-channel ACKs here and closes this sender before closing its UDP socket.
 * A transmission result never asserts that a person heard the camera speaker.
 */
export class C31TalkbackSender {
  readonly #abort = new AbortController();
  readonly #pending = new Map<number, { frame: Buffer; sentAt: number; sends: number }>();
  #running = false;
  #stopped = false;

  /** Borrow effects from the established, exact-model media session. */
  constructor(private readonly sink: C31TalkbackSink) {}

  /** Remove only an outstanding audio sequence, ignoring unrelated channel acknowledgements. */
  acknowledge(sequence: number): void { this.#pending.delete(sequence); }

  /** Abort pacing and explicitly close the speaker path while its parent socket still exists. */
  close(): void {
    this.#abort.abort();
    if (this.#running && !this.#stopped) {
      this.#stopped = true;
      this.sink.stop();
    }
    this.#pending.clear();
  }

  /** Play one prevalidated clip, requiring bounded ACK recovery and stopping on every exit. */
  async play(audio: Buffer, signal?: AbortSignal): Promise<void> {
    const frames = c31TalkbackFrames(audio);
    if (this.#running || this.#stopped || this.#abort.signal.aborted || signal?.aborted) throw new Error("Speaker operation unavailable");
    const cancel = (): void => this.close();
    signal?.addEventListener("abort", cancel, { once: true });
    this.#running = true;
    try {
      this.sink.start();
      await delay(200, undefined, { signal: this.#abort.signal });
      const started = performance.now();
      for (let index = 0; index < frames.length; index += 1) {
        const wait = started + index * 64 - performance.now();
        if (wait < -500) throw new Error("Speaker pacing fell behind");
        if (wait > 0) await delay(wait, undefined, { signal: this.#abort.signal });
        this.#retry();
        if (this.#pending.size >= 32) throw new Error("Speaker acknowledgement window exceeded");
        const frame = frames[index]!;
        const sequence = this.sink.send(frame);
        this.#pending.set(sequence, { frame, sentAt: performance.now(), sends: 1 });
      }
      await delay(64, undefined, { signal: this.#abort.signal });
      while (this.#pending.size) {
        this.#retry();
        await delay(50, undefined, { signal: this.#abort.signal });
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.close();
    }
  }

  #retry(): void {
    for (const [sequence, held] of this.#pending) {
      if (performance.now() - held.sentAt < 700) continue;
      if (held.sends >= 2) throw new Error("Camera did not acknowledge speaker audio");
      this.sink.send(held.frame, sequence);
      held.sends += 1;
      held.sentAt = performance.now();
    }
  }
}
