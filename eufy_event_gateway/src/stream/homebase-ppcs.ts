/**
 * Implements bounded, local-only HomeBase 3 state and control sessions.
 *
 * The session owns one UDP socket and accepts a single command at a time. It
 * uses the LAN-derived command key only after the HomeBase answers broadcast
 * discovery, so that credential is never sent through a cloud relay. Callers
 * receive validated station observations and command acknowledgements; raw
 * packets, account identifiers, and storage paths never cross this boundary.
 */
import { createCipheriv, createDecipheriv } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";

import type { HomeBaseStorageState } from "../domain/types.js";

const MAGIC = Buffer.from("XZYH");
/** PPCS request headers exposed for protocol regression tests. */
export const HOMEBASE_PPCS_REQUEST_HEADERS = {
  end: Buffer.from([0xf1, 0xf0]),
  ping: Buffer.from([0xf1, 0xe0]),
  ack: Buffer.from([0xf1, 0xd1]),
  check: Buffer.from([0xf1, 0x41]),
  localLookup: Buffer.from([0xf1, 0x30]),
  data: Buffer.from([0xf1, 0xd0]),
} as const;
const RESP = {
  localLookup: Buffer.from([0xf1, 0x41]),
  camId: Buffer.from([0xf1, 0x42]),
  pong: Buffer.from([0xf1, 0xe1]),
  data: Buffer.from([0xf1, 0xd0]),
} as const;
const DATA_HEADER = Buffer.from([0xd1, 0]);
const STATION_CHANNEL = 255;
const CMD_GATEWAY_INFO = 1100;
const CMD_CAMERA_INFO = 1103;
const CMD_GET_ALARM_MODE = 1151;
const CMD_SET_ARMING = 1224;
const CMD_SET_HUB_SPEAKER_VOLUME = 1235;
const CMD_HUB_ALARM_TONE = 1281;
const CMD_HOMEBASE_TONE = 1201;
const CMD_SET_PROMPT_VOLUME = 1292;
const CMD_STORAGE_INFO_HB3 = 1307;
const CMD_SET_PAYLOAD = 1350;
const CMD_NOTIFY_PAYLOAD = 1351;
const COMMAND_TIMEOUT_MS = 10_000;
const STORAGE_STATUSES = new Map<number, string>([
  [-1, "not_present"],
  [0, "normal"],
  [1, "non_original"],
  [2, "mount_failed"],
  [3, "format_failed"],
  [4, "removed"],
  [5, "formatting"],
  [6, "busy"],
  [11, "repairing"],
  [22, "io_error"],
  [23, "at_risk"],
  [24, "mounting"],
]);

/** Identify an ambiguous write whose T8030 result frame did not arrive in time. */
export class HomeBaseCommandAcknowledgementTimeoutError extends Error {
  /** Create a timeout that callers may resolve through a fresh state readback. */
  constructor() {
    super("HomeBase command acknowledgement timed out");
    this.name = "HomeBaseCommandAcknowledgementTimeoutError";
  }
}

/** Values read from the HomeBase camera-info response. */
export interface HomeBasePpcsState {
  readonly firmware: string | null;
  readonly guardMode: number | null;
  readonly effectiveMode: number | null;
  readonly alarmVolume: number | null;
  readonly promptVolume: number | null;
  readonly alarmTone: number | null;
  readonly storage: {
    readonly emmc: HomeBaseStorageState | null;
    readonly hdd: HomeBaseStorageState | null;
  } | null;
}

/** Network identity and account fields required for one HomeBase session. */
export interface HomeBasePpcsOptions {
  readonly serial: string;
  readonly p2pDid: string;
  readonly accountId: string;
  readonly userName: string;
}

interface PendingCommand {
  readonly outerCommand: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface CameraInfo {
  readonly params?: readonly unknown[];
  readonly main_sw_version?: unknown;
}

/**
 * Opens one short-lived local command channel to a HomeBase 3.
 *
 * A session never retries a control write. Every write waits for the matching
 * command result, and callers must perform a fresh read on the same session to
 * confirm the resulting device state.
 */
export class HomeBasePpcsSession {
  readonly #socket: Socket = createSocket("udp4");
  readonly #key: Buffer;
  #remote: { host: string; port: number } | null = null;
  #sequence = 0;
  #closed = false;
  #pendingByType = new Map<number, Buffer>();
  #lastSequenceByType = new Map<number, number>();
  #pendingCommand: PendingCommand | null = null;
  #gatewayInfoWaiter: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  #cameraInfoWaiter: { resolve: (value: CameraInfo) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  #storageWaiter: { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;

