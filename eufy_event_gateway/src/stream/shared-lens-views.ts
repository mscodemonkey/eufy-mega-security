/**
 * Splits one qualified NVR Both source into two video-only 720p viewer outputs.
 * The stream manager owns the physical source. Each instance owns one decoder,
 * its two encoded branches, bounded pipe queues and HTTP clients until the last
 * client leaves or the source ends. No camera setting or recording is changed.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { setPriority } from "node:os";
import type { OutgoingHttpHeaders } from "node:http";
import { PassThrough, Readable } from "node:stream";
import type { VideoCodec } from "../domain/types.js";
import type { VideoViewerResponse } from "./live-transport-muxer.js";

/** Closed pane selection for the source-qualified fixed-above-movable layout. */
export type SharedLens = "fixed" | "movable";

/** Content-free terminal reasons for the shared decoder lifetime. */
export type SharedLensCloseReason = "clients_closed" | "source_ended" | "input_backlog" | "admission_changed"
  | "converter_ended" | "converter_error" | "startup_timeout";

/** Manager-supplied decoder-start cache, independent for each encoded branch. */
export interface LensOutputCache {

  /** Consume only this branch's encoded H.264 bytes. */
  push(chunk: Buffer, hint: VideoCodec): void;

  /** Parameter sets and the latest retained random-access group for a new viewer. */
  readonly startup: Buffer | null;

  /** Whether the decoder start already contains the most recently submitted chunk. */
  readonly startupIncludesLatest: boolean;

  /** Branch-local random-access observations, never borrowed from its sibling. */
  readonly diagnostics: { readonly randomAccessPictures: number };
}

/** Injectable process boundary for offline ownership and backpressure tests. */
export type SharedLensConverterFactory = (codec: VideoCodec) => ChildProcess;

/**
 * One decoder and two encoders, with exact input geometry enforced before crop.
 * An unexpected initial or changed resolution produces no wrongly labelled pane.
 */
export function sharedLensConverterArguments(codec: VideoCodec): string[] {
  const encoding = ["-an", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "26",
    "-maxrate", "3M", "-bufsize", "1.5M", "-x264-params", "repeat-headers=1:keyint=10", "-f", "h264"];
  const width = "if(eq(iw,1280)*eq(ih,1440),1280,0)";
  return ["-hide_banner", "-loglevel", "error", "-probesize", "2048", "-analyzeduration", "1", "-fpsprobesize", "0",
    "-f", codec === "h265" ? "hevc" : "h264", "-i", "pipe:0", "-filter_complex",
    `[0:v]split=2[top][bottom];[top]crop=w='${width}':h=720:x=0:y=0[fixed];[bottom]crop=w='${width}':h=720:x=0:y=720[movable]`,
    "-map", "[fixed]", ...encoding, "pipe:1", "-map", "[movable]", ...encoding, "pipe:3"];
}

/** Start the owned split below gateway priority, with both output pipes drained. */
export function spawnSharedLensConverter(codec: VideoCodec): ChildProcess {
  const child = spawn("ffmpeg", sharedLensConverterArguments(codec), { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  if (child.pid) { try { setPriority(child.pid, 10); } catch {} }
  return child;
}

/** Crop only an exact retained Both JPEG, never a single-lens image or fallback. */
export async function sharedLensSnapshot(data: Buffer, lens: SharedLens): Promise<Buffer | null> {
  if (data.length > 8 * 1024 * 1024 || !bothJpegHeader(data)) return null;
  return await new Promise(resolve => {
    const width = "if(eq(iw,1280)*eq(ih,1440),1280,0)";
    const child = execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-threads", "1", "-f", "image2pipe",
      "-i", "pipe:0", "-vf", `crop=w='${width}':h=720:x=0:y=${lens === "fixed" ? 0 : 720}`,
      "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"],
    { encoding: "buffer", timeout: 3_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 },
    (error, output) => resolve(!error && output.length > 2 ? output : null));
    if (child.pid) { try { setPriority(child.pid, 10); } catch {} }
    child.stdin?.on("error", () => {}); child.stdin?.end(data);
  });
}

/**
 * Retains at most sixteen pane revisions and two concurrent JPEG crop jobs.
 * The server owns this cache. Repeated dashboard reads share the same job,
 * saturation returns no image, and clearing invalidates any late completion.
 */
