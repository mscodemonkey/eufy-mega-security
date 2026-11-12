/**
 * Owns one provider-admitted NVR RTC connection from join through bounded close.
 * Normal live view renews its lease through checked video output. Diagnostics
 * and separately admitted security trials retain a finite total lifetime.
 * The provider owns the station lease and supplies private Mega credentials.
 * Checked video reaches the media boundary. Normal opt-in controls and separately
 * consented guard/power trials retain distinct admission and request ownership.
 * Separately admitted E10 video receives a checked H.264 RTP track and
 * declines unused media, with no data-channel inventory or control requests.
 * Vendor assets and captures are not dependencies, and hardware needs testing.
 */
import { observeRawPeer, observeRawDataChannel } from "../diagnostics/raw-rtc.js";
import { observeRawSocket } from "../diagnostics/raw-network.js";
import { createHash, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import WebSocket from "ws";
import type { Socket } from "node:dgram";
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCRtpCodecParameters, type RTCDataChannel, type RTCIceServer } from "werift";
import type { VideoCodec } from "../domain/types.js";
import { NvrPtcsReassembler, type NvrPtcsReassemblyStats } from "./nvr-ptcs-reassembly.js";
import { recordRaw } from "../diagnostics/raw-history.js";
import { DoorbellH264Assembler } from "./doorbell-rtp.js";
import { doorbellRtcOffer, doorbellRtcAnswer, type DoorbellRtcOffer } from "./doorbell-rtc-offer.js";
import { refineE10OfferFailure } from "./e10-offer-diagnostic.js";
import { VideoParameterSetCache } from "./live-stream-manager.js";
import { markSourceTime } from "./media-source-clock.js";
import { installE10RelayLifetime } from "./e10-relay-lifetime.js";
import { installNvrIceTiming } from "./nvr-ice-timing.js";
import { installNvrIceGathering } from "./nvr-ice-gathering.js";
import { NvrPowerError, type NvrCameraPower } from "../provider/nvr-power-trial.js";
import { NvrGuardError } from "../provider/nvr-guard-trial.js";
import type { NvrGuardEffective } from "../provider/nvr-guard-schedule.js";
import { NvrTrialError, nvrAudio, nvrAudioChannel, nvrCameraPowerCommand, nvrGuardModeCommand, nvrApplication, nvrCandidate, nvrCommand, nvrHeartbeat, nvrJson,
  nvrMatchCamera, nvrNetworkHost, nvrOffer, nvrPackets, nvrRecord, nvrVideo, nvrStateSummary, type NvrSource, type NvrStateSummary, type NvrTrialStage, type NvrTrialReason } from "./nvr-protocol.js";

import { NvrLiveControlError } from "../provider/nvr-live-controls.js";
import { nvrEffectiveModeBroadcast, type NvrEffectiveModeObservation } from "./nvr-effective-mode.js";
import { nvrLiveCommand, nvrLiveJson, nvrLiveReceipt, nvrLivePanReply, nvrLiveSettings, type NvrLiveSettings, type NvrLiveWrite } from "./nvr-live-control-protocol.js";

const HEARTBEAT_ECHO = nvrHeartbeat();
const NVR_RECEIVE_BUFFER_BYTES = 4 * 1024 * 1024;
const XZYH = Buffer.from("XZYH");

// The slowest measured camera, a doorbell, gave its first picture in 3.4 seconds.
const SWITCH_PICTURE_MILLISECONDS = 8_000;

// For several seconds after a call on it hangs up, the NVR ignores a new call and
// never answers it later. It answers the same call sent again once it is ready, as
// the general route's peers do, so a call goes again at this interval until answered.
const CALL_REPEAT_MILLISECONDS = 5_000;

// The signalling service drops a socket that has been quiet for 120 s (code 1006),
// and a call can only hang up while its socket is open. It answers the general
// route's action-2 ping, so this keeps the socket for calls of any length.
const SIGNALLING_PING_MILLISECONDS = 30_000;

/**
 * Identify supported coded-picture NAL units in already checked Annex-B output.
 * Parameter sets and metadata cannot renew live ownership. This distinguishes
 * picture-bearing output from transport activity, without claiming decode or
 * displayed-frame progression.
 */
function hasCodedPicture(bytes: Buffer, codec: VideoCodec): boolean {
  for (let offset = 0; offset + 4 < bytes.length; offset++) {
    if (bytes[offset] !== 0 || bytes[offset + 1] !== 0) continue;
    const prefix = bytes[offset + 2] === 1 ? 3 : bytes[offset + 2] === 0 && bytes[offset + 3] === 1 ? 4 : 0;
    if (!prefix) continue;
    const header = offset + prefix;
    const width = codec === "h264" ? 1 : 2;
    if (header + width >= bytes.length || (bytes[header]! & 0x80) !== 0) continue;
    const type = codec === "h264" ? bytes[header]! & 0x1f : (bytes[header]! >> 1) & 0x3f;
    if (codec === "h264" ? type >= 1 && type <= 5
      : (bytes[header + 1]! & 7) !== 0 && (type <= 9 || type >= 16 && type <= 21)) return true;
    offset = header;
  }
  return false;
}


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

  /** A validated H.264 offer selects codecs only for separately admitted E10 video. */
  readonly peer: (servers: RTCIceServer[], videoOffer?: DoorbellRtcOffer) => RTCPeerConnection;
}

/** Relative monotonic startup milestones. Missing stages remain null on failure. */
export interface NvrTimings {
  readonly offer: number | null;
  readonly firstLocalCandidate: number | null;
  readonly answerSent: number | null;
  readonly channelOpen: number | null;
  readonly mediaRequest: number | null;
  readonly firstVideo: number | null;
}

/** The provider verifies this binding before and throughout the trial. */
export interface NvrRtcOptions {

  /** Receives one immutable live-start summary on close, never state/control queries. */
  readonly onTimings?: (timings: NvrTimings) => void;

  /**
   * Receives station-wide mode broadcasts on this existing connection only.
   * A null observation retires this connection's readings. No initial mode is
   * inferred and no query, polling or independent observer session is started.
   */
  readonly onEffectiveMode?: (observation: NvrEffectiveModeObservation | null) => void;

  /** Provider-admitted receive-only connection. Media and all control/trial methods are unavailable. */
  readonly modeObserver?: boolean;
  readonly station: string;
  readonly camera: string;
  readonly channel: number;

  /** Expected cloud inventory type, checked against fresh station discovery. */
  readonly cameraType?: number;

  /**
   * Let the provider-qualified experimental T8172 route use its existing
   * twenty-second picture budget when the start receipt is absent. The session
   * independently requires type 89 and the existing sensor-0 selection. No
   * start is repeated or receipt invented.
   */
  readonly s1FirstPictureGrace?: boolean;

  /** Provider-selected lens, or both lenses stacked. Omission preserves the original T8E00 trial. */
  readonly sensor?: NvrSource;
  readonly administrator: string;

  /** Freshly bound administrator display name required by the closed guard command. */
  readonly userName?: string;
  readonly context: NvrSignallingContext;
  readonly signal: AbortSignal;
  readonly current: () => boolean;

