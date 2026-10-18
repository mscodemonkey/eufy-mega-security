/**
 * Encodes finite source-derived NVR controls and projects scoped observations.
 * It owns no state or transport. The session owns correlation and the provider
 * owns the explicit administrator and exact model admission boundary.
 */
import { NvrLiveControlError, type NvrLiveControl } from "../provider/nvr-live-controls.js";
import { nvrRecord } from "./nvr-protocol.js";

/** Parse bounded JSON while rejecting duplicate properties before projection. */
export function nvrLiveJson(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > 65536) throw new NvrLiveControlError("unavailable", "reply");
  const value: unknown = JSON.parse(text.replace(/\0+$/, ""));
  if (!nvrRecord(value)) throw new NvrLiveControlError("unavailable", "reply");
  const objects: (Set<string> | null)[] = [];
  const tokens = /"(?:\\.|[^"\\])*"|[{}\[\]]/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === "{") objects.push(new Set());
    else if (token === "[") objects.push(null);
    else if (token === "}" || token === "]") objects.pop();
    else {
      let next = match.index! + token.length;
      while (next < text.length && /\s/.test(text[next]!)) next++;
      if (text[next] !== ":") continue;
      const keys = objects.at(-1), key: unknown = JSON.parse(token);
      if (!keys || typeof key !== "string" || keys.has(key)) throw new NvrLiveControlError("unavailable", "reply");
      keys.add(key);
    }
  }
  return value;
}

/** Internal closed setting request, never accepted directly from an HTTP client. */
export type NvrLiveWrite = NvrLiveControl | { readonly kind: "night"; readonly value: number }
  | { readonly kind: "quality"; readonly value: number; readonly sensor: 0 | 1 };

/** Encode portal wrappers. PTZ zoom:1 is the live click contract, never held movement. */
export function nvrLiveCommand(account: string, segment: number, channel: number, request: NvrLiveWrite): Buffer {
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(account) || !Number.isInteger(segment) || segment < 1 || segment > 254
    || !Number.isInteger(channel) || channel < 0 || channel > 254) throw new NvrLiveControlError("unavailable");
  const pan = request.kind === "pan";
  let body: Record<string, unknown>;
  if (pan) {
    const direction = { left: 1, right: 2, up: 3, down: 4 }[request.direction];
    if (!direction) throw new NvrLiveControlError("unavailable");
    body = { account_id: account, cmd: 6030, commandType: 6030, data: { cmd_type: 1, rotate_type: direction, zoom: 1 } };
  } else if (request.kind === "zoom" && [1, 2, 3].includes(request.level)) {
    body = { account_id: account, cmd: 6203, payload: { dstZoom: request.level } };
  } else if (request.kind === "night" && [0, 1, 2, 3].includes(request.value)) {
    body = { account_id: account, cmd: 1277, payload: { night_sion: request.value } };
  } else if (request.kind === "quality" && [0, 1, 2, 3, 4].includes(request.value) && [0, 1].includes(request.sensor)) {
    body = { account_id: account, cmd: 2730, payload: { mode: -1, quality: request.value, primary_view: -1, sensor: request.sensor } };
  } else throw new NvrLiveControlError("unavailable");
  const payload = Buffer.from(JSON.stringify(body));
  const header = Buffer.alloc(16);
  header.write("XZYH"); header.writeUInt16LE(pan ? 1700 : 1350, 4); header.writeUInt32LE(payload.length, 6);
  header[11] = segment; header[12] = channel; header[15] = 2;
  return Buffer.concat([header, payload]);
}

/** Accept bounded binary status receipts only, preserving the source's 132-byte form. */
export function nvrLiveReceipt(payload: Buffer): boolean {
  if (payload.length !== 132) return false;
  try { JSON.parse(payload.toString("utf8")); return false; } catch { /* Binary status is not JSON. */ }
  return payload.readInt32LE(0) === 0;
}

/** Validate PTZ data without publishing a limit or claiming a physical position. */
export function nvrLivePanReply(value: unknown): boolean {
  return nvrRecord(value) && value.cmd === 6030 && (value.mIntRet === undefined || value.mIntRet === 0)
    && nvrRecord(value.payload) && Number.isInteger(value.payload.limit) && Number(value.payload.limit) >= -1 && Number(value.payload.limit) <= 4;
}

/** Scoped readback values. Missing, ambiguous or malformed values remain unknown. */
export interface NvrLiveSettings { readonly night: number | null; readonly quality: number | null }

/** Read exact child rows only. The live-quality/web field pairing is hardware-unconfirmed. */
export function nvrLiveSettings(response: Record<string, unknown>, channel: number): NvrLiveSettings {
  const unknown = { night: null, quality: null };
  if (response.cmd !== 1103) return unknown;
  const nested = nvrRecord(response.payload) ? response.payload : {};
  const tables = (value: Record<string, unknown>): boolean => value.params !== undefined || value.db_bypass_str !== undefined;
  if (tables(response) && tables(nested)) return unknown;
  const { params, db_bypass_str: bypass } = tables(nested) ? nested : response;
  if (!Array.isArray(params) || params.length > 1024 || bypass !== undefined && (!Array.isArray(bypass) || bypass.length > 1024)) return unknown;
  const values = (command: number): unknown[] => {
    const found: unknown[] = [];
    for (const [rows, scope] of [[params, "dev_type"], [bypass ?? [], "channel"]] as const) {
      for (const row of rows) {
        if (!nvrRecord(row) || row.param_type !== command) continue;
        if ((row.dev_type === channel || row.channel === channel) && row.dev_type !== undefined && row.channel !== undefined && row.dev_type !== row.channel) return [null, null];
        if (row[scope] !== channel) continue;
        if (command === 2730 && scope !== "dev_type") return [null, null];
        found.push(row.param_value);
      }
    }
    return found;
  };
  const night = values(1277), quality = values(2730);
  const integer = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4 ? value
    : typeof value === "string" && /^[0-4]$/.test(value) ? Number(value) : null;
  let q: number | null = null;
  if (quality.length === 1) {
    try {
      const parsed: unknown = typeof quality[0] === "string" ? nvrLiveJson(quality[0]) : quality[0];
      if (nvrRecord(parsed) && Object.keys(parsed).filter(key => key === "web_video_quality").length === 1) q = integer(parsed.web_video_quality);
    } catch { /* Unreadable values remain unknown. */ }
  }
  return { night: night.length === 1 ? integer(night[0]) : null, quality: q };
}
