/**
 * Owns one default-off NVR diagnostic connection from join through bounded close.
 * The provider owns the station lease and supplies private Mega credentials.
 * Only checked video reaches its output. No vendor assets, captures or settings
 * writes are used, and this candidate does not establish hardware support.
 */
import { createHash, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import WebSocket from "ws";
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, type RTCDataChannel, type RTCIceServer } from "werift";
import type { VideoCodec } from "../domain/types.js";
import { NvrPtcsReassembler, type NvrPtcsReassemblyStats } from "./nvr-ptcs-reassembly.js";
import { VideoParameterSetCache } from "./live-stream-manager.js";
import { installNvrIceTiming } from "./nvr-ice-timing.js";
import { NvrTrialError, nvrApplication, nvrCandidate, nvrCommand, nvrHeartbeat, nvrJson,
  nvrMatchCamera, nvrNetworkHost, nvrOffer, nvrPackets, nvrRecord, nvrVideo, nvrStateSummary, type NvrStateSummary, type NvrTrialStage, type NvrTrialReason } from "./nvr-protocol.js";

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
  readonly context: NvrSignallingContext;
  readonly signal: AbortSignal;
  readonly current: () => boolean;
  readonly ready: (output: PassThrough, codec: () => VideoCodec | null) => void;

  /** Total owned session lifetime, including signalling and media delivery. */
  readonly maximumLifetimeMilliseconds?: number;
}

interface PendingRequest {
  readonly command: 9100 | 1003 | 1004 | 1103;
  readonly segment: number;
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
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

  /** Negotiate, correlate fresh discovery, attach the sink, and request video once. */
  async start(): Promise<void> {
    await this.#connectAndDiscover();
    this.options.ready(this.output, () => this.#codec);
    this.#stage = "start";
    await this.#request(1003, 5000);
    this.#stage = "video";
    if (!this.#bootstrapped) this.#firstFrame = setTimeout(() => this.#fail("video"), 20_000);
  }

  /** Query one scoped parameter response without starting media or changing settings. */
  async readState(): Promise<NvrStateSummary> {
    try {
      await this.#connectAndDiscover();
      this.#stage = "state";
      const response = await this.#request(1103, 5000);
      this.#guard();
      return nvrStateSummary(response, this.options.channel);
    } finally { await this.close(); }
  }

  async #connectAndDiscover(): Promise<void> {
    if (this.#started || this.options.signal.aborted) throw new NvrTrialError("cancelled");
    this.#started = true;
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
    this.#retired = true;
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
    const pending = this.#pending;
    if (!pending || frame.channel !== 255 || frame.segment !== 0 && frame.segment !== pending.segment) { this.stats.staleReplies++; return; }
    if (frame.segment === 0) this.stats.segmentNotEchoed++;
    if (frame.command === 1350 && frame.payload.length >= 4
      && frame.payload.subarray(4).every((byte) => byte === 0)) {
      if (frame.payload.readInt32LE(0) !== 0) { pending.reject(new NvrTrialError(this.#stage)); clearTimeout(pending.timer); this.#pending = null; }
      else if (pending.command === 1003 || pending.command === 1004) { pending.resolve({}); clearTimeout(pending.timer); this.#pending = null; }
      return;
    }
    if (frame.command !== 1351) { this.stats.staleReplies++; return; }
    const response = nvrJson(frame.payload.toString("utf8"));
    if (response.cmd !== pending.command) { this.stats.staleReplies++; return; }
    if (response.mIntRet !== undefined && response.mIntRet !== 0) pending.reject(new NvrTrialError(this.#stage));
    else pending.resolve(response);
    clearTimeout(pending.timer); this.#pending = null;
  }

  #request(command: 9100 | 1003 | 1004 | 1103, timeout: number, closing = false): Promise<Record<string, unknown>> {
    if (!closing) this.#guard();
    if (this.#pending || this.#segment >= 254) return Promise.reject(new NvrTrialError(this.#stage));
    const channel = this.#channels.get("WebrtcDataChannel");
    if (!channel || channel.readyState !== "open" || channel.bufferedAmount > 1024 * 1024) return Promise.reject(new NvrTrialError("channel"));
    return new Promise((resolve, reject) => {
      const segment = ++this.#segment;
      const timer = setTimeout(() => { this.#pending = null; reject(new NvrTrialError(command === 1004 ? "stop" : this.#stage)); }, timeout);
      this.#pending = { command, segment, resolve, reject, timer };
      if (command === 1003) this.#startSent = true;
      try {
        for (const packet of nvrPackets(nvrCommand(this.options.administrator, command, segment, this.options.channel, this.options.sensor ?? 1), this.#outSequence++ % 65536, Date.now())) channel.send(packet);
      } catch { clearTimeout(timer); this.#pending = null; reject(new NvrTrialError(this.#stage)); }
    });
  }
}
