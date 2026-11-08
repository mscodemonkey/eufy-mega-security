/**
 * Limits the age of gateway-queued input for each FFmpeg media child.
 * LiveStreamManager owns one bound per child, for the snapshot extractor and
 * the H.265 viewer conversion, together with the child's process, lifetime and
 * the stop summaries that report the skip counters. This boundary owns only
 * what is written to that child's stdin. It keeps write positions, not media,
 * and starts no process or timer.
 */
import type { Writable } from "node:stream";

import type { VideoCodec } from "../domain/types.js";

/**
 * Maximum age of a write still pending on the gateway-to-child pipe.
 * The allowance accommodates keyframe bursts. OS-pipe, decoder and player
 * queues are outside this observation, so this is not a display-latency cap.
 */
export const MAX_MEDIA_INPUT_AGE_MILLISECONDS = 2_000;

// End of sequence (H.264 NAL type 10, H.265 type 36). A decoder resuming at a CRA
// picture then drops the leading pictures that refer to frames it never received.
const END_OF_SEQUENCE: Record<VideoCodec, Buffer> = {
  h264: Buffer.from([0, 0, 0, 1, 0x0a]),
  h265: Buffer.from([0, 0, 0, 1, 0x48, 0x01]),
};

/**
 * Keeps an FFmpeg child's unread camera input short.
 *
 * Camera video is written to FFmpeg without waiting, and FFmpeg reads it in
 * order. A child slower than the camera therefore falls further behind for as
 * long as the source runs, and the input it has not read waits in gateway
 * memory. Once the oldest unread input is older than the limit, the child gets
 * nothing more until the gateway queue drains and a keyframe arrives. It then
 * starts again from that keyframe's cached decoder start, so it skips to live
 * instead of letting gateway input accumulate for the whole view.
 *
 * One bound belongs to one consumer. {@link attach} moves it to a replacement
 * process and keeps its counters for that consumer's summary.
 */
export class MediaInputBound {
  #input: Pick<Writable, "writable" | "writableLength" | "write">;
  #written = 0;

  // Where each write ended in the input, and when it was made, until the child has taken it.
  #unread: { end: number; at: number }[] = [];
  #skipping = false;
  #skips = 0;
  #skippedBytes = 0;
  #maximumAgeMilliseconds = 0;

  constructor(
    input: Pick<Writable, "writable" | "writableLength" | "write">,
    private readonly codec: VideoCodec,
    private readonly nowMilliseconds: () => number,
    private readonly limitMilliseconds = MAX_MEDIA_INPUT_AGE_MILLISECONDS,
  ) {
    this.#input = input;
  }

  /** Whether the child is waiting for a keyframe, so the caller knows to supply a decoder start. */
  get skipping(): boolean {
    return this.#skipping;
  }

  get skips(): number {
    return this.#skips;
  }

  get skippedBytes(): number {
    return this.#skippedBytes;
  }

  get maximumAgeMilliseconds(): number {
    return this.#maximumAgeMilliseconds;
  }

  /** Feed a replacement process from a clean start, keeping this consumer's counters. */
  attach(input: Pick<Writable, "writable" | "writableLength" | "write">): this {
    this.#input = input;
    this.#written = 0;
    this.#unread = [];
    this.#skipping = false;
    return this;
  }

  /**
   * Pass one source chunk on, or skip it. `restart` is the cached decoder start
   * when this chunk began a random-access picture: it already ends with the
   * chunk's keyframe, so it replaces the chunk. Returns the bytes written.
   */
  write(chunk: Buffer, restart: Buffer | null = null): number {
    if (!this.#input.writable) return 0;
    const now = this.nowMilliseconds();
    const age = this.#age(now);
    this.#maximumAgeMilliseconds = Math.max(this.#maximumAgeMilliseconds, age);
    if (this.#skipping) {
      if (!restart || this.#input.writableLength > 0) {
        this.#skippedBytes += chunk.length;
        return 0;
      }
      this.#skipping = false;
      return this.#write(END_OF_SEQUENCE[this.codec], now) + this.#write(restart, now);
    }
    if (age > this.limitMilliseconds) {
      this.#skipping = true;
      this.#skips += 1;
      this.#skippedBytes += chunk.length;
      return 0;
    }
    return this.#write(chunk, now);
  }

  /** Age of the oldest input the child has not taken yet. The pipe holds what has left the stream's buffer. */
  #age(now: number): number {
    const taken = this.#written - this.#input.writableLength;
    while (this.#unread.length > 0 && this.#unread[0]!.end <= taken) this.#unread.shift();
    return this.#unread.length > 0 ? now - this.#unread[0]!.at : 0;
  }

  #write(data: Buffer, now: number): number {
    this.#input.write(data);
    this.#written += data.length;
    this.#unread.push({ end: this.#written, at: now });
    return data.length;
  }
}