  /** Create an unopened session for a known HomeBase. */
  constructor(private readonly options: HomeBasePpcsOptions) {
    this.#key = commandKey(options.serial, options.p2pDid);
    if (this.#key.length !== 16) throw new Error("HomeBase command identity is invalid");
  }

  /** Discover the HomeBase on the local network and establish its UDP peer. */
  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("HomeBase local PPCS lookup timed out")), 10_000);
      this.#socket.once("error", (error) => { clearTimeout(timer); reject(error); });
      this.#socket.on("message", (message, info) => {
        try {
          if (this.#handle(message, info)) { clearTimeout(timer); resolve(); }
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.#socket.bind(0, () => {
        this.#socket.setBroadcast(true);
        this.#send(HOMEBASE_PPCS_REQUEST_HEADERS.localLookup, Buffer.from([0, 0]), { host: "255.255.255.255", port: 32108 });
      });
    });
    const gatewayInfoPromise = this.#waitForGatewayInfo();
    this.#sendCommand(CMD_GATEWAY_INFO, voidPayload(STATION_CHANNEL));
    await gatewayInfoPromise;
    this.#heartbeat = setInterval(() => {
      if (this.#remote) this.#send(HOMEBASE_PPCS_REQUEST_HEADERS.ping, Buffer.alloc(0), this.#remote);
    }, 5_000);
    this.#heartbeat.unref();
  }

  /** Read all state fields used by the Home Assistant integration. */
  async readState(includeStorage = true): Promise<HomeBasePpcsState> {
    const cameraInfoPromise = this.#waitForCameraInfo();
    this.#sendCommand(CMD_CAMERA_INFO, intPayload(255, STATION_CHANNEL, this.#key));
    const cameraInfo = await cameraInfoPromise;

    if (!includeStorage) return parseHomeBaseState(cameraInfo, null, false);
    const storagePromise = this.#waitForStorage();
    const storageRequest = JSON.stringify({
      account_id: this.options.accountId,
      cmd: CMD_STORAGE_INFO_HB3,
      mChannel: 0,
      mValue3: 0,
      payload: { version: 0, cmd: 11001 },
    });
    const acknowledgement = this.#sendAcknowledgedCommand(
      CMD_SET_PAYLOAD,
      stringPayload(storageRequest, 0, this.#key),
    );
    try {
      const [storage] = await Promise.all([storagePromise, acknowledgement]);
      return parseHomeBaseState(cameraInfo, storage, true);
    } catch {
      return parseHomeBaseState(cameraInfo, null, false);
    }
  }

  /** Set the configured Eufy guard mode once and wait for its acknowledgement. */
  async setGuardMode(mode: number): Promise<void> {
    const value = JSON.stringify({
      account_id: this.options.accountId,
      cmd: CMD_SET_ARMING,
      mValue3: 0,
      payload: { mode_type: mode, user_name: this.options.userName },
    });
    await this.#sendAcknowledgedCommand(CMD_SET_PAYLOAD, stringPayload(value, STATION_CHANNEL, this.#key));
  }

  /** Set the HomeBase alarm-speaker volume once. */
  async setAlarmVolume(value: number): Promise<void> {
    await this.#sendAcknowledgedCommand(
      CMD_SET_HUB_SPEAKER_VOLUME,
      intPayload(value, STATION_CHANNEL, this.#key, this.options.accountId),
    );
  }

  /** Set the HomeBase spoken-prompt volume once. */
  async setPromptVolume(value: number): Promise<void> {
    await this.#setPayload(CMD_SET_PROMPT_VOLUME, { value });
  }

  /** Set the HomeBase alarm tone once. */
  async setAlarmTone(value: number): Promise<void> {
    await this.#setPayload(CMD_HUB_ALARM_TONE, { type: value });
  }

  /** Trigger or stop the HomeBase siren through its station broadcast command. */
  async setSiren(durationSeconds: number): Promise<void> {
    await this.#setPayload(CMD_HOMEBASE_TONE, {
      time_out: durationSeconds,
      user_name: this.options.userName,
    });
  }

  /** Close the socket and reject every incomplete operation. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    const error = new Error("HomeBase session closed before the operation completed");
    this.#rejectPending(error);
    if (this.#remote) this.#send(HOMEBASE_PPCS_REQUEST_HEADERS.end, Buffer.alloc(0), this.#remote);
    this.#socket.close();
  }

  async #setPayload(command: number, payload: Record<string, number | string>): Promise<void> {
    const value = JSON.stringify({
      account_id: this.options.accountId,
      cmd: command,
      mValue3: 0,
      payload,
    });
    await this.#sendAcknowledgedCommand(CMD_SET_PAYLOAD, stringPayload(value, STATION_CHANNEL, this.#key));
  }

  #handle(message: Buffer, info: RemoteInfo): boolean {
    if (has(message, RESP.localLookup)) {
      if (decodeDid(message.subarray(4, 24)) === this.options.p2pDid) {
        this.#check({ host: info.address, port: info.port });
      }
      return false;
    }
    if (has(message, RESP.camId)) {
      if (this.#remote) return false;
      this.#remote = { host: info.address, port: info.port };
      this.#send(HOMEBASE_PPCS_REQUEST_HEADERS.ping, Buffer.alloc(0), this.#remote);
      return true;
    }
    if (has(message, RESP.pong)) return false;
    if (has(message, RESP.data) && this.#remote) {
      const type = message.subarray(4, 6);
      const sequence = message.readUInt16BE(6);
      this.#send(HOMEBASE_PPCS_REQUEST_HEADERS.ack, Buffer.concat([type, u16(1), u16(sequence)]), this.#remote);
      this.#consumeData(message.subarray(8), sequence, type[1] ?? 0);
    }
    return false;
  }

  #consumeData(data: Buffer, sequence: number, type: number): void {
    const previous = this.#lastSequenceByType.get(type);
    if (previous !== undefined && ((sequence - previous) & 0xffff) > 1) this.#pendingByType.delete(type);
    this.#lastSequenceByType.set(type, sequence);
    let pending = Buffer.concat([this.#pendingByType.get(type) ?? Buffer.alloc(0), data]);
    while (pending.length >= 16 && pending.subarray(0, 4).equals(MAGIC)) {
      const command = pending.readUInt16LE(4);
      const size = pending.readUInt32LE(6);
      if (size > 16 * 1024 * 1024) throw new Error("HomeBase response exceeded the safety limit");
      if (pending.length < 16 + size) break;
      const resultMessage = isHomeBaseResultFrame(pending);
      const channel = pending[12] ?? 0;
      const signCode = pending[13] ?? 0;
      const payload = pending.subarray(16, 16 + size);
      pending = pending.subarray(16 + size);
      this.#handleFrame(command, channel, signCode, resultMessage, payload);
    }
    this.#pendingByType.set(type, pending);
  }

  #handleFrame(command: number, _channel: number, signCode: number, resultMessage: boolean, payload: Buffer): void {
    const clear = signCode > 0 && payload.length > 0 && payload.length % 16 === 0
      ? decryptEcb(payload, this.#key)
      : payload;
    if (resultMessage) {
      if (this.#pendingCommand?.outerCommand !== command || clear.length < 4) return;
      const pending = this.#pendingCommand;
      this.#pendingCommand = null;
      clearTimeout(pending.timer);
      const result = clear.readInt32LE(0);
      result === 0 ? pending.resolve() : pending.reject(new Error(`HomeBase rejected command (${result})`));
      return;
    }
    if (command === CMD_GATEWAY_INFO && this.#gatewayInfoWaiter) {
      const waiter = this.#gatewayInfoWaiter;
      this.#gatewayInfoWaiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve();
      return;
    }
    if (command === CMD_CAMERA_INFO) {
      const value = parseJsonBuffer(clear);
      if (isRecord(value) && this.#cameraInfoWaiter) {
        const waiter = this.#cameraInfoWaiter;
        this.#cameraInfoWaiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve(value);
      }
      return;
    }
    if (command === CMD_GET_ALARM_MODE && clear.length > 0) return;
    if (command !== CMD_NOTIFY_PAYLOAD) return;
    const notification = parseJsonBuffer(clear);
    if (!isRecord(notification) || Number(notification.cmd) !== CMD_STORAGE_INFO_HB3 || !this.#storageWaiter) return;
    const value = isRecord(notification.payload) && "body" in notification.payload
      ? notification.payload.body
      : notification.payload;
    const waiter = this.#storageWaiter;
    this.#storageWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }

  #sendAcknowledgedCommand(command: number, payload: Buffer): Promise<void> {
    if (this.#pendingCommand) return Promise.reject(new Error("HomeBase already has a command in flight"));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingCommand = null;
        reject(new HomeBaseCommandAcknowledgementTimeoutError());
      }, COMMAND_TIMEOUT_MS);
      this.#pendingCommand = { outerCommand: command, resolve, reject, timer };
      this.#sendCommand(command, payload);
    });
  }

  #waitForCameraInfo(): Promise<CameraInfo> {
    if (this.#cameraInfoWaiter) return Promise.reject(new Error("HomeBase state read is already in flight"));
    return new Promise<CameraInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#cameraInfoWaiter = null;
        reject(new Error("HomeBase state read timed out"));
      }, COMMAND_TIMEOUT_MS);
      this.#cameraInfoWaiter = { resolve, reject, timer };
    });
  }

  #waitForGatewayInfo(): Promise<void> {
    if (this.#gatewayInfoWaiter) return Promise.reject(new Error("HomeBase gateway handshake is already in flight"));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#gatewayInfoWaiter = null;
        reject(new Error("HomeBase gateway handshake timed out"));
      }, COMMAND_TIMEOUT_MS);
      this.#gatewayInfoWaiter = { resolve, reject, timer };
    });
  }

  #waitForStorage(): Promise<unknown> {
    if (this.#storageWaiter) return Promise.reject(new Error("HomeBase storage read is already in flight"));
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#storageWaiter = null;
        reject(new Error("HomeBase storage read timed out"));
      }, COMMAND_TIMEOUT_MS);
      this.#storageWaiter = { resolve, reject, timer };
    });
  }

  #rejectPending(error: Error): void {
    if (this.#pendingCommand) {
      clearTimeout(this.#pendingCommand.timer);
      this.#pendingCommand.reject(error);
      this.#pendingCommand = null;
    }
    if (this.#gatewayInfoWaiter) {
      clearTimeout(this.#gatewayInfoWaiter.timer);
      this.#gatewayInfoWaiter.reject(error);
      this.#gatewayInfoWaiter = null;
    }
    if (this.#cameraInfoWaiter) {
      clearTimeout(this.#cameraInfoWaiter.timer);
      this.#cameraInfoWaiter.reject(error);
      this.#cameraInfoWaiter = null;
    }
    if (this.#storageWaiter) {
      clearTimeout(this.#storageWaiter.timer);
      this.#storageWaiter.reject(error);
      this.#storageWaiter = null;
    }
  }

  #check(address: { host: string; port: number }): void {
    this.#send(HOMEBASE_PPCS_REQUEST_HEADERS.check, Buffer.concat([encodeDid(this.options.p2pDid), Buffer.alloc(3)]), address);
  }

  #sendCommand(command: number, payload: Buffer): void {
    if (!this.#remote) throw new Error("HomeBase is not connected");
    const header = Buffer.concat([DATA_HEADER, u16(this.#sequence++), MAGIC, u16le(command)]);
    this.#send(HOMEBASE_PPCS_REQUEST_HEADERS.data, Buffer.concat([header, payload]), this.#remote);
  }

  #send(type: Buffer, payload: Buffer, address: { host: string; port: number }): void {
    this.#socket.send(Buffer.concat([type, u16(payload.length), payload]), address.port, address.host);
  }
}

/** Convert checked camera-info and storage payloads into normalized station state. */
export function parseHomeBaseState(cameraInfo: unknown, storage: unknown, storageObserved = true): HomeBasePpcsState {
  const info = isRecord(cameraInfo) ? cameraInfo : {};
  const values = new Map<number, number>();
  if (Array.isArray(info.params)) {
    for (const raw of info.params) {
      if (!isRecord(raw) || Number(raw.dev_type) !== STATION_CHANNEL) continue;
      const type = safeInteger(raw.param_type);
      const value = safeInteger(raw.param_value);
      if (type !== null && value !== null) values.set(type, value);
    }
  }
  return {
    firmware: safeText(info.main_sw_version, 100),
    guardMode: allowedMode(values.get(CMD_SET_ARMING)),
    effectiveMode: allowedMode(values.get(CMD_GET_ALARM_MODE)),
    alarmVolume: bounded(values.get(CMD_SET_HUB_SPEAKER_VOLUME), 1, 26),
    promptVolume: bounded(values.get(CMD_SET_PROMPT_VOLUME), 0, 26),
    alarmTone: bounded(values.get(CMD_HUB_ALARM_TONE), 1, 2),
    storage: storageObserved ? parseStorage(storage) : null,
  };
}

