/**
 * Owns Firebase delivery and Eufy notification normalization.
 *
 * The Android FCM transport supplies delivery; this module registers the token
 * through Mega, persists the Android identity, unwraps nested JSON used by several
 * camera generations, and emits a whitelisted `MegaPushEvent`. The provider
 * decides whether an event is motion/person and whether its picture URL is
 * downloaded. Raw payloads never cross the provider boundary or enter
 * diagnostics because they can contain tokens, URLs, and account metadata.
 * Deliveries that cannot be normalized produce only a payload-free receipt log.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { EventReceiverState } from "../domain/types.js";
import { createLogger } from "../logging.js";
import { FcmRegistrar } from "./android-push/fcm.js";
import { PushClient } from "./android-push/push-client.js";
import type { FcmCredentials, RawPushMessage } from "./android-push/types.js";
import type { MegaClient, PushActivationResult } from "./client.js";

const logger = createLogger("push");

/** Clock tolerance for a notification created at the current startup boundary. */
const STARTUP_DELIVERY_TOLERANCE_MILLISECONDS = 5_000;

/** Reject transport clocks far enough ahead that freshness cannot be trusted. */
const MAXIMUM_DELIVERY_FUTURE_SKEW_MILLISECONDS = 60_000;

/** AI meanings that structured push evidence can establish without notification text. */
export type MegaPushDetectionEvidence = "person" | "vehicle" | "pet" | "dog" | "crying" | "sound";

/** Final cloud-registration state for one connected Firebase receiver. */
export type PushRegistrationStatus = "ready" | "activation-unconfirmed";

const RETRY_DELAYS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;

function registrationFailureDiagnostic(error: unknown): {
  reason: "transport" | "http" | "response" | "timeout" | "unknown";
  httpStatus?: number;
  responseCode?: number;
  responseClass?: "empty" | "empty_or_truncated" | "json_without_numeric_code" | "non_json" | "unavailable";
} {
  if (!(error instanceof Error)) return { reason: "unknown" };
  if (error.name === "TimeoutError") return { reason: "timeout" };
  if (error.message === "Mega request failed (transport)") return { reason: "transport" };
  const http = /^Mega request failed \(HTTP (\d{3})(?: code (-?\d{1,9})| response (empty|empty_or_truncated|json_without_numeric_code|non_json|unavailable))?\)$/.exec(error.message);
  if (http) {
    return {
      reason: "http",
      httpStatus: Number(http[1]),
      ...(http[2] === undefined ? {} : { responseCode: Number(http[2]) }),
      ...(http[3] === undefined ? {} : { responseClass: http[3] as "empty" | "empty_or_truncated" | "json_without_numeric_code" | "non_json" | "unavailable" }),
    };
  }
  if (/^Mega response validation failed \([A-Z_]+\)$/.test(error.message)) return { reason: "response" };
  return { reason: "unknown" };
}

/** Normalized subset of an Android FCM/Eufy notification used by the provider. */
export interface MegaPushEvent {
  readonly cameraSerial: string;
  readonly stationSerial: string;
  readonly cameraName: string | null;
  readonly eventType: number | null;
  readonly messageType: number | null;
  readonly notificationStyle: number | null;
  readonly personName: string | null;
  readonly detectionEvidence: readonly MegaPushDetectionEvidence[];
  readonly content: string | null;
  readonly pictureUrl: string | null;
  readonly filePath: string | null;
  readonly fetchId: number | null;
  readonly senseId: string | null;
  readonly guardMode: number | null;
  readonly effectiveMode: number | null;

  /** Source field for the effective mode, retained without its private value for safe diagnostics. */
  readonly effectiveModeField: "station_current_mode" | "current_mode" | "mode" | null;

  /** Paired native station fields, interpreted only after exact NVR inventory binding. */
  readonly nvrModeChange?: { readonly configured: number; readonly effective: number; readonly previous: number } | null;

