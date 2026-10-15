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
  | "start" | "video" | "stop" | "cancelled" | "deadline" | "framing" | "timing" | "state";

const nvrTrialReasons = [
  "unspecified", "signalling_queue_limit", "signalling_closed", "signalling_error", "session_mismatch",
  "station_mismatch", "channel_mismatch", "relay_count", "relay_shape", "relay_fields", "candidate_limit",
  "candidate_shape", "candidate_component", "candidate_transport", "candidate_priority", "candidate_host",
  "candidate_port", "candidate_type", "candidate_extension", "candidate_related_address", "candidate_related_port",
  "offer_order", "offer_media", "offer_fingerprint", "offer_mid", "offer_ice",
  "offer_setup", "offer_sctp", "offer_message_size", "offer_duplicate", "peer_setup", "peer_failed",
  "peer_disconnected", "local_candidate_limit", "remote_description", "remote_candidate", "create_answer",
  "local_description", "send_answer", "unexpected_negotiation_error",
  "ptcs_packet_geometry", "ptcs_magic", "ptcs_type", "ptcs_flags", "ptcs_length", "ptcs_index",
  "ptcs_final_marker", "ptcs_channel", "ptcs_frame_too_large", "ptcs_metadata_conflict",
  "ptcs_duplicate_conflict", "ptcs_decompression", "ptcs_replay", "ptcs_capacity", "ptcs_poisoned",
  "frame_sequence_gap", "frame_reorder_limit", "frame_reorder_timeout", "clock_reversed",
] as const;

/** Fixed failure reasons distinguish setup failures without retaining received values. */
export type NvrTrialReason = typeof nvrTrialReasons[number];

/**
 * Carries only fixed diagnostic labels from a trial to provider logs and HTTP errors.
 * The originating session owns cleanup. Vendor messages and causes are excluded.
 */
export class NvrTrialError extends Error {

  /** Fixed reason safe to include in a reporter's single failure line. */
  readonly reason: NvrTrialReason;