export class SharedLensSnapshotCache {
  readonly #entries = new Map<string, { revision: string; pending: boolean; result: Promise<Buffer | null> }>();
  #active = 0;
  #generation = 0;

  constructor(private readonly render = sharedLensSnapshot) {}

  /** Read one exact retained revision without spawning an unbounded decoder queue. */
  async read(serial: string, revision: string, data: Buffer, lens: SharedLens): Promise<Buffer | null> {
    const key = JSON.stringify([serial, lens]), previous = this.#entries.get(key);
    if (previous?.revision === revision) return await previous.result;
    if (previous?.pending || this.#active >= 2) return null;
    const generation = this.#generation;
    this.#active++;
    const entry = { revision, pending: true, result: Promise.resolve<Buffer | null>(null) };
    entry.result = Promise.resolve().then(() => this.render(data, lens)).catch(() => null)
      .then(value => generation === this.#generation ? value : null)
      .finally(() => { this.#active--; entry.pending = false; });
    this.#entries.delete(key); this.#entries.set(key, entry);
    for (const [oldKey, old] of this.#entries) {
      if (this.#entries.size <= 16) break;
      if (!old.pending) this.#entries.delete(oldKey);
    }
    return await entry.result;
  }

  /** Drop retained images and prevent an old asynchronous crop from repopulating them. */
  clear(): void { this.#generation++; this.#entries.clear(); }
}

/** Inspect JPEG size without decoding untrusted retained pixels in the gateway process. */
function bothJpegHeader(data: Buffer): boolean {
  if (data.length < 4 || data.readUInt16BE(0) !== 0xffd8) return false;
  let offset = 2;
  for (let markerCount = 0; markerCount < 256 && offset + 4 <= data.length; markerCount++) {
    if (data[offset++] !== 0xff) return false;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9 || offset + 2 > data.length) return false;
    const size = data.readUInt16BE(offset);
    if (size < 2 || offset + size > data.length) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return size >= 8 && data.readUInt16BE(offset + 3) === 1440 && data.readUInt16BE(offset + 5) === 1280;
    }
    offset += size;
  }
  return false;
}

/** Internal native viewer whose end releases the entire derived pair. */
class LensSourceInput extends PassThrough implements VideoViewerResponse {
  headersSent = false;

  constructor(private readonly start: (codec: VideoCodec) => void) { super(); }

  /** Accept only the manager's explicit source codec before delivering bytes. */
  writeHead(_status: number, headers: OutgoingHttpHeaders): this {
    if (this.headersSent) return this;
    this.headersSent = true;
    const content = headers["Content-Type"];
    if (content === "video/h265") this.start("h265");
    else if (content === "video/h264") this.start("h264");
    else this.destroy();
    return this;
  }
}

/**
 * Shares one native source and one decoder across both pane client groups.
 * Its unmarked manager input keeps the call while any client or HA recorder
 * uses it. Empty groups are drained, slow clients close independently, and a
 * slow decoder closes the pair rather than accumulating unbounded camera input.
 */
export class SharedLensViews {

  /** The manager registers this one unmarked native viewer to retain the physical source. */
  readonly input: VideoViewerResponse;
  readonly #clients = { fixed: new Set<VideoViewerResponse>(), movable: new Set<VideoViewerResponse>() };
  readonly #pending = new Set<VideoViewerResponse>();
  readonly #caches: Record<SharedLens, LensOutputCache>;
  #process: ChildProcess | null = null;
  #closed = false;
  #writeSequence = 0;
  readonly #pendingWrites = new Map<number, number>();
  readonly #deadline: NodeJS.Timeout;

  constructor(
    cache: () => LensOutputCache,
    private readonly createProcess: SharedLensConverterFactory,
    private readonly stopProcess: (child: ChildProcess) => void,
    private readonly onClose: (reason: SharedLensCloseReason) => void,
    private readonly admitted: () => boolean,
    startupMilliseconds = 30_000,
    private readonly nowMilliseconds: () => number = () => performance.now(),
  ) {
    this.#caches = { fixed: cache(), movable: cache() };
    this.input = new LensSourceInput(codec => this.#start(codec));
    this.input.on("data", (chunk: Buffer) => {
      const pipe = this.#process?.stdin;
      if (!this.admitted()) { this.close("admission_changed"); return; }
      if (!pipe?.writable) { this.close("converter_error"); return; }
      const now = this.nowMilliseconds(), oldest = this.#pendingWrites.values().next().value;
      if (pipe.writableLength + chunk.length > 2 * 1024 * 1024 || this.#pendingWrites.size >= 256
        || (oldest !== undefined && now - oldest > 2_000)) { this.close("input_backlog"); return; }
      const sequence = ++this.#writeSequence;
      this.#pendingWrites.set(sequence, now);
      pipe.write(chunk, () => { this.#pendingWrites.delete(sequence); });
    });
    for (const event of ["end", "close", "error"]) this.input.once(event, () => this.close("source_ended"));
    this.#deadline = setTimeout(() => this.close("startup_timeout"), startupMilliseconds);
    this.#deadline.unref();
  }

  /** Register one HTTP consumer, joining from its pane's own decoder start. */
  add(lens: SharedLens, response: VideoViewerResponse): void {
    if (this.#closed || response.destroyed || response.writableEnded) return;
    this.#clients[lens].add(response); this.#pending.add(response);
    const leave = (): void => {
      this.#clients[lens].delete(response); this.#pending.delete(response);
      response.removeListener("close", leave); response.removeListener("error", leave);
      if (!this.#clients.fixed.size && !this.#clients.movable.size) this.close();
    };
    response.once("close", leave); response.once("error", leave);
    const cache = this.#caches[lens];
    if (cache.diagnostics.randomAccessPictures > 0 && cache.startup) this.#begin(response, cache.startup);
  }

  /** Idempotently retire both outputs and the one source viewer, preserving unrelated consumers. */
  close(reason: SharedLensCloseReason = "clients_closed"): void {
    if (this.#closed) return;
    this.#closed = true; clearTimeout(this.#deadline);
    this.onClose(reason); this.input.destroy();
    const child = this.#process; this.#process = null;
    if (child) this.stopProcess(child);
    for (const lens of ["fixed", "movable"] as const) {
      for (const response of this.#clients[lens]) response.destroy();
      this.#clients[lens].clear();
    }
    this.#pending.clear(); this.#pendingWrites.clear();
  }

  #start(codec: VideoCodec): void {
    if (this.#closed || this.#process) return;
    if (!this.admitted()) { this.close("admission_changed"); return; }
    let child: ChildProcess;
    try { child = this.createProcess(codec); } catch { this.close("converter_error"); return; }
    this.#process = child;
    const fixed = child.stdout, movable = child.stdio[3];
    if (!child.stdin || !fixed || !(movable instanceof Readable)) { this.close("converter_error"); return; }
    child.stdin.on("error", () => this.close("converter_error"));
    child.stderr?.resume();
    child.once("error", () => this.close("converter_error")); child.once("close", () => this.close("converter_ended"));
    fixed.on("data", (chunk: Buffer) => this.#output("fixed", chunk));
    movable.on("data", (chunk: Buffer) => this.#output("movable", chunk));
  }

  #output(lens: SharedLens, chunk: Buffer): void {
    if (this.#closed) return;
    if (!this.admitted()) { this.close("admission_changed"); return; }
    const cache = this.#caches[lens]; cache.push(chunk, "h264");
    const startup = cache.diagnostics.randomAccessPictures > 0 ? cache.startup : null;
    if (startup && this.#caches.fixed.diagnostics.randomAccessPictures > 0
      && this.#caches.movable.diagnostics.randomAccessPictures > 0) clearTimeout(this.#deadline);
    for (const response of [...this.#clients[lens]]) {
      const pending = this.#pending.has(response);
      if (pending && !startup) continue;
      if (pending) this.#begin(response, startup!);
      if (!pending || !cache.startupIncludesLatest) this.#write(response, chunk);
    }
  }

  #begin(response: VideoViewerResponse, startup: Buffer): void {
    this.#pending.delete(response);
    response.writeHead(200, { "Content-Type": "video/h264", "Cache-Control": "no-store" });
    this.#write(response, startup);
  }

  #write(response: VideoViewerResponse, chunk: Buffer): void {
    if (response.destroyed || response.writableEnded) return;
    if (response.writableLength + chunk.length > 1024 * 1024) { response.destroy(); return; }
    response.write(chunk);
  }
}
