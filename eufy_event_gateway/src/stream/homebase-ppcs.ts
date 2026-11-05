/**
 * Implements bounded, local-only HomeBase state and control sessions.
 *
 * The session owns one UDP socket and accepts a single command at a time. It
 * uses the LAN-derived command key only after the HomeBase answers broadcast
 * discovery, so that credential is never sent through a cloud relay. Callers
 * receive validated station observations and command acknowledgements; raw
 * packets, account identifiers, and storage paths never cross this boundary.
 */
import { createRecordedCipheriv as createCipheriv } from "../diagnostics/raw-crypto.js";
import { createRecordedDecipheriv as createDecipheriv } from "../diagnostics/raw-crypto.js";
import { observeRawSocket } from "../diagnostics/raw-network.js";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";

import type { HomeBaseStorageState } from "../domain/types.js";
import { PpcsDatagramReorderBuffer } from "./first-party-ppcs.js";
import { ppcsCandidatePorts, ppcsLocalLookupTargets } from "./ppcs-lookup.js";

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
  ack: Buffer.from([0xf1, 0xd1]),
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
const CMD_STORAGE_INFO_HB2 = 1144;
const CMD_STORAGE_INFO_HB3 = 1307;
const CMD_SET_PAYLOAD = 1350;
const CMD_NOTIFY_PAYLOAD = 1351;
const COMMAND_TIMEOUT_MS = 10_000;
const LOOKUP_RETRY_MILLISECONDS = 1_000;
const CHILD_READ_PARAM_TYPES: ReadonlySet<number> = new Set([
  1011,
  1013,
  1020,
  1035,
  1045,
  1101,
  1138,
  1141,
  1198,
  1207,
  1230,
  1240,
  1241,
  1277,
  1550,
  1551,
  1605,
  2001,
  2111,
  6012,
  6020,
  6040,
]);
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

  /** Why the station-channel alarm-volume parameter did or did not normalize. */
  readonly alarmVolumeObservation: "missing" | "invalid" | "out_of_range" | "valid";
  readonly promptVolume: number | null;
  readonly alarmTone: number | null;
  readonly storage: {
    readonly sd: HomeBaseStorageState | null;
    readonly emmc: HomeBaseStorageState | null;
    readonly hdd: HomeBaseStorageState | null;
  } | null;
  readonly storageDiagnostic: HomeBaseStorageDiagnostic | null;

  /** Allowlisted current values reported for attached-device channels in the same camera-info reply. */
  readonly childParams: readonly HomeBaseChildParam[];
}

/** One non-sensitive attached-device value retained from a HomeBase camera-info reply. */
export interface HomeBaseChildParam {
  readonly channel: number;
  readonly type: number;
  readonly value: string | number | boolean;
}

/** Privacy-safe field inventory for one raw HomeBase 3 HDD response. */
export interface HomeBaseStorageDiagnostic {
  readonly present: boolean;
  readonly numericFields: readonly string[];
  readonly booleanFields: readonly string[];
  readonly textFieldLengths: readonly string[];
  readonly structuredFields: readonly string[];
}

/** Network identity and account fields required for one HomeBase session. */
export interface HomeBasePpcsOptions {
  readonly serial: string;
  readonly p2pDid: string;

  /** Private inventory address used when the LAN blocks broadcast discovery. */
  readonly localAddress?: string | null;
  readonly accountId: string;
  readonly userName: string;

  /** Selects the generation-specific storage query, or disables storage reads. */
  readonly storageProtocol?: "homebase2" | "homebase3" | "none";

