/**
 * Owns the persistent Android FCM/MCS connection used by the gateway.
 * (mtalk.google.com:5228), logs in with the check-in androidId/securityToken,
 * heartbeats, and decodes DataMessageStanza pushes into eufy PushEvents.
 *
 * Implements Google's FCM/MCS push protocol; live-verified against real account pushes.
 * Adapted from mega-yfue/eufy-sdk (Apache-2.0), with gateway-specific logging
 * and module boundaries. Raw push data is emitted to the caller and never logged.
 */
import { EventEmitter } from "node:events";
import tls from "node:tls";
import { mcsRoot } from "./proto.js";
import { MessageTag } from "./message-tags.js";
import { McsParser } from "./parser.js";
import type {
  EufyPushMessage,
  FcmCredentials,
  McsMessage,
  PushEvent,
  PushPayload,
  RawPushMessage,
  ThumbnailCandidate,
} from "./types.js";
import { createLogger } from "../../logging.js";

const logger = createLogger("android-push");

const HOST = "mtalk.google.com";
const PORT = 5228;
const MCS_VERSION = 41;
const HEARTBEAT_MS = 5 * 60 * 1000;

function readNullTerminated(buf: Buffer): string {
  const i = buf.indexOf(0);
  return buf.toString("utf8", 0, i === -1 ? buf.length : i);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Describe one MCS data delivery without exposing its identifiers or payload. */
export function mcsDeliveryLogSummary(object: unknown, duplicate: boolean): string {
  const record = typeof object === "object" && object !== null ? object as Record<string, unknown> : {};
  const appData = Array.isArray(record.appData) ? record.appData.slice(0, 100) : [];
  const keys = new Set(appData.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const key = (entry as Record<string, unknown>).key;
    return typeof key === "string" ? [key] : [];
  }));
  return [
    `persistent_id_present=${typeof record.persistentId === "string"}`,
    `duplicate=${duplicate}`,
    `app_data_entries=${appData.length}`,
    `payload_entry=${keys.has("payload")}`,
    `device_entry=${keys.has("device_sn")}`,
    `station_entry=${keys.has("station_sn")}`,
    `event_entry=${keys.has("a") || keys.has("event_type")}`,
    `category_present=${typeof record.category === "string"}`,
  ].join(" ");
}

/** Decode bounded Firebase app-data fields while retaining the complete Eufy envelope. */
export function decodeMcsAppData(object: unknown): EufyPushMessage {
  const record = typeof object === "object" && object !== null ? object as Record<string, unknown> : {};
  const data: Record<string, unknown> = {};
  const appData = Array.isArray(record.appData) ? record.appData.slice(0, 100) : [];
  for (const entry of appData) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.key !== "string" || item.key.length > 128 || typeof item.value !== "string") continue;
    if (item.key === "payload") {
      if (item.value.length > 90_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.value)) continue;
      const json = readNullTerminated(Buffer.from(item.value, "base64"));
      if (Buffer.byteLength(json, "utf8") > 65_536) continue;
      try {
        data.payload = JSON.parse(json);
      } catch {
        data.payload = json;
      }
    } else if (item.value.length <= 2_048) {
      data[item.key] = item.value;
    }
  }
  return data as EufyPushMessage;
}

/**
 * Normalises a decoded eufy envelope without consulting device semantics; semantic event names remain unset.
 * @internal
 */