  /** Receives this camera's video, and its checked AAC when audio is admitted. */
  readonly ready: (output: PassThrough, codec: () => VideoCodec | null, audio?: PassThrough) => void;

  /**
   * Provider admission, per camera model, to ask for this camera's audio on the
   * start request and deliver checked AAC beside its video. Off by default.
   */
  readonly audio?: boolean;

  /** Provider admission for standalone E10 video. Caller-owned views and finite trials grant no controls. */
  readonly e10RtpTrial?: boolean;

  /**
   * Total owned lifetime, including signalling and media. Omission keeps the
   * finite diagnostic default. Null permits viewer-owned live delivery with a
   * rolling video-progress deadline, never a guard or camera-power trial.
   */
  readonly maximumLifetimeMilliseconds?: number | null;

  /**
   * Monotonic rolling-video lease clock. Omission uses performance.now.
   * Tests may advance this budget without ageing real transport fragments,
   * signalling deadlines or finite trials. The session owns all expiry timers.
   */
  readonly videoProgressNow?: () => number;

  /** Separate provider admission for the manual camera-power trial, never ordinary live view. */
  readonly powerTrial?: boolean;

  /** Separate provider admission for the station-wide Schedule recovery trial. */
  readonly guardTrial?: boolean;

  /** Provider admission for default-off exact-model normal controls, never a trial. */
  readonly liveControls?: boolean;

  /** The admitted profile accepts a pan receipt without waiting for PTZ data. */
  readonly panReceiptOnly?: boolean;
}

/** The camera a live call moves to, and the provider ownership that moves with it. */
export type NvrSwitchTarget = Pick<NvrRtcOptions, "camera" | "channel" | "cameraType" | "sensor" | "liveControls" | "panReceiptOnly"
  | "signal" | "current" | "ready" | "audio" | "onEffectiveMode" | "onTimings">;

interface PendingRequest {
  readonly strict?: boolean;
  readonly command: 9100 | 1003 | 1004 | 1103;
  readonly segment: number;
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly deadline: number;

  /** The receipt window ended, but this start still owns a finite picture wait. */
  readonly pictureGrace?: boolean;
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

  /** Checked AAC delivered for an admitted camera, and audio frames that failed the check. */
  audio: number;
  rejectedAudio: number;
  ignoredUnknownMedia: number;

  /** Forward application-frame gaps recovered within the owning channel. */
  applicationSequenceRecoveries: number;

  /** Video sequence gaps that forced decoder bootstrap to restart. */
  videoSequenceRecoveries: number;

  /** Transport channel of the terminal reorder timeout, or -1 when none occurred. */
  reorderTimeoutChannel: number;

  /** Missing predecessor sequence at that timeout, or -1 when none occurred. */
  reorderTimeoutExpected: number;

  /** Complete waiting frame that reached its deadline, or -1 when none occurred. */
  reorderTimeoutWaiting: number;

  /** Age and total queue size at the terminal timeout, retained after close clears buffers. */
  reorderTimeoutAgeMs: number;
  reorderTimeoutQueued: number;

  /** Calls sent again because the NVR had not answered, and camera lists asked for again. */
  callsRepeated: number;
  inventoryRepeated: number;

  /** Signalling sockets retired after a normal viewer had valid video. */
  signallingClosuresAfterVideo: number;

  /** E10 keepalive envelopes accepted by the local WebSocket send queue, not delivery proof. */
  signallingPingsQueued: number;

  /** E10 action-2 messages observed after authentication, not a per-ping correlation. */
  signallingPingResponses: number;

  /** E10 keepalive queue attempts that threw before any delivery could be established. */
  signallingPingQueueFailures: number;

  /** E10 selected ICE route categories, or -1 before a pair is selected. No addresses are retained. */
  e10LocalRelaySelected: number;
  e10RemoteRelaySelected: number;

  /** E10 selected-pair request and response counts, including consent requests in the request total. */
  e10IceRequests: number;
  e10IceResponses: number;
  e10ConsentRequests: number;

  /** Terminal transport failure categories, or -1 before that transport exists. */
  e10IceFailed: number;
  e10DtlsFailed: number;

  /** Signalling sockets retired after read-only discovery, while the RTC observer remains active. */
  signallingClosuresAfterModeObservation: number;
  stopUnconfirmed: number;
  channel0Frames: number;
  channel1Frames: number;
  channel2Frames: number;
  channel3Frames: number;
  channel4Frames: number;
  channel5Frames: number;
}

/**
 * A large keyframe arrives as one burst, bigger than the default UDP receive buffer. If the gateway
 * is slow to read, the kernel discards the overflow. Hosts may cap this below the request.
 */
export function widenNvrReceiveBuffers(peer: RTCPeerConnection): void {
  for (const transport of peer.iceTransports) {

    // werift keeps its sockets out of its types, and its version is pinned. A test covers the real path.
    const { protocols } = transport.connection as unknown as { protocols: { transport?: { socket?: Socket } }[] };
    for (const protocol of protocols) {
      try { protocol.transport?.socket?.setRecvBufferSize(NVR_RECEIVE_BUFFER_BYTES); }
      catch { /* The default buffer still works, with more loss under load. */ }
    }
  }
}

/**
 * Owns socket, peer, channels, timers, fragment buffers and pending requests.
 * One instance may start once and close repeatedly. Close settles pending work,
 * attempts stop once if needed, and releases resources before its owner releases
 * the lease. All externally visible errors have fixed diagnostic stages.
 */
