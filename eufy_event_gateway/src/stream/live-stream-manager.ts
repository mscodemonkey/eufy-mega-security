/**
 * Owns the gateway's camera-media lifecycle above a provider byte stream.
 *
 * A camera source opens only for the first viewer or capture request. This
 * manager shares that source, fans H.264 to HTTP viewers, feeds FFmpeg for a
 * JPEG frame or bounded MP4, retains the resulting snapshot, cancels idle
 * sources after a grace period, and enforces the maximum stream lifetime. It
 * knows media lifecycle and process management, but not Mega login or PPCS
 * packet construction.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import type { Readable } from "node:stream";

import { GatewayState } from "../domain/gateway-state.js";
import type { GatewayEvent, SnapshotInfo } from "../domain/types.js";
import { SnapshotStore } from "../storage/snapshot-store.js";
import { JpegParser } from "./jpeg-parser.js";

/** Provider operations needed to open and close a camera source. */
export interface StreamController {
  startStream(serial: string): Promise<void>;
  stopStream(serial: string): Promise<void>;
}

interface Session {
  readonly clients: Set<ServerResponse>;
  readonly pendingClients: Set<ServerResponse>;
  readonly recordings: Set<Recording>;
  parameterSets: VideoParameterSetCache;
  state: "idle" | "starting" | "streaming" | "stopping" | "error";
  source: Readable | null;
  ffmpeg: ChildProcessWithoutNullStreams | null;
  stopTimer: NodeJS.Timeout | null;
  owned: boolean;
  leases: number;
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

type VideoCodec = "h264" | "h265";
type ClipRemuxer = (video: Buffer, codec: VideoCodec) => Promise<Buffer>;

const MAX_RECORDING_BYTES = 256 * 1024 * 1024;
const MAX_PARAMETER_SET_SCAN_BYTES = 1024 * 1024;

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

  /** Inspect the next ordered stream bytes and retain complete parameter-set NAL units. */
  push(chunk: Buffer): void {
    if (this.#codec === null) {
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
 * HTTP viewers receive the source directly, while FFmpeg receives a tee of the
 * same bytes for retained JPEG snapshots and MP4 clips. Ownership counts avoid
 * duplicate camera sessions, and the idle grace period prevents refreshes from
 * repeatedly opening and closing a camera.
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
  ) {
    super();
  }

  /** Attach an HTTP viewer, starting the shared provider source if needed. */
  async addClient(serial: string, response: ServerResponse): Promise<void> {
    const session = this.#session(serial);
    this.#cancelStop(session);
    session.clients.add(response);
    const bootstrap = session.parameterSets.bootstrap;
    const codec = session.parameterSets.codec;
    if (bootstrap && codec) this.#startClient(response, codec, bootstrap);
    else session.pendingClients.add(response);
    this.#updateState(serial, session);

    response.on("close", () => this.#removeClient(serial, response));

    // Start the provider only after the HTTP client is registered so the first
    // video bytes can be fanned out to Home Assistant immediately.
    try {
      await this.#ensureStarted(serial, session);
    } catch (error) {
      response.destroy(error instanceof Error ? error : undefined);
    }
  }

  /** Capture one fresh JPEG through the shared source and return its metadata. */
  async captureSnapshot(serial: string, timeoutMilliseconds = 20_000): Promise<SnapshotInfo> {
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
  async captureStartupSnapshot(serial: string, timeoutMilliseconds = 20_000): Promise<SnapshotInfo> {
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

  /** Attach provider bytes to all current viewers and FFmpeg consumers. */
  attachSource(serial: string, source: Readable): void {
    const session = this.#session(serial);
    session.source?.destroy();
    session.ffmpeg?.kill("SIGTERM");
    session.source = source;
    session.state = "streaming";
    session.parameterSets = new VideoParameterSetCache();
    for (const client of session.clients) session.pendingClients.add(client);
    session.ffmpeg = null;

    source.on("data", (chunk: Buffer) => {
      session.parameterSets.push(chunk);
      const bootstrap = session.parameterSets.bootstrap;
      const startup = session.parameterSets.startup;
      const codec = session.parameterSets.codec;
      if (bootstrap && codec) {
        if (!session.ffmpeg) {
          session.ffmpeg = this.#startSnapshotExtractor(serial, codec);
          if (startup && session.ffmpeg.stdin.writable) session.ffmpeg.stdin.write(startup);
        }
        for (const client of session.pendingClients) {
          if (session.clients.has(client)) this.#startClient(client, codec, startup ?? bootstrap);
        }
        session.pendingClients.clear();
      }
      for (const client of session.clients) {
        if (session.pendingClients.has(client)) continue;
        client.write(chunk);
        if (client.writableLength > 4 * 1024 * 1024) {
          client.destroy(new Error("Live stream client exceeded the four-megabyte backpressure limit"));
        }
      }
      if (bootstrap && session.ffmpeg?.stdin.writable) session.ffmpeg.stdin.write(chunk);
      for (const recording of session.recordings) this.#appendRecordingChunk(session, recording, chunk);
    });
    source.once("error", (error) => this.#sourceEnded(serial, error));
    source.once("end", () => this.#sourceEnded(serial));
    source.once("close", () => this.#sourceEnded(serial));
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

  #sourceEnded(serial: string, error?: Error): void {
    const session = this.#session(serial);
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
    response.writeHead(200, {
      "Content-Type": codec === "h265" ? "video/h265" : "video/h264",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    response.write(bootstrap);
  }

  #startSnapshotExtractor(serial: string, codec: VideoCodec): ChildProcessWithoutNullStreams {

    // FFmpeg turns the shared Annex-B stream into JPEGs. The store keeps the
    // latest complete frame, so an idle camera still has a useful image.
    const process = spawn("ffmpeg", [
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
    const parser = new JpegParser();
    process.stdout.on("data", (chunk: Buffer) => {
      for (const image of parser.push(chunk)) {
        void this.snapshots.write(serial, image, "image/jpeg", "live").then((info) => {
          this.state.updateSnapshot(serial, info);
        }).catch((error: unknown) => this.emit("warning", error));
      }
    });
    process.stderr.on("data", (chunk: Buffer) => this.emit("ffmpeg-error", chunk.toString("utf8").trim()));
    return process;
  }

  #cleanupSource(session: Session): void {
    session.source?.removeAllListeners();
    session.source = null;
    if (session.ffmpeg) {
      session.ffmpeg.stdin.end();
      session.ffmpeg.kill("SIGTERM");
      session.ffmpeg = null;
    }
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
        stopTimer: null,
        owned: false,
        leases: 0,
      };
      this.#sessions.set(serial, session);
    }
    return session;
  }

  #updateState(serial: string, session: Session, error: string | null = null): void {
    this.state.updateStream(serial, session.state, session.clients.size, error);
  }
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
