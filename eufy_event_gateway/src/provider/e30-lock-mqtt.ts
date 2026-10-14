/**
 * Owns bounded, non-reconnecting MQTT connections for the opt-in E30 provider.
 * Credential material lives only in one operation. The registry controls
 * authority and cancellation; this boundary validates broker routing and
 * returns correlated queries, never interpreting PUBACK as motor completion.
 */
import { checkServerIdentity } from "node:tls";
import { resolve4 } from "node:dns/promises";
import { connect, type MqttClient, type IClientOptions } from "mqtt";
import { createLogger } from "../logging.js";
import { buildE30Command, buildE30NotificationCommand, decodeE30QueryReply, decodeE30SettingsReply, e30MqttEnvelope, E30LockError,
  type E30NotificationSetting,
  type E30LockIdentity, type E30MqttCredentials, type E30Observation, type E30SettingsObservation, type E30AudibleVolume, type E30Command } from "./e30-lock-protocol.js";

const logger = createLogger("e30-mqtt");

/** Initial status reads allow a sleeping lock time to respond; callers retain shorter operation/readback caps. */
export const E30_STATUS_QUERY_TIMEOUT_MS = 15_000;

/** Injectable network boundary for deterministic transport tests. */
export interface E30MqttNetwork {
  readonly resolve: (hostname: string) => Promise<string[]>;
  readonly connect: (options: IClientOptions) => MqttClient;
}

