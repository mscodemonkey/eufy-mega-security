/**
 * Encodes the narrowly scoped E30 command and validates its query responses.
 * The lock transport owns secrets and request lifetimes. This pure boundary
 * never logs payloads or performs network work, and supplies observations to
 * the lock registry. CBC and the frame checksum do not authenticate a reply.
 */
import { performance } from "node:perf_hooks";
import { inspect } from "node:util";
import { createCipheriv, createDecipheriv, randomBytes, X509Certificate, createPrivateKey } from "node:crypto";

/** Private identity from the authenticated, exact-model standalone inventory. */
export interface E30LockIdentity {
  readonly serial: string;
  readonly name: string;
  readonly adminUserId: string;
  readonly shortUserId: string;
  readonly userName: string;
  readonly administrator: boolean;
}

/** Transient credentials, never persisted or projected into public lock state. */
export interface E30MqttCredentials {
  readonly host: string;
  readonly certificate: string;
  readonly privateKey: string;
  readonly userId: string;
  readonly clientId: string;
}

type E30CbcOpcode = 34 | 35 | 52 | 53;

/** One request's correlation fields and transfer envelope; JSON commands have no cipher key time. */
export interface E30Command {
  readonly keyTime: number;
  readonly sequence: number;
  readonly opcode: E30CbcOpcode | 1919;
  readonly transfer: Readonly<Record<string, unknown>>;
}

/** A correlated device query observation, with its raw enum kept inside the provider. */
export interface E30Observation {
  readonly rawState: number;
  readonly batteryPercent: number | null;
}

/** Exact sound levels reported by E30; zero denotes disabled sound. */
export type E30SoundVolume = 0 | 1 | 2 | 3;

/** Trial writes admit audible levels only; muting has no validated write contract. */
export type E30AudibleVolume = 1 | 2 | 3;

/** The three E30 notification bits; other mode bits remain owned by the device. */
export type E30NotificationSetting = "notifications" | "lockedNotifications" | "unlockedNotifications";

/** Build one JSON notification write from a caller-owned fresh mode, preserving every other bit. */
export function buildE30NotificationCommand(identity: E30LockIdentity, setting: E30NotificationSetting,
  enabled: boolean, currentMode: number, sequence: number): E30Command {
  if (!identity || typeof identity !== "object" || identity.administrator !== true) throw new E30LockError("unavailable");
  validateE30Identity(identity, false);
  if (!["notifications", "lockedNotifications", "unlockedNotifications"].includes(setting)
    || typeof enabled !== "boolean" || !notificationMode(currentMode) || !uint32(sequence)) throw new E30LockError("unavailable");
  const mask = setting === "notifications" ? 1 : setting === "unlockedNotifications" ? 2 : 4;
  const mode = (enabled ? currentMode | mask : currentMode & ~mask) & 31;
  return { keyTime: 0, sequence, opcode: 1919,
    transfer: Object.freeze({ cmd: 1919, mChannel: 0, mValue3: 0, payload: Object.freeze({ mode }) }) };
}

