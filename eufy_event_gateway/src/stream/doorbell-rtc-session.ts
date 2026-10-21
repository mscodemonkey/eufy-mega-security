/**
 * Owns one default-off native doorbell video call and its RTP receiver.
 * The provider supplies current inventory ownership, a cloud sign and an
 * exclusive media lease. This session never issues settings or binary commands,
 * and sends only checked H.264 access units to the diagnostic clip recorder.
 */
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { PassThrough } from "node:stream";
import WebSocket from "ws";
import { RTCPeerConnection, RTCSessionDescription, RTCRtpCodecParameters, type RTCIceServer } from "werift";
import type { NvrSignallingContext } from "./nvr-rtc-session.js";
import { nvrCandidate, nvrNetworkHost, nvrRecord } from "./nvr-protocol.js";
import { VideoParameterSetCache } from "./live-stream-manager.js";
import { DoorbellH264Assembler } from "./doorbell-rtp.js";
import { DoorbellRtcError, doorbellRtcOffer, doorbellRtcAnswer, type DoorbellRtcStage, type DoorbellRtcOffer } from "./doorbell-rtc-offer.js";

/** The provider owns these private values and verifies the binding throughout the call. */
export interface DoorbellRtcOptions {
  readonly station: string;
  readonly administrator: string;
  readonly context: NvrSignallingContext;
  readonly signal: AbortSignal;
  readonly current: () => boolean;

  /** Internal test deadline, capped at the production 35-second startup limit. */
  readonly startupTimeoutMilliseconds?: number;

  /** Maximum media lifetime after decoder startup, owned by the calling lease. */
  readonly maximumLifetimeMilliseconds?: number;

  /** Attach the owned source before its first complete decoder startup is written. */
  readonly ready: (output: PassThrough) => void;
}

/** Local tests inject sockets and peers without contacting an Eufy account. */
export interface DoorbellRtcDependencies {
  readonly socket: (url: string, protocols: string[], options: WebSocket.ClientOptions) => WebSocket;
  readonly peer: (servers: RTCIceServer[], offer: DoorbellRtcOffer) => RTCPeerConnection;
}

function record(value: unknown, stage: DoorbellRtcStage): Record<string, unknown> {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 65536) throw new DoorbellRtcError(stage);
    try { value = JSON.parse(value); } catch { throw new DoorbellRtcError(stage); }
  }
  if (!nvrRecord(value)) throw new DoorbellRtcError(stage);
  return value;
}

/**
 * Owns signaling, one receive-only video peer, assembly and bounded retirement.
 * Start resolves after a complete H.264 bootstrap, not after ICE connection.
 * Closing is idempotent, invalidates asynchronous work and ends the private
 * output. Hardware playback remains unconfirmed until the clip is decoded.
 */
export class DoorbellRtcSession {

  /** Checked video owned by this call, ended on cancellation or transport failure. */
  readonly output = new PassThrough({ highWaterMark: 4 * 1024 * 1024 + 64 });
  readonly #assembler = new DoorbellH264Assembler(() => { this.#needRandomAccess = true; });
  #parameters = new VideoParameterSetCache();
  readonly #turn: RTCIceServer[] = [];
  readonly #remoteCandidates: string[] = [];
  readonly #localCandidates = new Set<string>();
  readonly #sentCandidates = new Set<string>();
  #socket: WebSocket | null = null;
  #peer: RTCPeerConnection | null = null;
  #offer: DoorbellRtcOffer | null = null;
  #earlyOffer: DoorbellRtcOffer | null = null;
  #chain: Promise<void> = Promise.resolve();
  #queued = 0;
  #candidateCount = 0;
  #candidateBytes = 0;
  #authenticated = false;
  #accepted = false;
  #answerSent = false;
  #started = false;
  #retired = false;
  #attached = false;
  #needRandomAccess = true;
  #videoSsrc: number | null = null;
  #closing: Promise<void> | null = null;
  #deadline: NodeJS.Timeout | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  #lastPingAck = 0;
  #stage: DoorbellRtcStage = "join";
  #resolve: (() => void) | null = null;
  #reject: ((error: Error) => void) | null = null;
  readonly #abort = (): void => { void this.close().catch(() => undefined); };

