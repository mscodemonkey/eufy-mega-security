/**
 * Multiplexes one shared viewer's H.264 and optional validated AAC into MPEG-TS.
 * Each instance owns its FFmpeg process and bounded input buffers. The stream
 * manager owns the camera source and supplies audio without opening another
 * camera session. HTTP disconnects release both ownership boundaries.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import { PassThrough, type Writable } from "node:stream";

/** Writable viewer boundary used by HTTP responses and an internal muxer input. */
export interface VideoViewerResponse extends Writable {
  readonly headersSent: boolean;
  writeHead(status: number, headers: OutgoingHttpHeaders): unknown;
}

/**
 * One muxer's internal Annex-B sink, enrolled as a viewer by the stream manager.
 * Destroying it releases that viewer. Headers acknowledge startup without
 * crossing the muxer's separate HTTP response boundary.
 */
class ViewerInput extends PassThrough implements VideoViewerResponse {
  headersSent = false;

  /** Mark the shared viewer started; the owning muxer writes its own HTTP content type. */
  writeHead(_status: number, _headers: OutgoingHttpHeaders): this {
    this.headersSent = true;
    return this;
  }
}

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const AUDIO_START_WAIT_MILLISECONDS = 2_000;

/**
 * Owns one live MPEG-TS viewer, its process, buffered startup and disconnect cleanup.
 * Camera ownership remains with the manager through videoInput. Missing initial
 * audio selects video-only output so a muted camera cannot stall its viewer.
 */
export class LiveTransportMuxer {

  /** Manager-facing video sink whose destruction releases shared camera ownership. */
  readonly videoInput = new ViewerInput();
  #process: ChildProcess | null = null;
  #video: Buffer[] = [];
  #audio: Buffer[] = [];
  #bufferedBytes = 0;
  #timer: NodeJS.Timeout | null = null;
  #outputTimer: NodeJS.Timeout | null = null;
  #closed = false;
  #starting = false;
  #audioReady = false;