/** Reject non-public IPv4 destinations even when returned by an approved hostname. */
export function isPublicE30BrokerAddress(address: string): boolean {
  if (!/^(?:(?:0|[1-9]\d{0,2})\.){3}(?:0|[1-9]\d{0,2})$/.test(address)) return false;
  const octets = address.split(".").map(Number);
  const [a, b, c] = octets as [number, number, number, number];
  if (octets.some(part => part > 255)) return false;
  return a !== 0 && a !== 10 && a !== 127 && a < 224
    && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
    && !(a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
    && !(a === 100 && b >= 64 && b <= 127)
    && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    && !(a === 203 && b === 0 && c === 113);
}

/**
 * Bind TLS identity to the validated broker hostname while connecting to a DNS
 * address. Trust remains with the system CA store, never response-supplied CAs.
 */
export function e30BrokerTlsOptions(host: string): { servername: string; rejectUnauthorized: true; checkServerIdentity: typeof checkServerIdentity } {
  if (host !== "security-mqtt-us.anker.com") throw new E30LockError("unavailable");
  return { servername: host, rejectUnauthorized: true,
    checkServerIdentity: (_hostname, certificate) => checkServerIdentity(host, certificate) };
}

/**
 * One clean MQTT session owned by one lock operation, with no reconnect or
 * offline writes. Callers must close it in finally, including failed opens.
 * Query correlation is structural over authenticated TLS, not a CBC MAC.
 */
export class E30MqttSession {
  #client: MqttClient | null = null;
  #credentials: E30MqttCredentials | null;
  #closed = false;
  #subscribed = false;
  #sequence = Math.floor(Date.now() / 1000);
  #lastKeyTime = 0;
  #reading = false;
  #publishing = false;
  readonly #abort: () => void;
  #failureReason = "closed";

  constructor(
    private readonly identity: E30LockIdentity, credentials: E30MqttCredentials,
    private readonly signal: AbortSignal,
    private readonly network: E30MqttNetwork = { resolve: resolve4, connect },
  ) {
    this.#credentials = credentials;
    this.#abort = () => this.close();
    signal.addEventListener("abort", this.#abort, { once: true });
  }

  /** Connect and obtain an explicit subscription grant before any command can be published. */
  async open(): Promise<void> {
    const credentials = this.#credentials;
    if (!credentials) throw new E30LockError("unavailable");
    logger.info("e30_lock_mqtt_route", "host_normalized=us");
    const tlsOptions = e30BrokerTlsOptions(credentials.host);
    const addresses = await bounded(this.network.resolve(credentials.host), this.signal, 8_000);
    for (const address of [...new Set(addresses)].filter(isPublicE30BrokerAddress).slice(0, 8)) {
      this.#alive();
      this.#failureReason = "timeout";
      const client = this.network.connect({ protocol: "mqtts", host: address, port: 8883,
        ...tlsOptions,
        cert: credentials.certificate, key: credentials.privateKey, clientId: credentials.clientId,
        protocolVersion: 4, clean: true, reconnectPeriod: 0, resubscribe: false,
        queueQoSZero: false, connectTimeout: 8_000, keepalive: 30 });
      this.#client = client;
      client.on("error", this.#ignoreVendorError);
      let phase = "connect";
      try {
        await bounded(new Promise<void>((resolve, reject) => {
          const connected = (): void => { cleanup(); resolve(); };
          const failed = (): void => { cleanup(); reject(new E30LockError("unavailable")); };
          const cleanup = (): void => { client.off("connect", connected); client.off("error", failed); client.off("close", failed); };
          client.once("connect", connected); client.once("error", failed); client.once("close", failed);
        }), this.signal, 8_000);
        phase = "subscribe";
        await bounded(new Promise<void>((resolve, reject) => {
          client.subscribe(this.#replyTopic(), { qos: 1 }, (error, grants) => {
            const outcome = e30SubscriptionOutcome(error, grants, this.#replyTopic());
            if (outcome !== "granted_qos0" && outcome !== "granted_qos1") {
              this.#failureReason = outcome; reject(new E30LockError("unavailable"));
            }
            else {
              logger.info("e30_lock_mqtt_subscription", `result=${outcome}`);
              resolve();
            }
          });
        }), this.signal, 4_000);
        this.#subscribed = true;
        this.#check();
        return;
      } catch {
        logger.warn("e30_lock_mqtt_unavailable", `stage=${phase} reason=${this.#failureReason}`);
        this.#destroyClient();
        this.#alive();
      }
    }
    throw new E30LockError("unavailable");
  }

  /** Publish a read once and accept only its non-retained, non-duplicate correlated reply. */
  async query(): Promise<E30Observation> {
    return this.#read(await this.#command("query"), decodeE30QueryReply, E30_STATUS_QUERY_TIMEOUT_MS);
  }

  /** Read fresh settings without exposing unrelated values or interpreting a SET acknowledgement. */
  async querySettings(): Promise<E30SettingsObservation> {
    return this.#read(await this.#command("settings"), decodeE30SettingsReply);
  }

  /** Write one audible sound level; delivery failures after dispatch remain outcome unknown. */
  async setSoundVolume(volume: E30AudibleVolume, onDispatch: () => void): Promise<void> {
    const command = await this.#command({ soundVolume: volume });
    let dispatched = false;
    try { await this.#publish(command, () => { onDispatch(); dispatched = true; }); }
    catch { throw new E30LockError(dispatched ? "outcome_unknown" : "unavailable"); }
  }

  /** Toggle Auto Lock with a fresh private snapshot, preserving its delay and schedule exactly. */
  async setAutoLock(enabled: boolean, onDispatch: () => void): Promise<void> {
    if (typeof enabled !== "boolean") throw new E30LockError("unavailable");
    let dispatched = false;
    try {
      const settings = await this.querySettings();
      if (settings.autoLockEnabled === null) throw new E30LockError("unavailable");
      const command = await this.#command({ autoLock: { enabled, settings } });
      await this.#publish(command, () => { onDispatch(); dispatched = true; });
    } catch { throw new E30LockError(dispatched ? "outcome_unknown" : "unavailable"); }
  }

  /** Publish one notification bit change. The caller owns mode freshness; PUBACK never proves delivery or state. */
  async setNotification(setting: E30NotificationSetting, enabled: boolean, currentMode: number, onDispatch: () => void): Promise<void> {
    if (typeof onDispatch !== "function") throw new E30LockError("unavailable");
    if (this.#reading || this.#publishing) throw new E30LockError("busy");
    let dispatched = false;
    try {
      this.#check();
      const command = buildE30NotificationCommand(this.identity, setting, enabled, currentMode, this.#nextSequence());
      await this.#publish(command, () => { onDispatch(); dispatched = true; });
    } catch { throw new E30LockError(dispatched ? "outcome_unknown" : "unavailable"); }
  }

  #nextSequence(): number { return ++this.#sequence; }

  async #read<T>(command: E30Command, decode: (bytes: Buffer, identity: E30LockIdentity, query: E30Command) => T | null, timeout = 5_000): Promise<T> {
    if (this.#reading || this.#publishing) throw new E30LockError("busy");
    const client = this.#check();
    this.#reading = true;
    const controller = new AbortController();
    const signal = AbortSignal.any([this.signal, controller.signal, AbortSignal.timeout(timeout)]);
    let cleanup = (): void => {};
    const result = new Promise<T>((resolve, reject) => {
      const received = (topic: string, bytes: Buffer, packet: { retain?: boolean; dup?: boolean }): void => {
        if (signal.aborted || topic !== this.#replyTopic() || packet.retain || packet.dup) return;
        const observation = decode(bytes, this.identity, command);
        if (observation) { cleanup(); resolve(observation); }
      };
      const failed = (): void => { cleanup(); reject(new E30LockError("unavailable")); };
      cleanup = (): void => {
        client.off("message", received); client.off("close", failed); client.off("error", failed);
        signal.removeEventListener("abort", failed);
      };
      client.on("message", received); client.once("close", failed); client.once("error", failed);
      signal.addEventListener("abort", failed, { once: true });
    });
    void result.catch(() => undefined);
    try {
      await this.#publish(command);
      return await result;
    } finally { controller.abort(); cleanup(); this.#reading = false; }
  }

  /** Invoke one absolute actuation publish; the caller owns the dispatch/unknown boundary. */
  async actuate(locked: boolean, onDispatch: () => void): Promise<void> {
    const command = await this.#command(locked);
    return this.#publish(command, onDispatch);
  }

  /** Retire sockets synchronously and drop credential references; no reconnect is possible. */
  close(): void {
    this.#closed = true;
    this.signal.removeEventListener("abort", this.#abort);
    this.#destroyClient();
    this.#credentials = null;
  }

  async #publish(command: E30Command, onDispatch?: () => void): Promise<void> {
    if (this.#publishing) throw new E30LockError("busy");
    const client = this.#check();
    const envelope = e30MqttEnvelope(this.identity, command, this.#credentials!.clientId);
    const topic = `cmd/eufy_security/T85F1/${this.identity.serial}/req`;
    this.#publishing = true;
    try { await bounded(new Promise<void>((resolve, reject) => {
      this.#check();
      if (!client.connected) throw new E30LockError("unavailable");
      onDispatch?.();
      client.publish(topic, envelope, { qos: 1, retain: false, dup: false }, error => {
        if (error) reject(new E30LockError("unavailable")); else resolve();
      });
    }), this.signal, 3_000); }
    finally { this.#publishing = false; }
  }

  async #command(action: Parameters<typeof buildE30Command>[1]): Promise<E30Command> {
    this.#check();
    const unixTime = Math.floor(Date.now() / 1000);

    // Never reuse even a timed-out read's key time. Removed listeners and an
    // exact active-time match discard late replies to every retired request.
    const keyTime = Math.max(unixTime, this.#lastKeyTime + 1);
    if (keyTime > 0xffffffff) throw new E30LockError("unavailable");
    this.#lastKeyTime = keyTime;
    return buildE30Command(this.identity, action, unixTime, keyTime, ++this.#sequence);
  }

  #replyTopic(): string { return `cmd/eufy_security/T85F1/${this.identity.serial}/res`; }

  #check(): MqttClient {
    this.#alive();
    if (!this.#client || !this.#subscribed) throw new E30LockError("unavailable");
    return this.#client;
  }

  #alive(): void {
    if (this.#closed || this.signal.aborted) throw new E30LockError("unavailable");
  }

  #destroyClient(): void {
    const client = this.#client; this.#client = null; this.#subscribed = false;
    if (client) { client.end(true); client.stream?.destroy(); }
  }

  #ignoreVendorError = (error: unknown): void => { this.#failureReason = e30MqttFailureReason(error); };
}

/** Classify an exact-topic subscription grant without retaining vendor values. */
export function e30SubscriptionOutcome(error: unknown, grants: unknown, replyTopic: string): string {
  if (error) return "error";
  if (!Array.isArray(grants) || grants.length !== 1) return "count_invalid";
  const grant: unknown = grants[0];
  if (!grant || typeof grant !== "object") return "topic_mismatch";
  if (!("topic" in grant) || typeof grant.topic !== "string" || grant.topic !== replyTopic) return "topic_mismatch";
  const qos = "qos" in grant ? grant.qos : undefined;
  if (qos === 128) return "refused_128";
  if (qos === 0) return "granted_qos0";
  if (qos === 1) return "granted_qos1";
  return "qos_invalid";
}

/** Convert vendor errors to a closed diagnostic vocabulary, never including their text or addresses. */
export function e30MqttFailureReason(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === 5 || (error instanceof Error && /not authori[sz]ed/i.test(error.message))) return "not_authorized";
  if (["ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_HAS_EXPIRED", "SELF_SIGNED_CERT_IN_CHAIN"].includes(String(code))) return "tls_validation";
  if (code === "ECONNREFUSED") return "connection_refused";
  if (code === "ETIMEDOUT") return "timeout";
  return "transport";
}

/** Race bounded work against cancellation, disposing the timer and abort listener afterwards. */
export async function bounded<T>(work: Promise<T>, signal: AbortSignal, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = (): void => {};
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      abort = (): void => reject(new E30LockError("unavailable"));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, milliseconds);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