/** Project exactly one canonical notification parameter from fresh cloud inventory, failing closed on ambiguity. */
export function parseE30NotificationMode(params: unknown): number | null {
  if (!Array.isArray(params)) return null;
  let found = false;
  let mode: number | null = null;
  for (const item of params) {
    if (!item || typeof item !== "object" || (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) return null;
    if (!Object.hasOwn(item, "param_type") || (item.param_type !== 1919 && item.param_type !== "1919")) continue;
    if (found || !Object.hasOwn(item, "param_value")) return null;
    found = true;
    const value: unknown = item.param_value;
    const parsed = typeof value === "string" && /^(0|[1-9][0-9]?)$/.test(value) ? Number(value) : value;
    if (!notificationMode(parsed)) return null;
    mode = parsed as number;
  }
  return mode;
}

function notificationMode(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 31 && !Object.is(value, -0);
}

/** Closed settings actions cannot select an arbitrary setting or motor command. */
export type E30SettingsAction = "settings" | { readonly soundVolume: E30AudibleVolume }
  | { readonly autoLock: { readonly enabled: boolean; readonly settings: E30SettingsObservation } };

/**
 * Owns one transient settings snapshot inside the transport caller's operation.
 * Only volume and stable-field comparison escape; serialization and inspection
 * redact the private tag values. Never persist this object or include it in errors.
 */
export class E30SettingsObservation {
  readonly #fields: ReadonlyMap<number, Buffer>;
  readonly #device: string | null;
  readonly #owner: string | null;
  readonly #observedAt = performance.now();

  constructor(readonly volume: E30SoundVolume, fields: ReadonlyMap<number, Buffer>, identity?: E30LockIdentity) {
    this.#device = identity?.serial ?? null; this.#owner = identity?.adminUserId ?? null;
    this.#fields = new Map([...fields].map(([tag, value]) => [tag, Buffer.from(value)]));
  }

  /** Return unknown when any companion field needed for a lossless write is malformed. */
  get autoLockEnabled(): boolean | null {
    return this.#validAutoLock() ? this.#fields.get(0xa1)![0] === 1 : null;
  }

  /** Check inactive companions for structural plausibility; preserve bytes and privately confirm the delay. */
  autoLockTrialPreflight(): { eligible: boolean; delaySeconds: number | null } {
    const valid = this.#validAutoLock();
    const plausibleTime = (value: Buffer): boolean => value.equals(Buffer.from([255, 255]))
      || (value[0]! <= 23 && value[1]! <= 59);
    return { eligible: valid && this.autoLockEnabled === false && this.#fields.get(0xa3)![0] === 0
      && plausibleTime(this.#fields.get(0xa4)!) && plausibleTime(this.#fields.get(0xa5)!),
    delaySeconds: valid ? this.#fields.get(0xa2)!.readUInt16LE() : null };
  }

  /** Encode only the enable change from this fresh, device/owner-bound private snapshot. */
  autoLockCommand(identity: E30LockIdentity, enabled: boolean, unixTime: number, keyTime: number, sequence: number): E30Command {
    validateE30Identity(identity, false);
    const age = performance.now() - this.#observedAt;
    if (![unixTime, keyTime, sequence].every(uint32) || typeof enabled !== "boolean" || !this.#validAutoLock() || this.#device !== identity.serial
      || this.#owner !== identity.adminUserId || age < 0 || age > 10_000) throw new E30LockError("unavailable");
    const timestamp = Buffer.alloc(4); timestamp.writeUInt32LE(unixTime);
    return encodeE30Command(identity, 52, [timestamp, Buffer.from(identity.adminUserId), Buffer.from([0]), Buffer.from([enabled ? 1 : 0]),
      this.#fields.get(0xa2)!, this.#fields.get(0xa3)!, this.#fields.get(0xa4)!, this.#fields.get(0xa5)!], keyTime, sequence);
  }

  #validAutoLock(): boolean {
    for (const [tag, length] of [[0xa1, 1], [0xa2, 2], [0xa3, 1], [0xa4, 2], [0xa5, 2]]) {
      if (this.#fields.get(tag!)?.length !== length) return false;
    }
    if (this.#fields.get(0xa1)![0]! > 1 || this.#fields.get(0xa3)![0]! > 1 || this.#fields.get(0xa2)!.readUInt16LE() === 0) return false;
    if (this.#fields.get(0xa3)![0] === 1) {
      for (const tag of [0xa4, 0xa5]) {
        const value = this.#fields.get(tag)!;
        if (value[0]! > 23 || value[1]! > 59) return false;
      }
    }
    return true;
  }

  /** Compare fields stable across two baseline reads, excluding volume itself. */
  compareStableFields(baseline: E30SettingsObservation, latest: E30SettingsObservation, setting: "sound" | "autoLock" = "sound"): { unchanged: boolean; comparedFields: number } {
    if (setting !== "sound" && setting !== "autoLock") throw new E30LockError("unavailable");
    let unchanged = true;
    let comparedFields = 0;
    const tags = new Set([...this.#fields.keys(), ...baseline.#fields.keys(), ...latest.#fields.keys()]);
    for (const tag of tags) {
      if (tag === (setting === "sound" ? 0xab : 0xa1)) continue;
      const first = this.#fields.get(tag), second = baseline.#fields.get(tag), after = latest.#fields.get(tag);
      if (!first || !second) { unchanged = false; continue; }
      if (!first.equals(second)) {
        if (setting === "autoLock" && ((tag >= 0xa2 && tag <= 0xa5) || tag === 0xab)) unchanged = false;
        continue;
      }
      comparedFields++;
      if (!after || !first.equals(after)) unchanged = false;
    }
    return { unchanged: unchanged && comparedFields > 0, comparedFields };
  }

  /** Permit safe JSON logging without exposing any of the unrelated settings. */
  toJSON(): { volume: E30SoundVolume; settings: "redacted" } {
    return { volume: this.volume, settings: "redacted" };
  }

  /** Redact Node's default console inspection, including nested diagnostic output. */
  [inspect.custom](): { volume: E30SoundVolume; settings: "redacted" } { return this.toJSON(); }
}

/** Fixed failure categories shared by transport and the local HTTP boundary. */
export type E30LockFailure = "unavailable" | "busy" | "rate_limited" | "outcome_unknown";

/**
 * A privacy-safe lock failure. The owning operation converts vendor exceptions
 * into these fixed categories; callers must never attach the original error.
 */
export class E30LockError extends Error {
  constructor(readonly code: E30LockFailure) {
    super(code === "outcome_unknown" ? "Lock outcome is unknown; check the Eufy app before retrying"
      : code === "busy" ? "A lock operation is already in progress"
      : code === "rate_limited" ? "Wait before requesting another lock operation"
      : "Lock operation unavailable");
  }
}

/** Validate the credential response without trusting a response-supplied CA. */
export function parseE30MqttCredentials(value: unknown, userId: string, installId: string): E30MqttCredentials {
  const row = record(value);
  const host = row?.endpoint_addr;
  const certificate = row?.certificate_pem;
  const privateKey = row?.private_key;
  if (typeof host !== "string" || !["aiot-mqtt-us.anker.com", "security-mqtt-us.anker.com"].includes(host)
    || (row?.endpoint_port !== undefined && row.endpoint_port !== 8883)
    || typeof certificate !== "string" || typeof privateKey !== "string"
    || certificate.length > 32_768 || privateKey.length > 32_768
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(userId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(installId)
    || (row?.user_id !== undefined && row.user_id !== userId)
    || (row?.app_name !== undefined && row.app_name !== "eufy_security")) throw new E30LockError("unavailable");
  try {
    const cert = new X509Certificate(certificate);
    const key = createPrivateKey(privateKey);
    if (!cert.checkPrivateKey(key) || Date.parse(cert.validFrom) > Date.now()
      || Date.parse(cert.validTo) <= Date.now()) throw new Error();
  } catch { throw new E30LockError("unavailable"); }

  // The observed US E30 route uses the Security broker with the existing
  // Security-scoped certificate. Other regions remain experimentally unavailable.
  return { host: "security-mqtt-us.anker.com", certificate, privateKey, userId,
    clientId: e30MqttClientId(userId, installId) };
}

/** Preserve the app's timestamp-shaped client ID while using the gateway's own install identity. */
export function e30MqttClientId(userId: string, installId: string, unixTime = Math.floor(Date.now() / 1000)): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(userId) || !/^[a-f0-9]{16}$/.test(installId)
    || !uint32(unixTime)) throw new E30LockError("unavailable");
  return `android-eufy_security-${userId}-${installId}-${unixTime}`;
}

/** Validate the route/key identity; actuation additionally requires the acting member's attribution. */
export function validateE30Identity(identity: E30LockIdentity, writing = true): void {
  if (!/^[A-Za-z0-9]{16}$/.test(identity.serial) || !/^[A-Za-z0-9]{12,128}$/.test(identity.adminUserId)
    || (writing && (!/^[a-fA-F0-9]{4}$/.test(identity.shortUserId)
    || !identity.userName || Buffer.byteLength(identity.userName) > 255))) throw new E30LockError("unavailable");
}

/** Build a status/settings read or a fixed absolute action; callers own unique correlation values. */
export function buildE30Command(
  identity: E30LockIdentity, action: "query" | boolean | E30SettingsAction, unixTime: number, keyTime: number, sequence: number,
): E30Command {
  validateE30Identity(identity, typeof action === "boolean");
  if (![unixTime, keyTime, sequence].every(uint32)) throw new E30LockError("unavailable");
  const objectAction = typeof action === "object" && action !== null;
  if (objectAction && Object.keys(action).length !== 1) throw new E30LockError("unavailable");
  if (objectAction && "autoLock" in action) {
    const request = action.autoLock;
    if (!request || typeof request !== "object" || Object.keys(request).length !== 2
      || typeof request.enabled !== "boolean" || !(request.settings instanceof E30SettingsObservation)) throw new E30LockError("unavailable");
    return request.settings.autoLockCommand(identity, request.enabled, unixTime, keyTime, sequence);
  }
  const settingsWrite = objectAction && "soundVolume" in action;
  if (settingsWrite && ![1, 2, 3].includes(action.soundVolume)) throw new E30LockError("unavailable");
  if (typeof action !== "boolean" && action !== "query" && action !== "settings" && !settingsWrite) throw new E30LockError("unavailable");
  const timestamp = Buffer.alloc(4); timestamp.writeUInt32LE(unixTime);
  const fields = [timestamp, Buffer.from(identity.adminUserId)];
  if (action === "query") fields.push(Buffer.from([0]));
  else if (typeof action === "boolean") fields.push(Buffer.from([action ? 0 : 1]), Buffer.from(identity.userName), Buffer.from(identity.shortUserId, "hex"));
  else if (settingsWrite) fields.push(Buffer.from([4]), Buffer.from([action.soundVolume]));
  const opcode = action === "query" ? 34 : action === "settings" ? 53 : settingsWrite ? 52 : 35;
  return encodeE30Command(identity, opcode, fields, keyTime, sequence);
}

function encodeE30Command(identity: E30LockIdentity, opcode: E30CbcOpcode, fields: readonly Buffer[], keyTime: number, sequence: number): E30Command {
  const tlv = Buffer.concat(fields.flatMap((field, index) => [Buffer.from([0xa1 + index, field.length]), field]));
  const aligned = Buffer.alloc(Math.ceil(tlv.length / 16) * 16); tlv.copy(aligned);
  const { key, iv } = cipherIdentity(identity, keyTime);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(aligned), cipher.final()]);
  const frame = Buffer.alloc(10 + encrypted.length);
  frame.set([0xff, 0x09]); frame.writeUInt16LE(frame.length, 2);
  frame.set([3, 0, 2], 4); frame.writeUInt16BE(0x4000 | opcode, 7); encrypted.copy(frame, 9);
  frame[frame.length - 1] = checksum(frame.subarray(0, -1));
  key.fill(0);
  return { keyTime, sequence, opcode,
    transfer: { cmd: 1940, mChannel: 0, mValue3: 0,
      payload: { apiCommand: opcode === 34 ? 6012 : opcode === 53 ? 6016 : opcode === 52 ? 6015 : 6018,
        lock_payload: frame.toString("hex"), seq_num: sequence, time: keyTime } } };
}

/** Wrap the transfer in the official MQTT command-nine envelope, with a fresh session marker. */
export function e30MqttEnvelope(identity: E30LockIdentity, command: E30Command, clientId: string): string {
  return JSON.stringify({ head: { version: "1.0.0.1", client_id: clientId,
    sess_id: randomBytes(8).toString("hex"), msg_seq: command.sequence, seed: randomBytes(16).toString("hex"),
    timestamp: Math.floor(Date.now() / 1000), cmd_status: 2, cmd: 9, sign_code: 0 },
  payload: JSON.stringify({ account_id: identity.adminUserId, device_sn: identity.serial,
    trans: Buffer.from(JSON.stringify(command.transfer)).toString("base64") }) });
}

/** Ignore unrelated or malformed messages; only a matching query can produce an observation. */
export function decodeE30QueryReply(
  bytes: Buffer, identity: E30LockIdentity, query: E30Command,
): E30Observation | null {
  if (query.opcode !== 34) return null;
  const fields = decodeReplyFields(bytes, identity, query, "status");
  if (!fields || fields.get(0xa1)?.length !== 1 || fields.get(0xa2)?.length !== 1) return null;
  const battery = fields.get(0xa1)![0]!;
  return { rawState: fields.get(0xa2)![0]!, batteryPercent: battery <= 100 ? battery : null };
}

/**
 * Decode a settings GET bound to device and unique request time; an optional
 * sequence must also match. CBC/checksum are structural checks, while trust
 * comes from the authenticated TLS topic. Callers must never reuse keyTime.
 */
export function decodeE30SettingsReply(bytes: Buffer, identity: E30LockIdentity, query: E30Command): E30SettingsObservation | null {
  if (query.opcode !== 53) return null;
  const fields = decodeReplyFields(bytes, identity, query, "settings");
  const volume = fields?.get(0xab);
  if (!fields || volume?.length !== 1 || volume[0]! > 3) return null;
  return new E30SettingsObservation(volume[0] as E30SoundVolume, fields, identity);
}

function decodeReplyFields(bytes: Buffer, identity: E30LockIdentity, query: E30Command, mode: "status" | "settings"): Map<number, Buffer> | null {
  if (bytes.length > 65_536 || (query.opcode !== 34 && query.opcode !== 53)) return null;
  try {
    const outer = record(JSON.parse(bytes.toString("utf8")));
    const payload = typeof outer?.payload === "string" ? record(JSON.parse(outer.payload)) : null;
    if (!payload || typeof payload.trans !== "string" || payload.trans.length > 65_536
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.trans)) return null;
    const inner = record(JSON.parse(Buffer.from(payload.trans, "base64").toString("utf8")));
    const row = record(inner?.payload);
    if (inner?.cmd !== 1940 || !row || replyTime(row.time) !== query.keyTime
      || (mode === "settings" ? (typeof row.dev_sn !== "string" || row.dev_sn !== identity.serial) : (row.dev_sn !== undefined && row.dev_sn !== identity.serial))
      || (row.seq_num !== undefined && row.seq_num !== query.sequence)
      || typeof row.lock_payload !== "string" || !/^(?:[a-fA-F0-9]{2})+$/.test(row.lock_payload)) return null;
    const frame = Buffer.from(row.lock_payload, "hex");
    if (frame.length < 26 || frame.length > 4096 || frame[0] !== 0xff || frame[1] !== 9
      || frame.readUInt16LE(2) !== frame.length || frame[4] !== 3 || frame[5] !== 0 || frame[6] !== 2
      || frame.readUInt16BE(7) !== (0x4800 | query.opcode) || (frame.length - 10) % 16 !== 0
      || checksum(frame.subarray(0, -1)) !== frame[frame.length - 1]) return null;
    const { key, iv } = cipherIdentity(identity, query.keyTime);
    let plain: Buffer;
    try {
      const decipher = createDecipheriv("aes-128-cbc", key, iv);
      plain = Buffer.concat([decipher.update(frame.subarray(9, -1)), decipher.final()]);
    } finally { key.fill(0); }
    if (plain[0] !== 0) return null;
    const fields = new Map<number, Buffer>();
    let offset = 1;
    while (offset < plain.length && plain[offset] !== 0) {
      const tag = plain[offset]!; const length = plain[offset + 1];
      if (tag < 0xa1 || length === undefined || length === 0 || offset + 2 + length > plain.length || fields.has(tag)) return null;
      fields.set(tag, plain.subarray(offset + 2, offset + 2 + length)); offset += 2 + length;
    }
    if (plain.length - offset > 15 || plain.subarray(offset).some(byte => byte !== 0)) return null;
    return fields;
  } catch { return null; }
}

function cipherIdentity(identity: E30LockIdentity, keyTime: number): { key: Buffer; iv: Buffer } {
  const time = Buffer.alloc(4); time.writeUInt32BE(keyTime);
  const key = Buffer.concat([Buffer.from(identity.adminUserId.slice(-12)), time]);
  const iv = Buffer.alloc(16); Buffer.from(identity.serial).copy(iv);
  if (key.length !== 16) throw new E30LockError("unavailable");
  return { key, iv };
}

function checksum(bytes: Buffer): number { return bytes.reduce((value, byte) => value ^ byte, 0); }

function uint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function replyTime(value: unknown): number | null {
  return uint32(value) ? value : typeof value === "string" && /^[a-fA-F0-9]{8}$/.test(value) ? parseInt(value, 16) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
