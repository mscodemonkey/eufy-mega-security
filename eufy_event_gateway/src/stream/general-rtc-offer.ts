/**
 * Normalizes a bounded general-portal offer to one receive-only H.264 track.
 * The RTC session owns the resulting private SDP. Existing doorbell validation
 * supplies transport checks without changing that route's narrower contract.
 */
import { doorbellRtcOffer, doorbellRtcAnswer, type DoorbellRtcOffer } from "./doorbell-rtc-offer.js";
import { GeneralRtcError } from "./general-rtc-protocol.js";
import { generalRtcCandidate } from "./general-rtc-network.js";

/** Checked offer plus the sole optional declared video source identifier. */
export interface GeneralRtcOffer extends DoorbellRtcOffer {
  readonly ssrc: number | null;
}

/** Select the first packetized H.264 codec and reject multiplexed source layouts. */
export function generalRtcOffer(value: unknown): GeneralRtcOffer {
  if (typeof value !== "string" || Buffer.byteLength(value) > 32768 || /[^\x0a\x0d\x20-\x7e]/.test(value)
    || /\r(?!\n)/.test(value)) throw new GeneralRtcError("offer", "offer_shape");
  const lines = value.split(/\r?\n/).filter(Boolean);
  if (lines.length > 256 || lines.some(line => /^(?:a=simulcast|a=rid|a=ssrc-group):/.test(line))) throw new GeneralRtcError("offer", "offer_shape");
  const sections: string[][] = [], session: string[] = [];
  for (const line of lines) {
    if (line.startsWith("m=")) sections.push([line]);
    else (sections.at(-1) ?? session).push(line);
  }
  const videos = sections.filter(section => section[0]!.startsWith("m=video "));
  if (videos.length !== 1) throw new GeneralRtcError("offer", "offer_shape");
  const video = videos[0]!;
  const directions = video.filter(line => /^a=(?:sendonly|sendrecv|recvonly|inactive)$/.test(line));
  if (directions.length !== 1 || !["a=sendonly", "a=sendrecv"].includes(directions[0]!)) throw new GeneralRtcError("offer", "offer_shape");
  const sources = new Set<number>();
  for (const line of video.filter(line => line.startsWith("a=ssrc:"))) {
    const match = /^a=ssrc:([1-9]\d{0,9}) /.exec(line);
    if (!match || Number(match[1]) > 0xffffffff) throw new GeneralRtcError("offer", "offer_shape");
    sources.add(Number(match[1]));
  }
  if (sources.size > 1) throw new GeneralRtcError("offer", "offer_shape");
  const candidates = lines.filter(line => line.startsWith("a=candidate:"));
  if (candidates.length > 64) throw new GeneralRtcError("offer", "candidate");
  try { for (const candidate of candidates) generalRtcCandidate(candidate.slice(2)); }
  catch { throw new GeneralRtcError("offer", "candidate"); }
  const payloads = video[0]!.split(" ").slice(3);
  let selected: string | undefined;
  for (const payload of payloads) {
    const maps = video.filter(line => line.toLowerCase() === `a=rtpmap:${payload} h264/90000`);
    const fmtp = video.filter(line => line.startsWith(`a=fmtp:${payload} `));
    if (maps.length === 1 && fmtp.length === 1 && /(?:^|;)\s*packetization-mode=1(?:;|$)/.test(fmtp[0]!.slice(fmtp[0]!.indexOf(" ") + 1))) {
      selected = payload; break;
    }
  }
  if (!selected) throw new GeneralRtcError("offer", "offer_shape");
  const filtered = video.filter(line => {
    const match = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)\b/.exec(line);
    return !match || match[1] === selected;
  }).map(line => line === "a=sendrecv" ? "a=sendonly" : line);
  filtered[0] = video[0]!.split(" ").slice(0, 3).join(" ") + " " + selected;
  const normalized = [...session, ...sections.flatMap(section => section === video ? filtered : section)].join("\r\n") + "\r\n";
  try { return { ...doorbellRtcOffer(normalized), ssrc: sources.values().next().value ?? null }; }
  catch { throw new GeneralRtcError("offer", "offer_shape"); }
}

/** Restore rejected audio and application sections while requiring a receive-only answer. */
export function generalRtcAnswer(offer: GeneralRtcOffer, value: string): string {
  try {
    const answer = doorbellRtcAnswer(offer, value);
    const video = answer.split(/(?=^m=)/m).find(section => section.startsWith("m=video "));
    const directions = video?.split(/\r?\n/).filter(line => /^a=(?:sendonly|sendrecv|recvonly|inactive)$/.test(line));
    if (directions?.length !== 1 || directions[0] !== "a=recvonly") throw new GeneralRtcError("peer");
    return answer;
  } catch { throw new GeneralRtcError("peer", "offer_shape"); }
}
