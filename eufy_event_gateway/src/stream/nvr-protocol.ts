/**
 * Validates the experimental NVR wire boundary without owning a connection.
 * The RTC session owns request identity and buffers. These helpers accept only
 * the documented short-video trial, never arbitrary device commands.
 */
import { isIP } from "node:net";
import type { VideoCodec } from "../domain/types.js";

/** Fixed diagnostic stages contain no vendor messages or private connection data. */
export type NvrTrialStage = "admission" | "region_or_authorization_rejected" | "sign" | "join" | "call" | "busy"
  | "negotiation" | "offer_compact" | "channel" | "inventory" | "identity_field_missing" | "identity_unmatched"
  | "start" | "video" | "stop" | "cancelled" | "deadline" | "framing" | "timing";

/** Errors crossing the HTTP boundary contain only a stable stage. */
export class NvrTrialError extends Error {
  constructor(readonly stage: NvrTrialStage) {
    super(stage === "region_or_authorization_rejected"
      ? "NVR region or authorization rejected. Check the experimental NVR service region, including ie for GB-style accounts."
      : `NVR video test failed at ${stage}`);
  }
}

/** Reject arrays and null before consuming an untrusted JSON object. */
export function nvrRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse one bounded object, allowing the portal's nested JSON-string envelope. */
export function nvrJson(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 65536) throw new NvrTrialError("framing");
    try { value = JSON.parse(value.replace(/\0+$/, "")); } catch { throw new NvrTrialError("framing"); }
  }
  if (!nvrRecord(value)) throw new NvrTrialError("framing");
  return value;
}

/** Encode only the discovery, start and stop operations used by this trial. */
export function nvrCommand(account: string, command: 9100 | 1003 | 1004, segment: number, channel: number): Buffer {
  if (!Number.isInteger(segment) || segment < 1 || segment > 254 || !Number.isInteger(channel) || channel < 0 || channel > 254) {
    throw new NvrTrialError("framing");
  }
  const payload = command === 1003 ? { ClientOS: "WEB", entrytype: 1, camera_type: 0, streamtype: 2,
    key: "", msg_id: "", audio_chn: -1, stitch_mode: 1, chn_list: [{ index: 0, chn: channel, sensor: 1 }] } : {};
  const body = Buffer.from(JSON.stringify({ account_id: account, cmd: command, payload }));
  const header = Buffer.alloc(16);
  header.write("XZYH"); header.writeUInt16LE(1350, 4); header.writeUInt32LE(body.length, 6);
  header[11] = segment; header[12] = 255; header[14] = command === 1003 ? 1 : 0; header[15] = 2;
  return Buffer.concat([header, body]);
}

/** Encode a caller-owned application frame using the independent sender layout. */
export function nvrPackets(frame: Buffer, sequence: number, timestamp: number, channel = 0): Buffer[] {
  if (frame.length > 4 * 1024 * 1024 + 64 || !Number.isInteger(sequence) || sequence < 0 || sequence > 65535
    || !Number.isInteger(channel) || channel < 0 || channel > 5 || !Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new NvrTrialError("framing");
  }
  const result: Buffer[] = [];
  const count = Math.max(1, Math.ceil(frame.length / 1000));
  for (let index = 0; index < count; index++) {
    const part = frame.subarray(index * 1000, (index + 1) * 1000), packet = Buffer.alloc(1028);
    packet.write("PTCS"); packet[4] = 3; packet[5] = channel;
    packet.writeUInt16LE(sequence, 6); packet.writeUInt32LE(timestamp >>> 0, 8);
    packet.writeUInt32LE(frame.length, 12); packet.writeUInt16LE(index, 16);
    packet.writeUInt16LE(0x4000 | (index === count - 1 ? 0x400 : 0) | part.length, 18);
    part.copy(packet, 28); result.push(packet);
  }
  return result;
}

/** Heartbeats bypass PTCS and carry no account or device identifier. */
export function nvrHeartbeat(): Buffer {
  const frame = Buffer.alloc(36);
  frame[1] = 9; frame.writeUInt16LE(16, 4); frame[12] = 99;
  frame.write("XZYH", 20); frame.writeUInt16LE(1139, 24); frame[35] = 2;
  return frame;
}

/** Checked application envelope, retaining its payload only for the owning session. */
export interface NvrApplicationFrame {
  readonly command: number;
  readonly segment: number;
  readonly channel: number;
  readonly stream: number;
  readonly payload: Buffer;
}

/** Reject inconsistent lengths before interpreting command or media bytes. */
export function nvrApplication(frame: Buffer): NvrApplicationFrame {
  if (frame.length < 16 || !frame.subarray(0, 4).equals(Buffer.from("XZYH"))
    || frame.readUInt32LE(6) !== frame.length - 16 || frame[10] !== 0 || frame[13] !== 0) throw new NvrTrialError("framing");
  return { command: frame.readUInt16LE(4), segment: frame[11]!, channel: frame[12]!, stream: frame[14]!, payload: frame.subarray(16) };
}

/** Validated video with its original integer timestamp and owned Annex-B bytes. */
export interface NvrVideoFrame {
  readonly codec: VideoCodec;
  readonly sequence: number;
  readonly timestamp: bigint;
  readonly bytes: Buffer;
}

