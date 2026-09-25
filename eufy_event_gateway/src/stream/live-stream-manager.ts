/**
 * Owns the gateway's camera-media lifecycle above a provider byte stream.
 *
 * A camera source opens only for the first viewer or capture request. This
 * manager shares that source, fans Annex-B video to HTTP viewers, feeds
 * FFmpeg for a JPEG frame or bounded MP4, retains the resulting snapshot, cancels idle
 * sources after a grace period, and enforces the maximum stream lifetime. It
 * knows media lifecycle and process management, but not Mega login or PPCS
 * packet construction.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import type { Readable } from "node:stream";

import { GatewayState } from "../domain/gateway-state.js";
import type { GatewayEvent, SnapshotInfo, VideoCodec } from "../domain/types.js";
import { SnapshotStore } from "../storage/snapshot-store.js";
import { JpegParser } from "./jpeg-parser.js";

/** Provider operations needed to open and close a camera source. */
export interface StreamController {
  startStream(serial: string): Promise<void>;
  stopStream(serial: string): Promise<void>;
}

/** Bounded timing counters for one side of a viewer conversion session. */
export interface StreamCadenceSummary {
  readonly samples: number;
  readonly durationMilliseconds: number;
  readonly maximumGapMilliseconds: number;
  readonly gapsAtLeast500Milliseconds: number;
  readonly gapsAtLeast1000Milliseconds: number;
  readonly gapsAtLeast2000Milliseconds: number;
}

/**
 * Tracks chunk timing without retaining media or wall-clock timestamps.
 *
 * One tracker belongs to one viewer transcoder invocation and is discarded
 * with that invocation. Its summary crosses only the privacy-safe logging
 * boundary used to compare camera input with converted viewer output.
 */
export class StreamCadenceTracker {
  #firstAtMilliseconds: number | null = null;
  #lastAtMilliseconds: number | null = null;
  #samples = 0;
  #maximumGapMilliseconds = 0;
  #gapsAtLeast500Milliseconds = 0;
  #gapsAtLeast1000Milliseconds = 0;
  #gapsAtLeast2000Milliseconds = 0;

