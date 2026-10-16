/**
 * Validates native doorbell RTC offers before the trial creates a peer.
 * This boundary selects one receive-only H.264 track and rejects unused audio
 * and SCTP sections. It retains no SDP, credentials, addresses or identifiers.
 */
import { isIP } from "node:net";
import { nvrCandidate } from "./nvr-protocol.js";

/** Content-free failure categories for the private diagnostic API. */
export type DoorbellRtcStage = "admission" | "sign" | "join" | "call" | "busy" | "offer"
  | "peer" | "video" | "cancelled" | "deadline";

/** Content-free reason categories for offer validation and support follow-up. */
export type DoorbellRtcReason = "unspecified" | "offer_text" | "media_sections" | "media_kinds"
  | "media_shape" | "mid" | "video_count" | "video_shape" | "transport_field"
  | "payloads" | "codec" | "fmtp" | "candidate_limit" | "candidate" | "connection";

/**
 * Carries one fixed stage across the trial's cleanup and HTTP boundary.
 * Received messages, SDP, credentials and causes must never enter this error.
 */
export class DoorbellRtcError extends Error {
  constructor(readonly stage: DoorbellRtcStage, readonly reason: DoorbellRtcReason = "unspecified") {
    super(`Standalone doorbell video test failed at ${stage}`);
  }
}

/** Validated local answer inputs. The session owns and discards the private SDP. */
export interface DoorbellRtcOffer {
  readonly sdp: string;
  readonly mid: string;
  readonly index: number;
  readonly payloadType: number;
  readonly parameters: string;

  /** Original media order, used to put rejected sections back into the wire answer. */
  readonly media: readonly { readonly line: string; readonly mid: string }[];
}

