/**
 * Encodes one source-derived attached FamiLock status query and validates its
 * correlated reply. The provider owns identity and lifetime, and PPCS supplies
 * authenticated plaintext. This boundary neither actuates locks nor logs secrets.
 */
import { createCipheriv, createDecipheriv } from "node:crypto";

/** Closed diagnostic failure categories safe to expose without private context. */
export type T85V0StatusStage = "admission" | "busy" | "cancelled" | "timeout" | "session" | "malformed" | "rejected";

/** Owns only a public failure category, never payloads or transport exceptions. */
export class T85V0StatusError extends Error {
  constructor(readonly stage: T85V0StatusStage) { super(stage); this.name = "T85V0StatusError"; }
}

/** Private, provider-validated child and account binding for this one query. */
export interface T85V0StatusIdentity {
  readonly serial: string;
  readonly accountId: string;
  readonly channel: number;
}

/** Source-derived readings require comparison with the existing physical state. */
export interface T85V0StatusSummary {
  readonly reportedState: "locked" | "unlocked" | "unknown";
  readonly batteryPercent: number;
  readonly physicalConfirmationRequired: true;
}

/** Reject identities outside the native ASCII derivation before any connection. */
export function validT85V0StatusIdentity(identity: T85V0StatusIdentity): boolean {
  return /^[A-Za-z0-9]{16}$/.test(identity.serial) && /^[\x21-\x7e]{12,255}$/.test(identity.accountId)
    && Number.isInteger(identity.channel) && identity.channel >= 0 && identity.channel <= 254;
}

/** Build only opcode 34, with a caller-owned unique key time and sequence. */
export function buildT85V0StatusQuery(identity: T85V0StatusIdentity, keyTime: number, sequence: number, unixTime: number): Buffer {
  if (!validT85V0StatusIdentity(identity) || !uint32(keyTime) || !uint32(sequence) || !uint32(unixTime)) throw new T85V0StatusError("admission");
  const timestamp = Buffer.alloc(4); timestamp.writeUInt32LE(unixTime);
  const owner = Buffer.from(identity.accountId, "ascii");
  const tlv = Buffer.concat([Buffer.from([0xa1, 4]), timestamp, Buffer.from([0xa2, owner.length]), owner, Buffer.from([0xa3, 1, 0])]);
  const aligned = Buffer.alloc(Math.ceil(tlv.length / 16) * 16); tlv.copy(aligned);
  const key = statusKey(identity, keyTime);
  let encrypted: Buffer;
  try {
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.from(identity.serial, "ascii"));
    encrypted = Buffer.concat([cipher.update(aligned), cipher.final()]);
  } finally { key.fill(0); aligned.fill(0); tlv.fill(0); owner.fill(0); }
  const frame = Buffer.alloc(encrypted.length + 10);
  frame.set([0xff, 9]); frame.writeUInt16LE(frame.length, 2); frame.set([3, 0, 2], 4);
  frame.writeUInt16BE(0x4022, 7); encrypted.copy(frame, 9); frame[frame.length - 1] = checksum(frame.subarray(0, -1));
  const result = Buffer.from(JSON.stringify({ account_id: identity.accountId, cmd: 1940, mChannel: identity.channel, mValue3: 0,
    payload: { apiCommand: 6012, lock_payload: frame.toString("hex"), seq_num: sequence, time: keyTime } }));
  encrypted.fill(0); frame.fill(0);
  return result;
}

/**
 * Ignore unrelated replies. Matching malformed replies fail closed. Trust comes
 * from the caller's authenticated GCM session and channel, never CBC/checksum.
 */
export function decodeT85V0StatusReply(bytes: Buffer, identity: T85V0StatusIdentity, keyTime: number, sequence: number): T85V0StatusSummary | null {
  if (!validT85V0StatusIdentity(identity) || !uint32(keyTime) || !uint32(sequence)) throw new T85V0StatusError("admission");
  if (bytes.length > 16_384) throw new T85V0StatusError("malformed");
  let outer: Record<string, unknown> | null;
  try { outer = record(JSON.parse(bytes.toString("utf8"))); } catch { return null; }
  const payload = record(outer?.payload);
  if (outer?.cmd !== 1940 || !payload || replyTime(payload.time) !== keyTime || payload.seq_num !== sequence) return null;
  if (payload.apiCommand !== 6012 || (payload.dev_sn !== undefined && payload.dev_sn !== identity.serial)
    || typeof payload.lock_payload !== "string" || payload.lock_payload.length > 8192
    || !/^(?:[a-fA-F0-9]{2})+$/.test(payload.lock_payload)) throw new T85V0StatusError("malformed");
  const frame = Buffer.from(payload.lock_payload, "hex");
  if (frame.length < 26 || frame.length > 4096 || frame.readUInt16LE(2) !== frame.length
    || frame[0] !== 0xff || frame[1] !== 9 || frame[4] !== 3 || frame[5] !== 0 || frame[6] !== 2
    || frame.readUInt16BE(7) !== 0x4822 || (frame.length - 10) % 16 !== 0
    || checksum(frame.subarray(0, -1)) !== frame[frame.length - 1]) throw new T85V0StatusError("malformed");
  const key = statusKey(identity, keyTime);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.from(identity.serial, "ascii"));
    plain = Buffer.concat([decipher.update(frame.subarray(9, -1)), decipher.final()]);
  } catch { throw new T85V0StatusError("malformed"); }
  finally { key.fill(0); frame.fill(0); }
  try {
    if (!plain.length) throw new T85V0StatusError("malformed");
    if (plain[0] !== 0) throw new T85V0StatusError("rejected");
    const fields = new Map<number, Buffer>();
    let offset = 1;
    while (offset < plain.length && plain[offset] !== 0) {
      const tag = plain[offset]!, length = plain[offset + 1];
      if (tag < 0xa1 || !length || offset + length + 2 > plain.length || fields.has(tag)) throw new T85V0StatusError("malformed");
      fields.set(tag, plain.subarray(offset + 2, offset + 2 + length)); offset += length + 2;
    }
    if (plain.length - offset > 15 || plain.subarray(offset).some(byte => byte !== 0)
      || fields.get(0xa1)?.length !== 1 || fields.get(0xa2)?.length !== 1 || fields.get(0xa1)![0]! > 100) throw new T85V0StatusError("malformed");
    const state = fields.get(0xa2)![0]!;
    return { reportedState: state === 4 ? "locked" : state === 3 ? "unlocked" : "unknown",
      batteryPercent: fields.get(0xa1)![0]!, physicalConfirmationRequired: true };
  } finally { plain.fill(0); }
}

function statusKey(identity: T85V0StatusIdentity, time: number): Buffer {
  const suffix = Buffer.alloc(4); suffix.writeUInt32BE(time);
  return Buffer.concat([Buffer.from(identity.accountId.slice(-12), "ascii"), suffix]);
}

function checksum(bytes: Buffer): number { return bytes.reduce((value, byte) => value ^ byte, 0); }
function uint32(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff; }
function replyTime(value: unknown): number | null { return uint32(value) ? value : typeof value === "string" && /^[a-fA-F0-9]{8}$/.test(value) ? Number.parseInt(value, 16) : null; }
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