export function normalizePushEvent(raw: RawPushMessage): PushEvent {
  const env = raw.payload ?? {};
  let inner: unknown = env.payload ?? env;
  if (typeof inner === "string") {
    try {
      inner = JSON.parse(inner);
    } catch {
      inner = undefined;
    }
  }
  const p: PushPayload = typeof inner === "object" && inner ? (inner as PushPayload) : {};
  const eventType = (p.event_type ?? p.a) as number | undefined;
  const url = nonemptyString(p.pic_url) ? p.pic_url : nonemptyString(p.thumbnail) ? p.thumbnail : undefined;
  let thumbnailCandidate: ThumbnailCandidate | undefined;
  if (url) {
    const deviceClaims = [p.device_sn, env.device_sn].filter(nonemptyString);
    const deviceSn = deviceClaims[0];
    const stationClaims = [p.station_sn, env.station_sn, p.s].filter(nonemptyString);
    const stationSn = stationClaims[0];
    thumbnailCandidate = {
      url,
      attribution:
        deviceSn && deviceClaims.every((claim) => claim === deviceSn)
          ? { kind: "device", deviceSn }
          : deviceClaims.length === 0 && stationSn
            ? {
                kind: "station",
                ...(stationClaims.every((claim) => claim === stationSn) ? { stationSn } : {}),
              }
            : { kind: "ambiguous" },
    };
  }
  const event: PushEvent = { payload: p, raw };
  const deviceSn = (p.device_sn ?? env.device_sn ?? p.s) as string | undefined;
  const stationSn = (p.station_sn ?? env.station_sn) as string | undefined;
  const thumbnailUrl = (p.pic_url ?? p.thumbnail) as string | undefined;
  const cipher = (p.cipher ?? p.k) as number | undefined;
  if (deviceSn !== undefined) event.deviceSn = deviceSn;
  if (stationSn !== undefined) event.stationSn = stationSn;
  if (eventType !== undefined) event.eventType = eventType;
  if (thumbnailUrl !== undefined) event.thumbnailUrl = thumbnailUrl;
  if (thumbnailCandidate !== undefined) event.thumbnailCandidate = thumbnailCandidate;
  if (cipher !== undefined) event.cipher = cipher;
  return event;
}

/**
 * Maintains one authenticated MCS socket for a registered Android identity.
 *
 * MegaPushReceiver owns this client and closes it on shutdown. This class owns
 * TLS reconnect, login, heartbeat, stanza decoding, and in-memory delivered
 * IDs; the caller persists the IDs and decides how camera events are routed.
 */
export class PushClient extends EventEmitter {
  /** Consecutive MCS login rejections tolerated (self-healing propagation) before surfacing an error. */
  private static readonly MAX_LOGIN_FAILURES = 3;
  private socket: tls.TLSSocket | undefined;
  private readonly parser = new McsParser();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private currentDelay = 0;
  private persistentIds: string[] = [];
  private loggedIn = false;
  private closing = false;
  /** Consecutive MCS login rejections — transient ones self-heal via reconnect (see {@link onMessage}). */
  private loginFailures = 0;

  constructor(
    private readonly creds: FcmCredentials,
  ) {
    super();
    this.parser.on("message", (m: McsMessage) => this.onMessage(m));
  }

  /** Persistent ids already seen (set this from storage to avoid re-delivery). */
  setPersistentIds(ids: string[]): void {
    this.persistentIds = ids;
  }
  getPersistentIds(): string[] {
    return this.persistentIds;
  }

  /**
   * Open the MCS connection and log in.
   *
   * `servername` is passed explicitly: Node sends SNI only when told to, never deriving it from `host`,
   * and this endpoint answers a connection without SNI with a self-signed certificate naming
   * `invalid2.invalid` — which now fails the handshake rather than being accepted. Verification matters
   * because the login request carries the account's `securityToken`, and an unverified peer could both
   * read it and inject forged pushes into the event path.
   */
  connect(): void {
    this.closing = false;
    this.parser.reset();
    this.loggedIn = false;
    const socket = tls.connect(PORT, HOST, { servername: HOST });
    this.socket = socket;
    socket.setKeepAlive(true);
    socket.on("secureConnect", () => {
      logger.info("mcs_tls_connected", "Android push TLS connection established");
      socket.write(this.buildLoginRequest());
    });
    socket.on("data", (d: Buffer) => {
      try {
        this.parser.handleData(d);
      } catch {
        this.emit("error", new Error("Android MCS frame could not be decoded"));
        socket.destroy();
      }
    });
    socket.on("close", () => this.onClose());
    socket.on("error", (e) => this.emit("error", e));
  }

  private buildLoginRequest(): Buffer {
    const LoginRequest = mcsRoot().lookupType("mcs_proto.LoginRequest");
    const hexAndroidId = BigInt(this.creds.androidId).toString(16);
    const obj = {
      adaptiveHeartbeat: false,
      authService: 2,
      authToken: this.creds.securityToken,
      id: "chrome-63.0.3234.0",
      domain: "mcs.android.com",
      deviceId: `android-${hexAndroidId}`,
      networkType: 1,
      resource: this.creds.androidId,
      user: this.creds.androidId,
      useRmq2: true,
      setting: [{ name: "new_vc", value: "1" }],
      clientEvent: [],
      receivedPersistentId: this.persistentIds,
    };
    const buf = LoginRequest.encodeDelimited(obj).finish();
    return Buffer.concat([Buffer.from([MCS_VERSION, MessageTag.LoginRequest]), buf]);
  }