  /** MCS-owned send time, never read from the untrusted application payload. */
  readonly transportSentAtMilliseconds?: number | null;
  readonly alarmType: number | null;
  readonly sensorOpen: boolean | null;
  readonly eventId: string | null;
}

interface StoredPushState {
  readonly version: 2;
  readonly credentials?: FcmCredentials;
  persistentIds: string[];
}

/**
 * Maintains Android FCM delivery for one Mega account and emits normalized events.
 *
 * EufyProvider owns this receiver from start through close. Its transport owns
 * reconnect and in-memory IDs while this module persists the private Android
 * identity and delivered IDs. Camera policy remains with EufyProvider and
 * GatewayState; raw notification fields never reach those neighbours.
 * Registration failures retain the transport and use a finite retry budget.
 * An established transport reconnect repeats token registration before the
 * receiver becomes ready again because Eufy can discard the prior binding.
 * Closing or restarting retires all owned waits before transport shutdown.
 */
export class MegaPushReceiver {
  #receiver: PushClient | null = null;
  #registered = false;
  #reregisterAfterReconnect = false;
  #connected = false;
  #connectRequested = false;
  #disconnected = false;
  #state: StoredPushState = { version: 2, persistentIds: [] };
  #saveQueue: Promise<void> = Promise.resolve();
  #lifetime: AbortController | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  #failed = false;
  #loaded = false;
  #credentialRequest: Promise<FcmCredentials> | null = null;
  #startedAtMilliseconds = 0;

