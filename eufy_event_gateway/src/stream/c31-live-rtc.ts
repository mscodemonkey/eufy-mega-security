/**
 * Adapts one opted-in C31 viewer to browser WebRTC with transient microphone audio.
 * The stream manager owns the physical camera. Each peer owns its viewer input,
 * encoder children, loopback RTP sockets and finite speaker operation. No host
 * microphone, source URL, SDP or audio contents enter persistent diagnostics.
 */
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import type { OutgoingHttpHeaders } from "node:http";
import { PassThrough } from "node:stream";
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpPacket, type RTCIceCandidateInit, type RTCDtlsTransport } from "werift";
import { C31MicrophoneInput } from "./c31-microphone.js";
import { terminateMediaProcess } from "./live-stream-manager.js";
import type { VideoViewerResponse } from "./live-transport-muxer.js";

/** Content-free refusal boundaries suitable for a reporter's single diagnostic line. */
export type C31LiveRtcErrorCode = "offer" | "busy" | "admission" | "negotiation" | "session";

/** One failed RTC operation, without retaining SDP, candidates or peer identity. */
export class C31LiveRtcError extends Error {

  /** Keep only the fixed boundary that prevented the operation. */
  constructor(readonly code: C31LiveRtcErrorCode) { super("Live talkback unavailable"); }
}

/** Effects remain bound to the selected camera and the original source owner. */
export interface C31LiveRtcEffects {

  /** Recheck the exact model, feature opt-in and authenticated account binding. */
  admitted(serial: string): boolean;

  /** A muted speaker may still supply video, but must not accept microphone audio. */
  microphoneReady(serial: string): boolean;

  /** Enrol a transient MPEG-TS consumer in the ordinary shared source manager. */
  source(serial: string, input: VideoViewerResponse): Promise<void>;

  /** Hold the original source while native AAC is consumed and its speaker stops. */
  speaker(serial: string, frames: AsyncIterable<Buffer>, signal: AbortSignal): Promise<void>;

  /** Publish content-free closure counters after owned children and audio settle. */
  finished(summary: C31LiveRtcSummary): void;
}

/** Peer-local outcomes describe this path, not physical speaker output. */
export type C31LiveRtcOutcome = "client_closed" | "peer_closed" | "peer_failed" | "expired" | "source_ended"
  | "source_failed" | "encoder_failed" | "speaker_failed" | "admission_changed" | "shutdown";

/** No SDP, peer address, session token or microphone bytes are exposed here. */
export interface C31LiveRtcSummary {
  readonly outcome: C31LiveRtcOutcome;
  readonly videoPackets: number;
  readonly audioPackets: number;
  readonly microphonePackets: number;
  readonly ignoredMicrophonePackets: number;
  readonly encodedFrames: number;
  readonly microphoneSegments: number;
  readonly speakerFailures: number;
}

/** Accept only a browser receive-video offer and conventional mono PCMU audio. */
export function c31LiveRtcOffer(sdp: string): { receiveMicrophone: boolean } {
  if (typeof sdp !== "string" || Buffer.byteLength(sdp) > 65_536 || sdp.includes("\0")) throw new C31LiveRtcError("offer");
  const sections = sdp.split(/(?=^m=)/m).filter(value => value.startsWith("m="));
  if (sections.length !== 2 || sections.some(value => !/^m=(video|audio) /.test(value))) throw new C31LiveRtcError("offer");
  const video = sections.find(value => value.startsWith("m=video "))!;
  const audio = sections.find(value => value.startsWith("m=audio "))!;
  const h264 = video && [...video.matchAll(/^a=rtpmap:(\d+) H264\/90000\r?$/gmi)].some(match => {
    const payload = Number(match[1]);
    const fmt = video.split(/\r?\n/).find(line => line.startsWith(`a=fmtp:${payload} `));
    const listed = video.split(/\r?\n/)[0]!.split(" ").slice(3).includes(String(payload));
    return payload >= 96 && payload <= 127 && listed && fmt !== undefined
      && /(?:^|[ ;])packetization-mode=1(?:;|$)/.test(fmt)
      && /(?:^|[ ;])profile-level-id=42[ce]01f(?:;|$)/i.test(fmt);
  });
  if (!video || !audio || !/^a=recvonly\r?$/m.test(video) || !h264
    || !/^m=video [1-9]\d* UDP\/TLS\/RTP\/SAVPF (?:\d+ ?)+\r?$/m.test(video)
    || !/^a=rtcp-mux\r?$/m.test(video) || !/^a=rtcp-mux\r?$/m.test(audio)
    || !/^m=audio [1-9]\d* UDP\/TLS\/RTP\/SAVPF (?:\d+ )*0(?: \d+)*\r?$/m.test(audio)
    || !/^a=rtpmap:0 PCMU\/8000\r?$/mi.test(audio)) throw new C31LiveRtcError("offer");
  const directions = audio.match(/^a=(sendrecv|recvonly|sendonly|inactive)\r?$/gm);
  if (directions?.length !== 1 || !/^a=(sendrecv|recvonly)\r?$/.test(directions[0]!)) throw new C31LiveRtcError("offer");
  return { receiveMicrophone: directions[0]!.startsWith("a=sendrecv") };
}