  constructor(private readonly options: DoorbellRtcOptions, private readonly dependencies: DoorbellRtcDependencies = {
    socket: (url, protocols, settings) => new WebSocket(url, protocols, settings),
    peer: (iceServers, offer) => new RTCPeerConnection({ iceServers, codecs: { audio: [], video: [
      new RTCRtpCodecParameters({ mimeType: "video/H264", clockRate: 90000,
        payloadType: offer.payloadType, parameters: offer.parameters,
        rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }] }),
    ] } }),
  }) {
    const deadline = options.startupTimeoutMilliseconds ?? 35_000;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 35_000) throw new DoorbellRtcError("admission");
    const lifetime = options.maximumLifetimeMilliseconds ?? 25_000;
    if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > 2_147_000_000) throw new DoorbellRtcError("admission");
    this.output.on("error", () => undefined);
  }

  /** Connect one user-consented call, stopping if ownership changes or no video arrives. */
  async start(): Promise<void> {
    if (this.#started) throw new DoorbellRtcError("admission");
    this.#started = true;
    this.#guard();
    const host = this.options.context.host;
    if (!/^security-smart(?:-(?:eu|ie))?\.eufylife\.com$/.test(host)) throw new DoorbellRtcError("sign");
    const ready = new Promise<void>((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
    void ready.catch(() => undefined);
    this.options.signal.addEventListener("abort", this.#abort, { once: true });
    this.#deadline = setTimeout(() => this.#fail("deadline"), this.options.startupTimeoutMilliseconds ?? 35_000);
    try {
      const protocols = ["v1", Buffer.from(JSON.stringify({ region: this.options.context.region,
        type: "NVR", sn: this.options.station, token: this.options.context.authToken,
        gtoken: this.options.context.gtoken, sign: this.options.context.sign,
        appName: "eufy_mega", modelType: "WEB" })).toString("base64url")];
      this.#socket = this.dependencies.socket(`wss://${host}/v1/rtc/ws/join?reqtype=nvr`, protocols, {
        headers: { Origin: "https://security.eufy.com" }, followRedirects: false, maxPayload: 65536,
        handshakeTimeout: 10_000, perMessageDeflate: false,
      });
      this.#socket.on("open", () => {
        try {
          this.#guard();
          this.#send({ code: 200, action: 1, data: this.options.context.sign, sn: this.options.station,
            source: "WEB", ts: Math.floor(Date.now() / 1000) }, true);
        } catch { this.#fail("join"); }
      });
      this.#socket.on("error", () => this.#fail(this.#stage));
      this.#socket.on("close", () => { if (!this.#retired) this.#fail(this.#stage); });
      this.#socket.on("message", raw => {
        if (this.#retired) return;
        if (++this.#queued > 32) { this.#fail("call"); return; }
        this.#chain = this.#chain.then(async () => { this.#guard(); await this.#message(raw.toString()); })
          .catch(error => this.#fail(error instanceof DoorbellRtcError ? error.stage : this.#stage,
            error instanceof DoorbellRtcError ? error.reason : "unspecified"))
          .finally(() => { this.#queued--; });
      });
      await ready;
    } catch (error) {
      await this.close();
      throw error instanceof DoorbellRtcError ? error : new DoorbellRtcError(this.#stage);
    }
  }

  /** Stop only this original call, cancel queued transitions and release buffered media. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#retired = true;
    this.options.signal.removeEventListener("abort", this.#abort);
    if (this.#deadline) clearTimeout(this.#deadline);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#reject?.(new DoorbellRtcError("cancelled"));
    this.#reject = null; this.#resolve = null;
    this.#assembler.clear(); this.#parameters = new VideoParameterSetCache();
    this.#earlyOffer = null; this.#offer = null;
    this.#remoteCandidates.splice(0); this.#localCandidates.clear(); this.#turn.splice(0);
    const socket = this.#socket, peer = this.#peer;
    this.#socket = null; this.#peer = null;
    this.#closing = (async () => {
      if (socket) {
        socket.removeAllListeners("message");
        if (socket.readyState === WebSocket.OPEN) {
          await new Promise<void>(resolve => {
            let finished = false;
            const finish = (): void => {
              if (finished) return;
              finished = true; clearTimeout(timer); socket.removeListener("close", finish);
              if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
              resolve();
            };
            const timer = setTimeout(finish, 500);
            socket.once("close", finish);
            try {
              if (this.#authenticated) socket.send(JSON.stringify(this.#envelope(this.#cameraMessage("hangup", {}))));

              // A close handshake lets the queued hangup flush before retirement.
              socket.close();
            } catch { finish(); }
          });
        } else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      }
      try { if (peer) await peer.close(); }
      finally { this.output.end(); }
    })();
    return this.#closing;
  }

  #guard(): void {
    if (this.#retired || this.options.signal.aborted || !this.options.current()) throw new DoorbellRtcError("cancelled");
  }

  #fail(stage: DoorbellRtcStage, reason: DoorbellRtcError["reason"] = "unspecified"): void {
    if (this.#retired) return;
    this.#stage = stage;
    const error = new DoorbellRtcError(stage, reason);
    this.#reject?.(error); this.#reject = null; this.#resolve = null;
    this.output.destroy(error);
    void this.close().catch(() => undefined);
  }

  #envelope(value: Record<string, unknown>, join = false): Record<string, unknown> {
    return { msgid: join ? "0" : `${this.options.context.authToken}_${randomUUID()}`, data: JSON.stringify(value) };
  }

  #send(value: Record<string, unknown>, join = false): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) throw new DoorbellRtcError(this.#stage);
    this.#socket.send(JSON.stringify(this.#envelope(value, join)));
  }

  #cameraMessage(kind: string, value: Record<string, unknown>): Record<string, unknown> {
    const ts = Math.floor(Date.now() / 1000);
    const account = createHash("md5").update(`0${this.options.administrator}${ts}`).digest("hex");
    return { code: 200, action: 3, sessionId: this.options.context.sign, sn: this.options.station,
      subSn: "", channelId: 0, isResponse: 0, dataType: kind, source: "WEB", ts,
      data: JSON.stringify({ timestamp: ts, account, ...value }) };
  }

  #action(kind: string, value: Record<string, unknown>): void {
    this.#guard(); this.#send(this.#cameraMessage(kind, value));
  }

  async #message(raw: string): Promise<void> {
    const inner = record(record(raw, this.#stage).data, this.#stage);
    if (inner.action === 1) {
      if (this.#authenticated || inner.code !== 200) throw new DoorbellRtcError("join");
      this.#authenticated = true; this.#lastPingAck = Date.now(); this.#stage = "call";
      this.#action("call", {});
      this.#heartbeat = setInterval(() => {
        try {
          this.#guard();
          if (Date.now() - this.#lastPingAck >= 30_000) throw new DoorbellRtcError("call");
          this.#send({ code: 200, action: 2, data: JSON.stringify({ source: "WEB" }) }, true);
        } catch { this.#fail("call"); }
      }, 10_000);
      return;
    }
    if (inner.action === 2 && this.#authenticated && inner.code === 200) { this.#lastPingAck = Date.now(); return; }
    if (!this.#authenticated || inner.action !== 3 || inner.sessionId !== this.options.context.sign
      || inner.sn !== this.options.station || inner.channelId !== 0
      || inner.code !== undefined && inner.code !== 200
      || inner.subSn !== undefined && inner.subSn !== "" && inner.subSn !== this.options.station) {
      throw new DoorbellRtcError("call");
    }
    const data = record(inner.data, "call");
    if (inner.dataType === "hangup") throw new DoorbellRtcError("call");
    if (inner.dataType === "call") {
      if (data.status === 486) throw new DoorbellRtcError("busy");
      if (data.status === 408) throw new DoorbellRtcError("call");
      if (data.status === 100) this.#relays(data.turn);
      else if (data.status === 200 && !this.#accepted) {
        this.#accepted = true; this.#action("ack", {});
        const offer = this.#earlyOffer; this.#earlyOffer = null;
        if (offer) await this.#negotiate(offer);
      }
      else if (data.status !== 200) throw new DoorbellRtcError("call");
      return;
    }
    if (inner.dataType !== "info") return;
    if (data.format === "CANDIDATE" || data.candidate !== undefined) {
      let candidate: string;
      try { candidate = nvrCandidate(data.format === "CANDIDATE" ? data.value : data.candidate); }
      catch { throw new DoorbellRtcError("peer"); }
      if (++this.#candidateCount > 64 || (this.#candidateBytes += Buffer.byteLength(candidate)) > 65536) throw new DoorbellRtcError("peer");
      if (!this.#offer || !this.#answerSent) this.#remoteCandidates.push(candidate);
      else await this.#candidate(candidate);
    } else if (data.format === "SDP" || data.sdp !== undefined) {
      if (this.#peer || this.#earlyOffer) throw new DoorbellRtcError("offer");
      const offer = doorbellRtcOffer(data.value ?? data.sdp);
      if (!this.#accepted) { this.#earlyOffer = offer; return; }
      await this.#negotiate(offer);
    }
  }

  #relays(value: unknown): void {
    const rows = Array.isArray(value) ? value : [value];
    if (this.#turn.length || rows.length < 1 || rows.length > 4) throw new DoorbellRtcError("peer");
    for (const row of rows) {
      if (!nvrRecord(row)) throw new DoorbellRtcError("peer");
      const host = row.turn_addr ?? row.addr, port = row.turn_port ?? row.port;
      const username = row.turn_user ?? row.user, credential = row.turn_password ?? row.password;
      if (typeof host !== "string" || !nvrNetworkHost(host) || !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535
        || typeof username !== "string" || !username.length || username.length > 512
        || typeof credential !== "string" || !credential.length || credential.length > 512) throw new DoorbellRtcError("peer");
      this.#turn.push({ urls: `turn:${isIP(host) === 6 ? `[${host}]` : host}:${port}?transport=udp`, username, credential });
    }
  }

  async #candidate(candidate: string): Promise<void> {
    this.#guard();
    try { await this.#peer!.addIceCandidate({ candidate, sdpMid: this.#offer!.mid, sdpMLineIndex: 0 }); }
    catch { throw new DoorbellRtcError("peer"); }
    this.#guard();
  }

  async #negotiate(offer: DoorbellRtcOffer): Promise<void> {
    if (!this.#accepted || this.#peer) throw new DoorbellRtcError("offer");
    this.#offer = offer;
    this.#stage = "peer";
    const peer = this.#peer = this.dependencies.peer(this.#turn, offer);
    peer.connectionStateChange.subscribe(state => {
      if (state === "failed" || state === "disconnected") this.#fail("peer");
    });
    peer.onIceCandidate.subscribe(candidate => {
      if (!candidate?.candidate || this.#retired || this.#sentCandidates.has(candidate.candidate)) return;
      let checked: string;
      try { checked = nvrCandidate(candidate.candidate); }
      catch { this.#fail("peer"); return; }
      if (this.#localCandidates.size + this.#sentCandidates.size >= 64) { this.#fail("peer"); return; }
      this.#localCandidates.add(checked);
      if (this.#answerSent) this.#flushCandidates();
    });
    peer.onTrack.subscribe(track => {
      if (track.kind !== "video") return;
      if (this.#videoSsrc !== null) { this.#fail("video"); return; }
      if (track.codec?.payloadType !== offer.payloadType) { this.#fail("video"); return; }
      this.#videoSsrc = track.ssrc ?? -1;
      track.onReceiveRtp.subscribe(packet => {
        try {
          this.#guard();
          if (packet.header.payloadType !== offer.payloadType) return;
          if (this.#videoSsrc === -1) this.#videoSsrc = packet.header.ssrc;
          if (packet.header.ssrc !== this.#videoSsrc) throw new DoorbellRtcError("video");
          const unit = this.#assembler.push({ sequenceNumber: packet.header.sequenceNumber,
            timestamp: packet.header.timestamp, marker: packet.header.marker, payload: packet.payload });
          if (!unit) return;
          const previousPictures = this.#parameters.diagnostics.randomAccessPictures;
          this.#parameters.push(unit, "h264");
          if (this.#needRandomAccess) {
            if (this.#parameters.diagnostics.randomAccessPictures === previousPictures) return;
            const startup = this.#parameters.startup;
            if (!startup) return;
            this.#needRandomAccess = false;
            if (!this.#attached) { this.#attached = true; this.options.ready(this.output); }
            if (!this.output.write(startup)) throw new DoorbellRtcError("video");
            if (this.#resolve) {
              this.#resolve(); this.#resolve = null; this.#reject = null;
              if (this.#deadline) clearTimeout(this.#deadline);
              this.#deadline = setTimeout(() => this.#fail("deadline"), this.options.maximumLifetimeMilliseconds ?? 25_000);
            }
          } else if (!this.output.write(unit)) throw new DoorbellRtcError("video");
        } catch (error) { this.#fail(error instanceof DoorbellRtcError ? error.stage : "video",
          error instanceof DoorbellRtcError ? error.reason : "unspecified"); }
      });
    });
    try {
      await peer.setRemoteDescription(new RTCSessionDescription(offer.sdp, "offer")); this.#guard();
      const answer = await peer.createAnswer(); this.#guard();
      await peer.setLocalDescription(answer); this.#guard();
      this.#action("info", { sdp: doorbellRtcAnswer(offer, peer.localDescription!.sdp) });
      this.#answerSent = true; this.#flushCandidates();
      for (const candidate of this.#remoteCandidates.splice(0)) await this.#candidate(candidate);
      this.#stage = "video";
    } catch (error) { throw error instanceof DoorbellRtcError ? error : new DoorbellRtcError("peer"); }
  }

  #flushCandidates(): void {
    try {
      for (const candidate of this.#localCandidates) { this.#action("info", { candidate }); this.#sentCandidates.add(candidate); }
      this.#localCandidates.clear();
    } catch { this.#fail("peer"); }
  }
}