  /** Bind a viewer, release its audio subscription on close, and report bounded failure codes without media or process output. */
  constructor(
    private readonly response: ServerResponse,
    private readonly onClose: () => void,
    private readonly audioWaitMilliseconds = AUDIO_START_WAIT_MILLISECONDS,
    private readonly onFailure: (reason: string) => void = () => undefined,
  ) {
    this.videoInput.on("data", (chunk: Buffer) => this.#acceptVideo(chunk));
    this.videoInput.once("end", () => this.close());
    this.videoInput.once("error", () => this.close());
    this.videoInput.once("close", () => this.close());
    response.once("close", () => this.close());
    response.once("error", () => this.close());
  }

  /** Consume only AAC already validated by the provider; retain bounded startup bytes. */
  acceptAudio(chunk: Buffer): void {
    if (this.#closed || chunk.length === 0) return;
    if (this.#process && this.#audioReady) {
      const input = this.#process.stdio[3] as Writable | null;
      if (input) this.#write(input, chunk);
      return;
    }
    if (this.#process && !this.#audioReady) return;
    this.#audio.push(Buffer.from(chunk));
    this.#bufferedBytes += chunk.length;
    if (this.#bufferedBytes > MAX_INPUT_BYTES) return this.close("startup_input_limit");
    if (this.#video.length) this.#start(true);
  }

  /** Idempotently release process and camera ownership, optionally reporting an internal failure code. */
  close(reason?: string): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#outputTimer) clearTimeout(this.#outputTimer);
    this.#outputTimer = null;
    this.#video = [];
    this.#audio = [];
    this.#bufferedBytes = 0;
    this.#process?.kill("SIGKILL");
    this.#process = null;
    this.videoInput.destroy();
    if (!this.response.destroyed) this.response.end();
    this.onClose();
    if (reason) this.onFailure(reason);
  }

  #acceptVideo(chunk: Buffer): void {
    if (this.#closed || chunk.length === 0) return;
    if (this.#process?.stdin) return this.#write(this.#process.stdin, chunk);
    this.#video.push(Buffer.from(chunk));
    this.#bufferedBytes += chunk.length;
    if (this.#bufferedBytes > MAX_INPUT_BYTES) return this.close("startup_input_limit");
    if (this.#audio.length) return this.#start(true);
    if (!this.#timer) {
      this.#timer = setTimeout(() => { this.#start(false); }, this.audioWaitMilliseconds);
    }
  }

  #write(input: Writable, chunk: Buffer): void {
    if (!input.writable || input.destroyed) return this.close("input_closed");
    input.write(chunk);
    if (input.writableLength > MAX_INPUT_BYTES) this.close("input_backpressure_limit");
  }

  #start(withAudio: boolean): void {
    if (this.#closed || this.#process || this.#starting || !this.#video.length) return;
    this.#starting = true;
    if (this.response.destroyed || this.response.writableEnded) return this.close();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;

    // Copying raw H.264 requires actual input timestamps for FFmpeg to schedule
    // successive AAC packets. Frame rate alone leaves its scheduler without a video clock.
    const args = ["-hide_banner", "-loglevel", "error", "-fflags", "+genpts", "-probesize", "32",
      "-analyzeduration", "0", "-thread_queue_size", "512", "-use_wallclock_as_timestamps", "1", "-r", "15", "-f", "h264", "-i", "pipe:0"];
    if (withAudio) args.push("-probesize", "32", "-analyzeduration", "0", "-thread_queue_size", "512", "-f", "aac", "-i", "pipe:3");
    args.push("-map", "0:v:0");
    if (withAudio) args.push("-map", "1:a:0");

    // Raw AAC startup can yield overlapping timestamps even when subsequent
    // packets are regular. Keep its sample clock continuous for HA's MP4 remux.
    if (withAudio) args.push("-bsf:a", "setts=ts='if(eq(N,0),0,PREV_OUTDTS+PREV_OUTDURATION)':duration='if(gt(DURATION,0),DURATION,1024/SR/TB)'");

    // HA back-calculates the first video DTS from the second packet. A burst
    // of startup frames can make that negative, shifting only its first MP4
    // segment and rounding AAC into an overlap at the next segment boundary.
    // A shared positive epoch prevents that shift without buffering or changing cadence.
    args.push("-c", "copy", "-output_ts_offset", "1", "-flush_packets", "1", "-muxdelay", "0", "-muxpreload", "0", "-max_interleave_delta", "100000", "-f", "mpegts", "pipe:1");
    const child = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe", withAudio ? "pipe" : "ignore"] });
    this.#process = child;
    child.once("error", () => this.close("process_error"));
    child.once("exit", () => this.close("process_exit"));
    child.stderr?.resume();
    child.stdin?.once("error", () => this.close("video_input_error"));
    const audioInput = child.stdio[3] as Writable | null;
    audioInput?.once("error", () => this.close("audio_input_error"));
    this.response.writeHead(200, { "Content-Type": "video/mp2t", "Cache-Control": "no-store" });
    const awaitOutput = (): void => {
      if (this.#outputTimer) clearTimeout(this.#outputTimer);
      this.#outputTimer = setTimeout(() => this.close("output_timeout"), 10_000);
      this.#outputTimer.unref();
    };
    awaitOutput();
    child.stdout?.on("data", awaitOutput);
    child.stdout?.pipe(this.response);
    for (const chunk of this.#video) {
      if (child.stdin && !this.#closed) this.#write(child.stdin, chunk);
    }
    this.#video = [];
    this.#bufferedBytes = this.#audio.reduce((total, chunk) => total + chunk.length, 0);
    if (withAudio && audioInput) {
      this.#audioReady = true;
      for (const chunk of this.#audio) this.#write(audioInput, chunk);
      this.#audio = [];
      this.#bufferedBytes = 0;
    }
  }
}