/** Fixed pipe input and loopback-only RTP destinations for the owned viewer encoder. */
export function c31ViewerRtcArguments(videoPort: number, audioPort: number): string[] {
  if (![videoPort, audioPort].every(value => Number.isInteger(value) && value > 0 && value <= 65535)) throw new Error("Live viewer ports unavailable");
  return ["-hide_banner", "-loglevel", "error", "-probesize", "32768", "-analyzeduration", "100000",
    "-f", "mpegts", "-i", "pipe:0", "-map", "0:v:0", "-an", "-vf", "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=10",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-level:v", "3.1",
    "-threads", "1", "-g", "10", "-bf", "0", "-b:v", "1500k", "-maxrate", "1500k", "-bufsize", "750k",
    "-rtpflags", "skip_rtcp", "-f", "rtp", "-payload_type", "96", `rtp://127.0.0.1:${videoPort}?pkt_size=1200`,
    "-map", "0:a:0", "-vn", "-c:a", "pcm_mulaw", "-ar", "8000", "-ac", "1", "-rtpflags", "skip_rtcp", "-f", "rtp", "-payload_type", "0",
    `rtp://127.0.0.1:${audioPort}?pkt_size=1200`];
}

/** One manager-owned viewer. Destroying this pipe releases only its consumer. */
class RtcViewerInput extends PassThrough implements VideoViewerResponse {
  headersSent = false;

  /** Require the manager's native audio transport before accepting any bytes. */
  writeHead(status: number, headers: OutgoingHttpHeaders): this {
    if (status !== 200 || !String(headers["Content-Type"] ?? headers["content-type"]).includes("video/mp2t")) {
      this.destroy(new Error("Live viewer source unavailable"));
    }
    this.headersSent = true;
    return this;
  }
}

/** Bind one decoder-output socket to loopback, returning only its assigned port. */
async function bindRtp(socket: Socket): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => reject(error);
    socket.once("error", failed);
    socket.bind(0, "127.0.0.1", () => { socket.off("error", failed); resolve(); });
  });
  const address = socket.address();
  if (typeof address === "string") throw new Error("Live viewer socket unavailable");
  return address.port;
}

/**
 * Own one browser peer and its transient media resources until complete retirement.
 * The broker reserves the camera before negotiation. Microphone frames cannot
 * reach the speaker before video has arrived through the same original source.
 */
class C31RtcSession {
  readonly #abort = new AbortController();
  readonly #peer: RTCPeerConnection;
  readonly #transports = new Set<RTCDtlsTransport>();
  readonly #video = new MediaStreamTrack({ kind: "video" });
  readonly #audio = new MediaStreamTrack({ kind: "audio" });
  readonly #videoSocket = createSocket("udp4");
  readonly #audioSocket = createSocket("udp4");
  readonly #input = new RtcViewerInput({ highWaterMark: 64 * 1024 });
  readonly #timer: NodeJS.Timeout;
  #encoder: ChildProcessWithoutNullStreams | null = null;
  #encoderClosed: Promise<void> = Promise.resolve();
  #segment: { input: C31MicrophoneInput; operation: Promise<void> } | null = null;
  #ports: [number, number] | null = null;
  #started = false;
  #microphoneTrack: MediaStreamTrack | null = null;
  #microphoneSsrc: number | null = null;
  #closing: Promise<void> | null = null;
  #counts = { videoPackets: 0, audioPackets: 0, microphonePackets: 0, ignoredMicrophonePackets: 0, encodedFrames: 0, microphoneSegments: 0, speakerFailures: 0 };