  /** Record one chunk arrival using a monotonic timestamp supplied by the caller or runtime. */
  record(atMilliseconds = performance.now()): void {
    if (!Number.isFinite(atMilliseconds)) return;
    if (this.#firstAtMilliseconds === null) this.#firstAtMilliseconds = atMilliseconds;
    if (this.#lastAtMilliseconds !== null) {
      const gapMilliseconds = Math.max(0, atMilliseconds - this.#lastAtMilliseconds);
      this.#maximumGapMilliseconds = Math.max(this.#maximumGapMilliseconds, gapMilliseconds);
      if (gapMilliseconds >= 500) this.#gapsAtLeast500Milliseconds += 1;
      if (gapMilliseconds >= 1_000) this.#gapsAtLeast1000Milliseconds += 1;
      if (gapMilliseconds >= 2_000) this.#gapsAtLeast2000Milliseconds += 1;
    }
    this.#lastAtMilliseconds = atMilliseconds;
    this.#samples += 1;
  }

  /** Return integer millisecond counters suitable for one bounded log line. */
  get summary(): StreamCadenceSummary {
    const durationMilliseconds = this.#firstAtMilliseconds === null || this.#lastAtMilliseconds === null
      ? 0
      : this.#lastAtMilliseconds - this.#firstAtMilliseconds;
    return {
      samples: this.#samples,
      durationMilliseconds: Math.round(durationMilliseconds),
      maximumGapMilliseconds: Math.round(this.#maximumGapMilliseconds),
      gapsAtLeast500Milliseconds: this.#gapsAtLeast500Milliseconds,
      gapsAtLeast1000Milliseconds: this.#gapsAtLeast1000Milliseconds,
      gapsAtLeast2000Milliseconds: this.#gapsAtLeast2000Milliseconds,
    };
  }
}

/** Privacy-safe outcome for one H.265-to-H.264 viewer conversion. */
export interface ViewerTranscoderSummary {
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly outputChunks: number;
  readonly bootstrapReady: boolean;
  readonly inputCadence: StreamCadenceSummary;
  readonly outputCadence: StreamCadenceSummary;
  readonly clientBackpressureEvents: number;
  readonly maximumClientWritableBytes: number;
}

interface Session {
  readonly clients: Set<ServerResponse>;
  readonly pendingClients: Set<ServerResponse>;
  readonly recordings: Set<Recording>;
  parameterSets: VideoParameterSetCache;
  state: "idle" | "starting" | "streaming" | "stopping" | "error";
  source: Readable | null;
  ffmpeg: ChildProcessWithoutNullStreams | null;
  viewerFfmpeg: ChildProcessWithoutNullStreams | null;
  viewerParameterSets: VideoParameterSetCache;
  viewerInputBytes: number;
  viewerOutputBytes: number;
  viewerOutputChunks: number;
  viewerInputCadence: StreamCadenceTracker;
  viewerOutputCadence: StreamCadenceTracker;
  viewerClientBackpressureEvents: number;
  viewerMaximumClientWritableBytes: number;
  stopTimer: NodeJS.Timeout | null;
  owned: boolean;
  leases: number;
  generation: number;
}

interface Recording {
  readonly chunks: Buffer[];
  readonly durationMilliseconds: number;
  size: number;
  started: boolean;
  startTimer: NodeJS.Timeout;
  durationTimer: NodeJS.Timeout | null;
  resolve: (data: Buffer) => void;
  reject: (error: Error) => void;
}

type ClipRemuxer = (video: Buffer, codec: VideoCodec) => Promise<Buffer>;
type ViewerTranscoderFactory = () => ChildProcessWithoutNullStreams;
type SnapshotExtractorFactory = (codec: VideoCodec) => ChildProcessWithoutNullStreams;

const MAX_RECORDING_BYTES = 256 * 1024 * 1024;
const MAX_PARAMETER_SET_SCAN_BYTES = 1024 * 1024;

/** Time allowed for peer lookup and a decodable fresh frame on slower cameras. */
export const SNAPSHOT_CAPTURE_TIMEOUT_MILLISECONDS = 30_000;

/**
 * Retains the latest complete H.264 or H.265 parameter sets from an Annex-B stream.
 *
 * Input chunks may divide NAL units arbitrarily. H.264 waits for SPS and PPS.
 * Some existing Eufy H.265 streams announce only VPS as a standard parameter
 * set, so their bounded opening bytes are retained for FFmpeg to probe. Camera
 * content is held only in memory and is never exposed in logs.
 */
export class VideoParameterSetCache {
  #pending = Buffer.alloc(0);
  #codec: VideoCodec | null = null;
  #opening = Buffer.alloc(0);
  #vps: Buffer | null = null;
  #sps: Buffer | null = null;
  #pps: Buffer | null = null;

  /** Return the codec identified by complete parameter-set NAL units. */
  get codec(): VideoCodec | null {
    return this.#codec;
  }

  /** Return bounded opening bytes for the first viewer once the codec is known. */
  get startup(): Buffer | null {
    if (this.#codec === "h264") {
      const bootstrap = this.bootstrap;
      const randomAccessOffset = annexBNalOffset(this.#opening, (header) => (header & 0x1f) === 5);
      return bootstrap && randomAccessOffset !== null
        ? Buffer.concat([bootstrap, this.#opening.subarray(randomAccessOffset)])
        : null;
    }
    return this.#codec && this.#opening.length > 0 ? this.#opening : this.bootstrap;
  }

  /** Return codec headers in decoder order once every required set is known. */
  get bootstrap(): Buffer | null {
    if (this.#codec === "h265") {
      return this.#vps && this.#sps && this.#pps
        ? Buffer.concat([this.#vps, this.#sps, this.#pps])
        : this.#vps && this.#opening.length > 0 ? this.#opening : null;
    }
    return this.#codec === "h264" && this.#sps && this.#pps
      ? Buffer.concat([this.#sps, this.#pps])
      : null;
  }

  /** Inspect ordered bytes using provider metadata when it identifies the codec. */
  push(chunk: Buffer, declaredCodec?: VideoCodec | null): void {
    if (declaredCodec && this.#codec === null) this.#codec = declaredCodec;
    if (this.startup === null) {
      const opening = Buffer.concat([this.#opening, chunk]);
      this.#opening = opening.length <= MAX_PARAMETER_SET_SCAN_BYTES
        ? opening
        : Buffer.from(opening.subarray(opening.length - MAX_PARAMETER_SET_SCAN_BYTES));
    }
    const data = this.#pending.length > 0 ? Buffer.concat([this.#pending, chunk]) : chunk;
    const starts = annexBStarts(data);
    if (starts.length < 2) {
      this.#pending = data.length <= MAX_PARAMETER_SET_SCAN_BYTES
        ? Buffer.from(data)
        : Buffer.from(data.subarray(data.length - 3));
      return;
    }
    for (let index = 0; index < starts.length - 1; index++) {
      const current = starts[index]!;
      const next = starts[index + 1]!;
      const header = data[current.payloadOffset]!;
      const h264Type = header & 0x1f;
      const h265Type = (header >> 1) & 0x3f;
      const nal = Buffer.from(data.subarray(current.offset, next.offset));
      if (this.#codec === "h264" && (h264Type === 7 || h264Type === 8)) {
        if (h264Type === 7) this.#sps = nal;
        else this.#pps = nal;
      } else if (this.#codec === "h265" && (h265Type === 32 || h265Type === 33 || h265Type === 34)) {
        if (h265Type === 32) this.#vps = nal;
        else if (h265Type === 33) this.#sps = nal;
        else this.#pps = nal;
      } else if (this.#codec === null && (header & 0x01) === 0 && (h265Type === 32 || h265Type === 33 || h265Type === 34)) {
        this.#codec = "h265";
        this.#vps = h265Type === 32 ? nal : null;
        this.#sps = h265Type === 33 ? nal : null;
        this.#pps = h265Type === 34 ? nal : null;
      } else if (this.#codec === null && (h264Type === 7 || h264Type === 8)) {
        if (h264Type === 7) this.#sps = nal;
        else this.#pps = nal;
        if (this.#sps && this.#pps) this.#codec = "h264";
      }
    }
    this.#pending = Buffer.from(data.subarray(starts.at(-1)!.offset));
  }
}

function annexBNalOffset(data: Buffer, matches: (header: number) => boolean): number | null {
  for (const start of annexBStarts(data)) {
    if (matches(data[start.payloadOffset]!)) return start.offset;
  }
  return null;
}

function annexBStarts(data: Buffer): Array<{ offset: number; payloadOffset: number }> {
  const starts: Array<{ offset: number; payloadOffset: number }> = [];
  for (let offset = 0; offset + 3 < data.length;) {
    if (data[offset] !== 0 || data[offset + 1] !== 0) {
      offset++;
      continue;
    }
    const length = data[offset + 2] === 1 ? 3 : data[offset + 2] === 0 && data[offset + 3] === 1 ? 4 : 0;
    if (length === 0) {
      offset++;
      continue;
    }
    starts.push({ offset, payloadOffset: offset + length });
    offset += length;
  }
  return starts;
}

/**
 * Coordinates one shared source per camera.
 *
 * HTTP viewers receive H.264 directly or share one H.265-to-H.264 transcoder,
 * while a separate FFmpeg process receives the source for retained JPEG
 * snapshots. MP4 clips retain the original camera codec. Ownership counts
 * avoid duplicate camera sessions, and the idle grace period prevents
 * refreshes from repeatedly opening and closing a camera.
 */
export class LiveStreamManager extends EventEmitter {
  readonly #sessions = new Map<string, Session>();
  #closed = false;

  /** Create a manager with state, image storage, provider, and idle grace. */
  constructor(
    private readonly state: GatewayState,
    private readonly snapshots: SnapshotStore,
    private readonly controller: StreamController,
    private readonly stopGraceMilliseconds: number,
    private readonly remuxClip: ClipRemuxer = remuxVideoToMp4,
    private readonly createViewerTranscoder: ViewerTranscoderFactory = spawnH265ViewerTranscoder,
    private readonly createSnapshotExtractor: SnapshotExtractorFactory = spawnSnapshotExtractor,
  ) {
    super();
  }

  /** Attach an HTTP viewer, starting the shared provider source if needed. */
  async addClient(serial: string, response: ServerResponse): Promise<void> {
    const session = this.#session(serial);
    this.#cancelStop(session);
    session.clients.add(response);
    const sourceBootstrap = session.parameterSets.bootstrap;
    const sourceCodec = session.parameterSets.codec;
    const viewerBootstrap = sourceCodec === "h265"
      ? session.viewerParameterSets.bootstrap
      : sourceBootstrap;
    const viewerCodec = sourceCodec === "h265" ? "h264" : sourceCodec;

    // Headers retained from a stopped source belong to its old encoding session.
    // Wait for the replacement source instead of sending two HTTP header blocks.
    if (session.source && session.state === "streaming" && viewerBootstrap && viewerCodec) {
      this.#startClient(response, viewerCodec, viewerBootstrap);
    } else {
      session.pendingClients.add(response);
      if (sourceCodec === "h265" && sourceBootstrap && !session.viewerFfmpeg) {
        this.#startViewerTranscoder(serial, session, session.parameterSets.startup ?? sourceBootstrap);
      }
    }
    this.#updateState(serial, session);

    response.on("close", () => this.#removeClient(serial, response));
    response.once("error", (error) => {
      this.emit("warning", error);
      this.#removeClient(serial, response);
    });

    // Start the provider only after the HTTP client is registered so the first
    // video bytes can be fanned out to Home Assistant immediately.
    try {
      await this.#ensureStarted(serial, session);
    } catch (error) {
      response.destroy(error instanceof Error ? error : undefined);
    }
  }

  /** Capture one fresh JPEG through the shared source and return its metadata. */
  async captureSnapshot(
    serial: string,
    timeoutMilliseconds = SNAPSHOT_CAPTURE_TIMEOUT_MILLISECONDS,
  ): Promise<SnapshotInfo> {
    if (this.#closed) throw new Error("Gateway closed before snapshot capture started");
    const session = this.#session(serial);
    const previousRevision = this.state.getCamera(serial).snapshot?.revision ?? 0;
    this.#cancelStop(session);
    session.leases += 1;
    this.#updateState(serial, session);
    const nextSnapshot = this.#waitForSnapshot(serial, previousRevision, timeoutMilliseconds);

    // PPCS startup can outlast the frame timer. Handle an early timeout now,
    // while still propagating it when startup settles and capture awaits it.
    void nextSnapshot.promise.catch(() => undefined);
    try {
      await this.#ensureStarted(serial, session);
      return await nextSnapshot.promise;
    } finally {
      nextSnapshot.cancel();
      session.leases -= 1;
      this.#scheduleStopIfUnused(serial, session);
    }
  }

  /** Capture one startup image and release its unused source immediately. */
  async captureStartupSnapshot(
    serial: string,
    timeoutMilliseconds = SNAPSHOT_CAPTURE_TIMEOUT_MILLISECONDS,
  ): Promise<SnapshotInfo> {
    try {
      return await this.captureSnapshot(serial, timeoutMilliseconds);
    } finally {
      await this.#stopNowIfUnused(serial, this.#session(serial));
    }
  }

  /** Record a bounded H.264 segment and package it as fragmented MP4. */
  async recordClip(
    serial: string,
    durationSeconds: number,
    startTimeoutMilliseconds = 20_000,
  ): Promise<Buffer> {
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 120) {
      throw new Error("Recording duration must be between 1 and 120 seconds");
    }
    const session = this.#session(serial);
    this.#cancelStop(session);
    session.leases += 1;
    this.#updateState(serial, session);
    const recording = this.#collectRecording(
      session,
      durationSeconds * 1_000,
      startTimeoutMilliseconds,
    );

    // Video can time out before PPCS startup returns; keep that rejection
    // handled until the recording operation awaits it.
    void recording.promise.catch(() => undefined);
    try {
      await this.#ensureStarted(serial, session);
      return await this.remuxClip(
        await recording.promise,
        session.parameterSets.codec ?? "h264",
      );
    } finally {
      recording.cancel();
      session.leases -= 1;
      this.#scheduleStopIfUnused(serial, session);
    }
  }

  /** Attach provider bytes and its live codec marker to all current consumers. */
  attachSource(serial: string, source: Readable, codecHint: () => VideoCodec | null = () => null): void {
    const session = this.#session(serial);
    this.#cleanupSource(session);
    const generation = session.generation;
    session.source = source;
    session.state = "streaming";
    session.parameterSets = new VideoParameterSetCache();
    session.viewerParameterSets = new VideoParameterSetCache();
    for (const client of session.clients) session.pendingClients.add(client);
    session.ffmpeg = null;
    session.viewerFfmpeg = null;
    session.viewerInputBytes = 0;
    session.viewerOutputBytes = 0;
    session.viewerOutputChunks = 0;
    session.viewerInputCadence = new StreamCadenceTracker();
    session.viewerOutputCadence = new StreamCadenceTracker();
    session.viewerClientBackpressureEvents = 0;
    session.viewerMaximumClientWritableBytes = 0;

    source.on("data", (chunk: Buffer) => {
      if (session.generation !== generation) return;
      session.parameterSets.push(chunk, codecHint());
      const bootstrap = session.parameterSets.bootstrap;
      const startup = session.parameterSets.startup;
      const codec = session.parameterSets.codec;
      if (bootstrap && startup && codec) {
        let snapshotStarted = false;
        if (!session.ffmpeg) {
          session.ffmpeg = this.#startSnapshotExtractor(serial, codec);
          snapshotStarted = true;
          if (session.ffmpeg.stdin.writable) session.ffmpeg.stdin.write(startup);
        }
        if (codec === "h265") {
          let started = false;
          if (session.clients.size > 0 && !session.viewerFfmpeg) {
            this.#startViewerTranscoder(serial, session, startup);
            started = true;
          }
          if (!started) this.#writeViewerTranscoderInput(session, chunk);
        } else {
          let started = false;
          for (const client of session.pendingClients) {
            if (session.clients.has(client)) {
              this.#startClient(client, codec, startup);
              started = true;
            }
          }
          session.pendingClients.clear();
          if (!started) this.#writeViewerChunk(session, chunk);
        }
        if (!snapshotStarted && session.ffmpeg?.stdin.writable) session.ffmpeg.stdin.write(chunk);
      }
      for (const recording of session.recordings) this.#appendRecordingChunk(session, recording, chunk);
    });
    source.once("error", (error) => this.#sourceEnded(serial, generation, error));
    source.once("end", () => this.#sourceEnded(serial, generation));
    source.once("close", () => this.#sourceEnded(serial, generation));
    this.#updateState(serial, session);
  }

  /** Mark a provider source as stopped and fail pending consumers cleanly. */
  markStopped(serial: string): void {
    const session = this.#session(serial);
    this.#cancelStop(session);
    this.#failRecordings(session, new Error("Camera video stopped before the recording completed"));
    this.#cleanupSource(session);
    session.state = "idle";
    session.owned = false;
    for (const client of session.clients) client.end();
    session.clients.clear();
    session.pendingClients.clear();
    this.#updateState(serial, session);
  }

  /** Stop every source and release FFmpeg processes during shutdown. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("closed");
    await Promise.all(
      [...this.#sessions.entries()].map(async ([serial, session]) => {
        if (session.stopTimer) clearTimeout(session.stopTimer);
        this.#cleanupSource(session);
        this.#failRecordings(session, new Error("Gateway closed while recording a clip"));
        for (const client of session.clients) client.end();
        session.pendingClients.clear();
        if (session.owned) await this.controller.stopStream(serial).catch(() => undefined);
      }),
    );
  }

  #removeClient(serial: string, response: ServerResponse): void {
    const session = this.#session(serial);
    session.clients.delete(response);
    session.pendingClients.delete(response);
    if (session.clients.size === 0) this.#stopViewerTranscoder(session);
    this.#updateState(serial, session);
    this.#scheduleStopIfUnused(serial, session);
  }

  #scheduleStopIfUnused(serial: string, session: Session): void {
    if (this.#closed) return;
    if (session.clients.size === 0 && session.leases === 0 && session.owned && !session.stopTimer) {
      session.stopTimer = setTimeout(() => {
        session.stopTimer = null;
        void this.#stopOwnedSource(serial, session);
      }, this.stopGraceMilliseconds);
    }
  }

  async #stopNowIfUnused(serial: string, session: Session): Promise<void> {
    if (session.clients.size > 0 || session.leases > 0 || !session.owned) return;
    this.#cancelStop(session);
    await this.#stopOwnedSource(serial, session);
  }

  async #stopOwnedSource(serial: string, session: Session): Promise<void> {
    session.state = "stopping";
    this.#updateState(serial, session);
    try {
      await this.controller.stopStream(serial);
      if (session.state === "stopping") {
        this.#cleanupSource(session);
        session.state = "idle";
        session.owned = false;
        this.#updateState(serial, session);
      }
    } catch (error) {
      session.state = "error";
      this.#updateState(serial, session, errorMessage(error));
    }
  }

  #cancelStop(session: Session): void {
    if (!session.stopTimer) return;
    clearTimeout(session.stopTimer);
    session.stopTimer = null;
  }

  async #ensureStarted(serial: string, session: Session): Promise<void> {
    if (this.#closed) throw new Error("Gateway closed before camera stream started");
    if (session.state !== "idle" && session.state !== "error") return;
    session.state = "starting";
    session.owned = true;
    this.#updateState(serial, session);
    try {
      await this.controller.startStream(serial);
    } catch (error) {
      session.state = "error";
      session.owned = false;
      this.#updateState(serial, session, errorMessage(error));
      throw error;
    }
  }

  #waitForSnapshot(
    serial: string,
    previousRevision: number,
    timeoutMilliseconds: number,
  ): { promise: Promise<SnapshotInfo>; cancel: () => void } {
    let cleanup = () => undefined;
    const promise = new Promise<SnapshotInfo>((resolve, reject) => {
      const listener = (event: GatewayEvent) => {
        if (
          event.type === "snapshot-updated" &&
          event.cameraSerial === serial &&
          event.snapshot.source === "live" &&
          event.snapshot.revision > previousRevision
        ) {
          cleanup();
          resolve(event.snapshot);
        }
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for a fresh camera frame"));
      }, timeoutMilliseconds);
      const closed = () => {
        cleanup();
        reject(new Error("Gateway closed while waiting for a fresh camera frame"));
      };
      cleanup = () => {
        clearTimeout(timeout);
        this.state.off("event", listener);
        this.off("closed", closed);
      };
      this.state.on("event", listener);
      this.once("closed", closed);
    });
    return { promise, cancel: cleanup };
  }

  #collectRecording(
    session: Session,
    durationMilliseconds: number,
    startTimeoutMilliseconds: number,
  ): { promise: Promise<Buffer>; cancel: () => void } {
    let recording!: Recording;
    const promise = new Promise<Buffer>((resolve, reject) => {
      recording = {
        chunks: [],
        durationMilliseconds,
        size: 0,
        started: false,
        startTimer: setTimeout(() => {
          this.#settleRecording(session, recording, new Error("Timed out waiting for camera video"));
        }, startTimeoutMilliseconds),
        durationTimer: null,
        resolve,
        reject,
      };
      session.recordings.add(recording);
    });
    return {
      promise,
      cancel: () => this.#cancelRecording(session, recording!),
    };
  }

  #appendRecordingChunk(session: Session, recording: Recording, chunk: Buffer): void {
    if (!recording.started) {
      recording.started = true;
      clearTimeout(recording.startTimer);
      recording.durationTimer = setTimeout(
        () => this.#settleRecording(session, recording),
        recording.durationMilliseconds,
      );
    }
    recording.chunks.push(Buffer.from(chunk));
    recording.size += chunk.length;
    if (recording.size > MAX_RECORDING_BYTES) {
      this.#settleRecording(session, recording, new Error("Recording exceeded the 256 MB safety limit"));
    }
  }

  #settleRecording(session: Session, recording: Recording, error?: Error): void {
    if (!session.recordings.delete(recording)) return;
    clearTimeout(recording.startTimer);
    if (recording.durationTimer) clearTimeout(recording.durationTimer);
    if (error) recording.reject(error);
    else recording.resolve(Buffer.concat(recording.chunks, recording.size));
  }

  #cancelRecording(session: Session, recording: Recording): void {
    if (!session.recordings.delete(recording)) return;
    clearTimeout(recording.startTimer);
    if (recording.durationTimer) clearTimeout(recording.durationTimer);
  }

  #failRecordings(session: Session, error: Error): void {
    for (const recording of [...session.recordings]) this.#settleRecording(session, recording, error);
  }

  #sourceEnded(serial: string, generation: number, error?: Error): void {
    const session = this.#session(serial);
    if (session.generation !== generation) return;
    if (session.state === "idle") return;
    this.#cancelStop(session);
    this.#failRecordings(session, error ?? new Error("Camera video ended before the recording completed"));
    this.#cleanupSource(session);
    session.state = error ? "error" : "idle";
    session.owned = false;
    for (const client of session.clients) client.end();
    session.clients.clear();
    session.pendingClients.clear();
    this.#updateState(serial, session, error?.message ?? null);
  }

  #startClient(response: ServerResponse, codec: VideoCodec, bootstrap: Buffer): void {
    if (!response.headersSent) {
      response.writeHead(200, {
        "Content-Type": codec === "h265" ? "video/h265" : "video/h264",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
    }
    response.write(bootstrap);
  }

  #writeViewerChunk(session: Session, chunk: Buffer): void {
    for (const client of session.clients) {
      if (session.pendingClients.has(client)) continue;
      const accepted = client.write(chunk);
      if (!accepted) session.viewerClientBackpressureEvents += 1;
      session.viewerMaximumClientWritableBytes = Math.max(
        session.viewerMaximumClientWritableBytes,
        client.writableLength,
      );
      if (client.writableLength > 4 * 1024 * 1024) {
        client.destroy(new Error("Live stream client exceeded the four-megabyte backpressure limit"));
      }
    }
  }

  #startViewerTranscoder(serial: string, session: Session, startup: Buffer): void {
    const generation = session.generation;
    const process = this.createViewerTranscoder();
    session.viewerFfmpeg = process;
    session.viewerParameterSets = new VideoParameterSetCache();
    session.viewerInputBytes = 0;
    session.viewerOutputBytes = 0;
    session.viewerOutputChunks = 0;
    session.viewerInputCadence = new StreamCadenceTracker();
    session.viewerOutputCadence = new StreamCadenceTracker();
    session.viewerClientBackpressureEvents = 0;
    session.viewerMaximumClientWritableBytes = 0;
    process.stdout.on("data", (chunk: Buffer) => {
      if (session.generation !== generation || session.viewerFfmpeg !== process) return;
      session.viewerOutputBytes += chunk.length;
      session.viewerOutputChunks += 1;
      session.viewerOutputCadence.record();
      session.viewerParameterSets.push(chunk, "h264");
      const bootstrap = session.viewerParameterSets.bootstrap;
      if (bootstrap) {
        for (const client of session.pendingClients) {
          if (session.clients.has(client)) this.#startClient(client, "h264", bootstrap);
        }
        session.pendingClients.clear();
      }
      this.#writeViewerChunk(session, chunk);
    });
    process.stderr.on("data", (chunk: Buffer) => {
      this.emit("ffmpeg-error", `pipeline=viewer ${chunk.toString("utf8").trim()}`);
    });
    process.stdin.on("error", (error) => {
      if (session.generation === generation) this.emit("warning", error);
    });
    process.once("error", (error) => {
      if (session.generation !== generation || session.viewerFfmpeg !== process) return;
      session.viewerFfmpeg = null;
      for (const client of session.clients) client.destroy(error);
      session.clients.clear();
      session.pendingClients.clear();
      this.#updateState(serial, session, error.message);
    });
    process.once("close", (code) => {
      if (session.generation !== generation || session.viewerFfmpeg !== process) return;
      this.#emitViewerTranscoderSummary(session);
      session.viewerFfmpeg = null;
      const error = new Error(`H.265 viewer fallback exited with status ${code ?? "unknown"}`);
      for (const client of session.clients) client.destroy(error);
      session.clients.clear();
      session.pendingClients.clear();
      this.#updateState(serial, session, error.message);
    });
    this.#writeViewerTranscoderInput(session, startup);
  }

  #writeViewerTranscoderInput(session: Session, chunk: Buffer): void {
    if (!session.viewerFfmpeg?.stdin.writable) return;
    session.viewerInputBytes += chunk.length;
    session.viewerInputCadence.record();
    session.viewerFfmpeg.stdin.write(chunk);
  }

  #emitViewerTranscoderSummary(session: Session): void {
    const summary: ViewerTranscoderSummary = {
      inputBytes: session.viewerInputBytes,
      outputBytes: session.viewerOutputBytes,
      outputChunks: session.viewerOutputChunks,
      bootstrapReady: session.viewerParameterSets.bootstrap !== null,
      inputCadence: session.viewerInputCadence.summary,
      outputCadence: session.viewerOutputCadence.summary,
      clientBackpressureEvents: session.viewerClientBackpressureEvents,
      maximumClientWritableBytes: session.viewerMaximumClientWritableBytes,
    };
    this.emit("viewer-transcoder-stopped", summary);
  }

  #startSnapshotExtractor(serial: string, codec: VideoCodec): ChildProcessWithoutNullStreams {
    const process = this.createSnapshotExtractor(codec);
    const parser = new JpegParser();
    process.stdout.on("data", (chunk: Buffer) => {
      for (const image of parser.push(chunk)) {
        void this.snapshots.write(serial, image, "image/jpeg", "live").then((info) => {
          this.state.updateSnapshot(serial, info);
        }).catch((error: unknown) => this.emit("warning", error));
      }
    });
    process.stderr.on("data", (chunk: Buffer) => {
      this.emit("ffmpeg-error", `pipeline=snapshot ${chunk.toString("utf8").trim()}`);
    });
    process.stdin.on("error", (error) => this.emit("warning", error));
    process.once("error", (error) => this.emit("warning", error));
    return process;
  }

  #cleanupSource(session: Session): void {
    session.generation += 1;
    session.source?.removeAllListeners();
    session.source = null;
    if (session.ffmpeg) {
      session.ffmpeg.stdin.end();
      session.ffmpeg.kill("SIGTERM");
      session.ffmpeg = null;
    }
    this.#stopViewerTranscoder(session);
  }

  #stopViewerTranscoder(session: Session): void {
    if (session.viewerFfmpeg) {
      this.#emitViewerTranscoderSummary(session);
      session.viewerFfmpeg.stdin.end();
      session.viewerFfmpeg.kill("SIGTERM");
      session.viewerFfmpeg = null;
    }
    session.viewerParameterSets = new VideoParameterSetCache();
  }

  #session(serial: string): Session {
    let session = this.#sessions.get(serial);
    if (!session) {
      session = {
        clients: new Set(),
        pendingClients: new Set(),
        recordings: new Set(),
        parameterSets: new VideoParameterSetCache(),
        state: "idle",
        source: null,
        ffmpeg: null,
        viewerFfmpeg: null,
        viewerParameterSets: new VideoParameterSetCache(),
        viewerInputBytes: 0,
        viewerOutputBytes: 0,
        viewerOutputChunks: 0,
        viewerInputCadence: new StreamCadenceTracker(),
        viewerOutputCadence: new StreamCadenceTracker(),
        viewerClientBackpressureEvents: 0,
        viewerMaximumClientWritableBytes: 0,
        stopTimer: null,
        owned: false,
        leases: 0,
        generation: 0,
      };
      this.#sessions.set(serial, session);
    }
    return session;
  }

  #updateState(serial: string, session: Session, error: string | null = null): void {
    this.state.updateStream(serial, session.state, session.clients.size, error);
  }
}

/** Start the shared low-latency fallback used only when a camera returns H.265. */
function spawnH265ViewerTranscoder(): ChildProcessWithoutNullStreams {
  return spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "hevc",
    "-i",
    "pipe:0",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-x264-params",
    "repeat-headers=1",
    "-f",
    "h264",
    "pipe:1",
  ]);
}

/** Start the JPEG extractor that retains a fresh image from the shared camera source. */
function spawnSnapshotExtractor(codec: VideoCodec): ChildProcessWithoutNullStreams {
  return spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    codec === "h265" ? "hevc" : "h264",
    "-i",
    "pipe:0",
    "-vf",
    "fps=1/2",
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "pipe:1",
  ]);
}

/** Remux Annex-B H.264 or H.265 into fragmented MP4 without re-encoding. */
export async function remuxVideoToMp4(video: Buffer, codec: VideoCodec): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const process = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-fflags",
      "+genpts",
      "-f",
      codec === "h265" ? "hevc" : "h264",
      "-i",
      "pipe:0",
      "-c:v",
      "copy",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-f",
      "mp4",
      "pipe:1",
    ]);
    const output: Buffer[] = [];
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      process.kill("SIGKILL");
      reject(new Error("Timed out while packaging the camera recording"));
    }, 30_000);
    process.stdout.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
    process.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_192) stderr += chunk.toString("utf8");
    });
    process.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    process.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const data = Buffer.concat(output);
      if (code === 0 && data.length > 0) resolve(data);
      else reject(new Error(stderr.trim() || `FFmpeg exited with status ${code ?? "unknown"}`));
    });
    process.stdin.end(video);
  });
}

/** Preserve the public H.264 remux helper used by existing callers and tests. */
export async function remuxH264ToMp4(h264: Buffer): Promise<Buffer> {
  return await remuxVideoToMp4(h264, "h264");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown stream error";
}
