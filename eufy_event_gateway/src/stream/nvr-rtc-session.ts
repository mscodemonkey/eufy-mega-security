/**
 * Owns one provider-admitted NVR RTC connection from join through bounded close.
 * The provider owns the station lease and supplies private Mega credentials.
 * Checked video reaches the media boundary. Normal opt-in controls and separately
 * consented guard/power trials retain distinct admission and request ownership.
 * Vendor assets and captures are not dependencies, and hardware needs testing.
 */
import { createHash, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import WebSocket from "ws";
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, type RTCDataChannel, type RTCIceServer } from "werift";
import type { VideoCodec } from "../domain/types.js";
import { NvrPtcsReassembler, type NvrPtcsReassemblyStats } from "./nvr-ptcs-reassembly.js";
import { VideoParameterSetCache } from "./live-stream-manager.js";
import { installNvrIceTiming } from "./nvr-ice-timing.js";
import { NvrPowerError, type NvrCameraPower } from "../provider/nvr-power-trial.js";
import { NvrGuardError } from "../provider/nvr-guard-trial.js";
import type { NvrGuardEffective } from "../provider/nvr-guard-schedule.js";
import { NvrTrialError, nvrCameraPowerCommand, nvrGuardModeCommand, nvrApplication, nvrCandidate, nvrCommand, nvrHeartbeat, nvrJson,
  nvrMatchCamera, nvrNetworkHost, nvrOffer, nvrPackets, nvrRecord, nvrVideo, nvrStateSummary, type NvrStateSummary, type NvrTrialStage, type NvrTrialReason } from "./nvr-protocol.js";

import { NvrLiveControlError } from "../provider/nvr-live-controls.js";
import { nvrLiveCommand, nvrLiveJson, nvrLiveReceipt, nvrLivePanReply, nvrLiveSettings, type NvrLiveSettings, type NvrLiveWrite } from "./nvr-live-control-protocol.js";

const HEARTBEAT_ECHO = nvrHeartbeat();

/** Private join credentials are short-lived and must never enter diagnostics. */
export interface NvrSignallingContext {
  readonly host: string;
  readonly region: "US" | "EU" | "IE";
  readonly authToken: string;
  readonly gtoken: string;
  readonly sign: string;
}

/** Injectable transports let offline tests exercise real peers without a cloud session. */
export interface NvrRtcDependencies {
  readonly socket: (url: string, protocols: string[], options: WebSocket.ClientOptions) => WebSocket;
  readonly peer: (servers: RTCIceServer[]) => RTCPeerConnection;
}

/** The provider verifies this binding before and throughout the trial. */
export interface NvrRtcOptions {
  readonly station: string;
  readonly camera: string;
  readonly channel: number;

  /** Expected cloud inventory type, checked against fresh station discovery. */
  readonly cameraType?: number;

  /** Provider-selected lens. Omission preserves the original T8E00 trial. */
  readonly sensor?: 0 | 1;
  readonly administrator: string;

  /** Freshly bound administrator display name required by the closed guard command. */
  readonly userName?: string;
  readonly context: NvrSignallingContext;
  readonly signal: AbortSignal;
  readonly current: () => boolean;
  readonly ready: (output: PassThrough, codec: () => VideoCodec | null) => void;

  /** Total owned session lifetime, including signalling and media delivery. */
  readonly maximumLifetimeMilliseconds?: number;

  /** Separate provider admission for the manual camera-power trial, never ordinary live view. */
  readonly powerTrial?: boolean;

  /** Separate provider admission for the station-wide Schedule recovery trial. */
  readonly guardTrial?: boolean;

  /** Provider admission for default-off exact-model normal controls, never a trial. */
  readonly liveControls?: boolean;
}

interface PendingRequest {
  readonly strict?: boolean;
  readonly command: 9100 | 1003 | 1004 | 1103;
  readonly segment: number;
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly deadline: number;
}

/** Content-free counters explain an unconfirmed trial without exposing its route. */
export interface NvrRtcStats {
  packets: number;
  frames: number;
  video: number;
  controlPackets: number;
  rejected: number;
  segmentNotEchoed: number;
  staleReplies: number;
  ignoredAudio: number;
  ignoredUnknownMedia: number;

  /** Forward application-frame gaps recovered within the owning channel. */
  applicationSequenceRecoveries: number;

  /** Video sequence gaps that forced decoder bootstrap to restart. */
  videoSequenceRecoveries: number;
  stopUnconfirmed: number;
  channel0Frames: number;
  channel1Frames: number;
  channel2Frames: number;
  channel3Frames: number;
  channel4Frames: number;
  channel5Frames: number;
}

/**
 * Owns socket, peer, channels, timers, fragment buffers and pending requests.
 * One instance may start once and close repeatedly. Close settles pending work,
 * attempts stop once if needed, and releases resources before its owner releases
 * the lease. All externally visible errors have fixed diagnostic stages.
 */