/** Return whether an inner HomeBase PPCS frame is a command-result message. */
export function isHomeBaseResultFrame(frame: Buffer): boolean {
  return frame.length >= 15 && frame[14] === 1;
}

function parseStorage(value: unknown): HomeBasePpcsState["storage"] {
  const parsed = typeof value === "string" ? parseJsonText(value) : value;
  const body = isRecord(parsed) ? parsed : {};
  return {
    emmc: storageDevice(body.emmc_info, "disk_size", "disk_used"),
    hdd: storageDevice(body.hdd_info, "disk_size", "disk_used"),
  };
}

function storageDevice(value: unknown, totalKey: string, usedKey: string): HomeBaseStorageState | null {
  if (!isRecord(value)) return null;
  const totalMebibytes = nonNegativeInteger(value[totalKey]);
  const usedMebibytes = nonNegativeInteger(value[usedKey]);
  if (totalMebibytes === null || totalMebibytes === 0) return null;
  const totalBytes = totalMebibytes * 1024 * 1024;
  const usedBytes = usedMebibytes === null ? null : usedMebibytes * 1024 * 1024;
  if (!Number.isSafeInteger(totalBytes) || (usedBytes !== null && !Number.isSafeInteger(usedBytes))) return null;
  const workStatus = safeInteger(value.work_status);
  return {
    status: workStatus === null ? "reported" : STORAGE_STATUSES.get(workStatus) ?? `unknown_${workStatus}`,
    totalBytes,
    freeBytes: usedBytes === null ? null : Math.max(0, totalBytes - usedBytes),
  };
}

