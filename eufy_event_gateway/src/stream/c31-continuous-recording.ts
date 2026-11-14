/**
 * Retrieves one consented C31 continuous-recording preview inside its owned PPCS
 * connection. The provider supplies a fresh index and identity. This reader owns
 * the finite media window, timestamp-derived key, stop request and private buffers.
 * The HTTP boundary receives only a fully decoded, seekable MP4.
 */
import { decodePpcsAac } from "./ppcs-audio.js";
import { decodeStoredVideo, finalizeStoredMp4, validateStoredMedia, type StoredVideoFrame } from "./stored-recordings.js";
import { remuxVideoToMp4 } from "./live-stream-manager.js";
import { C31IndexError, summarizeC31Index, validateC31IndexWindow } from "./c31-recording-index.js";

/** Explicit UTC selection for the fixed ten-second, default-off preview. */
export interface C31ContinuousRequest {
  readonly beginTime: number;
}

/** Admit a closed request before contacting a camera or retaining private media. */
export function parseC31ContinuousRequest(value: unknown, now: number): C31ContinuousRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new C31IndexError("admission");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || row.consentPrivateMedia !== true || typeof row.beginTime !== "number") {
    throw new C31IndexError("admission");
  }
  validateC31IndexWindow(row.beginTime, row.beginTime + 10, now);
  return { beginTime: row.beginTime };
}

/** Require one unambiguous, current index interval to contain the entire preview. */
export function requireC31ContinuousInterval(value: unknown, begin: number, owner: string): void {
  const summary = summarizeC31Index(value, begin, begin + 10, owner);
  const rows = (value as { videos: { start_time: number; stop_time: number }[] }).videos;
  const containing = rows.filter(row => row.start_time <= begin && row.stop_time >= begin + 10);
  if (summary.invalid || summary.overlapping !== 1 || containing.length !== 1) throw new C31IndexError("malformed");
}

/** Session callbacks never expose keys, peer addresses or recording references to callers. */
export interface C31ContinuousTransport {
  readonly serial: string;
  readonly did: string;

  /** Submit the single start request for the provider-selected recording time. */
  start(): void;

  /** Submit one stop while the parent transport still owns the peer. */
  stop(): void;

  /** Decode the selected protection form before its bounded timestamp can supply a media key. */
  decodeReply(payload: Buffer, sign: number): Buffer | null;
}

/**
 * Own one ten-second continuous playback request and its stop, including failures.
 * The parent session supplies complete, ordered frames. Foreign channels cannot
 * install the key or contribute media. Cancellation clears retained private bytes.
 */
export class C31ContinuousReader {
  #active = false;
  #started = false;
  #stopped = false;
  #timestamp: string | null = null;
  #firstClock: number | null = null;
  #lastClock: number | null = null;
  #video: StoredVideoFrame[] = [];
  #audio: { clock: number; data: Buffer }[] = [];
  #bytes = 0;
  #resolve: (() => void) | undefined;
  #reject: ((error: Error) => void) | undefined;

  /** Borrow the authenticated session for exactly one request, without creating a socket. */
  constructor(private readonly transport: C31ContinuousTransport) {}

