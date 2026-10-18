/**
 * Owns one encrypted general-portal video call for the manual RTC experiment.
 * The provider supplies a bound identity and exclusive parent lease. This
 * session owns socket, peer, timers and bounded H.264 assembly until retirement.
 * It never authenticates an account, changes settings or publishes snapshots.
 */
import { createHash, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import WebSocket from "ws";
import { RTCPeerConnection, RTCSessionDescription, RTCRtpCodecParameters, type RTCIceServer } from "werift";
import type { GeneralRtcCipher } from "../mega/general-rtc-identity.js";
import { DoorbellH264Assembler } from "./doorbell-rtp.js";
import { VideoParameterSetCache } from "./live-stream-manager.js";
import { generalRtcOffer, generalRtcAnswer, type GeneralRtcOffer } from "./general-rtc-offer.js";
import { generalRtcCandidate, generalRtcRelays } from "./general-rtc-network.js";
import { GeneralRtcError, type GeneralRtcStage } from "./general-rtc-protocol.js";
import { nvrRecord } from "./nvr-protocol.js";

/** Private immutable binding supplied by the owning provider lease. */
export interface GeneralRtcSessionOptions {
  readonly host: string;
  readonly token: string;
  readonly sign: string;
  readonly pin: string;
  readonly parent: string;
  readonly child: string;
  readonly administrator: string;
  readonly channel: number;
  readonly cipher: GeneralRtcCipher;
  readonly signal: AbortSignal;
  readonly current: () => boolean;

  /** Attach the private recorder before writing its first complete H.264 bootstrap. */
  readonly ready: (output: PassThrough) => void;
}

/** Offline tests replace both network owners and monotonic/epoch clocks. */
export interface GeneralRtcSessionDependencies {
  readonly socket: (url: string, protocols: string[], options: WebSocket.ClientOptions) => WebSocket;
  readonly peer: (servers: RTCIceServer[], offer: GeneralRtcOffer) => RTCPeerConnection;
  readonly now: () => number;
  readonly epoch: () => number;
}

function boundedRecord(value: unknown, depth = 1): Record<string, unknown> {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 65536) throw new GeneralRtcError("call", "frame");
    try { value = JSON.parse(value); } catch { throw new GeneralRtcError("call", "frame"); }
  }
  if (!nvrRecord(value)) throw new GeneralRtcError("call", "frame");
  const check = (item: unknown, level: number): void => {
    if (level > 8) throw new GeneralRtcError("call", "frame");
    if (item && typeof item === "object") for (const child of Object.values(item)) check(child, level + 1);
  };
  check(value, depth);
  return value;
}

/** Construct the video-only receiver with exactly the relay list validated by this call. */
export function createGeneralRtcPeer(iceServers: RTCIceServer[], offer: GeneralRtcOffer): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers, codecs: { audio: [], video: [
    new RTCRtpCodecParameters({ mimeType: "video/H264", clockRate: 90000, payloadType: offer.payloadType,
      parameters: offer.parameters, rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }] }),
  ] } });
}

/**
 * Retains one private encrypted socket and receive-only peer per prepared call.
 * Construction opens the socket synchronously after sign acquisition. Start is
 * accepted once and resolves only when a checked video bootstrap is attached.
 * Close is idempotent and bounds both network-owner cleanup operations.
 */
export class GeneralRtcSession {

  /** Checked Annex-B video owned solely by the private diagnostic recorder. */
  readonly output = new PassThrough({ highWaterMark: 4 * 1024 * 1024 + 64 });
  readonly #assembler = new DoorbellH264Assembler(() => { this.#needRandomAccess = true; });
  #parameters = new VideoParameterSetCache();
  #socket: WebSocket | null = null;
  #peer: RTCPeerConnection | null = null;
  #offer: GeneralRtcOffer | null = null;
  #offerText: string | null = null;
  #turn: RTCIceServer[] | null = null;
  #chain: Promise<void> = Promise.resolve();
  #queued = 0;
  #unknown = 0;
  #started = false;
  #authSent = false;
  #authenticated = false;
  #accepted = false;
  #negotiating = false;
  #retired = false;
  #answerSent = false;
  #attached = false;
  #needRandomAccess = true;
  #ssrc: number | null = null;
  #callCount = 0;
  #lastCall = -Infinity;
  #pingPending = false;
  readonly #localCandidates = new Set<string>();
  readonly #sentCandidates = new Set<string>();
  #deadline: NodeJS.Timeout | null = null;
  #callTimer: NodeJS.Timeout | null = null;
  #pingTimer: NodeJS.Timeout | null = null;
  #pingDeadline: NodeJS.Timeout | null = null;
  #closing: Promise<void> | null = null;
  #failure: GeneralRtcError | null = null;
  #stage: GeneralRtcStage = "join";
  #resolve: (() => void) | null = null;
  #reject: ((error: GeneralRtcError) => void) | null = null;
  readonly #abort = (): void => { this.#fail(new GeneralRtcError("cancelled")); };