export class NvrRtcSession {
  #startInvoked = false;
  #timingsEmitted = false;
  #modeObserved = false;
  readonly #timings: { -readonly [Key in keyof NvrTimings]: NvrTimings[Key] } = {
    offer: null, firstLocalCandidate: null, answerSent: null, channelOpen: null, mediaRequest: null, firstVideo: null,
  };
  #output = this.#createOutput();
  #audioOutput = this.#createOutput();
  readonly stats: NvrRtcStats = { packets: 0, frames: 0, video: 0, controlPackets: 0, rejected: 0,
    segmentNotEchoed: 0, staleReplies: 0, ignoredAudio: 0, audio: 0, rejectedAudio: 0, ignoredUnknownMedia: 0,
    applicationSequenceRecoveries: 0, videoSequenceRecoveries: 0, callsRepeated: 0, inventoryRepeated: 0, signallingClosuresAfterVideo: 0, signallingPingsQueued: 0, signallingPingResponses: 0, signallingPingQueueFailures: 0, e10LocalRelaySelected: -1, e10RemoteRelaySelected: -1, e10IceRequests: 0, e10IceResponses: 0, e10ConsentRequests: 0, e10IceFailed: -1, e10DtlsFailed: -1, signallingClosuresAfterModeObservation: 0, stopUnconfirmed: 0,
    reorderTimeoutChannel: -1, reorderTimeoutExpected: -1, reorderTimeoutWaiting: -1,
    reorderTimeoutAgeMs: 0, reorderTimeoutQueued: 0,
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
  #e10Offer: DoorbellRtcOffer | null = null;
  #e10Ssrc: number | null = null;
  #e10NeedRandomAccess = true;
  readonly #e10Assembler = new DoorbellH264Assembler(() => {
    this.#e10NeedRandomAccess = true; this.stats.videoSequenceRecoveries++;
  });
  readonly #channels = new Map<string, RTCDataChannel>();
  readonly #pendingCandidates: string[] = [];
  readonly #localCandidates = new Set<string>();
  readonly #sentCandidates = new Set<string>();
  readonly #turn: RTCIceServer[] = [];
  readonly #lastSequence = new Map<number, number>();

  /** Transport sequences live audio has already used, per channel, which video must not wait for. */
  readonly #audioSequences = new Map<number, Set<number>>();
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
  #livePending: { segment: number; pan: boolean; receipt: 1700 | 1350; acknowledged: boolean; deadline: number; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;

  /** Content-free PTZ settlement counters do not contain reply payloads. */
  readonly controlStats = { panAcknowledgedWithoutData: 0, panTimeouts: 0, panData: 0, panReceipts: 0, rejected: 0 };
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

  /** Checked picture output proves this session started independently of a receipt. */
  #startVideoObserved = false;

  /** Video from the previous camera may still be arriving and is never delivered. */
  #switching = false;

  /** The NVR's camera list from this call's start. It cannot change during a call. */
  #inventory: Record<string, unknown> | null = null;
  #switchPicture: { readonly resolve: () => void; readonly reject: (error: Error) => void } | null = null;

  /** Fixed S1 first-picture bound, independent of a delayed timer or start receipt. */
  #firstPictureDeadline: number | null = null;
  #authenticated = false;
  #accepted = false;
  #offerApplied = false;
  #answerSent = false;
  #signallingUnavailable = false;
  #modeObserverReady = false;
  #mid = "";
  #codec: VideoCodec | null = null;
  #videoSequence: number | null = null;
  #bootstrapped = false;
  #readyResolve: (() => void) | null = null;
  #readyReject: ((error: Error) => void) | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  #callRepeat: NodeJS.Timeout | null = null;
  #signallingPing: NodeJS.Timeout | null = null;
  #sweep: NodeJS.Timeout | null = null;
  #deadline: NodeJS.Timeout | null = null;
  #firstFrame: NodeJS.Timeout | null = null;
  #lastNow = 0;
  readonly #maximumLifetimeMilliseconds: number | null;
  #videoProgressTimer: NodeJS.Timeout | null = null;
  #videoProgressExpiresAt: number | null = null;
  readonly #externalAbort: () => void;

  constructor(private options: NvrRtcOptions, private readonly dependencies: NvrRtcDependencies = {
    socket: (url, protocols, settings) => new WebSocket(url, protocols, settings),
    peer: (servers, offer) => new RTCPeerConnection({ iceServers: servers, ...(offer ? { codecs: { audio: [], video: [
      new RTCRtpCodecParameters({ mimeType: "video/H264", clockRate: 90000, payloadType: offer.payloadType, parameters: offer.parameters }),
    ] } } : {}) }),
  }) {
    if (!["security-smart.eufylife.com", "security-smart-eu.eufylife.com", "security-smart-ie.eufylife.com"].includes(options.context.host)) throw new NvrTrialError("admission");
    this.#maximumLifetimeMilliseconds = options.maximumLifetimeMilliseconds === null ? null
      : options.maximumLifetimeMilliseconds ?? 75_000;
    if (options.modeObserver && (this.#maximumLifetimeMilliseconds !== null || !options.onEffectiveMode
      || options.powerTrial || options.guardTrial || options.liveControls)) throw new NvrTrialError("admission");
    if (this.#maximumLifetimeMilliseconds === null ? options.powerTrial || options.guardTrial
      : !Number.isSafeInteger(this.#maximumLifetimeMilliseconds) || this.#maximumLifetimeMilliseconds < 1_000
        || this.#maximumLifetimeMilliseconds > 2_147_483_647) throw new NvrTrialError("admission");
    if (options.e10RtpTrial && (options.cameraType !== 314 || options.station !== options.camera || options.channel !== 0
      || (options.sensor ?? 0) !== 0 || options.audio || options.modeObserver || options.powerTrial || options.guardTrial
      || options.liveControls)) throw new NvrTrialError("admission");
    this.#externalAbort = () => this.#fail("cancelled");
    options.signal.addEventListener("abort", this.#externalAbort, { once: true });
  }

  /** The current camera's video. A camera switch ends this stream and starts another. */
  get output(): PassThrough { return this.#output; }

  /** The current camera's checked AAC, ended and replaced with its video on a switch. */
  get audioOutput(): PassThrough { return this.#audioOutput; }

  #createOutput(): PassThrough {
    const output = new PassThrough({ highWaterMark: 4 * 1024 * 1024 + 64 });
    output.on("error", () => {});
    return output;
  }

  /** Report only a checked codec, never a model-derived guess. */
  get codec(): VideoCodec | null { return this.#codec; }

  /** Return a detached frozen snapshot, containing no session or candidate identity. */
  get timings(): NvrTimings { return Object.freeze({ ...this.#timings }); }

  #markTiming(stage: keyof NvrTimings): void {
    if (this.#startInvoked && this.#started && this.#timings[stage] === null) {
      this.#timings[stage] = Math.round(Math.max(0, performance.now() - this.#lifetimeStartedAt));
    }
  }

  /**
   * Remaining guaranteed budget before retirement without further video.
   * Finite trials include negotiation. Viewer-owned live budgets renew only
   * when checked video reaches the output, never from heartbeat traffic.
   */
  get remainingLifetimeMilliseconds(): number {
    if (!this.#started || this.#retired) return 0;
    const expires = this.#maximumLifetimeMilliseconds === null ? this.#videoProgressExpiresAt
      : this.#lifetimeStartedAt + this.#maximumLifetimeMilliseconds;
    const now = this.#maximumLifetimeMilliseconds === null
      ? (this.options.videoProgressNow?.() ?? performance.now()) : performance.now();
    return expires === null ? 0 : Math.max(0, expires - now);
  }

  /**
   * Negotiate, correlate fresh discovery, attach the sink and request video once.
   * Checked picture output can satisfy a missing receipt at five seconds. The
   * qualified experimental S1 route can then await its first picture within one
   * twenty-second media budget. A receipt can resolve before video, so playback
   * remains separate. Rejection, cancellation and stale ownership still fail.
   */
  async start(): Promise<void> {
    if (this.options.modeObserver) throw new NvrTrialError("admission");
    if (this.options.powerTrial || this.options.guardTrial) throw this.options.guardTrial
      ? new NvrGuardError("admission") : new NvrPowerError("admission");
    this.#startInvoked = true;
    await this.#connectAndDiscover();
    this.#guard();
    if (this.#e10Offer) {
      this.options.ready(this.output, () => this.#codec);
      return;
    }
    this.options.ready(this.output, () => this.#codec, this.options.audio ? this.#audioOutput : undefined);
    this.#stage = "start";
    const pictureDeadline = this.options.s1FirstPictureGrace && this.options.cameraType === 89 && this.options.sensor === 0
      ? performance.now() + 20_000 : undefined;
    this.#firstPictureDeadline = pictureDeadline ?? null;
    await this.#request(1003, 5000, false, false, pictureDeadline);
    this.#stage = "video";
    if (this.options.liveControls) this.#settingsFlight = this.readLiveSettings().catch(() => ({ night: null, quality: null, tracking: null }));
    if (!this.#bootstrapped) {
      const wait = pictureDeadline === undefined ? 20_000 : Math.max(0, pictureDeadline - performance.now());
      if (this.#maximumLifetimeMilliseconds === null) this.#videoProgressExpiresAt = (this.options.videoProgressNow?.() ?? performance.now()) + wait;
      this.#firstFrame = setTimeout(() => this.#fail("video"), wait);
    }
  }

  /** True while this viewer-owned call is delivering video and nothing else is using it. */
  get switchable(): boolean {
    return this.#maximumLifetimeMilliseconds === null && !this.options.modeObserver && this.#startSent && this.#startVideoObserved
      && !this.#retired && !this.#switching && !this.#pending && !this.#livePending
      && this.#channels.get("WebrtcDataChannel")?.readyState === "open";
  }

  /**
   * True while this read-only mode observer call to `station` is connected and
   * idle. A view on that NVR can then take the call over with switchCamera.
   * The signalling socket must still be open, so the view can hang up later.
   */
  canTakeOver(station: string): boolean {
    return this.options.modeObserver === true && this.options.station === station && this.#modeObserverReady
      && !this.#retired && !this.#switching && !this.#pending && this.#socket?.readyState === WebSocket.OPEN
      && this.#channels.get("WebrtcDataChannel")?.readyState === "open";
  }

  /**
   * Move this call to another camera on the same NVR, without a new call.
   * The previous camera's output ends cleanly and ownership moves synchronously,
   * so the caller may release the previous owner as soon as this returns its
   * promise. The new output is reported only after a checked picture, which
   * leaves a failed switch free to close this call and open a fresh one.
   * Resolves with the milliseconds from the start request to that picture.
   * An idle mode observer call becomes a normal view the same way.
   */
  async switchCamera(target: NvrSwitchTarget): Promise<number> {
    const observer = this.canTakeOver(this.options.station);
    if (!observer && !this.switchable) throw new NvrTrialError("admission");
    this.#switching = true;
    this.options.signal.removeEventListener("abort", this.#externalAbort);

    // The observer's own mode callback must not survive into the view.
    this.options = { ...this.options, ...target, ...observer ? { modeObserver: false, onEffectiveMode: target.onEffectiveMode } : {} };
    this.options.signal.addEventListener("abort", this.#externalAbort, { once: true });
    const previous = this.#output, previousAudio = this.#audioOutput;
    this.#output = this.#createOutput();
    this.#audioOutput = this.#createOutput();
    previous.end();
    previousAudio.end();
    this.#resetVideo();
    this.#renewVideoProgress();

    // An observer call never started a camera, so there is nothing to stop.
    if (!observer) {
      this.#stage = "stop";
      await this.#request(1004, 1500);
    }
    this.#stage = "inventory";
    nvrMatchCamera(this.#inventory!, target.camera, target.channel, target.cameraType ?? 301);
    this.#guard();
    this.#resetVideo();
    this.#switching = false;
    this.#stage = "start";
    const requested = performance.now();

    // A slow camera's picture can come before any receipt does, so give both the same window.
    this.#firstPictureDeadline = requested + SWITCH_PICTURE_MILLISECONDS;
    await this.#request(1003, 5000, false, false, this.#firstPictureDeadline);
    if (!this.#startVideoObserved) await this.#nextPicture();
    const firstPicture = Math.round(performance.now() - requested);
    this.#stage = "video";
    this.options.ready(this.#output, () => this.#codec, this.options.audio ? this.#audioOutput : undefined);
    if (this.options.liveControls) this.#settingsFlight = this.readLiveSettings().catch(() => ({ night: null, quality: null, tracking: null }));
    return firstPicture;
  }

  /** A new camera has its own encoder, sequence numbers and transport frames. */
  #resetVideo(): void {
    this.#cache = new VideoParameterSetCache();
    this.#codec = null; this.#videoSequence = null;
    this.#bootstrapped = false; this.#startVideoObserved = false; this.#settingsFlight = null;
    this.#reassembler.clear(); this.#lastSequence.clear(); this.#audioSequences.clear(); this.#reorder.clear(); this.#reorderBytes = 0;
  }

  #nextPicture(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#switchPicture = null; reject(new NvrTrialError("video", "switch_no_picture")); }, SWITCH_PICTURE_MILLISECONDS);
      this.#switchPicture = { resolve: () => { clearTimeout(timer); this.#switchPicture = null; resolve(); },
        reject: error => { clearTimeout(timer); this.#switchPicture = null; reject(error); } };
    });
  }

  /**
   * Query scoped state without starting media or changing settings.
   * Only a reply echoing this request's segment can satisfy the query, so an
   * unsolicited or uncorrelated state push cannot become fresh readback.
   */
  async readState(): Promise<NvrStateSummary> {
    if (this.options.e10RtpTrial) throw new NvrTrialError("admission");
    if (this.options.modeObserver) throw new NvrTrialError("admission");
    try {
      if (this.#maximumLifetimeMilliseconds === null) throw new NvrTrialError("admission");
      await this.#connectAndDiscover();
      this.#stage = "state";
      const response = await this.#request(1103, 5000);
      this.#guard();
      return nvrStateSummary(response, this.options.channel);
    } finally { await this.close(); }
  }

  /** Discover the admitted camera once, then receive station broadcasts without starting media. */
  async observeEffectiveMode(): Promise<void> {
    if (!this.options.modeObserver) throw new NvrTrialError("admission");
    await this.#connectAndDiscover();
    this.#modeObserverReady = true;
    this.#stage = "state";
  }

  /** Return one background observation without delaying video startup. */
  async initialLiveSettings(): Promise<NvrLiveSettings> {
    return await this.#settingsFlight ?? { night: null, quality: null, tracking: null };
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
    if (this.remainingLifetimeMilliseconds < (movement ? 10000 : 35000)) {
      throw new NvrLiveControlError("unavailable", "source_lifetime");
    }
    if (this.#segment + (movement ? 3 : 16) + 2 > 254) throw new NvrLiveControlError("unavailable", "segment_budget");
  }

  /** Dispatch once after the provider's synchronous final admission check. No retry occurs. */
  async writeLiveControl(request: NvrLiveWrite, signal: AbortSignal, beforeDispatch: () => void): Promise<void> {
    this.#guard();
    const movement = request.kind === "pan" || request.kind === "zoom";
    if (this.remainingLifetimeMilliseconds < (movement ? 10000 : request.kind === "quality" && request.sensor === 1 ? 25000 : 35000)) throw new NvrLiveControlError("unavailable", "source_lifetime");
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
      this.#livePending = { segment, pan: request.kind === "pan", receipt: request.kind === "pan" || request.kind === "tracking" ? 1700 : 1350, acknowledged: false, deadline: performance.now() + 5000,
        resolve: () => finish(), reject: error => finish(error), timer };
      signal.addEventListener("abort", abort, { once: true });
      let dispatched = false;
      try {
        this.#guard(); signal.throwIfAborted();
        const floor = movement ? 10000 : request.kind === "quality" && request.sensor === 1 ? 25000 : 35000;
        if (this.remainingLifetimeMilliseconds < floor) throw new NvrLiveControlError("unavailable", "source_lifetime");
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
    if (this.#maximumLifetimeMilliseconds !== null) {
      this.#deadline = setTimeout(() => this.#fail("deadline"), this.#maximumLifetimeMilliseconds);
    }
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
      this.#socket.on("error", () => {
        if (!this.#canRetireSignalling()) this.#fail(this.#stage, "signalling_error");
      });
      this.#socket.on("close", () => {
        if (!this.#retired && !this.#canRetireSignalling()) this.#fail(this.#stage, "signalling_closed");
      });
      observeRawSocket(this.#socket, "nvr_rtc_signal", "ws");
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
    if (this.#e10Offer) { this.#guard(); return; }
    this.#stage = "inventory";
    let discovery: Record<string, unknown>;
    try { discovery = await this.#request(9100, 5000); }
    catch (error) {

      // Just after a hang-up the NVR can answer a call before it replies on the channel. Ask once more.
      if (!(error instanceof NvrTrialError) || error.stage !== "inventory" || error.reason !== "unspecified") throw error;
      this.stats.inventoryRepeated++;
      discovery = await this.#request(9100, 5000);
    }
    nvrMatchCamera(discovery, this.options.camera, this.options.channel, this.options.cameraType ?? 301);
    this.#inventory = discovery;
    this.#guard();
  }

  /** Attempt stream stop and deterministically retire the original connection. */
  close(): Promise<void> {
    this.#retainE10PeerEvidence();
    if (!this.#timingsEmitted && this.#startInvoked) {
      this.#timingsEmitted = true;
      try { this.options.onTimings?.(this.timings); } catch { /* Diagnostics must never prevent retirement. */ }
    }
    if (this.#closing) return this.#closing;
    this.#livePending?.reject(new NvrLiveControlError("outcome_unknown", "dispatch"));
    this.#retired = true;
    if (this.#modeObserved) {
      this.#modeObserved = false;
      try { this.options.onEffectiveMode?.(null); } catch { /* State listeners must not prevent retirement. */ }
    }
    this.#finishPowerReceipt(new NvrPowerError("shutdown"));
    this.#finishGuardReceipt(new NvrGuardError("shutdown"));
    this.#negotiation.abort();
    this.#abort.abort();
    this.options.signal.removeEventListener("abort", this.#externalAbort);
    this.#readyReject?.(new NvrTrialError("cancelled"));
    this.#readyReject = null; this.#readyResolve = null;
    this.#switchPicture?.reject(new NvrTrialError("cancelled"));
    if (this.#pending) {
      clearTimeout(this.#pending.timer); this.#pending.reject(new NvrTrialError("cancelled")); this.#pending = null;
    }
    for (const timer of [this.#deadline, this.#firstFrame, this.#heartbeat, this.#callRepeat, this.#signallingPing, this.#sweep, this.#videoProgressTimer]) if (timer) clearTimeout(timer);
    this.#videoProgressTimer = null; this.#videoProgressExpiresAt = null;
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
          try {
            // Without a hangup the NVR holds the call for about 25 s, and a third held call goes unanswered.
            if (this.#authenticated && socket.readyState === WebSocket.OPEN) socket.send(this.#envelope(this.#cameraMessage("hangup", {})));

            // A close handshake lets the queued hangup flush before retirement.
            socket.close();
          } catch { socket.terminate(); finished(); }
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
      this.#e10Assembler.clear(); this.#e10Offer = null;
      this.#reassembler.clear(); this.#reorder.clear(); this.#reorderBytes = 0; this.#audioSequences.clear();
      this.#pendingCandidates.length = 0; this.#localCandidates.clear(); this.#turn.length = 0;
      this.output.end();
      this.#audioOutput.end();
    })();
    return this.#closing;
  }

  #guard(): void {
    if (this.#retired || this.options.signal.aborted || !this.options.current()) throw new NvrTrialError("cancelled");
  }

  #canRetireSignalling(): boolean {
    const mode = this.options.modeObserver && this.#modeObserverReady;
    if (this.#maximumLifetimeMilliseconds !== null || !mode && (!this.#startSent || !this.#bootstrapped)) return false;
    if (!this.#signallingUnavailable) {
      this.#signallingUnavailable = true;
      if (mode) this.stats.signallingClosuresAfterModeObservation++; else this.stats.signallingClosuresAfterVideo++;
    }
    return true;
  }

  #fail(stage: NvrTrialStage, reason: NvrTrialReason = "unspecified"): void {
    if (this.#retired) return;
    this.#stage = stage;
    const error = new NvrTrialError(stage, reason);
    this.#readyReject?.(error);
    this.#livePending?.reject(new NvrLiveControlError("outcome_unknown", "dispatch"));
    this.#switchPicture?.reject(error);
    this.#pending?.reject(error);
    this.output.destroy(error);
    this.#audioOutput.end();
    void this.close().catch(() => {});
  }

  #envelope(value: Record<string, unknown>, join = false): string {
    return JSON.stringify({ msgid: join ? "0" : `${this.options.context.authToken}_${randomUUID()}`, data: JSON.stringify(value) });
  }

  #send(value: Record<string, unknown>, join = false): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) throw new NvrTrialError(this.#stage);
    this.#socket.send(this.#envelope(value, join));
  }

  #cameraMessage(kind: string, value: Record<string, unknown>): Record<string, unknown> {
    const ts = Math.floor(Date.now() / 1000);
    const account = createHash("md5").update(`0${this.options.administrator}${ts}`).digest("hex");
    return { code: 200, action: 3, sessionId: this.options.context.sign, sn: this.options.station,
      subSn: "", channelId: 0, isResponse: 0, dataType: kind, source: "WEB", ts,
      data: JSON.stringify({ timestamp: ts, account, ...value }) };
  }

  /** Send the call again until the NVR answers it; the join timer still bounds the whole attempt. */
  #repeatCall(): void {
    this.#callRepeat = setTimeout(() => {
      this.#callRepeat = null;
      if (this.#retired || this.#accepted) return;
      try { this.#action("call", {}); this.stats.callsRepeated++; this.#repeatCall(); }
      catch { /* The join timer reports a call that never connects. */ }
    }, CALL_REPEAT_MILLISECONDS);
  }

  #action(kind: string, value: Record<string, unknown>): void {
    this.#guard(); this.#send(this.#cameraMessage(kind, value));
  }

  async #message(raw: string): Promise<void> {
    this.#guard();
    const outer = nvrJson(raw, this.options.e10RtpTrial ? "outer" : undefined);
    const inner = nvrJson(outer.data, this.options.e10RtpTrial ? "inner" : undefined);
    if (inner.action === 1) {
      if (this.#authenticated || inner.code !== 200) throw new NvrTrialError("join");
      this.#authenticated = true; this.#stage = "call"; this.#action("call", {});
      this.#repeatCall();
      this.#signallingPing = setInterval(() => {
        if (!this.#retired && this.#socket?.readyState === WebSocket.OPEN) {

          // General-camera pings use SMART even though call and hang-up use WEB.
          const source = this.options.e10RtpTrial ? "SMART" : "WEB";
          try {
            this.#send({ action: 2, data: JSON.stringify({ source }), code: 200 }, true);
            if (this.options.e10RtpTrial) this.stats.signallingPingsQueued++;
          } catch {
            if (this.options.e10RtpTrial) this.stats.signallingPingQueueFailures++;

            // The socket's close event still owns failure handling.
          }
        }
      }, SIGNALLING_PING_MILLISECONDS);
      return;
    }

    // The service's answer to the keep-alive ping.
    if (inner.action === 2) {
      if (this.options.e10RtpTrial && this.#authenticated) this.stats.signallingPingResponses++;
      return;
    }
    if (!this.#authenticated || inner.action !== 3) throw new NvrTrialError("call", "call_unexpected_action");
    if (inner.sessionId !== this.options.context.sign) throw new NvrTrialError("negotiation", "session_mismatch");
    if (inner.sn !== this.options.station) throw new NvrTrialError("negotiation", "station_mismatch");
    if (inner.channelId !== 0) throw new NvrTrialError("negotiation", "channel_mismatch");

    // A bound remote hang-up ends the call even when it carries no payload.
    // Parsing its optional body first mislabels it or silently ignores it.
    if (inner.dataType === "hangup") throw new NvrTrialError(this.#stage, "signalling_hangup");
    const data = nvrJson(inner.data, this.options.e10RtpTrial ? "payload" : undefined);
    if (inner.dataType === "call") {
      if (data.status === 486) throw new NvrTrialError("busy");
      if (data.status === 408) throw new NvrTrialError("call", "call_timeout");
      if (data.status === 100) {

        // Each call sent again gets its own relays. The latest apply until the offer creates the peer.
        if (this.#peer) return;
        const rows = Array.isArray(data.turn) ? data.turn : [data.turn];
        if (rows.length > 4) throw new NvrTrialError("negotiation", "relay_count");
        this.#turn.length = 0;
        for (const row of rows) {
          if (!nvrRecord(row)) throw new NvrTrialError("negotiation", "relay_shape");
          const host = row.turn_addr ?? row.addr ?? row.host ?? row.ip, port = row.turn_port ?? row.port ?? 3478;
          const username = row.turn_user ?? row.user ?? row.username, credential = row.turn_password ?? row.password ?? row.credential;
          if (typeof host !== "string" || !nvrNetworkHost(host) || !Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535
            || typeof username !== "string" || !username.length || username.length > 512
            || typeof credential !== "string" || !credential.length || credential.length > 512) throw new NvrTrialError("negotiation", "relay_fields");
          this.#turn.push({ urls: `turn:${host}:${port}?transport=udp`, username, credential });
        }
      } else if (data.status === 200 && !this.#accepted) {
        this.#accepted = true;
        if (this.#callRepeat) clearTimeout(this.#callRepeat);
        this.#callRepeat = null;
        this.#action("ack", {});
      }
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
      let offer: ReturnType<typeof nvrOffer>;
      if (this.options.e10RtpTrial) {
        try { offer = this.#e10Offer = doorbellRtcOffer(data.value); }
        catch {
          throw refineE10OfferFailure(new NvrTrialError("negotiation", "offer_media_tracks"), data.value, this.options);
        }
      } else {
        try { offer = nvrOffer(data.value); }
        catch (error) { throw refineE10OfferFailure(error, data.value, this.options); }
      }
      this.#mid = offer.mid; this.#stage = "negotiation";
      this.#markTiming("offer");
      let peer: RTCPeerConnection;
      try { peer = this.#peer = this.dependencies.peer(this.#turn, this.#e10Offer ?? undefined);
        observeRawPeer(peer, { station: this.options.station, camera: this.options.camera }); }
      catch { throw new NvrTrialError("negotiation", "peer_setup"); }
      peer.connectionStateChange.subscribe(state => { this.#retainE10PeerEvidence(); if (state === "failed" || state === "disconnected") this.#fail("negotiation", state === "failed" ? "peer_failed" : "peer_disconnected"); });
      peer.onIceCandidate.subscribe(candidate => {
        if (!candidate?.candidate || this.#retired) return;
        this.#markTiming("firstLocalCandidate");
        if (this.#localCandidates.size + this.#sentCandidates.size >= 64) { this.#fail("negotiation", "local_candidate_limit"); return; }
        if (this.#sentCandidates.has(candidate.candidate) || this.#localCandidates.has(candidate.candidate)) return;
        if (Buffer.byteLength(candidate.candidate) > 8192 || (this.#localCandidateBytes += Buffer.byteLength(candidate.candidate)) > 65536) { this.#fail("negotiation", "local_candidate_limit"); return; }
        this.#localCandidates.add(candidate.candidate);
        if (this.#answerSent) this.#flushLocal();
      });
      peer.onDataChannel.subscribe(channel => {
        if (this.#e10Offer) { channel.close(); this.#fail("channel"); }
        else this.#attach(channel);
      });
      if (this.#e10Offer) this.#receiveE10Video(peer, this.#e10Offer);
      await this.#step("peer_setup", () => {
        if (!this.#e10Offer) for (const label of ["WebrtcDataChannel", "audio", "idr", "video", "notify", "download"]) this.#attach(peer.createDataChannel(label));
        // The RTP-only peer has no SCTP-created ICE transport at this point.
        // Retain the existing RTP receiver's stock peer timing and bounded owner.
        if (!this.#e10Offer) {
          installNvrIceTiming(peer, this.#negotiation.signal);
          installNvrIceGathering(peer, this.#negotiation.signal);
        }
      });
      await this.#step("remote_description", () => peer.setRemoteDescription(new RTCSessionDescription(offer.sdp, "offer"))); this.#guard();
      if (this.#e10Offer) await this.#step("peer_setup", () => installE10RelayLifetime(peer, this.#negotiation.signal));
      this.#offerApplied = true;
      for (const candidate of this.#pendingCandidates.splice(0)) await this.#candidate(candidate);
      const answer = await this.#step("create_answer", () => peer.createAnswer()); this.#guard();
      await this.#step("local_description", () => peer.setLocalDescription(answer)); this.#guard();
      widenNvrReceiveBuffers(peer);
      await this.#step("send_answer", () => { this.#action("info", { sdp: this.#e10Offer ? doorbellRtcAnswer(this.#e10Offer, peer.localDescription!.sdp) : peer.localDescription!.sdp }); this.#markTiming("answerSent"); this.#answerSent = true; this.#flushLocal(); });
    }
  }

  /** Copy only selected-route categories and counters before the peer is retired. */
  #retainE10PeerEvidence(): void {
    if (this.#retired || !this.options.e10RtpTrial || !this.#peer) return;
    const ice = this.#peer.iceTransports[0]?.connection;
    const dtls = this.#peer.dtlsTransports[0];
    if (ice) this.stats.e10IceFailed = ice.state === "failed" ? 1 : 0;
    if (dtls) this.stats.e10DtlsFailed = dtls.state === "failed" ? 1 : 0;
    const pair = ice?.nominated;
    if (!pair) return;
    this.stats.e10LocalRelaySelected = pair.localCandidate.type === "relay" ? 1 : 0;
    this.stats.e10RemoteRelaySelected = pair.remoteCandidate.type === "relay" ? 1 : 0;
    this.stats.e10IceRequests = pair.requestsSent;
    this.stats.e10IceResponses = pair.responsesReceived;
    this.stats.e10ConsentRequests = pair.consentRequestsSent;
  }

  /** Receive only the selected H.264 track under this E10 call's existing owner. */
  #receiveE10Video(peer: RTCPeerConnection, offer: DoorbellRtcOffer): void {
    peer.onTrack.subscribe(track => {
      if (this.#retired) return;
      if (track.kind !== "video" || this.#e10Ssrc !== null || track.codec?.payloadType !== offer.payloadType) {
        this.#fail("video"); return;
      }
      this.#e10Ssrc = track.ssrc ?? -1;
      track.onReceiveRtp.subscribe(packet => {
        if (this.#retired) return;
        try {
          this.#guard();
          if (packet.header.payloadType !== offer.payloadType) throw new NvrTrialError("video");
          if (this.#e10Ssrc === -1) this.#e10Ssrc = packet.header.ssrc;
          if (packet.header.ssrc !== this.#e10Ssrc) throw new NvrTrialError("video");
          recordRaw({ boundary: "e10_rtc_rtp", connection: String(packet.header.ssrc), direction: "receive",
            metadata: { header: packet.header, decrypted: true } }, packet.payload);
          this.stats.packets++;
          const unit = this.#e10Assembler.push({ sequenceNumber: packet.header.sequenceNumber,
            timestamp: packet.header.timestamp, marker: packet.header.marker, payload: packet.payload });
          if (!unit) return;
          this.stats.frames++; this.stats.video++;
          const previous = this.#cache.diagnostics.randomAccessPictures;
          this.#cache.push(unit, "h264");
          let output = unit;
          if (this.#e10NeedRandomAccess) {
            if (this.#cache.diagnostics.randomAccessPictures === previous || !this.#cache.startup) return;
            output = this.#cache.startup;
            this.#e10NeedRandomAccess = false; this.#bootstrapped = true; this.#codec = "h264";
            this.#markTiming("firstVideo");
          }
          if (!this.output.write(output)) throw new NvrTrialError("video");
          this.#startVideoObserved = true;
          this.#renewVideoProgress();
          this.#readyResolve?.(); this.#readyResolve = null; this.#readyReject = null;
        } catch (error) {
          this.#fail(error instanceof NvrTrialError ? error.stage : "video");
        }
      });
    });
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
      this.#markTiming("channelOpen");
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
    observeRawDataChannel(channel, { station: this.options.station, camera: this.options.camera });
    channel.onmessage = event => {
      if (this.#retired && this.#pending?.command !== 1004) return;
      if (!Buffer.isBuffer(event.data)) { this.stats.rejected++; return; }
      try { this.#packet(event.data); }
      catch (error) { this.#fail(error instanceof NvrTrialError ? error.stage : "framing", error instanceof NvrTrialError ? error.reason : "unspecified"); }
    };
  }

  /** Renew only after usable video reaches the caller-owned output. */
  #renewVideoProgress(): void {
    if (this.#maximumLifetimeMilliseconds !== null) return;
    if (this.#videoProgressTimer) clearTimeout(this.#videoProgressTimer);

    // Leave enough guaranteed budget for the existing 35-second control lease.
    this.#videoProgressExpiresAt = (this.options.videoProgressNow?.() ?? performance.now()) + 45_000;
    const timer = this.#videoProgressTimer = setTimeout(() => {
      if (this.#videoProgressTimer !== timer) return;
      this.#videoProgressTimer = null;
      this.#fail("video", "video_progress_timeout");
    }, 45_000);
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

    // Live audio shares video's transport sequence but arrives on its own data channel,
    // one packet a frame, so it completes ahead of a large keyframe. It never waits for
    // video and never sets the order, or that keyframe would look old and be dropped.
    if (result.frame.length >= 6 && result.frame.readUInt16LE(4) === 1301 && result.frame.subarray(0, 4).equals(XZYH)) {
      this.#audioArrived(result.channel, result.sequence, result.frame);
      return;
    }
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
    if (this.#reorderFull(result.frame.length)) {
      const [oldest] = this.#reorder.values();
      if (oldest) this.#skipGap(oldest.channel);
      if (this.#reorderFull(result.frame.length)) throw new NvrTrialError("framing", "frame_reorder_limit");
    }
    this.#reorder.set(key, { channel: result.channel, sequence: result.sequence, frame: result.frame, at: this.#now() });
    this.#reorderBytes += result.frame.length; this.#drain();
  }

  /** Deliver audio at once and record its number, so video ordering steps over it. */
  #audioArrived(channel: number, sequence: number, frame: Buffer): void {
    const previous = this.#lastSequence.get(channel);

    // Behind the delivered video, it belongs before the current picture or to the previous camera.
    if (previous !== undefined && (sequence - previous + 65536) % 65536 >= 32768) return;
    const used = this.#audioSequences.get(channel) ?? new Set<number>();
    this.#audioSequences.set(channel, used);
    if (used.size < 64) used.add(sequence);
    this.#frame(frame, channel);
    this.#drain();
  }

  #drain(): void {
    for (const [channel, used] of this.#audioSequences) {
      let previous = this.#lastSequence.get(channel);
      if (previous === undefined) continue;
      while (used.delete((previous + 1) % 65536)) {
        previous = (previous + 1) % 65536;
        this.#lastSequence.set(channel, previous);
      }
      for (const sequence of used) if ((sequence - previous + 65536) % 65536 >= 32768) used.delete(sequence);
    }
    for (const [key, item] of this.#reorder) {
      const previous = this.#lastSequence.get(item.channel);
      if (previous !== undefined && item.sequence !== (previous + 1) % 65536) continue;
      this.#reorder.delete(key); this.#reorderBytes -= item.frame.length;
      this.#lastSequence.set(item.channel, item.sequence); this.#frame(item.frame, item.channel);
      this.#drain(); return;
    }

    // Arrival order can place a repaired predecessor after an older waiter.
    // Drain every ready frame before deciding whether a gap still exists.
    for (const item of this.#reorder.values()) {
      const age = (this.#reassembler.lastHeard(item.channel) ?? item.at) - item.at;
      if (age >= 1000) {

        // Keep the first lasting gap for diagnostics. The session carries on from the next keyframe.
        if (this.stats.reorderTimeoutChannel === -1) {
          this.stats.reorderTimeoutChannel = item.channel;
          this.stats.reorderTimeoutExpected = ((this.#lastSequence.get(item.channel) ?? 65535) + 1) % 65536;
          this.stats.reorderTimeoutWaiting = item.sequence;
          this.stats.reorderTimeoutAgeMs = age;
          this.stats.reorderTimeoutQueued = this.#reorder.size;
        }
        this.#skipGap(item.channel);
        return;
      }
    }
  }

  #reorderFull(incomingBytes: number): boolean {
    return this.#reorder.size >= 16 || this.#reorderBytes + incomingBytes > 8 * 1024 * 1024;
  }

  /** Resume from the oldest waiter. Video freezes until the next keyframe rebuilds its startup. */
  #skipGap(channel: number): void {
    const previous = this.#lastSequence.get(channel) ?? 0;
    const waiting = [...this.#reorder.values()].filter(item => item.channel === channel);
    const distance = (sequence: number): number => (sequence - previous + 65536) % 65536;
    const oldest = waiting.reduce((best, item) => distance(item.sequence) < distance(best.sequence) ? item : best);
    this.#lastSequence.set(channel, (oldest.sequence + 65535) % 65536);
    this.stats.applicationSequenceRecoveries++;
    this.#drain();
  }

  #frame(bytes: Buffer, transportChannel: number): void {
    this.stats.frames++;
    const frame = nvrApplication(bytes);
    const mode = nvrEffectiveModeBroadcast(frame, transportChannel);
    if (mode) {
      if (!this.#retired && this.options.current() && this.options.onEffectiveMode) {
        this.#modeObserved = true;
        this.options.onEffectiveMode(mode);
      }
      return;
    }
    if (frame.command === 1301) {

      // Audio before this camera's first picture may still be the previous camera's.
      if (!this.options.audio || !this.#startSent || this.#retired || this.#switching || !this.#startVideoObserved) { this.stats.ignoredAudio++; return; }
      const audio = nvrAudio(frame, this.options.channel);
      if (!audio) { this.stats.rejectedAudio++; return; }
      this.stats.audio++;

      // Video reaches viewers later than audio of the same moment, so viewers align the two by these capture times.
      markSourceTime(audio.bytes, audio.timestamp);
      this.#audioOutput.write(audio.bytes);
      return;
    }
    if (frame.command === 1303) { this.stats.ignoredUnknownMedia++; return; }
    if (frame.command === 1300) {
      if (!this.#startSent || this.#retired || this.#switching) return;
      if (!this.#startVideoObserved && this.#firstPictureDeadline !== null && performance.now() >= this.#firstPictureDeadline) {
        throw new NvrTrialError(this.#stage, this.#stage === "start" ? "start_receipt_timeout" : "unspecified");
      }
      const video = nvrVideo(frame, this.options.channel);
      if (this.#videoSequence !== null && video.sequence !== (this.#videoSequence + 1) % 65536) {
        this.#cache = new VideoParameterSetCache();
        this.#bootstrapped = false;
        this.stats.videoSequenceRecoveries++;
      }
      if (this.#codec && this.#codec !== video.codec) throw new NvrTrialError("video");
      this.#videoSequence = video.sequence; this.#codec = video.codec; this.stats.video++;
      this.#cache.push(video.bytes, video.codec);
      let delivered = video.bytes;
      if (!this.#bootstrapped) {
        const startup = this.#cache.startup;
        if (!startup) return;
        this.#bootstrapped = true;
        if (this.#firstFrame) clearTimeout(this.#firstFrame);
        this.#markTiming("firstVideo");
        markSourceTime(startup, Number(video.timestamp));
        if (!this.output.write(startup)) throw new NvrTrialError("video");
        delivered = startup;
      } else {
        markSourceTime(video.bytes, Number(video.timestamp));
        if (!this.output.write(video.bytes)) throw new NvrTrialError("video");
      }
      const picture = hasCodedPicture(delivered, video.codec);
      if (picture) {
        this.#startVideoObserved = true;
        this.#switchPicture?.resolve();
        const pending = this.#pending;
        if (pending?.command === 1003 && pending.pictureGrace) {
          this.#guard();
          this.#pending = null;
          clearTimeout(pending.timer);
          pending.resolve({});
        }
      }
      if (this.#maximumLifetimeMilliseconds === null && picture) this.#renewVideoProgress();
      return;
    }
    if (this.#livePending) {
      const pending = this.#livePending;
      if (frame.segment !== pending.segment || performance.now() >= pending.deadline
        || frame.channel !== this.options.channel && !(pending.pan && frame.channel === 255)) { this.stats.staleReplies++; return; }
      if (frame.command === pending.receipt) {
        if (frame.channel !== this.options.channel) { this.stats.staleReplies++; return; }
        if (!nvrLiveReceipt(frame.payload)) { this.controlStats.rejected++; pending.reject(new NvrLiveControlError("outcome_unknown", "receipt")); return; }
        pending.acknowledged = true;

        // Receipt-only profiles send no PTZ data after the receipt; any other pan resolves on the data reply.
        if (!pending.pan) pending.resolve();
        else if (this.options.panReceiptOnly) { this.controlStats.panReceipts++; pending.resolve(); }
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

  #request(command: 9100 | 1003 | 1004 | 1103, timeout: number, closing = false, strict = false, pictureDeadline?: number): Promise<Record<string, unknown>> {
    if (this.options.modeObserver && command !== 9100) return Promise.reject(new NvrTrialError("admission"));
    if (!closing) this.#guard();
    if (this.#pending || this.#livePending || this.#segment >= 254 || this.options.liveControls && command !== 1004 && this.#segment >= 252) return Promise.reject(new NvrTrialError(this.#stage));
    const channel = this.#channels.get("WebrtcDataChannel");
    if (!channel || channel.readyState !== "open" || channel.bufferedAmount > 1024 * 1024) return Promise.reject(new NvrTrialError("channel"));
    return new Promise((resolve, reject) => {
      const segment = ++this.#segment;
      const expired = (): void => {
        const pending = this.#pending;
        if (pending?.segment !== segment) return;

        // Some peers send usable video without a matching start receipt. Only
        // this start's checked picture output can satisfy its missing receipt.
        if (command === 1003 && this.#startVideoObserved) {
          this.#pending = null;
          try { this.#guard(); resolve({}); }
          catch (error) { reject(error instanceof Error ? error : new NvrTrialError("cancelled")); }
          return;
        }
        if (command === 1003 && pictureDeadline !== undefined && !pending.pictureGrace
          && performance.now() < pictureDeadline) {
          try { this.#guard(); }
          catch (error) {
            this.#pending = null;
            reject(error instanceof Error ? error : new NvrTrialError("cancelled"));
            return;
          }

          // The source contract gives this S1 route a picture deadline rather
          // than requiring a start ACK. Keep one request, the same identity and
          // its original deadline. A checked picture can finish this grace.
          this.#pending = { ...pending, pictureGrace: true, deadline: pictureDeadline,
            timer: setTimeout(expired, Math.max(0, pictureDeadline - performance.now())) };
          return;
        }
        this.#pending = null;
        reject(new NvrTrialError(command === 1004 ? "stop" : this.#stage,
          command === 1003 ? "start_receipt_timeout" : "unspecified"));
      };
      const timer = setTimeout(expired, timeout);
      this.#pending = { command, segment, resolve, reject, timer, strict, deadline: performance.now() + timeout };
      if (command === 1003) this.#startSent = true;
      try {
        const audio = command === 1003 && this.options.audio ? nvrAudioChannel(this.options.channel) : -1;
        for (const packet of nvrPackets(nvrCommand(this.options.administrator, command, segment, this.options.channel, this.options.sensor ?? 1, audio), this.#outSequence++ % 65536, Date.now())) channel.send(packet);
        if (command === 1003) this.#markTiming("mediaRequest");
      } catch { clearTimeout(timer); this.#pending = null; reject(new NvrTrialError(this.#stage)); }
    });
  }
}
