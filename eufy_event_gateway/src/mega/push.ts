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

import { createLogger } from "../logging.js";
import { FcmRegistrar } from "./android-push/fcm.js";
import { PushClient } from "./android-push/push-client.js";
import type { FcmCredentials, RawPushMessage } from "./android-push/types.js";
import type { MegaClient } from "./client.js";

const logger = createLogger("push");

/** AI meanings that structured push evidence can establish without notification text. */
export type MegaPushDetectionEvidence = "person" | "vehicle" | "pet" | "dog" | "crying" | "sound";

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
 * reconnect and in-memory IDs while this boundary persists the private Android
 * identity and delivered IDs. Camera policy remains with EufyProvider and
 * GatewayState; raw notification fields never reach those neighbours.
 */
export class MegaPushReceiver {
  #receiver: PushClient | null = null;
  #state: StoredPushState = { version: 2, persistentIds: [] };
  #saveQueue: Promise<void> = Promise.resolve();

  /** Create a receiver using the account client and private state directory. */
  constructor(
    private readonly client: MegaClient,
    private readonly path: string,
    private readonly onEvent: (event: MegaPushEvent) => void,
  ) {}

  /** Register as the Eufy Android app and forward normalized notifications. */
  async start(): Promise<void> {
    this.#state = await loadState(this.path);
    if (!this.#state.credentials) {
      const credentials = await new FcmRegistrar().register();
      this.#state = { ...this.#state, credentials };
      this.#persistState();
      await this.#saveQueue;
      logger.info("push_token_ready", "Firebase issued an Eufy Android-app push token");
    }
    const credentials = this.#state.credentials;
    if (!credentials) throw new Error("Android FCM credentials were unavailable after registration");
    await this.client.registerPushToken(credentials.fcmToken);
    logger.info("push_token_registered", "Mega accepted the Eufy Android-app push token");
    const receiver = new PushClient(credentials);
    receiver.setPersistentIds([...this.#state.persistentIds]);
    this.#receiver = receiver;
    receiver.on("connect", () => logger.info("push_receiver_ready", "Android FCM receiver login acknowledged"));
    receiver.on("disconnect", () => logger.warn("push_socket_disconnected", "Android FCM receiver disconnected; transport will retry"));
    receiver.on("error", (error: Error) => logger.warn("push_socket_unavailable", `Android FCM receiver error: ${error.message}`));
    receiver.on("message", (message: RawPushMessage) => {
      const newPersistentId = Boolean(message.persistentId && !this.#state.persistentIds.includes(message.persistentId));
      this.#recordPersistentId(message.persistentId);
      const event = parsePushEvent(message.payload);
      logger.info("push_received", `persistent_id_present=${Boolean(message.persistentId)} new_id=${newPersistentId} payload_record=${isRecord(message.payload)} parsed=${event !== null}`);
      if (event) this.onEvent(event);
      else if (!isRecord(message.payload) || Object.keys(message.payload).length === 0) logger.info("push_empty", "Android FCM notification had no Eufy data fields");
      else logger.info("push_unparsed", `Android FCM notification lacked a usable Eufy device identity: ${safeUnparsedShape(message.payload)}`);
    });
    receiver.connect();
    try {
      await waitForReceiverReady(receiver);
    } catch (error) {
      receiver.close();
      this.#receiver = null;
      throw error;
    }
  }

  /** Stop the receiver and flush pending private identity state. */
  async close(): Promise<void> {
    this.#receiver?.close();
    this.#receiver = null;
    await this.#saveQueue;
  }

  #persistState(): void {
    this.#saveQueue = this.#saveQueue.then(() => saveState(this.path, this.#state)).catch(() => {
      logger.warn("push_state_unavailable", "Private Firebase receiver state could not be saved");
    });
  }

  #recordPersistentId(persistentId: string | undefined): void {
    if (!persistentId || this.#state.persistentIds.includes(persistentId)) return;
    this.#state.persistentIds = [...this.#state.persistentIds.slice(-99), persistentId];
    this.#persistState();
  }
}

function waitForReceiverReady(receiver: PushClient): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      receiver.off("connect", onConnect);
      reject(new Error("Android FCM receiver login timed out"));
    }, 20_000);
    const onConnect = (): void => {
      clearTimeout(timer);
      resolve();
    };
    receiver.once("connect", onConnect);
  });
}

/** Parse nested notification JSON without retaining the original payload. */
export function parsePushEvent(data: unknown): MegaPushEvent | null {
  if (!isRecord(data)) return null;
  const outer = nestedRecord(data.payload) ?? data;
  const payload = nestedRecord(outer.payload) ?? outer;
  const cameraSerial = text(outer.device_sn) ?? text(payload.device_sn) ?? text(data.device_sn) ?? text(outer.station_sn) ?? text(data.station_sn);
  if (!cameraSerial) return null;
  return {
    cameraSerial,
    stationSerial: text(outer.station_sn) ?? text(payload.station_sn) ?? text(data.station_sn) ?? cameraSerial,
    cameraName: text(payload.name) ?? text(payload.device_name) ?? text(payload.n),
    eventType: integer(payload.a) ?? integer(payload.event_type),
    messageType: integer(payload.msg_type),
    notificationStyle: integer(payload.notification_style),
    personName: text(payload.f) ?? text(payload.nick_name),
    detectionEvidence: structuredDetectionEvidence(payload),
    content: text(outer.content) ?? text(payload.content) ?? text(data.content),
    pictureUrl: text(payload.pic_url),
    filePath: text(payload.file_path) ?? text(payload.p),
    fetchId: integer(payload.fetch_id) ?? integer(payload.i),
    senseId: text(payload.sense_id) ?? text(payload.j),
    guardMode: integer(payload.station_guard_mode),
    effectiveMode: integer(payload.station_current_mode) ?? integer(payload.current_mode),
    alarmType: integer(payload.alarm_type),
    sensorOpen: sensorOpen(payload.e),
    eventId: text(payload.unique_id) ?? text(outer.unique_id) ?? text(data.unique_id),
  };
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
    return null;
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