  private buildHeartbeatPing(): Buffer {
    const Ping = mcsRoot().lookupType("mcs_proto.HeartbeatPing");
    const buf = Ping.encodeDelimited({}).finish();
    return Buffer.concat([Buffer.from([MessageTag.HeartbeatPing]), buf]);
  }

  private buildHeartbeatAck(lastStreamId?: number): Buffer {
    const Ack = mcsRoot().lookupType("mcs_proto.HeartbeatAck");
    const obj = lastStreamId ? { lastStreamIdReceived: lastStreamId } : {};
    const buf = Ack.encodeDelimited(obj).finish();
    return Buffer.concat([Buffer.from([MessageTag.HeartbeatAck]), buf]);
  }

  private onMessage(m: McsMessage): void {
    switch (m.tag) {
      case MessageTag.LoginResponse:
        if (m.object?.error) {
          this.onLoginError(m.object.error);
        } else {
          this.loggedIn = true;
          this.currentDelay = 0;
          this.loginFailures = 0;
          this.startHeartbeat();
          logger.info("mcs_connected", "Android push MCS login acknowledged");
          this.emit("connect");
        }
        break;
      case MessageTag.DataMessageStanza:
        this.handleDataMessage(m.object);
        break;
      case MessageTag.HeartbeatPing:
        if (this.socket) this.socket.write(this.buildHeartbeatAck(m.object?.lastStreamIdReceived));
        break;
      case MessageTag.HeartbeatAck:
        break;
      case MessageTag.Close:
        logger.info("mcs_server_close", "Android push MCS server closed the connection");
        this.socket?.destroy();
        break;
    }
  }

  /**
   * Handle an MCS `LoginResponse` carrying an error. Google occasionally rejects the FIRST login right
   * after check-in (`wrong_secret`) while the freshly-registered androidId/securityToken propagates —
   * it succeeds on the very next attempt. So a login rejection is treated as **transient**: log it and
   * close the socket to let the existing backoff reconnect retry with the same creds, rather than
   * surfacing a self-healing blip as a host-facing `error`. Only once it persists past
   * {@link MAX_LOGIN_FAILURES} consecutive attempts (creds genuinely stale) is it emitted as `error`.
   */
  private onLoginError(_error: unknown): void {
    this.loginFailures++;
    const msg = "MCS login rejected";
    if (this.loginFailures >= PushClient.MAX_LOGIN_FAILURES) {
      this.emit("error", new Error(`${msg} (after ${this.loginFailures} attempts)`));
    } else {
      logger.warn("mcs_login_retry", `Android push MCS login rejected; retrying attempt ${this.loginFailures}`);
    }
    this.socket?.destroy(); // → onClose → scheduleReconnect
  }

  private handleDataMessage(object: any): void {
    const duplicate = typeof object?.persistentId === "string" && this.persistentIds.includes(object.persistentId);
    logger.info("mcs_delivery_received", mcsDeliveryLogSummary(object, duplicate));
    if (typeof object?.persistentId === "string") {
      if (duplicate) return;
      this.persistentIds = [...this.persistentIds.slice(-99), object.persistentId];
    }
    const data = decodeMcsAppData(object);
    const raw: RawPushMessage = {
      id: object?.id,
      from: object?.from,
      to: object?.to,
      category: object?.category,
      persistentId: object?.persistentId,
      ttl: object?.ttl,
      sent: object?.sent,
      payload: data,
    };
    this.emit("message", raw);
    const event = normalizePushEvent(raw);
    if (event) this.emit("push", event);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket && this.loggedIn) this.socket.write(this.buildHeartbeatPing());
    }, HEARTBEAT_MS);
  }
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private onClose(): void {
    this.stopHeartbeat();
    this.loggedIn = false;
    this.emit("disconnect");
    if (!this.closing) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = this.currentDelay === 0 ? 5000 : this.currentDelay;
    if (this.currentDelay < 60000) this.currentDelay += 10000;
    else if (this.currentDelay < 600000) this.currentDelay += 60000;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.closing) this.connect();
    }, delay);
  }

  close(): void {
    this.closing = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.destroy();
    this.socket = undefined;
  }
}