  constructor(readonly stage: NvrTrialStage, reason: NvrTrialReason = "unspecified") {
    super(stage === "region_or_authorization_rejected"
      ? "NVR region or authorization rejected. Check the experimental NVR service region, including ie for GB-style accounts."
      : `NVR video test failed at ${stage}`);
    this.reason = nvrTrialReasons.includes(reason) ? reason : "unspecified";
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

/**
 * Select an exact reported camera profile for the opt-in trial only.
 * Additional legacy cameras use their first lens. T8E00 retains the original
 * trial's sensor selection. This does not establish hardware playback support.
 */
export function nvrTrialSensor(model: string, deviceType: number | null): 0 | 1 | null {
  const cameras = [["T8140", 14], ["T8140-Z", 14], ["T8113-V", 8], ["T8172", 89],
    ["T8162", 26], ["T8170", 48], ["T81A0", 10005], ["T8425", 47]] as const;
  if (model === "T8E00" && deviceType === 301) return 1;
  return cameras.some(([name, type]) => name === model && type === deviceType) ? 0 : null;
}

/** Encode only fixed trial operations, keeping the chosen lens separate from its channel. */
export function nvrCommand(account: string, command: 9100 | 1003 | 1004 | 1103, segment: number, channel: number, sensor: 0 | 1 = 1): Buffer {
  if (![9100, 1003, 1004, 1103].includes(command)) throw new NvrTrialError("framing");
  if (!Number.isInteger(segment) || segment < 1 || segment > 254 || !Number.isInteger(channel) || channel < 0 || channel > 254) {
    throw new NvrTrialError("framing");
  }
  if (sensor !== 0 && sensor !== 1) throw new NvrTrialError("framing");
  const payload = command === 1003 ? { ClientOS: "WEB", entrytype: 1, camera_type: 0, streamtype: 2,
    key: "", msg_id: "", audio_chn: -1, stitch_mode: 1, chn_list: [{ index: 0, chn: channel, sensor }] }
    : command === 1103 ? { channel_info: { array_size: 2, channel_array: [255, channel] } } : {};
  const body = Buffer.from(JSON.stringify({ account_id: account, cmd: command, payload }));
  const header = Buffer.alloc(16);
  header.write("XZYH"); header.writeUInt16LE(1350, 4); header.writeUInt32LE(body.length, 6);
  header[11] = segment; header[12] = 255; header[14] = command === 1003 ? 1 : 0; header[15] = 2;
  return Buffer.concat([header, body]);
}

/**
 * A single explicit query result, separate from inventory or confirmed controls.
 * Missing or unsupported settings stay unknown. No identity or received text
 * escapes the private session through this projection.
 */
export interface NvrStateSummary {
  readonly configuredGuardMode: number | null;
  readonly effectiveGuardMode: number | null;
  readonly cameraPower: "on" | "off" | null;
  readonly parameterCount: number;

  /** Gateway receipt time, not proof that the appliance refreshed its own cache. */
  readonly queriedAt: string;
}

/** Project only explicitly scoped state, rejecting ambiguous parameter ownership. */
export function nvrStateSummary(response: Record<string, unknown>, channel: number): NvrStateSummary {
  if (!Number.isInteger(channel) || channel < 0 || channel > 254) throw new NvrTrialError("state");
  const payload = nvrRecord(response.payload) ? response.payload : response;
  if (!Array.isArray(payload.params) || payload.params.length > 1024
    || payload.db_bypass_str !== undefined && (!Array.isArray(payload.db_bypass_str) || payload.db_bypass_str.length > 1024)) {
    throw new NvrTrialError("state");
  }
  const rows: unknown[] = [...payload.params, ...(Array.isArray(payload.db_bypass_str) ? payload.db_bypass_str : [])];
  if (rows.length > 1024) throw new NvrTrialError("state");
  const read = (scope: number, parameter: number, encoded = false): number | null => {
    const matches = rows.filter(row => nvrRecord(row) && row.param_type === parameter
      && (row.dev_type === scope || row.channel === scope));
    if (matches.length > 1) throw new NvrTrialError("state");
    const row = matches[0];
    if (!nvrRecord(row)) return null;
    if (row.dev_type !== undefined && !Number.isInteger(row.dev_type)
      || row.channel !== undefined && !Number.isInteger(row.channel)
      || row.dev_type !== undefined && row.channel !== undefined && row.dev_type !== row.channel) throw new NvrTrialError("state");
    let value = row.param_value;
    if (typeof value === "string") {
      if (value.length > 256) throw new NvrTrialError("state");
      if (encoded && !/^(0|[1-9]\d*)$/.test(value) && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        const bytes = Buffer.from(value, "base64");
        if (bytes.toString("base64") === value) value = bytes.toString("utf8");
      }
      if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
      value = Number(value);
    }
    return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
  };
  const guard = (parameter: number): number | null => {
    const value = read(255, parameter);
    return value !== null && [0, 1, 2, 3, 4, 5, 47, 63].includes(value) ? value : null;
  };
  const power = read(channel, 6250, true);
  return { configuredGuardMode: guard(1224), effectiveGuardMode: guard(1151),
    cameraPower: power === 0 ? "on" : power === 1 ? "off" : null,
    parameterCount: rows.length, queriedAt: new Date().toISOString() };
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
    || frame.readUInt32LE(6) !== frame.length - 16 || ![0, 1].includes(frame[10]!) || frame[13] !== 0) throw new NvrTrialError("framing");
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
export function nvrMatchCamera(response: Record<string, unknown>, serial: string, channel: number, deviceType = 301): void {
  const payload = nvrRecord(response.payload) ? response.payload : null;
  if (!payload || !Array.isArray(payload.dev_list) || payload.dev_list.length > 256) throw new NvrTrialError("identity_field_missing");
  let fields = false;
  const matches = payload.dev_list.filter(row => {
    if (!nvrRecord(row) || typeof row.sn !== "string" || !Number.isInteger(row.ch)) return false;
    fields = true;
    return row.sn === serial || row.ch === channel;
  });
  if (matches.length !== 1) throw new NvrTrialError(fields ? "identity_unmatched" : "identity_field_missing");
  const row = matches[0]!;
  if (!nvrRecord(row) || row.sn !== serial || row.ch !== channel || !Number.isInteger(deviceType)
    || (row.dev_type ?? row.type) !== deviceType
    || row.dev_type !== undefined && row.type !== undefined && row.dev_type !== row.type) {
    throw new NvrTrialError("identity_unmatched");
  }
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
    || !/^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel(?: \d+)?$/.test(media[0]!)) throw new NvrTrialError("negotiation", "offer_media");
  if (fingerprints.length !== 1 || !/^a=fingerprint:sha-256 (?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/.test(fingerprints[0]!)) throw new NvrTrialError("negotiation", "offer_fingerprint");
  if (mids.length !== 1 || !/^a=mid:[A-Za-z0-9_-]{1,32}$/.test(mids[0]!)) throw new NvrTrialError("negotiation", "offer_mid");
  if (!lines.some(line => /^a=ice-ufrag:[A-Za-z0-9+/]{4,256}$/.test(line))
    || !lines.some(line => /^a=ice-pwd:[A-Za-z0-9+/]{22,256}$/.test(line))) throw new NvrTrialError("negotiation", "offer_ice");
  if (!lines.some(line => /^a=setup:(actpass|passive)$/.test(line))) throw new NvrTrialError("negotiation", "offer_setup");
  if (!lines.some(line => /^a=sctp-port:5000$/.test(line))) throw new NvrTrialError("negotiation", "offer_sctp");
  if (!lines.some(line => /^a=max-message-size:\d+$/.test(line) && Number(line.slice(19)) >= 1028 && Number(line.slice(19)) <= 4 * 1024 * 1024)) throw new NvrTrialError("negotiation", "offer_message_size");
  const candidates = lines.filter(line => line.startsWith("a=candidate:"));
  if (candidates.length > 64) throw new NvrTrialError("negotiation", "candidate_limit");
  for (const key of ["ice-ufrag", "ice-pwd", "setup", "sctp-port", "max-message-size"]) {
    if (lines.filter(line => line.startsWith(`a=${key}:`)).length !== 1) throw new NvrTrialError("negotiation", "offer_duplicate");
  }
  for (const line of candidates) nvrCandidate(line);
  return { sdp: value, mid: mids[0]!.slice(6) };
}

/**
 * Validate destinations before passing a candidate to the ICE library.
 * Non-host candidates may conceal paired related metadata, as in RFC 8829
 * section 7.3 and RFC 8839 section 5.1. Those fields are never destinations.
 */
export function nvrCandidate(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 8192 || /[\r\n]/.test(value)) throw new NvrTrialError("negotiation", "candidate_shape");
  const text = value.replace(/^a=/, ""), parts = text.trim().split(/\s+/);
  if (parts.length < 8 || parts.length % 2 !== 0 || !/^candidate:[A-Za-z0-9+/._-]+$/.test(parts[0] ?? "")
    || parts[6] !== "typ") throw new NvrTrialError("negotiation", "candidate_shape");
  if (parts[1] !== "1") throw new NvrTrialError("negotiation", "candidate_component");
  if (parts[2]?.toLowerCase() !== "udp") throw new NvrTrialError("negotiation", "candidate_transport");
  if (!/^\d+$/.test(parts[3] ?? "") || Number(parts[3]) > 0xffffffff) throw new NvrTrialError("negotiation", "candidate_priority");
  if (!nvrNetworkHost(parts[4] ?? "")) throw new NvrTrialError("negotiation", "candidate_host");
  if (!/^\d+$/.test(parts[5] ?? "") || Number(parts[5]) < 1 || Number(parts[5]) > 65535) throw new NvrTrialError("negotiation", "candidate_port");
  if (!["host", "srflx", "relay", "prflx"].includes(parts[7] ?? "")) throw new NvrTrialError("negotiation", "candidate_type");
  let relatedAddress: string | undefined, relatedPort: string | undefined;
  for (let i = 8; i < parts.length; i += 2) {
    if (parts[i] === "raddr") {
      if (relatedAddress !== undefined) throw new NvrTrialError("negotiation", "candidate_related_address");
      relatedAddress = parts[i + 1]!;
    }
    if (parts[i] === "rport") {
      if (relatedPort !== undefined) throw new NvrTrialError("negotiation", "candidate_related_port");
      relatedPort = parts[i + 1]!;
    }
  }
  const concealed = parts[7] !== "host" && (relatedAddress === "0.0.0.0" || relatedAddress === "::")
    && (relatedPort === "0" || relatedPort === "9");
  if (!concealed) {
    if (relatedPort !== undefined && (!/^\d+$/.test(relatedPort) || Number(relatedPort) < 1 || Number(relatedPort) > 65535)) {
      throw new NvrTrialError("negotiation", "candidate_related_port");
    }
    if (relatedAddress !== undefined && !nvrNetworkHost(relatedAddress)) {
      throw new NvrTrialError("negotiation", "candidate_related_address");
    }
  }
  return text;
}