  /** Retrieve a checked preview, stopping the camera before packaging or returning bytes. */
  async read(signal: AbortSignal): Promise<Buffer> {
    if (this.#active || this.#started || signal.aborted) throw new C31IndexError("cancelled");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => this.#fail(new C31IndexError("cancelled"));
    try {
      await new Promise<void>((resolve, reject) => {
        this.#resolve = resolve; this.#reject = reject; this.#active = true;
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => this.#fail(new C31IndexError("timeout")), 30_000);
        this.#started = true;
        try { this.transport.start(); } catch { this.#fail(new C31IndexError("session")); }
      });
      this.#stop();
      if (!this.#timestamp || this.#firstClock === null || this.#lastClock === null || this.#video.length < 2 || signal.aborted) {
        throw new C31IndexError("malformed");
      }
      const elapsed = (this.#lastClock - this.#firstClock) >>> 0;
      const rate = this.#video.length * 1000 / elapsed;
      if (elapsed < 10_000 || elapsed > 12_000 || rate < 1 || rate > 60) throw new C31IndexError("malformed");
      const video = decodeStoredVideo(this.#video, this.transport.serial, this.transport.did, this.#timestamp);
      const audio = Buffer.concat(this.#audio.filter(row => ((row.clock - this.#firstClock!) >>> 0) <= elapsed).map(row => row.data));
      try {
        const fragmented = await remuxVideoToMp4(video, "h264", audio.length ? audio : undefined, signal, rate);
        const media = await finalizeStoredMp4(fragmented, signal);
        if (media.length > 32 * 1024 * 1024) throw new C31IndexError("malformed");
        await validateStoredMedia(media, signal, 4096 * 2160);
        return media;
      } finally { video.fill(0); audio.fill(0); }
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort); this.#active = false;
      try { this.#stop(); }
      finally {
        this.#resolve = undefined; this.#reject = undefined; this.#timestamp = null;
        for (const row of this.#video) row.frame.fill(0);
        for (const row of this.#audio) row.data.fill(0);
        this.#video = []; this.#audio = [];
      }
    }
  }

  /** Consume only this connection's selected receipt and recorded-media channel. */
  handleFrame(header: Buffer, payload: Buffer, type: number): boolean {
    if (!this.#active || header.length !== 16) return false;
    const command = header.readUInt16LE(4), sign = header[13] ?? 0;
    if (command === 6001) {
      if (header[12] !== 0 || type !== 2 || ![1, 2, 8].includes(sign)) return true;
      const clear = this.transport.decodeReply(payload, sign);
      if (!clear || clear.length !== 128 || clear[10] !== 0 || !/^\d{10}$/.test(clear.subarray(0, 10).toString("ascii"))) {
        this.#fail(new C31IndexError("malformed")); return true;
      }
      const timestamp = clear.subarray(0, 10).toString("ascii");
      if (this.#timestamp && this.#timestamp !== timestamp) this.#fail(new C31IndexError("malformed"));
      else this.#timestamp = timestamp;
      return true;
    }
    if (![1300, 1301].includes(command)) return false;
    if (header[12] !== 101 || type !== 1) return true;
    this.#bytes += payload.length;
    if (this.#bytes > 32 * 1024 * 1024 || this.#video.length + this.#audio.length > 6000) {
      this.#fail(new C31IndexError("malformed")); return true;
    }
    if (command === 1300) {
      if (payload.length < 22 || payload.readUInt32LE(0) !== payload.length - 22 || payload[5] !== 1
        || ![0, 1].includes(sign) || payload.readUInt16LE(10) > 4096 || payload.readUInt16LE(12) > 2160) {
        this.#fail(new C31IndexError("malformed")); return true;
      }
      if (this.#firstClock === null) {
        if (!this.#timestamp || !(payload[4]! & 1)) return true;
        this.#firstClock = payload.readUInt32LE(14);
      }
      const clock = payload.readUInt32LE(14), elapsed = (clock - this.#firstClock) >>> 0;
      if (elapsed > 12_000 || this.#lastClock !== null && ((clock - this.#lastClock) >>> 0) > 2000) {
        this.#fail(new C31IndexError("malformed")); return true;
      }
      this.#lastClock = clock;
      if (elapsed >= 10_000) { this.#active = false; this.#resolve?.(); }
      else this.#video.push({ frame: Buffer.from(payload), sign });
    } else if (this.#firstClock !== null) {
      const data = sign === 0 ? decodePpcsAac(payload) : null;
      if (!data) this.#fail(new C31IndexError("malformed"));
      else this.#audio.push({ clock: payload.readUInt32LE(8), data });
    }
    return true;
  }

  /** Reject unfinished capture and issue its stop before the parent closes transport. */
  close(): void {
    this.#fail(new C31IndexError("cancelled"));
    try { this.#stop(); } catch { this.#fail(new C31IndexError("session")); }
  }

  #fail(error: Error): void { this.#active = false; this.#reject?.(error); }

  #stop(): void {
    if (!this.#started || this.#stopped) return;
    this.#stopped = true;
    this.transport.stop();
  }
}
