/**
 * Serves one S4 lens on its own native NVR call, for one optional pane camera,
 * or one NVR's stitched multi-view the same way, for its multi-view camera.
 * The provider owns the call and its admission. Each instance owns that call's
 * output, its HTTP clients and the idle grace, and hangs the call up when its
 * last client has gone. The other lens and the multi-view have their own
 * instances and calls, so closing one never touches another. No transcoder or
 * camera setting is involved.
 */
import type { Readable } from "node:stream";
import type { VideoCodec } from "../domain/types.js";
import type { VideoViewerResponse } from "./live-transport-muxer.js";
import type { SharedLens } from "./shared-lens-views.js";

/** What one native view shows: an S4 lens for a pane, or an NVR's multi-view. */
export type NativeView = SharedLens | "multiview";

/** One provider-owned native call for one lens or a multi-view. Closing it hangs up the call. */
export interface NvrLensCall {

  /** The call's own H.265 (or H.264) Annex B video, ended when the call ends. */
  readonly output: Readable;

  /** The codec the session has checked from the video, once it has. */
  readonly codec: () => VideoCodec | null;

  /** Idempotent: stop the stream, hang up, and release the provider's reservation. */
  close(): Promise<void>;
}

/** Manager-supplied decoder start for new viewers, fed only by this view's call. */
export interface NativeLensCache {
  push(chunk: Buffer, hint: VideoCodec): void;
  readonly codec: VideoCodec | null;
  readonly startup: Buffer | null;
  readonly startupIncludesLatest: boolean;
  readonly diagnostics: { readonly randomAccessPictures: number };
}

/** Content-free reasons a native view ended, for the gateway log. */
export type NativeLensCloseReason = "clients_closed" | "source_ended" | "start_failed" | "admission_changed" | "gateway_closed";

/** Largest unsent response queue before one slow viewer is closed on its own. */
const MAX_CLIENT_QUEUE_BYTES = 4 * 1024 * 1024;

/**
 * One native call shared by every viewer of that pane or multi-view camera.
 * Viewers join from the current keyframe. A slow viewer closes alone. The call
 * stays up through the gateway's normal idle grace, so Home Assistant's URL
 * renewals do not hang it up and call again, and then closes. The call ending
 * by itself closes every viewer, so Home Assistant retries with a fresh call.
 */
export class NativeLensView {
  readonly #clients = new Set<VideoViewerResponse>();
  readonly #pending = new Set<VideoViewerResponse>();
  #call: NvrLensCall | null = null;
  #closed = false;
  #idle: NodeJS.Timeout | null = null;
  readonly #ready: Promise<void>;

  constructor(
    readonly lens: NativeView,
    open: () => Promise<NvrLensCall>,
    private readonly cache: NativeLensCache,
    private readonly graceMilliseconds: number,
    private readonly admitted: () => boolean,
    private readonly onClose: (reason: NativeLensCloseReason) => void,
  ) {
    this.#ready = open().then(call => {
      if (this.#closed) { void call.close().catch(() => {}); return; }
      this.#call = call;
      call.output.on("data", (chunk: Buffer) => this.#output(chunk));
      for (const event of ["end", "close", "error"]) call.output.once(event, () => this.close("source_ended"));
      if (!this.#clients.size) this.#scheduleIdle();
    }, error => { this.close("start_failed", error); throw error; });

    // Viewers that have already left must not turn a failed start into an unhandled rejection.
    this.#ready.catch(() => {});
  }

  /** True once this view has ended; the manager then makes a fresh one. */
  get closed(): boolean { return this.#closed; }

  /** Register one HTTP viewer. Rejects when the call could not be opened. */
  async add(response: VideoViewerResponse): Promise<void> {
    if (this.#closed || response.destroyed || response.writableEnded) return;
    this.#cancelIdle();
    this.#clients.add(response); this.#pending.add(response);
    const leave = (): void => {
      this.#clients.delete(response); this.#pending.delete(response);
      response.removeListener("close", leave); response.removeListener("error", leave);
      if (!this.#clients.size) this.#scheduleIdle();
    };
    response.once("close", leave); response.once("error", leave);
    const startup = this.cache.diagnostics.randomAccessPictures > 0 ? this.cache.startup : null;
    if (startup) this.#begin(response, startup);
    await this.#ready;
  }

  /** Idempotently end every viewer and hang up the call. */
  close(reason: NativeLensCloseReason = "clients_closed", error?: unknown): void {
    if (this.#closed) return;
    this.#closed = true; this.#cancelIdle();
    for (const response of this.#clients) response.destroy(error instanceof Error ? error : undefined);
    this.#clients.clear(); this.#pending.clear();
    const call = this.#call; this.#call = null;

    // Failed starts were already released by the provider; there is no call to close.
    if (call) void call.close().catch(() => {});
    try { this.onClose(reason); } catch {}
  }

  #output(chunk: Buffer): void {
    if (this.#closed) return;
    if (!this.admitted()) { this.close("admission_changed"); return; }
    this.cache.push(chunk, this.#call?.codec() ?? "h265");
    const startup = this.cache.diagnostics.randomAccessPictures > 0 ? this.cache.startup : null;
    for (const response of [...this.#clients]) {
      const pending = this.#pending.has(response);
      if (pending && !startup) continue;
      if (pending) this.#begin(response, startup!);
      if (!pending || !this.cache.startupIncludesLatest) this.#write(response, chunk);
    }
  }

  #begin(response: VideoViewerResponse, startup: Buffer): void {
    this.#pending.delete(response);
    response.writeHead(200, { "Content-Type": this.cache.codec === "h264" ? "video/h264" : "video/h265",
      "Cache-Control": "no-store", Connection: "keep-alive" });
    this.#write(response, startup);
  }

  #write(response: VideoViewerResponse, chunk: Buffer): void {
    if (response.destroyed || response.writableEnded) return;
    if (response.writableLength + chunk.length > MAX_CLIENT_QUEUE_BYTES) { response.destroy(); return; }
    response.write(chunk);
  }

  #scheduleIdle(): void {
    if (this.#closed || this.#idle) return;
    this.#idle = setTimeout(() => { this.#idle = null; if (!this.#clients.size) this.close("clients_closed"); }, this.graceMilliseconds);
    this.#idle.unref();
  }

  #cancelIdle(): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
  }
}