function intPayload(value: number, channel: number, key: Buffer, suffix = ""): Buffer {
  const integer = Buffer.alloc(4);
  integer.writeUInt32LE(value, 0);
  const suffixBytes = suffix ? fixedString(suffix) : Buffer.alloc(0);
  return encryptedPayload(Buffer.concat([integer, suffixBytes]), channel, key);
}

function stringPayload(value: string, channel: number, key: Buffer): Buffer {
  return encryptedPayload(Buffer.from(value), channel, key);
}

function encryptedPayload(value: Buffer, channel: number, key: Buffer): Buffer {
  const plain = Buffer.alloc(Math.ceil(Math.max(value.length, 16) / 16) * 16);
  value.copy(plain);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const result = Buffer.alloc(10 + encrypted.length);
  result.writeUInt16LE(encrypted.length, 0);
  result.writeUInt16LE(1, 4);
  result[6] = channel;
  result[7] = 1;
  encrypted.copy(result, 10);
  return result;
}

function voidPayload(channel: number): Buffer {
  return Buffer.from([0, 0, 0, 0, 1, 0, channel, 0, 0, 0]);
}

function fixedString(value: string): Buffer {
  const bytes = Buffer.from(value);
  const output = Buffer.alloc(Math.max(128, Math.ceil(bytes.length / 128) * 128));
  bytes.copy(output);
  return output;
}