/** Only documented 1300 video may reach the media pipeline. */
export function nvrVideo(frame: NvrApplicationFrame, channel: number): NvrVideoFrame {
  const body = frame.payload;
  if (frame.command !== 1300 || body.length < 23 || body.length > 4 * 1024 * 1024 + 22
    || ![channel, 255].includes(frame.channel) || frame.stream !== 1 || body.readUInt32LE(0) !== body.length - 22
    || ![0, 1].includes(body[5]!) || body.readUInt16LE(10) < 16 || body.readUInt16LE(10) > 8192
    || body.readUInt16LE(12) < 16 || body.readUInt16LE(12) > 8192) throw new NvrTrialError("video");
  const bytes = body.subarray(22);
  if (bytes.length < 4 || !(bytes[0] === 0 && bytes[1] === 0 && (bytes[2] === 1 || bytes[2] === 0 && bytes[3] === 1))) {
    throw new NvrTrialError("video");
  }
  return { codec: body[5] === 1 ? "h265" : "h264", sequence: body.readUInt16LE(6), timestamp: body.readBigUInt64LE(14), bytes };
}

/** Fresh discovery must bind the selected serial, channel and exact camera type. */
export function nvrMatchCamera(response: Record<string, unknown>, serial: string, channel: number): void {
  const payload = nvrRecord(response.payload) ? response.payload : null;
  if (!payload || !Array.isArray(payload.dev_list) || payload.dev_list.length > 256) throw new NvrTrialError("identity_field_missing");
  let fields = false;
  const matches = payload.dev_list.filter(row => {
    if (!nvrRecord(row) || typeof row.sn !== "string" || !Number.isInteger(row.ch)) return false;
    fields = true;
    return row.sn === serial && row.ch === channel && (row.dev_type === 301 || row.type === 301);
  });
  if (matches.length !== 1) throw new NvrTrialError(fields ? "identity_unmatched" : "identity_field_missing");
}

/** Reject local-only or non-unicast endpoints supplied by signalling. */
export function nvrNetworkHost(host: string): boolean {
  let value = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(value) === 4) {
    const parts = value.split(".").map(Number), first = parts[0]!, second = parts[1]!;
    return first !== 0 && first !== 127 && first < 224 && !(first === 169 && second === 254);
  }
  if (isIP(value) === 6) {
    value = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    return value !== "::" && value !== "::1" && !value.startsWith("ff") && !/^fe[89ab]/.test(value)
      && !value.includes(".") && !value.startsWith("::ffff:");
  }
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)
    && !value.endsWith(".localhost") && !value.endsWith(".local");
}

/** Validate a single data-channel offer and return its actual ICE mid. */
export function nvrOffer(value: unknown): { sdp: string; mid: string } {
  if (typeof value !== "string" || value.trimStart().startsWith("{")) throw new NvrTrialError("offer_compact");
  const lines = value.split(/\r?\n/), media = lines.filter(line => line.startsWith("m="));
  const fingerprints = lines.filter(line => line.startsWith("a=fingerprint:"));
  const mids = lines.filter(line => line.startsWith("a=mid:"));
  if (Buffer.byteLength(value) > 65536 || media.length !== 1
    || !/^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel$/.test(media[0]!)
    || fingerprints.length !== 1 || !/^a=fingerprint:sha-256 (?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/.test(fingerprints[0]!)
    || mids.length !== 1 || !/^a=mid:[A-Za-z0-9_-]{1,32}$/.test(mids[0]!)
    || !lines.some(line => /^a=ice-ufrag:[A-Za-z0-9+/]{4,256}$/.test(line))
    || !lines.some(line => /^a=ice-pwd:[A-Za-z0-9+/]{22,256}$/.test(line))
    || !lines.some(line => /^a=setup:(actpass|passive)$/.test(line))
    || !lines.some(line => /^a=sctp-port:5000$/.test(line))
    || !lines.some(line => /^a=max-message-size:\d+$/.test(line) && Number(line.slice(19)) >= 1028 && Number(line.slice(19)) <= 4 * 1024 * 1024)) {
    throw new NvrTrialError("negotiation");
  }
  const candidates = lines.filter(line => line.startsWith("a=candidate:"));
  if (candidates.length > 64) throw new NvrTrialError("negotiation");
  for (const key of ["ice-ufrag", "ice-pwd", "setup", "sctp-port", "max-message-size"]) {
    if (lines.filter(line => line.startsWith(`a=${key}:`)).length !== 1) throw new NvrTrialError("negotiation");
  }
  for (const line of candidates) nvrCandidate(line);
  return { sdp: value, mid: mids[0]!.slice(6) };
}

/** Validate candidate syntax and addresses before passing it to the ICE library. */
export function nvrCandidate(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 8192 || /[\r\n]/.test(value)) throw new NvrTrialError("negotiation");
  const text = value.replace(/^a=/, ""), parts = text.trim().split(/\s+/);
  if (!/^candidate:[A-Za-z0-9+/._-]+$/.test(parts[0] ?? "") || parts[1] !== "1" || parts[2]?.toLowerCase() !== "udp"
    || !/^\d+$/.test(parts[3] ?? "") || Number(parts[3]) > 0xffffffff || !nvrNetworkHost(parts[4] ?? "")
    || !/^\d+$/.test(parts[5] ?? "") || Number(parts[5]) < 1 || Number(parts[5]) > 65535
    || parts.length % 2 !== 0 || parts[6] !== "typ" || !["host", "srflx", "relay", "prflx"].includes(parts[7] ?? "")) throw new NvrTrialError("negotiation");
  for (let i = 8; i < parts.length; i += 2) {
    if (parts[i] === "rport" && (!/^\d+$/.test(parts[i + 1] ?? "") || Number(parts[i + 1]) < 1 || Number(parts[i + 1]) > 65535)) throw new NvrTrialError("negotiation");
    if (parts[i] === "raddr" && !nvrNetworkHost(parts[i + 1] ?? "")) throw new NvrTrialError("negotiation");
  }
  return text;
}