  constructor(private readonly options: GeneralRtcSessionOptions,
    private readonly dependencies: GeneralRtcSessionDependencies = {
      socket: (url, protocols, settings) => new WebSocket(url, protocols, settings),
      peer: createGeneralRtcPeer, now: () => performance.now(), epoch: () => Date.now(),
    }) {
    this.output.on("error", () => undefined);
    this.#guard();
    if (!/^security-smart(?:-(?:eu|ie))?\.eufylife\.com$/.test(options.host)) throw new GeneralRtcError("sign", "shape");
    try {
      this.#socket = dependencies.socket(`wss://${options.host}/v1/smart/ws/join?sign=${encodeURIComponent(options.sign)}&pin=${encodeURIComponent(options.pin)}`,
        [options.token], { headers: { Origin: "https://mysecurity.eufylife.com" }, followRedirects: false,
          maxPayload: 65536, handshakeTimeout: 10000, perMessageDeflate: false });
      this.#socket.on("error", () => this.#fail(new GeneralRtcError(this.#stage, "socket")));
      this.#socket.on("close", () => { if (!this.#retired) this.#fail(new GeneralRtcError(this.#stage, "socket")); });
      this.#socket.on("open", () => { try { if (this.#started) this.#authenticate(); } catch { this.#fail(new GeneralRtcError("join", "socket")); } });
      this.#socket.on("message", (raw, binary) => {
        try {
          if (this.#retired) return;
          const size = Array.isArray(raw) ? raw.reduce((sum, part) => sum + part.length, 0) : raw.byteLength;
          if (binary || size > 65536 || ++this.#queued > 32) throw new GeneralRtcError(this.#stage, "frame");
          const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(new Uint8Array(raw));
          const message = bytes.toString("utf8");
          this.#chain = this.#chain.then(() => this.#message(message))
            .catch(error => this.#fail(error instanceof GeneralRtcError ? error : new GeneralRtcError(this.#stage, "frame")))
            .finally(() => { this.#queued--; });
        } catch { this.#fail(new GeneralRtcError(this.#stage, "frame")); }
      });
      options.signal.addEventListener("abort", this.#abort, { once: true });
    } catch { throw new GeneralRtcError("join", "socket"); }
  }

  /** Start exactly one call after the private manager has installed its recorder. */
  async start(): Promise<void> {
    if (this.#started) throw new GeneralRtcError("admission");
    this.#started = true;
    if (this.#failure) throw this.#failure;
    this.#guard();
    const ready = new Promise<void>((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
    void ready.catch(() => undefined);
    this.#deadline = setTimeout(() => this.#fail(new GeneralRtcError(this.#offer && !this.#turn ? "turn" : this.#stage, "timeout")), 35_000);
    try {
      if (this.#socket?.readyState === WebSocket.OPEN) this.#authenticate();
      await ready;
    } catch (error) {
      await this.close();
      throw error instanceof GeneralRtcError ? error : new GeneralRtcError(this.#stage);
    }
  }

  /** Retire only this call, ending video and bounding socket and peer shutdown. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#retired = true;
    this.options.signal.removeEventListener("abort", this.#abort);
    for (const timer of [this.#deadline, this.#callTimer, this.#pingTimer, this.#pingDeadline]) if (timer) clearTimeout(timer);
    this.#reject?.(this.#failure ?? new GeneralRtcError("cancelled"));
    this.#resolve = null; this.#reject = null;
    this.#assembler.clear(); this.#parameters = new VideoParameterSetCache();
    this.#offer = null; this.#offerText = null; this.#turn = null;
    this.#localCandidates.clear(); this.#sentCandidates.clear();
    const socket = this.#socket, peer = this.#peer;
    this.#socket = null; this.#peer = null;
    this.output.end();
    this.#closing = (async () => {
      if (socket) {
        socket.removeAllListeners("message");
        await new Promise<void>(resolve => {
          let finished = false;
          const finish = (): void => {
            if (finished) return;
            finished = true; clearTimeout(timer); socket.removeListener("close", finish);
            try { if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); } catch {}
            resolve();
          };
          const timer = setTimeout(finish, 500);
          socket.once("close", finish);
          try {
            if (socket.readyState === WebSocket.OPEN && this.#callCount) {
              socket.send(JSON.stringify(this.#envelope(this.#camera("hangup", {}))));
              socket.send(JSON.stringify({ code: 200, msgid: "0", action: 4 }));
            }
            if (socket.readyState === WebSocket.CLOSED) finish();
            else socket.close();
          } catch { finish(); }
        });
      }
      if (peer) await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 500);
        void Promise.resolve().then(() => peer.close()).catch(() => undefined).finally(() => { clearTimeout(timer); resolve(); });
      });
    })();
    return this.#closing;
  }

  #guard(): void {
    if (this.#retired || this.options.signal.aborted) throw new GeneralRtcError("cancelled");
    if (!this.options.current()) throw new GeneralRtcError("binding", "binding");
  }

  #fail(error: GeneralRtcError): void {
    if (this.#retired) return;
    this.#failure = error;
    this.#reject?.(error); this.#reject = null; this.#resolve = null;
    this.output.destroy(error);
    void this.close().catch(() => undefined);
  }

  #envelope(value: Record<string, unknown>, zero = false): Record<string, unknown> {
    return { msgid: zero ? "0" : `${this.options.token}_${randomUUID()}`, data: this.options.cipher.encrypt(JSON.stringify(value)) };
  }

  #send(value: Record<string, unknown>, zero = false): void {
    this.#guard();
    if (this.#socket?.readyState !== WebSocket.OPEN) throw new GeneralRtcError(this.#stage, "socket");
    this.#socket.send(JSON.stringify(this.#envelope(value, zero)));
  }

  #camera(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
    const ts = Math.floor(this.dependencies.epoch() / 1000);
    const account = createHash("md5").update(String(this.options.channel) + this.options.administrator + String(ts)).digest("hex");
    return { code: 200, action: 3, sessionId: this.options.sign, sn: this.options.parent, subSn: this.options.child,
      channelId: this.options.channel, is_response: 0, dataType: kind, source: "WEB", ts,
      data: JSON.stringify({ timestamp: ts, account, ...payload }) };
  }

  #authenticate(): void {
    if (this.#authSent) return;
    this.#authSent = true;
    this.#send({ code: 200, action: 1, data: this.options.sign }, true);
  }

  #ping(): void {
    this.#pingPending = true;
    this.#send({ action: 2, data: JSON.stringify({ source: "SMART" }), code: 200 }, true);
    this.#pingDeadline = setTimeout(() => this.#fail(new GeneralRtcError("call", "heartbeat")), 30_000);
  }

  #call(): void {
    this.#guard();
    if (++this.#callCount > 4) throw new GeneralRtcError("call", "call_limit");
    this.#lastCall = this.dependencies.now();
    this.#send(this.#camera("call", {}));
    this.#callTimer = setTimeout(() => {
      try { this.#call(); } catch (error) { this.#fail(error instanceof GeneralRtcError ? error : new GeneralRtcError("call")); }
    }, 5_000);
  }

  async #message(raw: string): Promise<void> {
    this.#guard();
    const outer = boundedRecord(raw);
    if (outer.code !== undefined && outer.code !== 200) throw new GeneralRtcError(this.#stage, "code");
    if (typeof outer.data !== "string") throw new GeneralRtcError(this.#stage, "frame");
    let inner: Record<string, unknown>;
    try { inner = boundedRecord(this.options.cipher.decrypt(outer.data), 2); }
    catch { throw new GeneralRtcError(this.#stage, "frame"); }
    if (inner.code !== undefined && inner.code !== 200) throw new GeneralRtcError(this.#stage, "code");
    for (const [key, expected] of [["sessionId", this.options.sign], ["sn", this.options.parent], ["subSn", this.options.child], ["channelId", this.options.channel]] as const) {
      if (inner[key] !== undefined && inner[key] !== expected) throw new GeneralRtcError("binding", "binding");
    }
    if (inner.action === 1) {
      if (this.#authenticated || !this.#authSent) throw new GeneralRtcError("join", "frame");
      this.#authenticated = true; this.#stage = "call";
      this.#ping(); this.#call(); return;
    }
    if (!this.#authenticated) throw new GeneralRtcError("join", "frame");
    if (inner.action === 2) {
      if (!this.#pingPending) return;
      this.#pingPending = false;
      if (this.#pingDeadline) clearTimeout(this.#pingDeadline);
      this.#pingTimer = setTimeout(() => { try { this.#ping(); } catch { this.#fail(new GeneralRtcError("call", "heartbeat")); } }, 10_000);
      return;
    }
    if (inner.action !== 3 || !["call", "info", "hangup", "ack"].includes(String(inner.dataType))) {
      if (++this.#unknown > 16) throw new GeneralRtcError("call", "frame");
      return;
    }
    if (inner.dataType === "hangup") throw new GeneralRtcError("call", "response");
    const data = boundedRecord(inner.data, 3);
    if (inner.dataType === "call") {
      if (this.#callTimer) clearTimeout(this.#callTimer);
      if (data.status === 100) {
        const servers = generalRtcRelays(data.turn);
        if (this.#turn && JSON.stringify(this.#turn) !== JSON.stringify(servers)) throw new GeneralRtcError("turn", "turn_change");
        this.#turn = servers;
      } else if (data.status === 200) {
        if (!this.#accepted) { this.#accepted = true; this.#send(this.#camera("ack", {})); }
      } else if (data.status === 486) {
        if (this.#callCount >= 4) throw new GeneralRtcError("call", "call_limit");
        this.#callTimer = setTimeout(() => {
          try { this.#call(); } catch (error) { this.#fail(error instanceof GeneralRtcError ? error : new GeneralRtcError("call")); }
        }, Math.max(0, this.#lastCall + 3_000 - this.dependencies.now()));
      } else throw new GeneralRtcError("call", "response");
      await this.#negotiate(); return;
    }
    if (inner.dataType === "info" && data.format === "SDP") {
      if (this.#offerText !== null) {
        if (data.value === this.#offerText) return;
        throw new GeneralRtcError("offer", "offer_shape");
      }
      this.#offer = generalRtcOffer(data.value); this.#offerText = data.value as string;
      await this.#negotiate();
    }
  }

  async #negotiate(): Promise<void> {
    if (!this.#accepted || !this.#offer || !this.#turn || this.#negotiating) return;
    this.#negotiating = true; this.#stage = "peer";
    const offer = this.#offer;
    const peer = this.#peer = this.dependencies.peer(this.#turn, offer);
    peer.connectionStateChange.subscribe(state => {
      if (state === "failed" || state === "disconnected") this.#fail(new GeneralRtcError("peer", "transport"));
    });
    peer.onIceCandidate.subscribe(candidate => {
      try {
        if (!candidate?.candidate || this.#retired || this.#sentCandidates.has(candidate.candidate)) return;
        const checked = generalRtcCandidate(candidate.candidate);
        if (!this.#localCandidates.has(checked) && this.#localCandidates.size + this.#sentCandidates.size >= 64) throw new GeneralRtcError("peer", "candidate");
        this.#localCandidates.add(checked);
        if (this.#answerSent) this.#flushCandidates();
      } catch { this.#fail(new GeneralRtcError("peer", "candidate")); }
    });
    peer.onTrack.subscribe(track => {
      try {
        if (this.#retired) return;
        if (track.kind !== "video" || this.#ssrc !== null || track.codec?.payloadType !== offer.payloadType
          || offer.ssrc !== null && track.ssrc !== undefined && track.ssrc !== offer.ssrc) throw new GeneralRtcError("video", "media");
        this.#ssrc = track.ssrc ?? offer.ssrc ?? -1;
        track.onReceiveRtp.subscribe(packet => {
          try {
            this.#guard();
            if (packet.header.payloadType !== offer.payloadType) throw new GeneralRtcError("video", "media");
            if (this.#ssrc === -1) this.#ssrc = packet.header.ssrc;
            if (packet.header.ssrc !== this.#ssrc) throw new GeneralRtcError("video", "media");
            const unit = this.#assembler.push({ sequenceNumber: packet.header.sequenceNumber, timestamp: packet.header.timestamp,
              marker: packet.header.marker, payload: packet.payload });
            if (!unit) return;
            const previous = this.#parameters.diagnostics.randomAccessPictures;
            this.#parameters.push(unit, "h264");
            if (this.#needRandomAccess) {
              if (this.#parameters.diagnostics.randomAccessPictures === previous || !this.#parameters.startup) return;
              this.#needRandomAccess = false;
              if (!this.#attached) { this.#attached = true; this.options.ready(this.output); }
              if (!this.output.write(this.#parameters.startup)) throw new GeneralRtcError("video", "media");
              this.#resolve?.(); this.#resolve = null; this.#reject = null;
              if (this.#deadline) clearTimeout(this.#deadline);
            } else if (!this.output.write(unit)) throw new GeneralRtcError("video", "media");
          } catch (error) { this.#fail(error instanceof GeneralRtcError ? error : new GeneralRtcError("video", "media")); }
        });
      } catch { this.#fail(new GeneralRtcError("video", "media")); }
    });
    try {
      await peer.setRemoteDescription(new RTCSessionDescription(offer.sdp, "offer")); this.#guard();
      const answer = await peer.createAnswer(); this.#guard();
      await peer.setLocalDescription(answer); this.#guard();
      this.#send(this.#camera("info", { sdp: generalRtcAnswer(offer, peer.localDescription!.sdp) }));
      this.#answerSent = true; this.#flushCandidates(); this.#stage = "video";
    } catch (error) { throw error instanceof GeneralRtcError ? error : new GeneralRtcError("peer", "transport"); }
  }

  #flushCandidates(): void {
    for (const candidate of this.#localCandidates) {
      this.#send(this.#camera("info", { candidate })); this.#sentCandidates.add(candidate);
    }
    this.#localCandidates.clear();
  }
}