  /**
   * Create a receiver using the account client and private state directory.
   *
   * @param createReceiver Supplies a fresh transport for each start, owned and closed by this receiver.
   * @param now Supplies the local clock used only to reject queued startup deliveries.
   */
  constructor(
    private readonly client: MegaClient,
    private readonly path: string,
    private readonly onEvent: (event: MegaPushEvent) => void,
    private readonly onReceiverState: (state: EventReceiverState) => void = () => undefined,
    private readonly onDelivery: (outcome: "parsed" | "empty" | "unparsed") => void = () => undefined,
    private readonly createReceiver: (credentials: FcmCredentials) => PushClient = (credentials) => new PushClient(credentials),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Start delivery without rejecting for initialization, login or activation failure.
   * Resolves after the initial attempt settles or is retired. Later attempts are
   * owned internally and never replace an established Firebase identity.
   */
  async start(): Promise<void> {
    this.#retire();
    const lifetime = new AbortController();
    this.#lifetime = lifetime;
    this.#attempt = 0;
    this.#failed = false;
    this.#loaded = false;
    this.#credentialRequest = null;
    this.#registered = false;
    this.#reregisterAfterReconnect = false;
    this.#connected = false;
    this.#connectRequested = false;
    this.#disconnected = false;
    this.#startedAtMilliseconds = this.now();
    this.#publish("starting");
    await this.#runAttempt(lifetime, true).catch(() => undefined);
  }

  async #runAttempt(lifetime: AbortController, initial: boolean): Promise<void> {
    let stage: "initialization" | "login" | "registration" | "activation" = "initialization";
    let activationCode: number | undefined;
    let counted = false;
    try {
      if (!this.#active(lifetime)) return;
      if (!this.#loaded) {
        const state = await abortable(loadState(this.path), lifetime.signal);
        if (!this.#active(lifetime)) return;
        this.#state = { ...state, ...(this.#state.credentials ? { credentials: this.#state.credentials } : {}) };
        this.#loaded = true;
      }
      if (!this.#state.credentials) {
        const request = this.#credentialRequest ??= new FcmRegistrar().register();
        try {
          const credentials = await abortable(request, lifetime.signal);
          if (!this.#active(lifetime)) return;
          this.#state = { ...this.#state, credentials };
          this.#persistState();
        } finally {
          if (this.#active(lifetime)) this.#credentialRequest = null;
        }
      }
      if (!this.#active(lifetime)) return;
      const credentials = this.#state.credentials!;
      if (!this.#receiver) this.#attachReceiver(this.createReceiver(credentials), lifetime);
      const receiver = this.#receiver!;
      stage = "login";
      if (!this.#connected) {
        if (initial) {
          this.#attempt += 1;
          counted = true;
        }
        const connect = !this.#connectRequested;
        await waitForReceiverReady(receiver, lifetime.signal, initial || connect ? 20_000 : null,
          connect ? () => { receiver.connect(); this.#connectRequested = true; } : false);
      }
      if (!this.#active(lifetime)) return;
      if (!counted) {
        this.#attempt += 1;
        counted = true;
      }
      stage = "registration";
      const result = await abortable(this.client.registerPushToken(credentials.fcmToken), lifetime.signal);
      if (!this.#active(lifetime)) return;
      if (result?.activated !== true) {
        stage = result?.failedSecurityStage ?? "activation";
        const code = result?.code;
        if (typeof code === "number" && Number.isSafeInteger(code) && Math.abs(code) <= 999999999) activationCode = code;
        if (result?.megaRegistrationRestored === true) {
          this.#failed = true;
          if (!this.#disconnected) this.#publish("degraded");
          try { logger.warn("push_registration_degraded", [
            "Security push activation unavailable. Mega registration restored.", `stage=${stage}`,
            ...(activationCode !== undefined ? [`code=${activationCode}`] : []),
            `attempt=${this.#attempt}`, `max_retries=${RETRY_DELAYS.length}`, "restoration=mega", "retry=false",
          ].join(" ")); } catch {}
          return;
        }
        throw new Error("Push activation unavailable");
      }
      this.#registered = true;
      if (this.#connected) this.#publish("connected");
      try { logger.info("push_token_registered", "Mega and Security accepted push registration and activation"); } catch {}
      try { logger.info("push_receiver_ready", "Android FCM receiver and Eufy notification registration are ready"); } catch {}
    } catch (error) {
      if (!this.#active(lifetime)) return;
      if (!counted) this.#attempt += 1;
      this.#failed = true;
      const delay = RETRY_DELAYS[this.#attempt - 1];
      if (delay !== undefined) {
        this.#retryTimer = setTimeout(() => {
          this.#retryTimer = null;
          if (this.#active(lifetime)) void this.#runAttempt(lifetime, false).catch(() => undefined);
        }, delay);
        this.#retryTimer.unref?.();
      }
      if (!this.#disconnected) this.#publish("degraded");
      const match = error instanceof Error
        ? /^(Mega push registration|Security push registration) failed \((-?\d{1,9})\)$/.exec(error.message)
        : null;
      const code = stage === "activation" ? activationCode : match ? Number(match[2]) : undefined;
      const diagnostic = stage === "registration" && code === undefined
        ? registrationFailureDiagnostic(error)
        : undefined;
      try { logger.warn("push_registration_degraded", [
        "Push registration unavailable.", `stage=${stage}`,
        ...(code !== undefined ? [`code=${code}`] : []),
        ...(diagnostic === undefined ? [] : [`reason=${diagnostic.reason}`]),
        ...(diagnostic?.httpStatus === undefined ? [] : [`http_status=${diagnostic.httpStatus}`]),
        ...(diagnostic?.responseCode === undefined ? [] : [`response_code=${diagnostic.responseCode}`]),
        ...(diagnostic?.responseClass === undefined ? [] : [`response_class=${diagnostic.responseClass}`]),
        `attempt=${this.#attempt}`, `max_retries=${RETRY_DELAYS.length}`,
        delay === undefined ? "exhausted=true" : `next_retry_seconds=${delay / 1_000}`,
      ].join(" ")); } catch {}
    }
  }

  #attachReceiver(receiver: PushClient, lifetime: AbortController): void {
    receiver.setPersistentIds([...this.#state.persistentIds]);
    this.#receiver = receiver;
    receiver.on("connect", () => {
      if (!this.#active(lifetime) || this.#receiver !== receiver) return;
      this.#connected = true;
      this.#disconnected = false;
      if (this.#reregisterAfterReconnect) {
        this.#reregisterAfterReconnect = false;
        this.#attempt = 0;
        this.#failed = false;
        void this.#runAttempt(lifetime, false).catch(() => undefined);
      } else if (this.#registered) this.#publish("connected");
      else if (this.#failed) this.#publish("degraded");
      logger.info("push_receiver_connected", "Android FCM receiver login acknowledged");
    });
    receiver.on("disconnect", () => {
      if (!this.#active(lifetime) || this.#receiver !== receiver) return;
      this.#reregisterAfterReconnect ||= this.#registered;
      this.#registered = false;
      this.#connected = false;
      this.#disconnected = true;
      this.#publish("disconnected");
      logger.warn("push_socket_disconnected", "Android FCM receiver disconnected; transport will retry");
    });
    receiver.on("error", () => {
      if (this.#active(lifetime) && this.#receiver === receiver) logger.warn("push_socket_unavailable", "Android FCM receiver reported a transport error");
    });
    receiver.on("message", (message: RawPushMessage) => {
      if (!this.#active(lifetime) || this.#receiver !== receiver) return;
      const newPersistentId = Boolean(message.persistentId && !this.#state.persistentIds.includes(message.persistentId));
      this.#recordPersistentId(message.persistentId);
      const event = parsePushEvent(message.payload);
      const outcome = event
        ? "parsed"
        : !isRecord(message.payload) || Object.keys(message.payload).length === 0 ? "empty" : "unparsed";
      const suppressStartupReplay = event !== null && !this.#registered
        && !isFreshStartupDelivery(message.sent, this.#startedAtMilliseconds, this.now());
      this.onDelivery(outcome);
      logger.info("push_received", `persistent_id_present=${Boolean(message.persistentId)} new_id=${newPersistentId} payload_record=${isRecord(message.payload)} parsed=${event !== null} startup_replay_suppressed=${suppressStartupReplay}`);
      if (event && !suppressStartupReplay) this.onEvent({ ...event, transportSentAtMilliseconds: mcsTimestampMilliseconds(message.sent) });
      else if (suppressStartupReplay) logger.info("push_startup_replay_suppressed", "Queued Android notification was acknowledged without publishing a device event");
      else if (!isRecord(message.payload) || Object.keys(message.payload).length === 0) logger.info("push_empty", "Android FCM notification had no Eufy data fields");
      else logger.info("push_unparsed", `Android FCM notification lacked a usable Eufy device identity: ${safeUnparsedShape(message.payload)}`);
    });
  }

  /** Retire owned waits synchronously, then flush pending private identity state. */
  async close(): Promise<void> {
    this.#retire();
    this.#publish("stopped");
    await this.#saveQueue;
  }

  #active(lifetime: AbortController): boolean {
    return this.#lifetime === lifetime && !lifetime.signal.aborted;
  }

  /** Reporting must not interrupt registration, retries or shutdown. */
  #publish(state: EventReceiverState): void {
    try { this.onReceiverState(state); } catch {}
  }

  #retire(): void {
    this.#lifetime?.abort();
    this.#lifetime = null;
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    const receiver = this.#receiver;
    this.#receiver = null;
    this.#registered = false;
    this.#reregisterAfterReconnect = false;
    this.#connected = false;
    try { receiver?.close(); } catch {}
  }

  #persistState(): void {
    this.#saveQueue = this.#saveQueue.then(() => saveState(this.path, this.#state)).catch(() => {
      try { logger.warn("push_state_unavailable", "Private Firebase receiver state could not be saved"); } catch {}
    });
  }

  #recordPersistentId(persistentId: string | undefined): void {
    if (!persistentId || this.#state.persistentIds.includes(persistentId)) return;
    this.#state.persistentIds = [...this.#state.persistentIds.slice(-99), persistentId];
    this.#persistState();
  }
}

/**
 * Decide whether an MCS delivery can be attributed to the current startup.
 *
 * Protobuf.js represents int64 fields as number, bigint, decimal string or a
 * Long-like low/high pair depending on its runtime. Only safe positive epoch
 * milliseconds are accepted, and the transport value is never logged.
 */
export function isFreshStartupDelivery(value: unknown, startedAtMilliseconds: number, nowMilliseconds: number): boolean {
  const sent = mcsTimestampMilliseconds(value);
  if (sent === null || !Number.isSafeInteger(startedAtMilliseconds) || !Number.isSafeInteger(nowMilliseconds)) return false;
  if (sent < Date.UTC(2000, 0, 1) || sent > nowMilliseconds + MAXIMUM_DELIVERY_FUTURE_SKEW_MILLISECONDS) return false;
  return sent >= startedAtMilliseconds - STARTUP_DELIVERY_TOLERANCE_MILLISECONDS;
}

/** Convert supported protobuf int64 representations without rounding private wire data. */
function mcsTimestampMilliseconds(value: unknown): number | null {
  let parsed: bigint;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return null;
    return value;
  } else if (typeof value === "string" && /^\d{10,16}$/.test(value)) parsed = BigInt(value);
  else if (isRecord(value) && Number.isInteger(value.low) && Number.isInteger(value.high)
    && (value.high as number) >= 0 && (value.high as number) <= 0x7fffffff) {
    parsed = (BigInt(value.high as number) << 32n) | BigInt((value.low as number) >>> 0);
  } else return null;
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
}

/** Minimal receiver lifecycle used to order Firebase login before cloud activation. */
export interface PushReceiverTransport {
  once(event: "connect", listener: () => void): this;
  off(event: "connect", listener: () => void): this;
  connect(): void;
  close(): void;
}

/**
 * Connect Firebase before registering and checking its token with Eufy.
 *
 * Eufy's activation check can reject a freshly issued token until the Android
 * receiver has completed its MCS login. A non-ready return leaves transport ownership with the caller. A registration failure closes the
 * receiver so callers never expose a half-ready notification connection.
 * Cancellation closes the transport and retires login and registration waits.
 * Late registration results remain handled after cancellation.
 */
export async function connectAndRegisterPush(
  receiver: PushReceiverTransport,
  register: () => Promise<PushActivationResult>,
  signal?: AbortSignal,
): Promise<PushRegistrationStatus> {
  try {
    await waitForReceiverReady(receiver, signal, 20_000, true);
    const result = await abortable(Promise.resolve().then(register), signal);
    return result?.activated === true ? "ready" : "activation-unconfirmed";
  } catch (error) {
    receiver.close();
    throw error;
  }
}

/** Await login without letting a retired receiver retain listeners or timers. */
function waitForReceiverReady(
  receiver: PushReceiverTransport,
  signal: AbortSignal | undefined,
  timeoutMilliseconds: number | null,
  connect: boolean | (() => void),
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      receiver.off("connect", onConnect);
      signal?.removeEventListener("abort", onAbort);
    };
    const onConnect = (): void => {
      cleanup();
      resolve();
    };
    const onAbort = (): void => { cleanup(); reject(signal?.reason); };
    if (signal?.aborted) { reject(signal.reason); return; }
    if (timeoutMilliseconds !== null) timer = setTimeout(() => {
      cleanup();
      reject(new Error("Android FCM receiver login timed out"));
    }, timeoutMilliseconds);
    receiver.once("connect", onConnect);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (connect) {
      try { if (typeof connect === "function") connect(); else receiver.connect(); }
      catch (error) { cleanup(); reject(error); }
    }
  });
}

/** Settle retired waits promptly while still handling the underlying late result. */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal?.removeEventListener("abort", onAbort));
    if (signal?.aborted) onAbort();
  });
}

/**
 * Normalize notification detail from the deepest payload and identity from its enclosing levels.
 *
 * Malformed, cyclic, or more than sixteen nested payloads are rejected rather
 * than attributing an outer event to an unrelated device. Only the normalized
 * allow-listed fields cross into provider logic.
 */
export function parsePushEvent(data: unknown): MegaPushEvent | null {
  if (!isRecord(data)) return null;
  const levels = pushPayloadLevels(data);
  if (!levels) return null;
  const payload = levels[levels.length - 1]!;
  const deepestFirst = [...levels].reverse();
  const field = (key: string): string | null => deepestFirst.map((level) => text(level[key])).find((value) => value !== null) ?? null;
  const stationSerial = field("station_sn");
  const cameraSerial = field("device_sn") ?? stationSerial;
  if (!cameraSerial) return null;
  const nvrModeChange = (integer(payload.a) ?? integer(payload.event_type)) === 9
    && typeof payload.arming === "number" && Number.isSafeInteger(payload.arming)
    && typeof payload.mode === "number" && Number.isSafeInteger(payload.mode)
    && typeof payload.before_change_mode === "number" && Number.isSafeInteger(payload.before_change_mode)
    ? { configured: payload.arming, effective: payload.mode, previous: payload.before_change_mode } : null;
  return {
    cameraSerial,
    stationSerial: stationSerial ?? cameraSerial,
    cameraName: text(payload.name) ?? text(payload.device_name) ?? text(payload.n),
    eventType: integer(payload.a) ?? integer(payload.event_type),
    messageType: integer(payload.msg_type),
    notificationStyle: integer(payload.notification_style),
    personName: text(payload.f) ?? text(payload.nick_name),
    detectionEvidence: structuredDetectionEvidence(payload),
    content: field("content"),
    pictureUrl: text(payload.pic_url),
    filePath: text(payload.file_path) ?? text(payload.p),
    fetchId: integer(payload.fetch_id) ?? integer(payload.i),
    senseId: text(payload.sense_id) ?? text(payload.j),
    guardMode: integer(payload.station_guard_mode),
    effectiveMode: integer(payload.station_current_mode) ?? integer(payload.current_mode),
    effectiveModeField: integer(payload.station_current_mode) !== null
      ? "station_current_mode"
      : integer(payload.current_mode) !== null ? "current_mode" : nvrModeChange ? "mode" : null,
    nvrModeChange,
    alarmType: integer(payload.alarm_type),
    sensorOpen: sensorOpen(payload.e),
    eventId: field("unique_id"),
  };
}

/** Walk object or JSON payload envelopes with a finite depth and no repeated object identities. */
function pushPayloadLevels(data: Record<string, unknown>): Record<string, unknown>[] | null {
  const levels = [data];
  let current = data;
  while (current.payload !== undefined && current.payload !== null) {
    if (levels.length > 16) return null;
    const next = nestedRecord(current.payload);
    if (!next || levels.includes(next)) return null;
    levels.push(next);
    current = next;
  }
  return levels;
}

/**
 * Reduce structured AI results to detection kinds without retaining face
 * records, identifiers, counts, object arrays, or recognition metadata.
 *
 * Generic HomeBase security pushes can keep event type `1` even when the Eufy
 * app has a more specific classification. These optional AI fields are more
 * specific than the generic event type. Default zero values and
 * `ai_detect_type` are deliberately ignored because the latter may describe
 * enabled camera settings rather than the object detected in this event.
 */
function structuredDetectionEvidence(payload: Record<string, unknown>): MegaPushDetectionEvidence[] {
  const evidence = new Set<MegaPushDetectionEvidence>();
  const person = payload.person;
  if (positiveSignal(person)
    || positiveInteger(payload.person_count)
    || positiveInteger(payload.person_id)
    || positiveInteger(payload.face_id)
    || [payload.ai_faces, payload.face_ids, payload.familiar_faces]
      .some((value) => Array.isArray(value) && value.length > 0)) {
    evidence.add("person");
  }

  const objectNames = Array.isArray(payload.objects)
    ? payload.objects
    : isRecord(payload.objects) && Array.isArray(payload.objects.names) ? payload.objects.names : [];
  for (const value of objectNames) {
    if (typeof value !== "string") continue;
    const name = value.trim().toLowerCase();
    if (["person", "human"].includes(name)) evidence.add("person");
    else if (["vehicle", "car", "truck", "bus", "motorcycle", "bicycle"].includes(name)) evidence.add("vehicle");
    else if (name === "dog") evidence.add("dog");
    else if (["pet", "animal", "cat"].includes(name)) evidence.add("pet");
    else if (name === "crying") evidence.add("crying");
    else if (name === "sound") evidence.add("sound");
  }

  if (Array.isArray(payload.vehicle_types) && payload.vehicle_types.length > 0) evidence.add("vehicle");
  if (positiveSignal(payload.pet_type)) {
    evidence.add(typeof payload.pet_type === "string" && payload.pet_type.trim().toLowerCase() === "dog" ? "dog" : "pet");
  }
  if (positiveSignal(payload.crying)) evidence.add("crying");
  if (positiveSignal(payload.sound_detection) || positiveSignal(payload.sound_type)) evidence.add("sound");
  return [...evidence];
}

/** Return whether an optional scalar represents affirmative event evidence. */
function positiveSignal(value: unknown): boolean {
  if (value === true || (typeof value === "number" && value > 0)) return true;
  return typeof value === "string" && !/^(?:|0|false|none|null)$/i.test(value.trim());
}

/** Return whether an optional integer field carries a positive event value. */
function positiveInteger(value: unknown): boolean {
  const parsed = integer(value);
  return parsed !== null && parsed > 0;
}

function sensorOpen(value: unknown): boolean | null {
  if (value === "1" || value === 1) return true;
  if (value === "0" || value === 0) return false;
  return null;
}

/** Describe only the field layout of an unparsed Firebase data envelope. */
export function safeUnparsedShape(data: unknown): string {
  if (!isRecord(data)) return "data_record=false";
  const outer = nestedRecord(data.payload) ?? data;
  const payload = nestedRecord(outer.payload) ?? outer;
  return [
    "data_record=true",
    `outer_payload=${nestedRecord(data.payload) !== null}`,
    `inner_payload=${nestedRecord(outer.payload) !== null}`,
    `device_field=${text(data.device_sn) !== null || text(outer.device_sn) !== null || text(payload.device_sn) !== null}`,
    `station_field=${text(data.station_sn) !== null || text(outer.station_sn) !== null || text(payload.station_sn) !== null}`,
    `notification_field=${isRecord(data.notification)}`,
  ].join(" ");
}

async function loadState(path: string): Promise<StoredPushState> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value) || value.version !== 2) return { version: 2, persistentIds: [] };
    const credentials = isAndroidCredentials(value.credentials) ? value.credentials : undefined;
    return {
      version: 2,
      ...(credentials ? { credentials } : {}),
      persistentIds: Array.isArray(value.persistentIds)
        ? value.persistentIds.filter((entry): entry is string => typeof entry === "string").slice(-100)
        : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return { version: 2, persistentIds: [] };
    throw error;
  }
}

function isAndroidCredentials(value: unknown): value is FcmCredentials {
  return isRecord(value) &&
    ["fid", "androidId", "securityToken", "fcmToken"].every((key) => text(value[key]) !== null) &&
    Number.isSafeInteger(value.createdAt);
}

async function saveState(path: string, state: StoredPushState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    const encoded = value.trim();
    if (encoded.length === 0 || encoded.length > 87_384
      || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
    try {
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.length === 0 || decoded.length > 65_536
        || decoded.toString("base64") !== encoded) return null;
      const parsed: unknown = JSON.parse(decoded.toString("utf8"));
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  const result = typeof value === "string" ? value.trim() : "";
  return result.length > 0 && result.length <= 2_048 ? result : null;
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}