function parseJsonBuffer(value: Buffer): unknown {
  const end = value.indexOf(0);
  const text = value.subarray(0, end < 0 ? value.length : end).toString("utf8");
  return parseJsonText(text);
}

function parseJsonText(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function allowedMode(value: number | undefined): number | null {
  return value !== undefined && [0, 1, 2, 3, 4, 5, 47, 63].includes(value) ? value : null;
}

function bounded(value: number | undefined, minimum: number, maximum: number): number | null {
  return value !== undefined && value >= minimum && value <= maximum ? value : null;
}

function safeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = safeInteger(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function safeText(value: unknown, maximum: number): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 && text.length <= maximum ? text : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has(value: Buffer, header: Buffer): boolean {
  return value.length >= 2 && value.subarray(0, 2).equals(header);
}

function commandKey(serial: string, did: string): Buffer {
  return Buffer.from(`${serial.slice(-7)}${did.substring(did.indexOf("-"), did.indexOf("-") + 9)}`);
}

function decryptEcb(value: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(value), decipher.final()]);
}

function encodeDid(value: string): Buffer {
  const [prefix, number, suffix] = value.split("-");
  const result = Buffer.alloc(20);
  Buffer.from(prefix ?? "").copy(result);
  result.writeUInt32BE(Number(number ?? 0), 8);
  Buffer.from(suffix ?? "").copy(result, 12);
  return result;
}

function decodeDid(value: Buffer): string {
  return `${value.subarray(0, 8).toString().replace(/\0+$/g, "")}-${value.readUInt32BE(8).toString().padStart(6, "0")}-${value.subarray(12, 20).toString().replace(/\0+$/g, "")}`;
}

function u16(value: number): Buffer {
  const output = Buffer.alloc(2);
  output.writeUInt16BE(value & 0xffff);
  return output;
}

function u16le(value: number): Buffer {
  const output = Buffer.alloc(2);
  output.writeUInt16LE(value & 0xffff);
  return output;
}