/** Select H.264 and reject unused sections without allowing an unbounded SDP parser input. */
export function doorbellRtcOffer(value: unknown): DoorbellRtcOffer {
  if (typeof value !== "string" || Buffer.byteLength(value) > 32768 || /[^\x09\x0a\x0d\x20-\x7e]/.test(value)) throw new DoorbellRtcError("offer", "offer_text");
  const lines = value.split(/\r?\n/).filter(Boolean);
  if (lines.length > 256 || lines.some(line => line.length > 8192) || lines[0] !== "v=0") throw new DoorbellRtcError("offer", "offer_text");
  const sections: string[][] = [], session: string[] = [];
  for (const line of lines) {
    if (line.startsWith("m=")) sections.push([line]);
    else (sections.at(-1) ?? session).push(line);
  }
  if (sections.length < 1 || sections.length > 3) throw new DoorbellRtcError("offer", "media_sections");
  const kinds = sections.map(section => section[0]!.split(" ")[0]!);
  if (new Set(kinds).size !== kinds.length || kinds.some(kind => !["m=audio", "m=video", "m=application"].includes(kind))) {
    throw new DoorbellRtcError("offer", "media_kinds");
  }
  for (const section of sections) {
    if (section[0]!.startsWith("m=audio ") && !/^m=audio \d{1,5} UDP\/TLS\/RTP\/SAVPF(?: \d{1,3})+$/.test(section[0]!)
      || section[0]!.startsWith("m=application ") && !/^m=application \d{1,5} UDP\/DTLS\/SCTP webrtc-datachannel$/.test(section[0]!)) {
      throw new DoorbellRtcError("offer", "media_shape");
    }
  }
  const mids = sections.map(section => section.filter(line => line.startsWith("a=mid:")));
  if (mids.some(mid => mid.length !== 1 || !/^a=mid:[A-Za-z0-9_-]{1,32}$/.test(mid[0]!))
    || new Set(mids.map(mid => mid[0])).size !== sections.length) throw new DoorbellRtcError("offer", "mid");
  const videos = sections.map((section, index) => ({ section, index })).filter(row => row.section[0]!.startsWith("m=video "));
  if (videos.length !== 1) throw new DoorbellRtcError("offer", "video_count");
  const { section: video, index } = videos[0]!;
  if (!/^m=video [1-9]\d{0,4} UDP\/TLS\/RTP\/SAVPF(?: \d{1,3})+$/.test(video[0]!)
    || Number(video[0]!.split(" ")[1]) > 65535 || !video.includes("a=sendonly") || !video.includes("a=rtcp-mux")) throw new DoorbellRtcError("offer", "video_shape");
  const inherited = [...session, ...video];
  for (const [prefix, pattern] of [["a=ice-ufrag:", /^a=ice-ufrag:[A-Za-z0-9+/]{4,256}$/],
    ["a=ice-pwd:", /^a=ice-pwd:[A-Za-z0-9+/]{22,256}$/],
    ["a=fingerprint:", /^a=fingerprint:sha-256 (?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2}$/],
    ["a=setup:", /^a=setup:(?:actpass|active)$/]] as const) {
    const found = inherited.filter(line => line.startsWith(prefix));
    if (found.length !== 1 || !pattern.test(found[0]!)) throw new DoorbellRtcError("offer", "transport_field");
  }
  const payloads = video[0]!.split(" ").slice(3).map(Number);
  if (payloads.some(payload => payload > 127) || new Set(payloads).size !== payloads.length) throw new DoorbellRtcError("offer", "payloads");
  const h264 = video.filter(line => /^a=rtpmap:\d{1,3} H264\/90000$/i.test(line));
  if (h264.length !== 1) throw new DoorbellRtcError("offer", "codec");
  const payloadType = Number(h264[0]!.split(":")[1]!.split(" ")[0]);
  if (!payloads.includes(payloadType) || payloadType < 96 || payloadType > 127) throw new DoorbellRtcError("offer", "payloads");
  const fmtp = video.filter(line => line.startsWith(`a=fmtp:${payloadType} `));
  if (fmtp.length !== 1) throw new DoorbellRtcError("offer", "fmtp");
  const parameters = fmtp[0]!.slice(fmtp[0]!.indexOf(" ") + 1);
  if (parameters.length > 512 || !/(?:^|;)\s*packetization-mode=1(?:;|$)/.test(parameters)
    || !/^[A-Za-z0-9+/=;., -]+$/.test(parameters)) throw new DoorbellRtcError("offer", "fmtp");
  const mid = mids[index]![0]!.slice(6);
  const candidates = video.filter(line => line.startsWith("a=candidate:"));
  if (candidates.length > 64) throw new DoorbellRtcError("offer", "candidate_limit");
  try { for (const candidate of candidates) nvrCandidate(candidate.slice(2)); }
  catch { throw new DoorbellRtcError("offer", "candidate"); }
  for (const line of lines.filter(line => line.startsWith("c="))) {
    if (!/^c=IN IP[46] \S+$/.test(line) || isIP(line.split(" ")[2]!) !== (line.startsWith("c=IN IP4") ? 4 : 6)) {
      throw new DoorbellRtcError("offer", "connection");
    }
  }

  // Choosing the permitted passive answer avoids the doorbell's DTLS mismatch.
  // Its unused SCTP section must stay rejected so RTP cannot later fail on SCTP.
  const output = session.filter(line => !line.startsWith("a=group:BUNDLE "))
    .map(line => line === "a=setup:actpass" ? "a=setup:active" : line);
  output.push(`a=group:BUNDLE ${mid}`);

  // The local peer library constructs transports even for port-zero sections.
  // Give it only video, then restore explicit rejections in the wire answer.
  output.push(...video.map(line => line === "a=setup:actpass" ? "a=setup:active" : line));
  return { sdp: output.join("\r\n") + "\r\n", mid, index, payloadType, parameters,
    media: sections.map((section, i) => ({ line: section[0]!, mid: mids[i]![0]!.slice(6) })) };
}

/** Restore rejected media in the original order without constructing local SCTP or audio transports. */
export function doorbellRtcAnswer(offer: DoorbellRtcOffer, value: string): string {
  if (Buffer.byteLength(value) > 32768) throw new DoorbellRtcError("peer");
  const lines = value.split(/\r?\n/).filter(Boolean);
  const start = lines.findIndex(line => line.startsWith("m="));
  if (start < 0 || !lines[start]!.startsWith("m=video ") || lines.filter(line => line.startsWith("m=")).length !== 1
    || !lines.slice(start).includes(`a=mid:${offer.mid}`)) throw new DoorbellRtcError("peer");
  const output = lines.slice(0, start).filter(line => !line.startsWith("a=group:BUNDLE "));
  output.push(`a=group:BUNDLE ${offer.mid}`);
  for (let i = 0; i < offer.media.length; i++) {
    const section = offer.media[i]!;
    if (i === offer.index) output.push(...lines.slice(start));
    else output.push(section.line.replace(/^(m=\w+) \d+/, "$1 0"), "c=IN IP4 0.0.0.0", `a=mid:${section.mid}`, "a=inactive");
  }
  return output.join("\r\n") + "\r\n";
}
