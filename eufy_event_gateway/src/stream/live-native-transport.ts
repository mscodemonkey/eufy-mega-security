/**
 * Multiplexes one viewer's unconverted H.264 or H.265 and optional checked AAC
 * into MPEG-TS, without a transcoder or FFmpeg process. The stream manager owns
 * the camera source and fans audio out without opening another camera session.
 * Each instance owns its writer, bounded startup buffer, timers and disconnect cleanup.
 */
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import type { VideoCodec } from "../domain/types.js";
import { splitAccessUnits } from "./annexb-access-units.js";
import { ClockedTransportWriter } from "./clocked-transport.js";
import type { VideoViewerResponse } from "./live-transport-muxer.js";
import { parseAdtsAccessUnits } from "./ppcs-audio.js";

const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

// HA back-calculates the first video DTS from the second packet, so start the
// program clock one second in to keep that first DTS positive.
const CLOCK_OFFSET_MILLISECONDS = 1_000;

/** Audio further than this from its arrival time is resynchronized, never left to drift. */
export const NATIVE_AUDIO_SLEW_MILLISECONDS = 300;

/**
 * One muxer's native Annex-B sink, enrolled as a native viewer by the stream manager.
 * The manager's content type names the codec. Destroying it releases that viewer.
 */
class NativeViewerInput extends PassThrough implements VideoViewerResponse {
  headersSent = false;
  codec: VideoCodec | null = null;

  /** Record the codec; the owning muxer writes its own HTTP content type. */
  writeHead(_status: number, headers: OutgoingHttpHeaders): this {
    this.headersSent = true;
    const type = headers["Content-Type"];
    this.codec = type === "video/h265" ? "h265" : type === "video/h264" ? "h264" : null;
    return this;
  }
}

interface PendingMedia {
  readonly kind: "video" | "audio";
  readonly data: Buffer;
  readonly at: number;
  readonly continuesPrevious: boolean;
}

/** Content-free counters reported once when the viewer closes. */
export interface NativeTransportSummary {
  readonly codec: VideoCodec | null;
  readonly audio: boolean;
  readonly startWaitMilliseconds: number | null;
  readonly videoUnits: number;
  readonly audioBatches: number;
  readonly audioResyncs: number;
  readonly audioDropped: number;
}

/**
 * Owns one native MPEG-TS viewer, its writer, buffered startup and disconnect cleanup.
 * Video waits for the first AAC at most `audioWaitMilliseconds`, then the program
 * starts with or without an audio track; a track is never declared before audio
 * has arrived, so neither HA's stream worker nor go2rtc waits on a silent one.
 */
export class NativeTransportMuxer {

  /** Manager-facing video sink whose destruction releases shared camera ownership. */
  readonly videoInput = new NativeViewerInput();
  #writer: ClockedTransportWriter | null = null;
  #withAudio = false;
  #pending: PendingMedia[] = [];
  #pendingBytes = 0;
  #timer: NodeJS.Timeout | null = null;
  #outputTimer: NodeJS.Timeout | null = null;
  #closed = false;
  #epoch: number | null = null;
  #firstVideoAt: number | null = null;
  #startWait: number | null = null;
  #videoTicks = -1;
  #audioNext: number | null = null;
  #videoUnits = 0;
  #audioBatches = 0;
  #audioResyncs = 0;
  #audioDropped = 0;