  /** Inventory firmware used only to select the HomeBase 2 request shape. */
  readonly firmware?: string | null;
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
 * Opens one short-lived local state or command channel to a discovered HomeBase.
 *
 * A session never retries a control write. Every write waits for the matching
 * command result, and callers must perform a fresh read on the same session to
 * confirm the resulting device state. Close cancels operations immediately.
 * Callers await local disconnect-send completion before reusing the peer.
 * A session-owned bounded reorder buffer repairs transport ordering without
 * repeating application commands, including household-security writes.
 */
export class HomeBasePpcsSession {
  readonly #socket: Socket = createSocket("udp4");
  readonly #key: Buffer;
  #remote: { host: string; port: number } | null = null;
  #sequence = 0;
  #closed = false;
  #closeCompletion: Promise<void> = Promise.resolve();
  #cancelConnect: ((error: Error) => void) | null = null;
  #pendingByType = new Map<number, Buffer>();
  #receivedDatagrams = 0;
  #frameHeaders = 0;
  #sequenceGaps = 0;
  #sequenceRestarts = 0;
  #duplicateDatagrams = 0;
  #staleDatagrams = 0;
  #parserResyncs = 0;
  #readRequests = 0;
  #readAcknowledged = 0;
  readonly #readSequences = new Set<number>();
  #closedSequenceEvidence: string | null = null;
  readonly #commands = new Set<number>();
  readonly #reorder = new PpcsDatagramReorderBuffer(
    (data, type) => {
      try { this.#consumeData(data, type); }
      catch (error) {
        this.#rejectPending(error instanceof Error ? error : new Error("HomeBase response could not be parsed"));
        this.close();
      }
    },
    (type, reason) => {
      this.#pendingByType.delete(type);
      if (reason === "gap") this.#sequenceGaps++;
      else this.#sequenceRestarts++;
    },
    reason => {
      if (reason === "duplicate") this.#duplicateDatagrams++;
      else this.#staleDatagrams++;
    },
  );
  #pendingCommand: PendingCommand | null = null;
  #gatewayInfoWaiter: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  #cameraInfoWaiter: { resolve: (value: CameraInfo) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  #storageWaiter: { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #lookupTimer: ReturnType<typeof setInterval> | null = null;