  /** Reserve effects for this exact camera without opening its source during negotiation. */
  constructor(private readonly serial: string, private readonly effects: C31LiveRtcEffects,
    private readonly retired: () => void, private readonly receiveMicrophone: boolean) {
    this.#peer = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle", codecs: {
      video: [new RTCRtpCodecParameters({ mimeType: "video/H264", clockRate: 90000, payloadType: 96,
        parameters: "packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1" })],
      audio: [new RTCRtpCodecParameters({ mimeType: "audio/PCMU", clockRate: 8000, payloadType: 0, channels: 1 })],
    } });
    this.#peer.addTransceiver(this.#video, { direction: "sendonly" });
    this.#peer.addTransceiver(this.#audio, { direction: receiveMicrophone ? "sendrecv" : "sendonly" });

    // BUNDLE can withdraw a provisional transport from Werift's public list.
    // This peer still owns it and must stop it during exact-peer retirement.
    for (const transport of this.#peer.dtlsTransports) this.#transports.add(transport);
    this.#peer.onTrack.subscribe(track => {
      if (track.kind !== "audio" || !receiveMicrophone || this.#microphoneTrack) return;
      this.#microphoneTrack = track;
      this.#microphoneSsrc = track.ssrc ?? null;
      track.onReceiveRtp.subscribe(packet => this.#microphone(packet));
    });
    this.#peer.connectionStateChange.subscribe(state => {
      if (state === "connected") void this.#startSource();
      else if (["closed", "disconnected", "failed"].includes(state)) void this.close(state === "failed" ? "peer_failed" : "peer_closed");
    });
    this.#input.once("error", () => { void this.close("source_failed"); });
    this.#input.once("close", () => { void this.close("source_ended"); });
    this.#timer = setTimeout(() => { void this.close("expired"); }, 120_000); this.#timer.unref();
    const forward = (socket: Socket, track: MediaStreamTrack, video: boolean): void => {
      socket.on("error", () => { void this.close("encoder_failed"); });
      socket.on("message", (data, remote) => {
        if (this.#closing || remote.address !== "127.0.0.1" || data.length > 1500) return;
        try {
          const packet = RtpPacket.deSerialize(data);
          track.writeRtp(packet);
          if (video) this.#counts.videoPackets++;
          else this.#counts.audioPackets++;
        } catch { void this.close("encoder_failed"); }
      });
    };
    forward(this.#videoSocket, this.#video, true); forward(this.#audioSocket, this.#audio, false);
  }

  /** Negotiate only the already validated offer, retaining no public source URL. */
  async answer(sdp: string): Promise<string> {
    this.#ports = [await bindRtp(this.#videoSocket), await bindRtp(this.#audioSocket)];
    await this.#peer.setRemoteDescription({ type: "offer", sdp });
    for (const transport of this.#peer.dtlsTransports) this.#transports.add(transport);
    await this.#peer.setLocalDescription(await this.#peer.createAnswer());
    if (this.#closing || !this.effects.admitted(this.serial) || !this.#peer.localDescription?.sdp) throw new Error("Live talkback negotiation ended");
    return this.#peer.localDescription.sdp;
  }

  /** Complete browser trickle ICE only while this exact peer remains owned. */
  async candidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (this.#closing) throw new Error("Live talkback session ended");
    await this.#peer.addIceCandidate(candidate);
  }

  async #startSource(): Promise<void> {
    if (this.#started || this.#closing || !this.#ports) return;
    this.#started = true;
    try {
      if (!this.effects.admitted(this.serial)) throw new C31LiveRtcError("admission");
      this.#encoder = spawn("ffmpeg", c31ViewerRtcArguments(...this.#ports), { stdio: ["pipe", "pipe", "pipe"] });
      const child = this.#encoder;
      this.#encoderClosed = new Promise(resolve => child.once("close", () => { resolve(); void this.close("encoder_failed"); }));
      child.on("error", () => { void this.close("encoder_failed"); });
      child.stdin.on("error", () => { void this.close("encoder_failed"); });
      child.stderr.resume(); child.stdout.resume(); this.#input.pipe(child.stdin);
      await this.effects.source(this.serial, this.#input);
    } catch { void this.close("source_failed"); }
  }

  #microphone(packet: RtpPacket): void {
    if (this.#closing || !this.receiveMicrophone) return;
    if (this.#microphoneSsrc === null) this.#microphoneSsrc = packet.header.ssrc;
    if (packet.header.ssrc !== this.#microphoneSsrc) { this.#counts.ignoredMicrophonePackets++; return; }
    if (!this.effects.admitted(this.serial)) { void this.close("admission_changed"); return; }
    if (!this.#counts.videoPackets || packet.header.payloadType !== 0 || !this.effects.microphoneReady(this.serial)) { this.#counts.ignoredMicrophonePackets++; return; }
    if (this.#segment) {
      if (!this.#segment.input.accepting) { this.#counts.ignoredMicrophonePackets++; return; }
      this.#segment.input.push(packet.payload, packet.header.sequenceNumber, packet.header.timestamp);
      this.#counts.microphonePackets++; return;
    }
    const input = new C31MicrophoneInput(); this.#counts.microphoneSegments++;
    const operation = this.effects.speaker(this.serial, input.frames, this.#abort.signal)
      .catch(() => {
        this.#counts.speakerFailures++;
        if (this.effects.microphoneReady(this.serial)) void this.close("speaker_failed");
      })
      .finally(async () => {
        input.close(); await input.finished;
        this.#counts.encodedFrames += input.summary.encodedFrames;
        if (this.#segment?.input === input) this.#segment = null;
      });
    this.#segment = { input, operation };
    input.push(packet.payload, packet.header.sequenceNumber, packet.header.timestamp); this.#counts.microphonePackets++;
  }

  /** Stop the speaker before releasing its source, then await every owned child and socket. */
  close(outcome: C31LiveRtcOutcome): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = Promise.resolve().then(async () => {
      clearTimeout(this.#timer); this.#abort.abort();
      const segment = this.#segment;
      segment?.input.close(); await segment?.operation;
      this.#input.destroy();
      if (this.#encoder) terminateMediaProcess(this.#encoder);
      await this.#encoderClosed;
      await this.#peer.close();
      await Promise.all([...this.#transports].map(transport => transport.stop()));
      this.#video.stop(); this.#audio.stop();
      await Promise.all([this.#videoSocket, this.#audioSocket].map(socket => new Promise<void>(resolve => {
        try { socket.close(() => resolve()); } catch { resolve(); }
      })));
      this.effects.finished({ outcome, ...this.#counts }); this.retired();
    });
    return this.#closing;
  }
}

/**
 * Reserve at most two opted-in browser peers and one per camera.
 * This broker owns opaque session IDs. Closing or adding a candidate requires
 * the same camera and ID, and failed negotiation retires its own resources.
 */
export class C31LiveRtc {
  readonly #sessions = new Map<string, { id: string; session: C31RtcSession }>();
  #closed = false;

  /** Supply manager and provider effects without borrowing their ownership maps. */
  constructor(private readonly effects: C31LiveRtcEffects) {}

  /** Prevent a prepared upload from being queued behind a live microphone peer. */
  has(serial: string): boolean { return this.#sessions.has(serial); }

  /** Reserve before any asynchronous negotiation or camera activity. */
  async offer(serial: string, sdp: string): Promise<{ sessionId: string; sdp: string }> {
    const offer = c31LiveRtcOffer(sdp);
    if (this.#closed || !this.effects.admitted(serial)) throw new C31LiveRtcError("admission");
    if (this.#sessions.has(serial) || this.#sessions.size >= 2) throw new C31LiveRtcError("busy");
    const id = randomBytes(16).toString("hex");
    const session = new C31RtcSession(serial, this.effects, () => {
      if (this.#sessions.get(serial)?.id === id) this.#sessions.delete(serial);
    }, offer.receiveMicrophone);
    this.#sessions.set(serial, { id, session });
    try { return { sessionId: id, sdp: await session.answer(sdp) }; }
    catch { await session.close("peer_failed"); throw new C31LiveRtcError("negotiation"); }
  }

  /** Refuse foreign or retired IDs before changing any peer candidate state. */
  async candidate(serial: string, id: string, candidate: RTCIceCandidateInit | null): Promise<void> {
    const owner = this.#sessions.get(serial);
    if (!owner || owner.id !== id) throw new C31LiveRtcError("session");
    if (!this.effects.admitted(serial)) { await owner.session.close("admission_changed"); throw new C31LiveRtcError("admission"); }
    await owner.session.candidate(candidate);
  }

  /** Retire only the matching peer, with no fallback to another camera or session. */
  async close(serial: string, id: string): Promise<void> {
    const owner = this.#sessions.get(serial);
    if (!owner || owner.id !== id) throw new C31LiveRtcError("session");
    await owner.session.close("client_closed");
  }

  /** Drain all owned speakers and media resources before gateway shutdown. */
  async closeAll(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#sessions.values()].map(owner => owner.session.close("shutdown")));
  }
}