  /**
   * Bind a viewer and its finite buffer and audio-subscription lifetime.
   *
   * @param audioWaitMilliseconds Longest hold of video for the first AAC. Zero starts video-only at once.
   * @param now Monotonic clock in milliseconds, shared by video and audio arrival.
   */
  constructor(
    private readonly response: ServerResponse,
    private readonly onClose: () => void,
    private readonly audioWaitMilliseconds: number,
    private readonly onFailure: (reason: string) => void = () => undefined,
    private readonly onSummary: (summary: NativeTransportSummary) => void = () => undefined,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.videoInput.on("data", (chunk: Buffer) => this.#acceptVideo(chunk));
    this.videoInput.once("end", () => this.close());
    this.videoInput.once("error", () => this.close());
    this.videoInput.once("close", () => this.close());
    response.once("close", () => this.close());
    response.once("error", () => this.close());
  }

  /** Consume only AAC already validated by the provider. Late audio after a muted start is ignored. */
  acceptAudio(chunk: Buffer): void {
    if (this.#closed || chunk.length === 0) return;
    if (this.#writer) {
      if (this.#withAudio) this.#writeAudio(chunk, this.now());
      return;
    }
    if (!parseAdtsAccessUnits(chunk)) return;
    this.#hold({ kind: "audio", data: Buffer.from(chunk), at: this.now(), continuesPrevious: false });
    if (this.#firstVideoAt !== null) this.#start(true);
  }

  /** Idempotently release the writer and camera ownership, optionally reporting an internal failure code. */
  close(reason?: string): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#outputTimer) clearTimeout(this.#outputTimer);
    this.#timer = this.#outputTimer = null;
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#writer = null;
    this.videoInput.destroy();
    if (!this.response.destroyed) this.response.end();
    this.onClose();
    try {
      this.onSummary({ codec: this.videoInput.codec, audio: this.#withAudio, startWaitMilliseconds: this.#startWait,
        videoUnits: this.#videoUnits, audioBatches: this.#audioBatches, audioResyncs: this.#audioResyncs, audioDropped: this.#audioDropped });
    } catch {

      // Diagnostic listeners cannot retain an already stopped viewer.
    }
    if (reason) this.onFailure(reason);
  }

  #acceptVideo(chunk: Buffer): void {
    if (this.#closed || chunk.length === 0) return;
    const codec = this.videoInput.codec;
    if (!codec) return this.close("codec_unknown");
    const at = this.now();
    const { units, continuesPrevious } = splitAccessUnits(chunk, codec);
    if (this.#writer) {
      units.forEach((unit, index) => this.#writeVideo(unit, at, continuesPrevious && index === 0));
      return;
    }
    units.forEach((unit, index) => this.#hold({ kind: "video", data: Buffer.from(unit), at, continuesPrevious: continuesPrevious && index === 0 }));
    if (this.#closed) return;
    if (this.#firstVideoAt === null) {
      this.#firstVideoAt = at;
      if (this.#pending.some(item => item.kind === "audio")) return this.#start(true);
      if (this.audioWaitMilliseconds <= 0) return this.#start(false);
      this.#timer = setTimeout(() => this.#start(false), this.audioWaitMilliseconds);
    }
  }

  #hold(item: PendingMedia): void {
    this.#pending.push(item);
    this.#pendingBytes += item.data.length;
    if (this.#pendingBytes > MAX_BUFFERED_BYTES) this.close("startup_input_limit");
  }

  #start(withAudio: boolean): void {
    if (this.#closed || this.#writer) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.response.destroyed || this.response.writableEnded) return this.close();
    const codec = this.videoInput.codec!;
    this.#withAudio = withAudio;
    this.#startWait = Math.round(this.now() - this.#firstVideoAt!);
    this.response.writeHead(200, { "Content-Type": "video/mp2t", "Cache-Control": "no-store" });
    this.#writer = new ClockedTransportWriter(packet => this.#output(packet), withAudio, codec);
    const pending = this.#pending;
    this.#pending = [];
    this.#pendingBytes = 0;

    // Audio from well before the first picture would only hold that picture back.
    const firstVideo = pending.findIndex(item => item.kind === "video");
    const firstAt = pending[firstVideo]!.at;
    const ordered = pending.filter((item, index) => item.kind === "video" ? index >= firstVideo : withAudio && item.at >= firstAt - NATIVE_AUDIO_SLEW_MILLISECONDS)
      .sort((left, right) => left.at - right.at);
    for (const item of ordered) {
      if (this.#closed) return;
      if (item.kind === "video") this.#writeVideo(item.data, item.at, item.continuesPrevious);
      else this.#writeAudio(item.data, item.at);
    }
    this.#awaitOutput();
  }

  /** Stamp each unit with its arrival, strictly after the last; a continued picture keeps its time. */
  #writeVideo(unit: Buffer, at: number, continuesPrevious: boolean): void {
    const arrival = this.#ticks(at);
    const ticks = continuesPrevious && this.#videoTicks >= 0 ? this.#videoTicks : Math.max(arrival, this.#videoTicks + 1);
    this.#videoTicks = ticks;
    this.#videoUnits++;
    this.#write(() => this.#writer!.video(unit, ticks / 90));
  }

  /**
   * Keep AAC on its sample clock from the first batch's arrival. A batch that
   * arrives too late moves the clock up to its arrival; one too early is dropped.
   */
  #writeAudio(chunk: Buffer, at: number): void {
    const units = parseAdtsAccessUnits(chunk);
    if (!units) return;
    const arrival = this.#ticks(at) / 90;
    if (this.#audioNext === null) this.#audioNext = arrival;
    else if (arrival - this.#audioNext > NATIVE_AUDIO_SLEW_MILLISECONDS) {
      this.#audioNext = arrival;
      this.#audioResyncs++;
    } else if (this.#audioNext - arrival > NATIVE_AUDIO_SLEW_MILLISECONDS) {
      this.#audioDropped++;
      return;
    }
    const start = this.#audioNext;
    this.#audioNext += units.reduce((total, unit) => total + unit.samples * 1_000 / unit.sampleRate, 0);
    this.#audioBatches++;
    this.#write(() => this.#writer!.audio(chunk, start));
  }

  #ticks(at: number): number {
    this.#epoch ??= at;
    return Math.round((at - this.#epoch + CLOCK_OFFSET_MILLISECONDS) * 90);
  }

  #write(operation: () => void): void {
    if (this.#closed || !this.#writer) return;
    try { operation(); }
    catch { this.close("clocked_transport_invalid"); }
  }

  #output(packet: Buffer): void {
    if (this.#closed) return;
    if (this.response.destroyed || this.response.writableEnded) return this.close();
    if (this.response.writableLength + packet.length > MAX_BUFFERED_BYTES) return this.close("output_backpressure_limit");
    this.response.write(packet);
    this.#awaitOutput();
  }

  #awaitOutput(): void {
    if (this.#closed) return;
    if (this.#outputTimer) clearTimeout(this.#outputTimer);
    this.#outputTimer = setTimeout(() => this.close("output_timeout"), 10_000);
    this.#outputTimer.unref();
  }
}