  /** Create an unopened session for a known HomeBase. */
  constructor(private readonly options: HomeBasePpcsOptions) {
    this.#key = commandKey(options.serial, options.p2pDid);
    if (this.#key.length !== 16) throw new Error("HomeBase command identity is invalid");
  }

  /** Discover the HomeBase on the local network and establish its UDP peer. */
  async connect(): Promise<void> {
    if (this.#closed) throw new Error("HomeBase session is closed");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#lookupTimer) clearInterval(this.#lookupTimer);
        this.#lookupTimer = null;
        reject(new Error("HomeBase local PPCS lookup timed out"));
      }, 10_000);
      this.#cancelConnect = (error) => { clearTimeout(timer); reject(error); };
      this.#socket.once("error", (error) => {
        clearTimeout(timer);
        if (this.#lookupTimer) clearInterval(this.#lookupTimer);
        this.#lookupTimer = null;
        reject(error);
      });
    observeRawSocket(this.#socket, "homebase_ppcs", "udp");
      this.#socket.on("message", (message, info) => {
        try {
          if (this.#handle(message, info)) {
            clearTimeout(timer);
            if (this.#lookupTimer) clearInterval(this.#lookupTimer);
            this.#lookupTimer = null;
            resolve();
          }
        } catch (error) {
          clearTimeout(timer);
          if (this.#lookupTimer) clearInterval(this.#lookupTimer);
          this.#lookupTimer = null;
          reject(error);
        }
      });
      this.#socket.bind(0, () => {
        if (this.#closed) return;
        this.#socket.setBroadcast(true);
        this.#lookup();
        this.#lookupTimer = setInterval(
          () => this.#lookup(),
          LOOKUP_RETRY_MILLISECONDS,
        );
        this.#lookupTimer.unref?.();
      });
    }).finally(() => { this.#cancelConnect = null; });
    if (this.#closed) throw new Error("HomeBase session is closed");
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
    if (this.#closed) throw new Error("HomeBase session is closed");
    const cameraInfoPromise = this.#waitForCameraInfo();
    this.#sendCommand(CMD_CAMERA_INFO, intPayload(255, STATION_CHANNEL, this.#key));
    const cameraInfo = await cameraInfoPromise;
    if (this.#closed) throw new Error("HomeBase session is closed");

    if (!includeStorage || !this.options.storageProtocol || this.options.storageProtocol === "none") {
      return parseHomeBaseState(cameraInfo, null, false);
    }
    if (this.options.storageProtocol === "homebase2") {
      const storagePromise = this.#waitForStorage();
      const firmware = safeText(cameraInfo.main_sw_version, 100) ?? this.options.firmware;
      const payload = buildHomeBase2StorageRequestPayload(
        firmware,
        this.options.accountId,
        this.#key,
      );
      this.#sendCommand(CMD_STORAGE_INFO_HB2, payload);
      try {
        const storage = await storagePromise;
        const storageBuffer = Buffer.isBuffer(storage) ? storage : null;
        return {
          ...parseHomeBaseState(cameraInfo, null, false),
          storage: {
            sd: storageBuffer ? parseHomeBase2StorageResponse(storageBuffer) : null,
            emmc: null,
            hdd: null,
          },
          storageDiagnostic: storageBuffer ? homeBase2StorageDiagnostic(storageBuffer) : null,
        };
      } catch {
        return parseHomeBaseState(cameraInfo, null, false);
      }
    }
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
    const value = buildHomeBaseGuardModeValue(
      this.options.accountId,
      this.options.userName,
      mode,
    );
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

  /** Cancel operations immediately, then drain the final local disconnect send. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#lookupTimer) clearInterval(this.#lookupTimer);
    const error = new Error("HomeBase session closed before the operation completed");
    this.#cancelConnect?.(error);
    this.#cancelConnect = null;
    this.#rejectPending(error);
    this.#pendingByType.clear();
    this.#readSequences.clear();
    this.#closedSequenceEvidence = this.#reorder.diagnostics();
    this.#reorder.close();
    this.#closeCompletion = new Promise<void>(resolve => {
      let finished = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (deadline) clearTimeout(deadline);
        try { this.#socket.close(); } catch {

          // An unopened or failed socket may already be closed.
        }
        resolve();
      };
      if (!this.#remote) { finish(); return; }
      deadline = setTimeout(finish, 500);
      deadline.unref?.();
      try {
        this.#socket.send(Buffer.concat([HOMEBASE_PPCS_REQUEST_HEADERS.end, u16(0)]),
          this.#remote.port, this.#remote.host, finish);
      } catch { finish(); }
    });
  }

  /** Wait up to 500ms for local disconnect-send completion, without claiming peer acknowledgement. */
  waitUntilClosed(): Promise<void> {
    return this.#closeCompletion;
  }

  /** Return bounded transport counters without state values, addresses or device identity. */
  diagnostics(): string {
    const pendingBytes = [...this.#pendingByType.values()].reduce((sum, value) => sum + value.length, 0);
    return `data_datagrams=${this.#receivedDatagrams} frame_headers=${this.#frameHeaders}`
      + ` sequence_gaps=${this.#sequenceGaps} sequence_restarts=${this.#sequenceRestarts}`
      + ` duplicate_datagrams=${this.#duplicateDatagrams} stale_datagrams=${this.#staleDatagrams}`
      + ` parser_resyncs=${this.#parserResyncs} pending_bytes=${pendingBytes}`
      + ` read_requests=${this.#readRequests} read_acknowledged=${this.#readAcknowledged}`
      + ` commands=${[...this.#commands].join(",") || "none"}`
      + ` sequence_channels=${this.#closedSequenceEvidence ?? this.#reorder.diagnostics()}`;
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
    if (this.#closed) return false;
    if (has(message, RESP.localLookup)) {
      for (const port of ppcsCandidatePorts(info.port)) {
        this.#check({ host: info.address, port });
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
    if (has(message, RESP.ack) && message.length >= 8 && this.#remote
      && info.address === this.#remote.host && info.port === this.#remote.port
      && message[4] === 0xd1 && message[5] === 0) {
      const count = message.readUInt16BE(6);
      if (count <= (message.length - 8) / 2) {
        for (let index = 0; index < count; index++) {
          if (this.#readSequences.delete(message.readUInt16BE(8 + index * 2))) this.#readAcknowledged++;
        }
      }
      return false;
    }
    if (has(message, RESP.data) && message.length >= 8 && this.#remote) {
      const type = message.subarray(4, 6);
      const sequence = message.readUInt16BE(6);
      this.#send(HOMEBASE_PPCS_REQUEST_HEADERS.ack, Buffer.concat([type, u16(1), u16(sequence)]), this.#remote);
      this.#receivedDatagrams++;
      this.#reorder.push(message.subarray(8), sequence, type[1] ?? 0);
    }
    return false;
  }

  #lookup(): void {
    if (this.#remote) return;
    for (const address of ppcsLocalLookupTargets(this.options.localAddress)) {
      this.#send(
        HOMEBASE_PPCS_REQUEST_HEADERS.localLookup,
        Buffer.from([0, 0]),
        address,
      );
    }
  }

  #consumeData(data: Buffer, type: number): void {
    let pending = Buffer.concat([this.#pendingByType.get(type) ?? Buffer.alloc(0), data]);
    while (pending.length >= 4) {
      const marker = pending.indexOf(MAGIC);
      if (marker !== 0) {

        // A lost fragment's tail must not hide the next complete command header.
        this.#parserResyncs++;
        pending = pending.subarray(marker < 0 ? Math.max(0, pending.length - 3) : marker);
        if (marker < 0) break;
      }
      if (pending.length < 16) break;
      const command = pending.readUInt16LE(4);
      const size = pending.readUInt32LE(6);
      if (size > 16 * 1024 * 1024) throw new Error("HomeBase response exceeded the safety limit");
      if (pending.length < 16 + size) break;
      const resultMessage = isHomeBaseResultFrame(pending, size);
      const channel = pending[12] ?? 0;
      const signCode = pending[13] ?? 0;
      const payload = pending.subarray(16, 16 + size);
      pending = pending.subarray(16 + size);
      this.#frameHeaders++;
      if (this.#commands.size < 8) this.#commands.add(command);
      this.#handleFrame(command, channel, signCode, resultMessage, payload);
    }
    this.#pendingByType.set(type, pending);
  }

  #handleFrame(command: number, _channel: number, signCode: number, resultMessage: boolean, payload: Buffer): void {
    const clear = signCode > 0 && payload.length > 0 && payload.length % 16 === 0
      ? decryptEcb(payload, this.#key)
      : payload;
    if (command === CMD_STORAGE_INFO_HB2 && this.#storageWaiter && clear.length >= 12) {
      const waiter = this.#storageWaiter;
      this.#storageWaiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(clear);
      return;
    }
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
    if (this.#closed) return Promise.reject(new Error("HomeBase session is closed"));
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
    const sequence = this.#sequence++;
    if ([CMD_GATEWAY_INFO, CMD_CAMERA_INFO, CMD_STORAGE_INFO_HB2].includes(command)) {
      this.#readRequests++;
      this.#readSequences.add(sequence);
      if (this.#readSequences.size > 8) this.#readSequences.delete(this.#readSequences.values().next().value!);
    }
    const header = Buffer.concat([DATA_HEADER, u16(sequence), MAGIC, u16le(command)]);
    this.#send(HOMEBASE_PPCS_REQUEST_HEADERS.data, Buffer.concat([header, payload]), this.#remote);
  }

  #send(type: Buffer, payload: Buffer, address: { host: string; port: number }): void {
    if (this.#closed) return;
    this.#socket.send(Buffer.concat([type, u16(payload.length), payload]), address.port, address.host);
  }
}

/** Build the broadcast and inventory-directed targets for HomeBase discovery. */
export function homeBaseLocalLookupTargets(
  localAddress?: string | null,
): Array<{ readonly host: string; readonly port: number }> {
  return ppcsLocalLookupTargets(localAddress);
}

/** Build the wrapped guard-mode value accepted by current HomeBase firmware. */
export function buildHomeBaseGuardModeValue(
  accountId: string,
  userName: string,
  mode: number,
): string {
  return JSON.stringify({
    account_id: accountId,
    cmd: CMD_SET_ARMING,
    mValue3: 0,
    payload: { mode_type: mode, user_name: userName },
  });
}

/** Convert checked camera-info and storage payloads into normalized station state. */
export function parseHomeBaseState(cameraInfo: unknown, storage: unknown, storageObserved = true): HomeBasePpcsState {
  const info = isRecord(cameraInfo) ? cameraInfo : {};
  const values = new Map<number, number>();
  let alarmVolumeObservation: HomeBasePpcsState["alarmVolumeObservation"] = "missing";
  if (Array.isArray(info.params)) {
    for (const raw of info.params) {
      if (!isRecord(raw) || Number(raw.dev_type) !== STATION_CHANNEL) continue;
      const type = safeInteger(raw.param_type);
      const value = safeInteger(raw.param_value);
      if (type === CMD_SET_HUB_SPEAKER_VOLUME) {
        alarmVolumeObservation = value === null
          ? "invalid"
          : value < 1 || value > 26 ? "out_of_range" : "valid";
      }
      if (type !== null && value !== null) values.set(type, value);
    }
  }
  return {
    firmware: safeText(info.main_sw_version, 100),
    guardMode: allowedMode(values.get(CMD_SET_ARMING)),
    effectiveMode: allowedMode(values.get(CMD_GET_ALARM_MODE)),
    alarmVolume: bounded(values.get(CMD_SET_HUB_SPEAKER_VOLUME), 1, 26),
    alarmVolumeObservation,
    promptVolume: bounded(values.get(CMD_SET_PROMPT_VOLUME), 0, 26),
    alarmTone: bounded(values.get(CMD_HUB_ALARM_TONE), 1, 2),
    storage: storageObserved ? parseStorage(storage) : null,
    storageDiagnostic: storageObserved ? storageDiagnostic(storage) : null,
    childParams: parseChildParams(info.params),
  };
}

function parseChildParams(value: unknown): HomeBaseChildParam[] {
  if (!Array.isArray(value)) return [];
  const output: HomeBaseChildParam[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const channel = safeInteger(raw.dev_type);
    const type = safeInteger(raw.param_type);
    const paramValue = raw.param_value;
    if (channel === null || channel === STATION_CHANNEL || type === null || !CHILD_READ_PARAM_TYPES.has(type)) continue;
    if (typeof paramValue !== "string" && typeof paramValue !== "number" && typeof paramValue !== "boolean") continue;
    output.push({ channel, type, value: paramValue });
  }
  return output;
}

/**
 * Return whether an inner HomeBase PPCS frame carries a command result.
 *
 * HomeBases may set the result type byte or return an untyped four-byte
 * status body. The pending outer command still has to match before the caller
 * accepts either form as its acknowledgement.
 */
export function isHomeBaseResultFrame(frame: Buffer, payloadLength: number): boolean {
  return frame.length >= 15 && (frame[14] === 1 || payloadLength === 4);
}

function parseStorage(value: unknown): HomeBasePpcsState["storage"] {
  const parsed = typeof value === "string" ? parseJsonText(value) : value;
  const body = isRecord(parsed) ? parsed : {};
  return {
    sd: null,
    emmc: storageDevice(body.emmc_info, "disk_size", "disk_used"),
    hdd: storageDevice(
      body.hdd_info,
      "disk_size",
      "disk_used",
      "disk_size_1024",
      "video_size",
      "video_used",
    ),
  };
}

/** Decode the compact HomeBase 2 SD-card status and capacity response. */
export function parseHomeBase2StorageResponse(value: Buffer): HomeBaseStorageState | null {
  if (value.length < 12) return null;
  const result = value.readInt32LE(0);
  if (result < -1) return null;
  const totalMebibytes = value.readUInt32LE(4);
  const freeMebibytes = value.readUInt32LE(8);
  const totalBytes = totalMebibytes > 0 ? totalMebibytes * 1024 * 1024 : null;
  const freeBytes = totalBytes !== null && freeMebibytes <= totalMebibytes
    ? freeMebibytes * 1024 * 1024
    : null;
  if (
    (totalBytes !== null && !Number.isSafeInteger(totalBytes))
    || (freeBytes !== null && !Number.isSafeInteger(freeBytes))
  ) return null;
  return {
    status: STORAGE_STATUSES.get(result) ?? `unknown_${result}`,
    totalBytes,
    freeBytes,
  };
}

/** Inventory the bounded numeric fields in a HomeBase 2 SD response. */
export function homeBase2StorageDiagnostic(value: Buffer): HomeBaseStorageDiagnostic | null {
  if (value.length < 12) return null;
  return {
    present: true,
    numericFields: [
      `result:${value.readInt32LE(0)}`,
      `total_mebibytes:${value.readUInt32LE(4)}`,
      `free_mebibytes:${value.readUInt32LE(8)}`,
    ],
    booleanFields: [],
    textFieldLengths: [],
    structuredFields: [],
  };
}

/** Return whether HomeBase 2 firmware uses the payload-free SD query. */
export function usesModernHomeBase2StorageRequest(firmware: string | null | undefined): boolean {
  if (!firmware) return false;
  const parts = firmware.match(/\d+/g)?.slice(0, 4).map(Number) ?? [];
  const minimum = [3, 2, 7, 6];
  if (parts.length < minimum.length) return false;
  for (let index = 0; index < minimum.length; index++) {
    const difference = parts[index]! - minimum[index]!;
    if (difference !== 0) return difference > 0;
  }
  return true;
}

/** Build the firmware-specific payload for the read-only HomeBase 2 SD query. */
export function buildHomeBase2StorageRequestPayload(
  firmware: string | null | undefined,
  accountId: string,
  key: Buffer,
): Buffer {
  if (usesModernHomeBase2StorageRequest(firmware)) return voidPayload(STATION_CHANNEL);
  if (!accountId) throw new Error("HomeBase 2 storage query requires account identity");
  if (key.length !== 16) throw new Error("HomeBase 2 storage query requires a 16-byte command key");
  return twoIntegerPayload(0, 0, STATION_CHANNEL, key, accountId);
}

function storageDiagnostic(value: unknown): HomeBaseStorageDiagnostic {
  const parsed = typeof value === "string" ? parseJsonText(value) : value;
  const body = isRecord(parsed) ? parsed : {};
  if (!isRecord(body.hdd_info)) {
    return {
      present: false,
      numericFields: [],
      booleanFields: [],
      textFieldLengths: [],
      structuredFields: [],
    };
  }
  const numericFields: string[] = [];
  const booleanFields: string[] = [];
  const textFieldLengths: string[] = [];
  const structuredFields: string[] = [];
  for (const [rawKey, fieldValue] of Object.entries(body.hdd_info).sort(([left], [right]) => left.localeCompare(right))) {
    const key = diagnosticKey(rawKey);
    if (typeof fieldValue === "number" && Number.isFinite(fieldValue)) {
      numericFields.push(`${key}:${sensitiveDiagnosticKey(rawKey) ? "redacted" : fieldValue}`);
    } else if (typeof fieldValue === "boolean") {
      booleanFields.push(`${key}:${fieldValue}`);
    } else if (typeof fieldValue === "string") {
      textFieldLengths.push(`${key}:${Buffer.byteLength(fieldValue, "utf8")}`);
    } else {
      structuredFields.push(`${key}:${fieldValue === null ? "null" : Array.isArray(fieldValue) ? "array" : typeof fieldValue}`);
    }
  }
  return {
    present: true,
    numericFields: numericFields.slice(0, 50),
    booleanFields: booleanFields.slice(0, 50),
    textFieldLengths: textFieldLengths.slice(0, 50),
    structuredFields: structuredFields.slice(0, 50),
  };
}

function diagnosticKey(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64) || "unknown";
}

function sensitiveDiagnosticKey(value: string): boolean {
  return /(?:account|credential|email|password|serial|signature|token|user)/i.test(value);
}

function storageDevice(
  value: unknown,
  totalKey: string,
  usedKey: string,
  usableSizeKey?: string,
  freePartitionSizeKey?: string,
  freePartitionUsedKey?: string,
): HomeBaseStorageState | null {
  if (!isRecord(value)) return null;
  const totalMebibytes = nonNegativeInteger(value[totalKey]);
  const usedMebibytes = nonNegativeInteger(value[usedKey]);
  if (totalMebibytes === null || totalMebibytes === 0) return null;
  const usableSize = usableSizeKey ? nonNegativeInteger(value[usableSizeKey]) : null;
  const freePartitionSize = freePartitionSizeKey ? nonNegativeInteger(value[freePartitionSizeKey]) : null;
  const freePartitionUsed = freePartitionUsedKey ? nonNegativeInteger(value[freePartitionUsedKey]) : null;
  const hasUsableSize = usableSize !== null && usableSize > 0;

  // HomeBase 3 reports reserved system partitions inside its usable capacity.
  // Eufy free space is the unused video partition, not total minus disk_used.
  const totalBytes = hasUsableSize
    ? Math.round(usableSize * 1_000_000_000 / 1024)
    : totalMebibytes * 1024 * 1024;
  const usedBytes = usedMebibytes === null
    ? null
    : hasUsableSize
      ? usedMebibytes * 1_000_000
      : usedMebibytes * 1024 * 1024;
  const partitionFreeBytes = hasUsableSize && freePartitionSize !== null && freePartitionUsed !== null
    ? Math.round(Math.max(0, freePartitionSize - freePartitionUsed) * 1_000_000_000 / 1024)
    : null;
  if (
    !Number.isSafeInteger(totalBytes)
    || (usedBytes !== null && !Number.isSafeInteger(usedBytes))
    || (partitionFreeBytes !== null && !Number.isSafeInteger(partitionFreeBytes))
  ) return null;
  const workStatus = safeInteger(value.work_status);
  return {
    status: workStatus === null ? "reported" : STORAGE_STATUSES.get(workStatus) ?? `unknown_${workStatus}`,
    totalBytes,
    freeBytes: partitionFreeBytes ?? (usedBytes === null ? null : Math.max(0, totalBytes - usedBytes)),
  };
}

function intPayload(value: number, channel: number, key: Buffer, suffix = ""): Buffer {
  const integer = Buffer.alloc(4);
  integer.writeUInt32LE(value, 0);
  const suffixBytes = suffix ? fixedString(suffix) : Buffer.alloc(0);
  return encryptedPayload(Buffer.concat([integer, suffixBytes]), channel, key);
}

function twoIntegerPayload(
  value: number,
  valueSub: number,
  channel: number,
  key: Buffer,
  suffix: string,
): Buffer {
  const integers = Buffer.alloc(8);
  integers.writeUInt32LE(value, 0);
  integers.writeUInt32LE(valueSub, 4);
  return encryptedPayload(Buffer.concat([integers, fixedString(suffix)]), channel, key);
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