export class NvrRtcSession {
  readonly output = new PassThrough({ highWaterMark: 4 * 1024 * 1024 + 64 });
  readonly stats: NvrRtcStats = { packets: 0, frames: 0, video: 0, controlPackets: 0, rejected: 0,
    segmentNotEchoed: 0, staleReplies: 0, ignoredAudio: 0, ignoredUnknownMedia: 0,
    applicationSequenceRecoveries: 0, videoSequenceRecoveries: 0, stopUnconfirmed: 0,
    channel0Frames: 0, channel1Frames: 0, channel2Frames: 0, channel3Frames: 0, channel4Frames: 0, channel5Frames: 0 };
  readonly #abort = new AbortController();
  readonly #negotiation = new AbortController();
  readonly #reassembler = new NvrPtcsReassembler({ maxFrameBytes: 4 * 1024 * 1024 + 64,
    maxBufferedBytes: 12 * 1024 * 1024, expiryMilliseconds: 1000 });

  /** Return copied structural rejection counts without retaining packet contents. */
  get framingRejections(): NvrPtcsReassemblyStats["rejected"] {
    return this.#reassembler.stats.rejected;
  }
  #cache = new VideoParameterSetCache();
  readonly #channels = new Map<string, RTCDataChannel>();
  readonly #pendingCandidates: string[] = [];
  readonly #localCandidates = new Set<string>();
  readonly #sentCandidates = new Set<string>();
  readonly #turn: RTCIceServer[] = [];
  readonly #lastSequence = new Map<number, number>();
  readonly #reorder = new Map<string, { channel: number; sequence: number; frame: Buffer; at: number }>();
  #reorderBytes = 0;
  #candidateBytes = 0;
  #candidateCount = 0;
  #localCandidateBytes = 0;
  #socket: WebSocket | null = null;
  #peer: RTCPeerConnection | null = null;
  #pending: PendingRequest | null = null;
  #segment = 0;
  #lifetimeStartedAt = 0;
  #settingsFlight: Promise<NvrLiveSettings> | null = null;
  #livePending: { segment: number; pan: boolean; acknowledged: boolean; deadline: number; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;

  /** Content-free PTZ settlement counters do not contain reply payloads. */
  readonly controlStats = { panAcknowledgedWithoutData: 0, panTimeouts: 0, panData: 0, rejected: 0 };
  #powerMode = false;
  #powerReceipt: { readonly segment: number; readonly deadline: number; readonly resolve: () => void;
    readonly reject: (error: NvrPowerError) => void; readonly timer: NodeJS.Timeout; readonly detach: () => void } | null = null;
  #guardQueryCount = 0;
  #guardRecovering = false;
  #guardMode = false;
  #guardReceipt: { readonly segment: number; readonly deadline: number; readonly resolve: () => void;
    readonly reject: (error: NvrGuardError) => void; readonly timer: NodeJS.Timeout; readonly detach: () => void } | null = null;
  #outSequence = 0;
  #operations = 0;
  #chain: Promise<void> = Promise.resolve();
  #stage: NvrTrialStage = "join";
  #closing: Promise<void> | null = null;
  #retired = false;
  #channelFailureScheduled = false;
  #started = false;
  #startSent = false;
  #authenticated = false;
  #accepted = false;
  #offerApplied = false;
  #answerSent = false;
  #mid = "";
  #codec: VideoCodec | null = null;
  #videoSequence: number | null = null;
  #bootstrapped = false;
  #readyResolve: (() => void) | null = null;
  #readyReject: ((error: Error) => void) | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  #sweep: NodeJS.Timeout | null = null;
  #deadline: NodeJS.Timeout | null = null;
  #firstFrame: NodeJS.Timeout | null = null;
  #lastNow = 0;
  readonly #maximumLifetimeMilliseconds: number;
  readonly #externalAbort: () => void;

  constructor(private readonly options: NvrRtcOptions, private readonly dependencies: NvrRtcDependencies = {
    socket: (url, protocols, settings) => new WebSocket(url, protocols, settings),
    peer: servers => new RTCPeerConnection({ iceServers: servers }),
  }) {
    if (!["security-smart.eufylife.com", "security-smart-eu.eufylife.com", "security-smart-ie.eufylife.com"].includes(options.context.host)) throw new NvrTrialError("admission");
    this.#maximumLifetimeMilliseconds = options.maximumLifetimeMilliseconds ?? 75_000;
    if (!Number.isSafeInteger(this.#maximumLifetimeMilliseconds) || this.#maximumLifetimeMilliseconds < 1_000
      || this.#maximumLifetimeMilliseconds > 2_147_483_647) throw new NvrTrialError("admission");
    this.#externalAbort = () => this.#fail("cancelled");
    options.signal.addEventListener("abort", this.#externalAbort, { once: true });
    this.output.on("error", () => {});
  }

  /** Report only a checked codec, never a model-derived guess. */
  get codec(): VideoCodec | null { return this.#codec; }

  /** Remaining owned lifetime, including negotiation. Callers cannot extend it. */
  get remainingLifetimeMilliseconds(): number {
    return this.#started && !this.#retired ? Math.max(0, this.#maximumLifetimeMilliseconds - (performance.now() - this.#lifetimeStartedAt)) : 0;
  }

  /** Negotiate, correlate fresh discovery, attach the sink, and request video once. */
  async start(): Promise<void> {
    if (this.options.powerTrial || this.options.guardTrial) throw this.options.guardTrial
      ? new NvrGuardError("admission") : new NvrPowerError("admission");
    await this.#connectAndDiscover();
    this.options.ready(this.output, () => this.#codec);
    this.#stage = "start";
    await this.#request(1003, 5000);
    this.#stage = "video";
    if (this.options.liveControls) this.#settingsFlight = this.readLiveSettings().catch(() => ({ night: null, quality: null }));
    if (!this.#bootstrapped) this.#firstFrame = setTimeout(() => this.#fail("video"), 20_000);
  }

  /**
   * Query scoped state without starting media or changing settings.
   * Only a reply echoing this request's segment can satisfy the query, so an
   * unsolicited or uncorrelated state push cannot become fresh readback.
   */
  async readState(): Promise<NvrStateSummary> {
    try {
      await this.#connectAndDiscover();
      this.#stage = "state";
      const response = await this.#request(1103, 5000);
      this.#guard();
      return nvrStateSummary(response, this.options.channel);
    } finally { await this.close(); }
  }

  /** Return one background observation without delaying video startup. */
  async initialLiveSettings(): Promise<NvrLiveSettings> {
    return await this.#settingsFlight ?? { night: null, quality: null };
  }

  /** Query settings on the existing normal connection, or an admitted read-only connection. */
  async readLiveSettings(signal?: AbortSignal, timeout = 5000): Promise<NvrLiveSettings> {
    if (!this.options.liveControls || this.options.guardTrial || this.options.powerTrial) throw new NvrLiveControlError("disabled");
    signal?.throwIfAborted();
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 5000) throw new NvrLiveControlError("unavailable");
    if (!this.#started) await this.#connectAndDiscover();
    const operation = this.#request(1103, timeout, false, true);
    const pending = this.#pending as PendingRequest | null;
    const abort = (): void => {
      if (pending && this.#pending === pending) {
        clearTimeout(pending.timer); this.#pending = null; pending.reject(new NvrLiveControlError("unavailable", "reply"));
      }
    };
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    try { const response = await operation; signal?.throwIfAborted(); return nvrLiveSettings(response, this.options.channel); }
    finally { signal?.removeEventListener("abort", abort); }
  }

  /** Reserve lifetime and close segments, then reconfirm the child on this connection. */
  async prepareLiveControl(movement: boolean): Promise<void> {
    await this.#settingsFlight;
    this.#liveGuard(movement);
    const response = await this.#request(9100, 5000, false, true);
    nvrMatchCamera(response, this.options.camera, this.options.channel, this.options.cameraType);
    this.#liveGuard(movement);
  }

  #liveGuard(movement: boolean): void {
    this.#guard();
    if (!this.options.liveControls || this.options.powerTrial || this.options.guardTrial || !this.#startSent
      || this.#channels.get("WebrtcDataChannel")?.ordered !== true) throw new NvrLiveControlError("disabled");
    if (performance.now() - this.#lifetimeStartedAt > this.#maximumLifetimeMilliseconds - (movement ? 10000 : 35000)) {
      throw new NvrLiveControlError("unavailable", "source_lifetime");
    }
    if (this.#segment + (movement ? 3 : 16) + 2 > 254) throw new NvrLiveControlError("unavailable", "segment_budget");
  }

  /** Dispatch once after the provider's synchronous final admission check. No retry occurs. */
  async writeLiveControl(request: NvrLiveWrite, signal: AbortSignal, beforeDispatch: () => void): Promise<void> {
    this.#guard();
    const movement = request.kind === "pan" || request.kind === "zoom";
    if (performance.now() - this.#lifetimeStartedAt > this.#maximumLifetimeMilliseconds - (movement ? 10000 : request.kind === "quality" && request.sensor === 1 ? 25000 : 35000)) throw new NvrLiveControlError("unavailable", "source_lifetime");
    if (!this.options.liveControls || !this.#startSent || this.#pending || this.#livePending || this.#segment >= 252) throw new NvrLiveControlError("busy");
    const channel = this.#channels.get("WebrtcDataChannel");
    if (!channel || channel.readyState !== "open" || channel.ordered !== true || channel.bufferedAmount > 1024 * 1024) throw new NvrLiveControlError("unavailable");
    const segment = this.#segment + 1;
    const packet = nvrLiveCommand(this.options.administrator, segment, this.options.channel, request);
    let packets: Buffer[];
    try { packets = nvrPackets(packet, this.#outSequence % 65536, Date.now()); }
    finally { packet.fill(0); }
    this.#segment = segment; this.#outSequence++;
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        if (this.#livePending?.segment !== segment) return;
        clearTimeout(this.#livePending.timer); this.#livePending = null;
        signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve();
      };
      const abort = (): void => finish(new NvrLiveControlError("outcome_unknown", "dispatch"));
      const timer = setTimeout(() => {
        if (request.kind === "pan") {
          this.controlStats.panTimeouts++;
          if (this.#livePending?.acknowledged) this.controlStats.panAcknowledgedWithoutData++;
        }
        finish(new NvrLiveControlError("outcome_unknown", "dispatch"));
      }, 5000);
      this.#livePending = { segment, pan: request.kind === "pan", acknowledged: false, deadline: performance.now() + 5000,
        resolve: () => finish(), reject: error => finish(error), timer };
      signal.addEventListener("abort", abort, { once: true });
      let dispatched = false;
      try {
        this.#guard(); signal.throwIfAborted();
        const floor = movement ? 10000 : request.kind === "quality" && request.sensor === 1 ? 25000 : 35000;
        if (performance.now() - this.#lifetimeStartedAt > this.#maximumLifetimeMilliseconds - floor) throw new NvrLiveControlError("unavailable", "source_lifetime");
        if (channel.readyState !== "open" || channel.bufferedAmount > 1024 * 1024) throw new NvrLiveControlError("unavailable");
        beforeDispatch();
        dispatched = true;
        channel.send(packets[0]!);
        for (let index = 1; index < packets.length; index++) channel.send(packets[index]!);
      } catch (error) { finish(dispatched ? new NvrLiveControlError("outcome_unknown", "dispatch") : error instanceof NvrLiveControlError ? error : new NvrLiveControlError("unavailable")); }

      // Packet buffers belong to the transport after send and must not be mutated.
      finally { packet.fill(0); }
    });
  }

  /** Open one power-only connection after the provider's separate consent and admission. */
  async preparePowerTrial(): Promise<void> {
    if (!this.options.powerTrial || this.options.cameraType !== 301 || this.#started) throw new NvrPowerError("admission");
    this.#powerMode = true;
    await this.#connectAndDiscover();
    if (this.#channels.get("WebrtcDataChannel")?.ordered !== true) throw new NvrPowerError("identity");
  }

  /** Reconfirm the selected child on the same connection before a recovery write. */
  async validatePowerTrial(signal: AbortSignal): Promise<void> {
    this.#powerGuard();
    const response = await this.#powerQuery(9100, signal);
    nvrMatchCamera(response, this.options.camera, this.options.channel, 301);
    this.#powerGuard();
  }

  /** Project only the freshly correlated camera-power field, keeping all other state private. */
  async readPowerTrial(signal: AbortSignal): Promise<NvrCameraPower | null> {
    this.#powerGuard();
    const response = await this.#powerQuery(1103, signal);
    this.#powerGuard();
    return nvrStateSummary(response, this.options.channel).cameraPower;
  }

  /** Send one absolute power command. A receipt is not a reported or physical state. */
  async writePowerTrial(value: NvrCameraPower, signal: AbortSignal, dispatched: () => void): Promise<void> {
    this.#powerGuard(); signal.throwIfAborted();
    if (this.#pending || this.#powerReceipt || this.#segment >= 254 || !["on", "off"].includes(value)) throw new NvrPowerError("send");
    const channel = this.#channels.get("WebrtcDataChannel");
    if (!channel || channel.readyState !== "open" || channel.bufferedAmount > 1024 * 1024) throw new NvrPowerError("send");
    const segment = ++this.#segment;
    const frame = nvrCameraPowerCommand(this.options.administrator, segment, this.options.channel, value === "off" ? 1 : 0);
    const packets = nvrPackets(frame, this.#outSequence++ % 65536, Date.now());
    return await new Promise<void>((resolve, reject) => {
      const abort = (): void => this.#finishPowerReceipt(new NvrPowerError("cancelled"));
      const timer = setTimeout(() => this.#finishPowerReceipt(new NvrPowerError("receipt")), 15_000);
      this.#powerReceipt = { segment, deadline: performance.now() + 15_000, resolve, reject, timer,
        detach: () => signal.removeEventListener("abort", abort) };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      try {
        this.#powerGuard(); signal.throwIfAborted(); dispatched();
        for (const packet of packets) channel.send(packet);
      } catch { this.#finishPowerReceipt(new NvrPowerError("send")); }
      finally { frame.fill(0); }
    });
  }

  /** Open one station-wide guard-only connection after separate consent and admission. */
  async prepareGuardTrial(): Promise<void> {
    if (!this.options.guardTrial || this.options.cameraType !== 301 || this.#started
      || typeof this.options.userName !== "string") throw new NvrGuardError("admission");
    this.#guardMode = true;
    await this.#connectAndDiscover();
    if (this.#channels.get("WebrtcDataChannel")?.ordered !== true) throw new NvrGuardError("identity");
  }

  /** Reconfirm the selected child on the same connection before a guard write. */
  async validateGuardTrial(signal: AbortSignal, recovery = false): Promise<void> {
    this.#guardTrialGuard();
    if (recovery) this.#guardRecovering = true;
    const response = await this.#guardQuery(9100, signal);
    nvrMatchCamera(response, this.options.camera, this.options.channel, 301);
    this.#guardTrialGuard();
  }

  /** Send Home or Schedule once. Its receipt is not independent state confirmation. */
  async writeGuardTrial(mode: 1 | 2, signal: AbortSignal, dispatched: () => void): Promise<void> {
    this.#guardTrialGuard(); signal.throwIfAborted();
    if (mode === 2) this.#guardRecovering = true;
    if (this.#pending || this.#powerReceipt || this.#guardReceipt || this.#segment >= 254
      || mode !== 1 && mode !== 2) throw new NvrGuardError("send");
    const channel = this.#channels.get("WebrtcDataChannel");
    if (!channel || channel.readyState !== "open" || channel.bufferedAmount > 1024 * 1024) throw new NvrGuardError("send");
    const segment = ++this.#segment;
    const frame = nvrGuardModeCommand(this.options.administrator, this.options.userName ?? "", segment, mode);
    const packets = nvrPackets(frame, this.#outSequence++ % 65536, Date.now());
    return await new Promise<void>((resolve, reject) => {
      const abort = (): void => this.#finishGuardReceipt(new NvrGuardError("cancelled"));
      const timer = setTimeout(() => this.#finishGuardReceipt(new NvrGuardError("receipt")), 15_000);
      this.#guardReceipt = { segment, deadline: performance.now() + 15_000, resolve, reject, timer,
        detach: () => signal.removeEventListener("abort", abort) };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      try {
        this.#guardTrialGuard(); signal.throwIfAborted(); dispatched();
        for (const packet of packets) channel.send(packet);
      } catch (error) { this.#finishGuardReceipt(error instanceof NvrGuardError ? error : new NvrGuardError("send")); }
      finally { frame.fill(0); }
    });
  }

  /** Query station-scoped effective state on a fresh, correlated request. */
  async confirmGuardEffectiveTrial(expected: NvrGuardEffective, signal: AbortSignal): Promise<void> {
    this.#guardTrialGuard(); signal.throwIfAborted();
    const response = await this.#guardQuery(1103, signal);
    if (nvrStateSummary(response, this.options.channel).effectiveGuardMode !== expected) throw new NvrGuardError("readback");
  }

  #powerGuard(): void {
    this.#guard();
    if (!this.#powerMode || !this.options.powerTrial || this.#startSent || this.#channels.get("WebrtcDataChannel")?.ordered !== true) throw new NvrPowerError("identity");
  }

  #guardTrialGuard(): void {
    try { this.#guard(); }
    catch { throw new NvrGuardError(this.#retired || this.options.signal.aborted ? "shutdown" : "identity"); }
    if (!this.#guardMode || !this.options.guardTrial || this.#startSent
      || this.#channels.get("WebrtcDataChannel")?.ordered !== true) throw new NvrGuardError("identity");
  }

  async #guardQuery(command: 9100 | 1103, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (this.#pending || this.#powerReceipt || this.#guardReceipt) throw new NvrGuardError("busy");

    // Leave more than eight wire segments for restore writes and final proof.
    if (this.#guardQueryCount >= (this.#guardRecovering ? 220 : 32)) throw new NvrGuardError("readback");
    this.#guardQueryCount++;
    const operation = this.#request(command, 5_000);
    const pending = this.#pending as PendingRequest | null;
    const abort = (): void => {
      if (pending && this.#pending === pending) {
        clearTimeout(pending.timer); this.#pending = null; pending.reject(new NvrGuardError("cancelled"));
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try { const result = await operation; signal.throwIfAborted(); return result; }
    finally { signal.removeEventListener("abort", abort); }
  }

  async #powerQuery(command: 9100 | 1103, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (this.#pending || this.#powerReceipt) throw new NvrPowerError("busy");
    const operation = this.#request(command, 5_000);

    // The request installs its pending owner synchronously despite the preceding null guard.
    const pending = this.#pending as PendingRequest | null;
    const abort = (): void => {
      if (pending && this.#pending === pending) {
        clearTimeout(pending.timer); this.#pending = null; pending.reject(new NvrPowerError("cancelled"));
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try { const result = await operation; signal.throwIfAborted(); return result; }
    finally { signal.removeEventListener("abort", abort); }
  }

  #finishPowerReceipt(error?: NvrPowerError): void {
    const pending = this.#powerReceipt;
    if (!pending) return;
    this.#powerReceipt = null; clearTimeout(pending.timer); pending.detach();
    if (error) pending.reject(error); else pending.resolve();
  }

  #finishGuardReceipt(error?: NvrGuardError): void {
    const pending = this.#guardReceipt;
    if (!pending) return;
    this.#guardReceipt = null; clearTimeout(pending.timer); pending.detach();
    if (error) pending.reject(error); else pending.resolve();
  }

  async #connectAndDiscover(): Promise<void> {
    if (this.#started || this.options.signal.aborted) throw new NvrTrialError("cancelled");
    this.#started = true;
    this.#lifetimeStartedAt = performance.now();
    this.#deadline = setTimeout(() => this.#fail("deadline"), this.#maximumLifetimeMilliseconds);
    const ready = new Promise<void>((resolve, reject) => { this.#readyResolve = resolve; this.#readyReject = reject; });
    const timer = setTimeout(() => this.#fail(this.#stage), 30_000);
    try {
      this.#socket = this.dependencies.socket(`wss://${this.options.context.host}/v1/rtc/ws/join?reqtype=nvr`, ["v1",
        Buffer.from(JSON.stringify({ region: this.options.context.region, type: "NVR", sn: this.options.station,
          token: this.options.context.authToken, gtoken: this.options.context.gtoken, sign: this.options.context.sign,
          appName: "eufy_mega", modelType: "WEB" })).toString("base64url")],
      { headers: { Origin: "https://security.eufy.com" }, maxPayload: 65536, followRedirects: false, handshakeTimeout: 10_000 });
      this.#socket.on("open", () => {
        if (this.#retired) return;
        try { this.#send({ code: 200, action: 1, data: this.options.context.sign, sn: this.options.station,
          source: "WEB", ts: Math.floor(Date.now() / 1000) }, true); } catch { this.#fail("join"); }
      });
      this.#socket.on("error", () => this.#fail(this.#stage, "signalling_error"));
      this.#socket.on("close", () => { if (!this.#retired) this.#fail(this.#stage, "signalling_closed"); });
      this.#socket.on("message", data => {
        if (this.#retired) return;
        if (++this.#operations > 32) { this.#fail("negotiation", "signalling_queue_limit"); return; }
        this.#chain = this.#chain.then(async () => { if (!this.#retired) await this.#message(data.toString()); })
          .catch(error => this.#fail(error instanceof NvrTrialError ? error.stage : "negotiation",
            error instanceof NvrTrialError ? error.reason : "unexpected_negotiation_error"))
          .finally(() => { this.#operations--; });
      });
      await ready;
    } catch (error) {
      await this.close();
      throw error instanceof NvrTrialError ? error : new NvrTrialError(this.#stage);
    } finally { clearTimeout(timer); }
    this.#stage = "inventory";
    const discovery = await this.#request(9100, 5000);
    nvrMatchCamera(discovery, this.options.camera, this.options.channel, this.options.cameraType ?? 301);
    this.#guard();
  }

  /** Attempt stream stop and deterministically retire the original connection. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#livePending?.reject(new NvrLiveControlError("outcome_unknown", "dispatch"));
    this.#retired = true;
    this.#finishPowerReceipt(new NvrPowerError("shutdown"));
    this.#finishGuardReceipt(new NvrGuardError("shutdown"));
    this.#negotiation.abort();
    this.#abort.abort();
    this.options.signal.removeEventListener("abort", this.#externalAbort);
    this.#readyReject?.(new NvrTrialError("cancelled"));
    this.#readyReject = null; this.#readyResolve = null;
    if (this.#pending) {
      clearTimeout(this.#pending.timer); this.#pending.reject(new NvrTrialError("cancelled")); this.#pending = null;
    }
    for (const timer of [this.#deadline, this.#firstFrame, this.#heartbeat, this.#sweep]) if (timer) clearTimeout(timer);
    this.#closing = (async () => {
      if (this.#startSent && this.#channels.get("WebrtcDataChannel")?.readyState === "open") {
        try { await this.#request(1004, 1500, true); } catch { this.stats.stopUnconfirmed++; }
      } else if (this.#startSent) this.stats.stopUnconfirmed++;
      const socket = this.#socket;
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        socket.removeAllListeners("message");
        await new Promise<void>(resolve => {
          const finished = (): void => { clearTimeout(terminate); socket.removeListener("close", finished); resolve(); };
          const terminate = setTimeout(() => { socket.terminate(); finished(); }, 500);
          socket.once("close", finished);
          try { socket.close(); } catch { socket.terminate(); finished(); }
        });
      }
      for (const channel of this.#channels.values()) { channel.onmessage = undefined; channel.onopen = undefined; channel.onclose = undefined; channel.close(); }
      this.#channels.clear();
      if (this.#peer) {
        const peer = this.#peer;
        let timer: NodeJS.Timeout | undefined;
        try { await Promise.race([peer.close().catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 2500); })]); }
        finally { if (timer) clearTimeout(timer); }
      }
      this.#reassembler.clear(); this.#reorder.clear(); this.#reorderBytes = 0;
      this.#pendingCandidates.length = 0; this.#localCandidates.clear(); this.#turn.length = 0;
      this.output.end();
    })();
    return this.#closing;
  }

  #guard(): void {
    if (this.#retired || this.options.signal.aborted || !this.options.current()) throw new NvrTrialError("cancelled");
  }

  #fail(stage: NvrTrialStage, reason: NvrTrialReason = "unspecified"): void {
    if (this.#retired) return;
    this.#stage = stage;
    const error = new NvrTrialError(stage, reason);
    this.#readyReject?.(error);
    this.#livePending?.reject(new NvrLiveControlError("outcome_unknown", "dispatch"));
    this.#pending?.reject(error);
    this.output.destroy(error);
    void this.close().catch(() => {});
  }

  #send(value: Record<string, unknown>, join = false): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) throw new NvrTrialError(this.#stage);
    this.#socket.send(JSON.stringify({ msgid: join ? "0" : `${this.options.context.authToken}_${randomUUID()}`, data: JSON.stringify(value) }));
  }

  #action(kind: string, value: Record<string, unknown>): void {
    this.#guard();
    const ts = Math.floor(Date.now() / 1000);
    const account = createHash("md5").update(`0${this.options.administrator}${ts}`).digest("hex");
    this.#send({ code: 200, action: 3, sessionId: this.options.context.sign, sn: this.options.station,
      subSn: "", channelId: 0, isResponse: 0, dataType: kind, source: "WEB", ts,
      data: JSON.stringify({ timestamp: ts, account, ...value }) });
  }

  async #message(raw: string): Promise<void> {
    this.#guard();
    const outer = nvrJson(raw), inner = nvrJson(outer.data);
    if (inner.action === 1) {
      if (this.#authenticated || inner.code !== 200) throw new NvrTrialError("join");
      this.#authenticated = true; this.#stage = "call"; this.#action("call", {}); return;
    }
    if (!this.#authenticated || inner.action !== 3) throw new NvrTrialError("call");
    if (inner.sessionId !== this.options.context.sign) throw new NvrTrialError("negotiation", "session_mismatch");
    if (inner.sn !== this.options.station) throw new NvrTrialError("negotiation", "station_mismatch");
    if (inner.channelId !== 0) throw new NvrTrialError("negotiation", "channel_mismatch");
    const data = nvrJson(inner.data);
    if (inner.dataType === "call") {
      if (data.status === 486) throw new NvrTrialError("busy");
      if (data.status === 408) throw new NvrTrialError("call");
      if (data.status === 100) {
        const rows = Array.isArray(data.turn) ? data.turn : [data.turn];
        if (rows.length > 4 || this.#turn.length) throw new NvrTrialError("negotiation", "relay_count");
        for (const row of rows) {
          if (!nvrRecord(row)) throw new NvrTrialError("negotiation", "relay_shape");
          const host = row.turn_addr ?? row.addr ?? row.host ?? row.ip, port = row.turn_port ?? row.port ?? 3478;
          const username = row.turn_user ?? row.user ?? row.username, credential = row.turn_password ?? row.password ?? row.credential;
          if (typeof host !== "string" || !nvrNetworkHost(host) || !Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535
            || typeof username !== "string" || !username.length || username.length > 512
            || typeof credential !== "string" || !credential.length || credential.length > 512) throw new NvrTrialError("negotiation", "relay_fields");
          this.#turn.push({ urls: `turn:${host}:${port}?transport=udp`, username, credential });
        }
      } else if (data.status === 200 && !this.#accepted) { this.#accepted = true; this.#action("ack", {}); }
      return;
    }
    if (inner.dataType !== "info") return;
    if (data.format === "CANDIDATE") {
      const candidate = nvrCandidate(data.value);
      if (++this.#candidateCount > 64 || (this.#candidateBytes += Buffer.byteLength(candidate)) > 65536) throw new NvrTrialError("negotiation", "candidate_limit");
      if (!this.#offerApplied) this.#pendingCandidates.push(candidate);
      else await this.#candidate(candidate);
    } else if (data.format === "SDP") {
      if (!this.#accepted || this.#peer) throw new NvrTrialError("negotiation", "offer_order");
      const offer = nvrOffer(data.value); this.#mid = offer.mid; this.#stage = "negotiation";
      let peer: RTCPeerConnection;
      try { peer = this.#peer = this.dependencies.peer(this.#turn); }
      catch { throw new NvrTrialError("negotiation", "peer_setup"); }
      peer.connectionStateChange.subscribe(state => { if (state === "failed" || state === "disconnected") this.#fail("negotiation", state === "failed" ? "peer_failed" : "peer_disconnected"); });
      peer.onIceCandidate.subscribe(candidate => {
        if (!candidate?.candidate || this.#retired) return;
        if (this.#localCandidates.size + this.#sentCandidates.size >= 64) { this.#fail("negotiation", "local_candidate_limit"); return; }
        if (this.#sentCandidates.has(candidate.candidate) || this.#localCandidates.has(candidate.candidate)) return;
        if (Buffer.byteLength(candidate.candidate) > 8192 || (this.#localCandidateBytes += Buffer.byteLength(candidate.candidate)) > 65536) { this.#fail("negotiation", "local_candidate_limit"); return; }
        this.#localCandidates.add(candidate.candidate);
        if (this.#answerSent) this.#flushLocal();
      });
      peer.onDataChannel.subscribe(channel => this.#attach(channel));
      await this.#step("peer_setup", () => {
        for (const label of ["WebrtcDataChannel", "audio", "idr", "video", "notify", "download"]) this.#attach(peer.createDataChannel(label));
        installNvrIceTiming(peer, this.#negotiation.signal);
      });
      await this.#step("remote_description", () => peer.setRemoteDescription(new RTCSessionDescription(offer.sdp, "offer"))); this.#guard();
      this.#offerApplied = true;
      for (const candidate of this.#pendingCandidates.splice(0)) await this.#candidate(candidate);
      const answer = await this.#step("create_answer", () => peer.createAnswer()); this.#guard();
      await this.#step("local_description", () => peer.setLocalDescription(answer)); this.#guard();
      await this.#step("send_answer", () => { this.#action("info", { sdp: peer.localDescription!.sdp }); this.#answerSent = true; this.#flushLocal(); });
    }
  }

  async #step<T>(reason: NvrTrialReason, operation: () => T | Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof NvrTrialError) throw error;
      throw new NvrTrialError("negotiation", reason);
    }
  }

  #flushLocal(): void {
    for (const candidate of this.#localCandidates) { this.#action("info", { candidate }); this.#sentCandidates.add(candidate); }
    this.#localCandidates.clear();
  }

  async #candidate(candidate: string): Promise<void> {
    await this.#step("remote_candidate", () => this.#peer!.addIceCandidate(new RTCIceCandidate({ candidate, sdpMid: this.#mid, sdpMLineIndex: 0 }))); this.#guard();
  }

  #attach(channel: RTCDataChannel): void {
    if (this.#retired || !["WebrtcDataChannel", "audio", "idr", "video", "notify", "download"].includes(channel.label)
      || this.#channels.has(channel.label)) {
      if (!this.#retired && !this.#channelFailureScheduled) {
        this.#channelFailureScheduled = true;
        setImmediate(() => { try { this.#fail("channel"); } catch { void this.close().catch(() => {}); } });
      }
      return;
    }
    this.#channels.set(channel.label, channel);
    channel.onopen = () => {
      if (this.#retired || channel.label !== "WebrtcDataChannel") return;
      try {
        this.#guard(); channel.send(nvrHeartbeat());
        this.#heartbeat = setInterval(() => { try { this.#guard(); channel.send(nvrHeartbeat()); } catch { this.#fail("channel"); } }, 10_000);
        this.#sweep = setInterval(() => {
          try { this.#guard(); this.#reassembler.expire(this.#now()); this.#drain(); }
          catch (error) { this.#fail(error instanceof NvrTrialError ? error.stage : "framing", error instanceof NvrTrialError ? error.reason : "unspecified"); }
        }, 100);
        this.#readyResolve?.(); this.#readyResolve = null; this.#readyReject = null;
      } catch { this.#fail("channel"); }
    };
    channel.onclose = () => { if (!this.#retired) this.#fail("channel"); };
    channel.onmessage = event => {
      if (this.#retired && this.#pending?.command !== 1004) return;
      if (!Buffer.isBuffer(event.data)) { this.stats.rejected++; return; }
      try { this.#packet(event.data); }
      catch (error) { this.#fail(error instanceof NvrTrialError ? error.stage : "framing", error instanceof NvrTrialError ? error.reason : "unspecified"); }
    };
  }

  #now(): number {
    const now = Math.floor(performance.now());
    if (now < this.#lastNow) throw new NvrTrialError("framing", "clock_reversed");
    this.#lastNow = now; return now;
  }

  #packet(packet: Buffer): void {
    this.stats.packets++;

    // Exact heartbeat echoes carry no camera identity and may arrive on any channel.
    if (packet.equals(HEARTBEAT_ECHO)) { this.stats.controlPackets++; return; }
    if (packet.length >= 5 && packet.subarray(0, 4).toString() === "PTCS" && packet[4] !== 3) { this.stats.controlPackets++; return; }
    const result = this.#reassembler.push(packet, this.#now());
    if (result.status === "rejected") {
      if (result.reason !== "replay" && ++this.stats.rejected >= 32) {
        throw new NvrTrialError("framing", `ptcs_${result.reason.replaceAll("-", "_")}` as NvrTrialReason);
      }
      return;
    }
    if (result.status !== "complete") return;
    const counter = (["channel0Frames", "channel1Frames", "channel2Frames", "channel3Frames", "channel4Frames", "channel5Frames"] as const)[result.channel];
    if (counter) this.stats[counter]++;
    const previous = this.#lastSequence.get(result.channel);
    if (previous !== undefined) {
      const distance = (result.sequence - previous + 65536) % 65536;
      if (distance === 0 || distance >= 32768) return;
      if (distance > 16) {
        for (const [queuedKey, queued] of this.#reorder) {
          if (queued.channel !== result.channel) continue;
          this.#reorder.delete(queuedKey);
          this.#reorderBytes -= queued.frame.length;
        }
        this.#lastSequence.set(result.channel, (result.sequence + 65535) % 65536);
        this.stats.applicationSequenceRecoveries++;
      }
    }
    const key = `${result.channel}:${result.sequence}`;
    if (this.#reorder.has(key)) return;
    if (this.#reorder.size >= 16 || this.#reorderBytes + result.frame.length > 8 * 1024 * 1024) throw new NvrTrialError("framing", "frame_reorder_limit");
    this.#reorder.set(key, { channel: result.channel, sequence: result.sequence, frame: result.frame, at: this.#now() });
    this.#reorderBytes += result.frame.length; this.#drain();
  }

  #drain(): void {
    for (const [key, item] of this.#reorder) {
      const previous = this.#lastSequence.get(item.channel);
      if (previous !== undefined && item.sequence !== (previous + 1) % 65536) {
        if (this.#now() - item.at >= 1000) throw new NvrTrialError("framing", "frame_reorder_timeout");
        continue;
      }
      this.#reorder.delete(key); this.#reorderBytes -= item.frame.length;
      this.#lastSequence.set(item.channel, item.sequence); this.#frame(item.frame);
      this.#drain(); break;
    }
  }

  #frame(bytes: Buffer): void {
    this.stats.frames++;
    const frame = nvrApplication(bytes);
    if (frame.command === 1301) { this.stats.ignoredAudio++; return; }
    if (frame.command === 1303) { this.stats.ignoredUnknownMedia++; return; }
    if (frame.command === 1300) {
      if (!this.#startSent || this.#retired) return;
      const video = nvrVideo(frame, this.options.channel);
      if (this.#videoSequence !== null && video.sequence !== (this.#videoSequence + 1) % 65536) {
        this.#cache = new VideoParameterSetCache();
        this.#bootstrapped = false;
        this.stats.videoSequenceRecoveries++;
      }
      if (this.#codec && this.#codec !== video.codec) throw new NvrTrialError("video");
      this.#videoSequence = video.sequence; this.#codec = video.codec; this.stats.video++;
      this.#cache.push(video.bytes, video.codec);
      if (!this.#bootstrapped) {
        const startup = this.#cache.startup;
        if (!startup) return;
        this.#bootstrapped = true;
        if (this.#firstFrame) clearTimeout(this.#firstFrame);
        if (!this.output.write(startup)) throw new NvrTrialError("video");
      } else if (!this.output.write(video.bytes)) throw new NvrTrialError("video");
      return;
    }
    if (this.#livePending) {
      const pending = this.#livePending;
      if (frame.segment !== pending.segment || performance.now() >= pending.deadline
        || frame.channel !== this.options.channel && !(pending.pan && frame.channel === 255)) { this.stats.staleReplies++; return; }
      if (frame.command === (pending.pan ? 1700 : 1350)) {
        if (frame.channel !== this.options.channel) { this.stats.staleReplies++; return; }
        if (nvrLiveReceipt(frame.payload)) { pending.acknowledged = true; if (!pending.pan) pending.resolve(); }
        else { this.controlStats.rejected++; pending.reject(new NvrLiveControlError("outcome_unknown", "receipt")); }
        return;
      }
      if (pending.pan && frame.command === 1351) {
        try {
          const data = nvrLiveJson(frame.payload.toString("utf8"));
          if (data.cmd !== 6030) { this.stats.staleReplies++; return; }
          if (!nvrLivePanReply(data)) throw new Error();
          this.controlStats.panData++; pending.resolve();
        } catch { this.controlStats.rejected++; pending.reject(new NvrLiveControlError("outcome_unknown", "reply")); }
      } else this.stats.staleReplies++;
      return;
    }
    if (this.#powerReceipt && frame.command === 1350) {
      const pending = this.#powerReceipt;
      if (frame.channel === this.options.channel && frame.segment === pending.segment && frame.payload.length === 132
        && performance.now() < pending.deadline) {
        let json = false;
        try { JSON.parse(frame.payload.toString("utf8")); json = true; } catch { /* The source receipt is binary. */ }
        if (!json) this.#finishPowerReceipt(); else this.stats.staleReplies++;
      } else this.stats.staleReplies++;
      return;
    }
    if (this.#guardReceipt && frame.command === 1350) {
      const pending = this.#guardReceipt;
      if (frame.channel === 255 && frame.segment === pending.segment && frame.payload.length === 132
        && performance.now() < pending.deadline) {
        let json = false;
        try { JSON.parse(frame.payload.toString("utf8")); json = true; } catch { /* The source receipt is binary. */ }
        if (!json) this.#finishGuardReceipt(); else this.stats.staleReplies++;
      } else this.stats.staleReplies++;
      return;
    }
    const pending = this.#pending;
    if (!pending || frame.channel !== 255 || frame.segment !== pending.segment && (frame.segment !== 0 || pending.command === 1103 || pending.strict)) { this.stats.staleReplies++; return; }
    if ((pending.strict || pending.command === 1103 || (this.#powerMode || this.#guardMode) && pending.command === 9100)
      && (frame.segment !== pending.segment || performance.now() >= pending.deadline)) { this.stats.staleReplies++; return; }
    if (frame.segment === 0) this.stats.segmentNotEchoed++;
    if (frame.command === 1350 && frame.payload.length >= 4
      && frame.payload.subarray(4).every((byte) => byte === 0)) {
      if (frame.payload.readInt32LE(0) !== 0) { pending.reject(new NvrTrialError(this.#stage)); clearTimeout(pending.timer); this.#pending = null; }
      else if (pending.command === 1003 || pending.command === 1004) { pending.resolve({}); clearTimeout(pending.timer); this.#pending = null; }
      return;
    }
    if (frame.command !== 1351) { this.stats.staleReplies++; return; }
    let response: Record<string, unknown>;
    try { response = this.options.liveControls ? nvrLiveJson(frame.payload.toString("utf8")) : nvrJson(frame.payload.toString("utf8")); }
    catch (error) {
      if (!this.options.liveControls || pending.command !== 1103 && !pending.strict) throw error;
      clearTimeout(pending.timer); this.#pending = null; pending.reject(new NvrLiveControlError("unavailable", "reply")); return;
    }
    if (response.cmd !== pending.command) { this.stats.staleReplies++; return; }
    if (response.mIntRet !== undefined && response.mIntRet !== 0) pending.reject(new NvrTrialError(this.#stage));
    else pending.resolve(response);
    clearTimeout(pending.timer); this.#pending = null;
  }

  #request(command: 9100 | 1003 | 1004 | 1103, timeout: number, closing = false, strict = false): Promise<Record<string, unknown>> {
    if (!closing) this.#guard();
    if (this.#pending || this.#livePending || this.#segment >= 254 || this.options.liveControls && command !== 1004 && this.#segment >= 252) return Promise.reject(new NvrTrialError(this.#stage));
    const channel = this.#channels.get("WebrtcDataChannel");
    if (!channel || channel.readyState !== "open" || channel.bufferedAmount > 1024 * 1024) return Promise.reject(new NvrTrialError("channel"));
    return new Promise((resolve, reject) => {
      const segment = ++this.#segment;
      const timer = setTimeout(() => { this.#pending = null; reject(new NvrTrialError(command === 1004 ? "stop" : this.#stage)); }, timeout);
      this.#pending = { command, segment, resolve, reject, timer, strict, deadline: performance.now() + timeout };
      if (command === 1003) this.#startSent = true;
      try {
        for (const packet of nvrPackets(nvrCommand(this.options.administrator, command, segment, this.options.channel, this.options.sensor ?? 1), this.#outSequence++ % 65536, Date.now())) channel.send(packet);
      } catch { clearTimeout(timer); this.#pending = null; reject(new NvrTrialError(this.#stage)); }
    });
  }
}
