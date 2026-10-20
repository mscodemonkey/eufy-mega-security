/**
 * Owns the gateway's direct connection to Eufy's current Mega cloud API.
 *
 * This client discovers regional hosts, performs the per-host ECDH identity
 * exchange, encrypts and signs requests, handles login challenge states,
 * persists a reusable session, retrieves inventory/DSK/cipher material,
 * registers push, and downloads bounded HTTPS media. It returns checked values
 * to `EufyProvider`; it deliberately knows nothing about Home Assistant entities,
 * SSE, or the PPCS packet stream. Keeping those concerns out of this class is
 * what makes the Mega layer reusable by a probe or another application.
 */
import { MEDIA_HOST, MEDIA_OBJECT_HOST, mediaRequestDiagnostic } from "./media-request-diagnostic.js";
import type { NvrSignallingContext } from "../stream/nvr-rtc-session.js";
import { NvrTrialError } from "../stream/nvr-protocol.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { parseE30MqttCredentials, type E30MqttCredentials } from "../provider/e30-lock-protocol.js";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { eventImageResponseMetadata, type EventImageResponseMetadata } from "../diagnostics/event-image-capture.js";
import {
  beginKeyExchange,
  decryptEnvelope,
  encryptEnvelope,
  encryptPassword,
  finishKeyExchange,
  credentialVerifier,
  megaUserToken,
  EUFYLIFE_PRESET_KEY,
  MEGA_PRESET_KEY,
  randomIdentifier,
  requestSignature,
  sharedAesKey,
  sharedSigningKey,
} from "./crypto.js";
import { CloudRecordingError, type CloudRecordingStage, prepareCloudRecording } from "../stream/cloud-recordings.js";
import { selectCloudRecording, cloudRecordingUrl, cloudRecordingKey, projectCloudHistory, validateCloudHistoryQuery, type CloudHistoryQuery, type CloudHistoryRecord } from "./cloud-history.js";
import { readBoundedResponse } from "./bounded-response.js";
import { CloudCalendarError, cloudCalendarBounds, projectCloudCalendar, type CloudCalendarQuery, type CloudCalendarProjection } from "./cloud-calendar.js";
import { MegaSessionStore } from "./session-store.js";
import { captureGeneralRtcIdentity, generalRtcCipher, type GeneralRtcCipher } from "./general-rtc-identity.js";
import { createLogger } from "../logging.js";
import { GeneralRtcError, generalRtcSmartHost, generalRtcAwait, type GeneralRtcStage } from "../stream/general-rtc-protocol.js";
import type { MegaAuthResult, MegaCaptcha, MegaIdentity, MegaInventory, MegaResult, MegaSession } from "./types.js";

// These codes are handled at the transport boundary so every caller gets the
// same challenge and session-recovery behaviour.
const CAPTCHA_REQUIRED = new Set([100032, 100033]);
const VERIFICATION_REQUIRED = 26052;
const TRANSIENT_IDENTITY_ERRORS = new Set([4404, 4406, 100030]);
const AUTH_SESSION_INVALID_CODES = new Set([4404, 26084, 26884]);

// The native app's login screen interprets this code as a credential rejection.
const LOGIN_CREDENTIALS_REJECTED = 26108;

// Android thumbnail processing retries at one, three, five and ten seconds.
const MEDIA_NOT_READY_DELAYS_MS = [1_000, 2_000, 2_000, 5_000] as const;
const CIPHER_IDENTITY_RECOVERY_INTERVAL_MS = 10 * 60_000;

/** Internal request controls used only by the isolated general RTC experiment. */
interface GeneralRtcCallOptions {
  readonly cachedIdentityOnly?: true;
  readonly onDispatch?: () => void;
}

/** Fixed operation names may cross the logging boundary without request data. */
type MegaOperation = "login" | "inventory" | "lock_credentials" | "cloud_history" | "cloud_playback" | "cipher" | "dsk" | "push" | "captcha" | "general_rtc_hubs" | "general_rtc_params" | "general_rtc_pin" | "general_rtc_sign" | "unknown";

/** Project a known internal endpoint into a fixed, privacy-safe diagnostic label. */
export function megaOperation(path: string): MegaOperation {
  const operations: Readonly<Record<string, MegaOperation>> = {
    "/app/house/get_devs_list": "inventory",
    "/passport/login": "login",
    "/app/devicemanage/get_user_mqtt_info": "lock_credentials",
    "/v3/event/app/get_all_video_record": "cloud_history",
    "/v3/app/cipher/get_ciphers": "cipher",
    "/v3/web/cipher/dec_aes_keys": "cipher",
    "/app/devicerelation/get_dsk_keys": "dsk",
    "/app/push/register_push_token": "push",
    "/passport/generate/captcha": "captcha",
    "/v3/event/app/get_kvs_urls": "cloud_playback",
    "/v3/web/get_hub_list": "general_rtc_hubs",
    "/v3/app/overall/get_params": "general_rtc_params",
    "/v3/web/wp/verify_captcha": "general_rtc_pin",
    "/v1/smart/ws/sign": "general_rtc_sign",
  };
  return Object.hasOwn(operations, path) ? operations[path]! : "unknown";
}

/**
 * Carries an unclassified HTTP rejection without treating it as an expired login.
 * The request caller owns any narrowly scoped read retry. This error retains
 * only a response category, never the server body or account material.
 */
class MegaHttpRejection extends Error {
  constructor(readonly responseKind: string) {
    super(`Mega request failed (HTTP 463 response ${responseKind})`);
  }
}

/** Result of registering one Firebase token with Eufy's notification backends. */
export interface PushActivationResult {

  /** Whether Security confirmed the final application activation check. */
  readonly activated: boolean;

  /** Numeric application result when Eufy supplied one, otherwise `null`. */
  readonly code: number | null;

  /** Security step that rejected the token after Mega accepted it. */
  readonly failedSecurityStage?: "registration" | "activation";

  /** Whether a final Mega registration restored the pre-Security delivery path. */
  readonly megaRegistrationRestored?: boolean;
}

/** Runtime dependencies and account settings for {@link MegaClient}. */
export interface MegaClientOptions {
  readonly email: string;
  readonly password: string;
  readonly country: string;
  readonly persistentDirectory: string;
  readonly minimumRequestIntervalMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;

  /** Permit capture during natural login, without renewing a valid saved session. */
  readonly experimentalGeneralRtc?: boolean;
}

/**
 * Authenticated Mega API client used by the production Eufy provider.
 *
 * The client keeps one account session, caches per-host ECDH identities, and
 * serializes requests because Mega rate-limits aggressively. Authentication
 * challenges are represented as return states so the caller can decide how to
 * present them, rather than embedding a browser or Home Assistant dependency
 * in this low-level client.
 */
export class MegaClient {
  readonly #email: string;
  readonly #password: string;
  readonly #country: string;
  readonly #store: MegaSessionStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #wait: ((milliseconds: number) => Promise<void>) | undefined;
  readonly #minimumRequestIntervalMs: number;
  readonly #experimentalGeneralRtc: boolean;
  #lastRequestAt = 0;
  #connectionFlight: { readonly arguments: string; readonly promise: Promise<MegaAuthResult> } | null = null;
  #requestTail: Promise<unknown> = Promise.resolve();
  #requestLifetime = new AbortController();
  readonly #identityFlights = new Map<string, Promise<MegaIdentity>>();
  readonly #identityRecoveryFlights = new Map<string, Promise<MegaIdentity>>();
  readonly #cipherIdentityRecoveryAt = new Map<string, number>();
  readonly #responseIdentities = new WeakMap<MegaResult, MegaIdentity>();
  readonly #responseOperations = new WeakMap<MegaResult, MegaOperation>();
  #session: MegaSession | null = null;
  #pendingCaptcha: MegaCaptcha | null = null;

  constructor(options: MegaClientOptions) {
    this.#email = options.email;
    this.#password = options.password;
    this.#country = options.country.toLowerCase();
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#wait = options.wait;
    this.#minimumRequestIntervalMs = options.minimumRequestIntervalMs ?? 3_000;
    this.#experimentalGeneralRtc = options.experimentalGeneralRtc === true;
    this.#store = new MegaSessionStore(join(options.persistentDirectory, "mega-session.json"));
  }

  /**
   * Cancel queued and active cloud work when the provider shuts down.
   * A later connect starts a new lifetime, but cancelled jobs cannot dispatch.
   */
  cancelPendingRequests(): void {
    this.#requestLifetime.abort();
    this.#identityFlights.clear();
    this.#identityRecoveryFlights.clear();
  }

  /** Check the current authenticated user without exposing stored account identity. */
  isAuthenticatedUser(userId: string): boolean {
    return this.isAuthenticated && !!userId && this.#session?.userId === userId;
  }

  /** Return only a currently bound RTC cipher, without initiating authentication. */
  generalRtcCipher(): GeneralRtcCipher | null {
    if (!this.#experimentalGeneralRtc || !this.isAuthenticated || !this.#session) return null;
    return generalRtcCipher(this.#session, this.#clusterHost("security"));
  }

  /** Read the existing account binding without authentication, renewal or network I/O. */
  generalRtcAccount(): { userId: string; securityHost: string; smartHost: string | null; country: string; token: string; cipher: GeneralRtcCipher | null } | null {
    if (!this.#experimentalGeneralRtc || !this.isAuthenticated || !this.#session) return null;
    const securityHost = this.#clusterHost("security");
    return { userId: this.#session.userId, securityHost, smartHost: generalRtcSmartHost(securityHost),
      country: this.#country.toUpperCase(), token: this.#session.authToken, cipher: this.generalRtcCipher() };
  }

  /** Check both required native identities without waiting for or starting an exchange. */
  generalRtcHasNativeIdentities(): boolean {
    return !!this.#session && !!this.#cachedNativeIdentity(this.#clusterHost("openapi"))
      && !!this.#cachedNativeIdentity(this.#clusterHost("security"));
  }

  /** Fetch both native inventory lists with no identity recovery or suppressed failure. */
  async generalRtcInventory(signal: AbortSignal): Promise<MegaInventory> {
    if (!this.#experimentalGeneralRtc || !this.isAuthenticated) throw new GeneralRtcError("admission");
    try {
      const first = await this.#call("house", "/app/house/get_devs_list", { house_id: "", device_sns: {} }, false,
        undefined, AbortSignal.any([signal, AbortSignal.timeout(10_000)]), { cachedIdentityOnly: true });
      const value = this.#generalRtcResult(first, "inventory");
      if (!isRecord(value) || !Array.isArray(value.devices)) throw new GeneralRtcError("inventory", "response");
      const second = await this.#call("security", "/v2/house/device_list", {
        device_sn: "", num: 1000, orderby: "", page: 0, station_sn: "",
        time_zone: new Date(this.#now()).getTimezoneOffset() * -60_000, transaction: `${this.#now()}`,
      }, false, undefined, AbortSignal.any([signal, AbortSignal.timeout(10_000)]), { cachedIdentityOnly: true });
      const legacy = this.#generalRtcResult(second, "inventory");
      const rows = Array.isArray(legacy) ? legacy : isRecord(legacy) && Array.isArray(legacy.devices) ? legacy.devices : null;
      if (!rows) throw new GeneralRtcError("inventory", "response");
      return projectMegaInventory(value, chargingDaysFromRows(rows));
    } catch (error) { throw generalRtcRequestFailure(error, "inventory"); }
  }

  /** Read one bounded portal hub page through the existing native request queue. */
  async generalRtcHubs(page: number, signal: AbortSignal): Promise<readonly unknown[]> {
    if (!this.#experimentalGeneralRtc || !this.isAuthenticated || !Number.isInteger(page) || page < 0 || page > 4) throw new GeneralRtcError("admission");
    try {
      const result = await this.#call("security", "/v3/web/get_hub_list",
        { page, num: 100, station_sn: "", device_sn: "" }, false, undefined,
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]), { cachedIdentityOnly: true });
      const data = this.#generalRtcResult(result, "inventory");
      if (!Array.isArray(data)) throw new GeneralRtcError("inventory", "response");
      return data;
    } catch (error) { throw generalRtcRequestFailure(error, "inventory"); }
  }

  /** Read the portal's start-stream preflight configuration without issuing its commands. */
  async generalRtcParams(signal: AbortSignal): Promise<readonly unknown[]> {
    if (!this.#experimentalGeneralRtc || !this.isAuthenticated) throw new GeneralRtcError("admission");
    try {
      const result = await this.#call("security", "/v3/app/overall/get_params",
        { param_name: "common.start_stream.config" }, false, undefined,
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]), { cachedIdentityOnly: true });
      const data = this.#generalRtcResult(result, "preflight");
      if (!Array.isArray(data)) throw new GeneralRtcError("preflight", "response");
      return data;
    } catch (error) { throw generalRtcRequestFailure(error, "preflight"); }
  }

  /** Send one PIN verification with no identity retry and exact dispatch accounting. */
  async generalRtcVerifyPin(pin: string, signal: AbortSignal, onDispatch: () => void): Promise<void> {
    if (!this.#experimentalGeneralRtc || !this.isAuthenticated || !/^[\x20-\x7e]{1,32}$/.test(pin)) throw new GeneralRtcError("admission");
    try {
      const result = await this.#call("security", "/v3/web/wp/verify_captcha", { captcha: pin }, false,
        undefined, AbortSignal.any([signal, AbortSignal.timeout(10_000)]), { cachedIdentityOnly: true, onDispatch });
      this.#generalRtcResult(result, "pin");
    } catch (error) { throw generalRtcRequestFailure(error, "pin"); }
  }

  /** Fetch only the allowlisted smart sign with native token/country headers and no redirects. */
  async generalRtcSign(signal: AbortSignal): Promise<string> {
    const account = this.generalRtcAccount();
    if (!account?.smartHost || !account.cipher) throw new GeneralRtcError("sign", "identity");
    try {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      return await generalRtcAwait(this.#enqueue(async lifetime => {
        const current = this.generalRtcAccount();
        if (!current || current.token !== account.token || current.cipher?.bindingKey !== account.cipher!.bindingKey) throw new GeneralRtcError("binding");
        const scoped = AbortSignal.any([lifetime, deadline]);
        scoped.throwIfAborted();
        const response = await this.#fetch(`https://${account.smartHost}/v1/smart/ws/sign`, {
          method: "GET", headers: { "X-Auth-Token": account.token, "Web-Country": account.country }, redirect: "error", signal: scoped,
        });
        if (response.status !== 200) throw new GeneralRtcError("sign", "response");
        const value: unknown = JSON.parse((await readBoundedResponse(response, 65536, scoped)).toString("utf8"));
        if (!isRecord(value) || value.code !== 0 || typeof value.data !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(value.data)) throw new GeneralRtcError("sign", "response");
        return value.data;
      }), deadline, "sign");
    } catch { throw new GeneralRtcError("sign", "response"); }
  }

  /** Return the pending image challenge, if login requested one. */
  get captcha(): MegaCaptcha | null {
    return this.#pendingCaptcha;
  }

  /** Return true only while the cached token has a one-minute safety margin. */
  get isAuthenticated(): boolean {
    return this.#session !== null && this.#session.verificationPending !== true && this.#session.authToken.length > 0 &&
      this.#session.userId.length > 0 && this.#now() / 1_000 < this.#session.tokenExpiresAt - 60;
  }

  /**
   * Restore or establish the account session.
   *
   * @returns An authentication state. Challenge states are expected and let
   * the provider expose the right next step to the user.
   */
  async connect(verificationCode?: string, captchaAnswer?: string, forceLogin = false): Promise<MegaAuthResult> {
    const argumentsKey = JSON.stringify([verificationCode, captchaAnswer, forceLogin]);
    if (this.#connectionFlight) {
      if (this.#connectionFlight.arguments !== argumentsKey) throw new Error("Mega authentication is already in progress");
      return this.#connectionFlight.promise;
    }
    const promise = this.#connect(verificationCode, captchaAnswer, forceLogin);
    this.#connectionFlight = { arguments: argumentsKey, promise };
    try {
      return await promise;
    } finally {
      if (this.#connectionFlight?.promise === promise) this.#connectionFlight = null;
    }
  }

  async #connect(verificationCode?: string, captchaAnswer?: string, forceLogin = false): Promise<MegaAuthResult> {
    if (forceLogin) this.cancelPendingRequests();
    if (this.#requestLifetime.signal.aborted) this.#requestLifetime = new AbortController();
    const lifetime = this.#requestLifetime.signal;
    if (forceLogin) {
      const previous = this.#session;
      this.#session = null;
      const stored = previous ?? await this.#store.load();
      if (stored?.generalRtcIdentity) {
        await this.#store.save(nativeOnlySession(stored));
        createLogger("mega").info("general_rtc_identity_dropped", "reason=binding");
      }
    }
    if (!this.#session && !forceLogin) await this.#restore();
    lifetime.throwIfAborted();
    if (!forceLogin && this.#session?.verificationPending && !verificationCode && !captchaAnswer) {
      return { state: "verification-required" };
    }
    if (!forceLogin && this.isAuthenticated && !captchaAnswer &&
      (!verificationCode || this.#session?.verificationPending !== true)) {
      if (this.#session) await this.#store.save(this.#session);
      return { state: "authenticated" };
    }


    // Domain discovery and key exchange happen before login because the
    // regional API host and its signing identity are account-specific.
    await this.#ensureDomain();
    lifetime.throwIfAborted();
    const openApiHost = this.#clusterHost("openapi");
    await this.#identity(openApiHost);
    lifetime.throwIfAborted();
    const password = encryptPassword(this.#password, this.#experimentalGeneralRtc);
    const result = await this.#call("passport", "/passport/login", {
      email: this.#email,
      password: password.encrypted,
      ab: this.#country,
      enc: 0,
      time_zone: new Date(this.#now()).getTimezoneOffset() * -60_000,
      client_secret_info: { public_key: password.clientPublicKey },
      answer: captchaAnswer ?? "",
      captcha_id: captchaAnswer ? this.#pendingCaptcha?.id ?? "" : "",
      verify_code: verificationCode ?? "",
      login_id: "",
    });

    if (CAPTCHA_REQUIRED.has(result.code)) {
      const challenge = await this.#requestCaptcha();
      this.#pendingCaptcha = challenge;
      return { state: "captcha-required", captcha: challenge };
    }

    const decoded = this.#decodeResult(result);
    if (!isRecord(decoded)) throw new Error(`Mega login failed (${result.code}: ${safeMegaMessage(result.msg)})`);
    const authToken = stringValue(decoded.auth_token) ?? stringValue(decoded.token);
    const userId = stringValue(decoded.user_id) ?? stringValue(decoded.userId);
    const verificationPending = result.code === VERIFICATION_REQUIRED ||
      isRecord(decoded.fa_info) && decoded.fa_info.step === VERIFICATION_REQUIRED;
    if (authToken && userId) {
      this.#setAuth(authToken, userId, numberValue(decoded.token_expires_at), verificationPending);
    }

    if (verificationPending) {
      if (!verificationCode) await this.#call("push", "/app/sendmsg/verify_code", {
        message_type: 2,
        biz_type: 1004,
        transaction: `${this.#now()}`,
      }, false);
      await this.#save();
      return { state: "verification-required" };
    }
    if (!isSuccess(result.code) || !this.isAuthenticated) {
      throw new Error(`Mega login failed (${result.code}: ${safeMegaMessage(result.msg)})`);
    }
    this.#pendingCaptcha = null;
    if (this.#experimentalGeneralRtc && this.#session && password.scalar) {
      const secretInfo = isRecord(decoded.server_secret_info) ? decoded.server_secret_info : null;
      const identity = captureGeneralRtcIdentity(this.#session, this.#clusterHost("security"),
        password.scalar, password.clientPublicKey, secretInfo?.public_key);
      if (identity) this.#session = { ...this.#session, generalRtcIdentity: identity };
      else createLogger("mega").info("general_rtc_identity_dropped", "reason=server_key");
    }
    await this.#save();
    return { state: "authenticated" };
  }

  /** Fetch transient lock credentials in Security scope without another login or persistence. */
  async e30MqttCredentials(): Promise<E30MqttCredentials> {
    this.#requireAuthentication();
    const session = this.#session!;
    const result = await this.#call("devicemanage", "/app/devicemanage/get_user_mqtt_info", {}, true, "eufy_security");
    if (this.#session?.authToken !== session.authToken || this.#session.userId !== session.userId) throw new Error("Lock credentials unavailable");
    return parseE30MqttCredentials(this.#decodeResult(result), session.userId,
      createHash("sha256").update(session.openUdid).digest("hex").slice(0, 16));
  }

  /** Fetch current account inventory, cancelling only this read when its caller retires. */
  async inventory(cancellation?: AbortSignal): Promise<MegaInventory> {
    this.#requireAuthentication();
    const lifetime = cancellation ? AbortSignal.any([this.#requestLifetime.signal, cancellation]) : this.#requestLifetime.signal;
    const result = await this.#call("house", "/app/house/get_devs_list", { house_id: "", device_sns: {} }, true, undefined, cancellation);
    const value = this.#decodeResult(result);
    if (!isRecord(value) || !Array.isArray(value.devices)) throw new Error("Mega returned an invalid device inventory");
    lifetime.throwIfAborted();
    const chargingDays = await this.#legacyChargingDays(cancellation).catch(() => new Map<string, unknown>());
    lifetime.throwIfAborted();
    return projectMegaInventory(value, chargingDays);
  }

  /**
   * Read cloud recording metadata for one inventory camera without fetching
   * media or altering recordings. Local HomeBase storage is a separate API.
   */
  async cloudHistory(cameraSerial: string, query: CloudHistoryQuery): Promise<readonly CloudHistoryRecord[]> {
    this.#requireAuthentication();
    validateCloudHistoryQuery(query);
    if (!cameraSerial) throw new SyntaxError("Cloud history requires a camera");
    const result = await this.#call("security", "/v3/event/app/get_all_video_record", {
      device_sn: cameraSerial, start_time: query.startTime, end_time: query.endTime,
      offset: query.timezoneOffset ?? 0, id: query.cursor ?? 0, num: query.count ?? 100,
      pullup: true, shared: true, storage: 2,
    });
    return projectCloudHistory(this.#decodeResult(result), cameraSerial, query.count ?? 100);
  }

  /** Read unconfirmed calendar hints without retries, media access or account changes. */
  async cloudCalendar(camera: string, station: string, query: CloudCalendarQuery, signal: AbortSignal): Promise<CloudCalendarProjection> {
    const session = this.#session;
    if (!this.isAuthenticated || !session) throw new CloudCalendarError("auth");
    if (!camera || !station) throw new CloudCalendarError("admission");
    let start: number, end: number;
    try { ({ start, end } = cloudCalendarBounds(query)); }
    catch { throw new CloudCalendarError("request"); }
    if (signal.aborted) throw new CloudCalendarError("cancelled");
    let result: MegaResult;
    try {
      result = await this.#call("security", "/v3/event/web/get_history_by_time", {
        device_sn: camera, station_sn: station, start_time: start, end_time: end,
        offset: query.timezoneOffset, storage: 2, shared: true,
      }, false, undefined, signal);
    } catch { throw new CloudCalendarError(signal.aborted ? "cancelled" : "request"); }
    if (signal.aborted) throw new CloudCalendarError("cancelled");
    if (!this.isAuthenticated || this.#session?.userId !== session.userId || this.#session?.authToken !== session.authToken) throw new CloudCalendarError("auth");
    if (result.code !== 0) throw new CloudCalendarError("response");
    try { return projectCloudCalendar(this.#decodeResult(result), query, camera, station); }
    catch { throw new CloudCalendarError("response"); }
  }

  /**
   * Prepare one user-consented cloud clip from a fresh camera/parent history binding.
   * This read-only experiment never changes subscriptions, recordings or settings.
   * Temporary URLs, the recovered key and downloaded source stay operation-owned.
   */
  async cloudRecordingTrial(camera: string, station: string, id: string, query: CloudHistoryQuery,
    cancellation: AbortSignal): Promise<Buffer> {
    this.#requireAuthentication();
    const session = this.#session!;
    const signal = AbortSignal.any([cancellation, this.#requestLifetime.signal, AbortSignal.timeout(90_000)]);
    let stage: CloudRecordingStage = "history", key: Buffer | null = null, media: Buffer | null = null;
    const current = (): void => {
      signal.throwIfAborted();
      if (this.#session?.authToken !== session.authToken || this.#session?.userId !== session.userId
        || this.#session?.openUdid !== session.openUdid) throw new CloudRecordingError("cancelled");
    };
    try {
      current(); validateCloudHistoryQuery(query);
      const history = await this.#call("security", "/v3/event/app/get_all_video_record", {
        device_sn: camera, start_time: query.startTime, end_time: query.endTime,
        offset: query.timezoneOffset ?? 0, id: query.cursor ?? 0, num: query.count ?? 100,
        pullup: true, shared: true, storage: 2,
      }, false, undefined, signal);
      current(); stage = "ownership";
      const reference = selectCloudRecording(this.#decodeResult(history), camera, station, id, query);
      stage = "url";
      const renewed = await this.#call("security", "/v3/event/app/get_kvs_urls", {
        monitor_ids: [reference.monitorId], user_id: reference.cipherOwner,
      }, false, undefined, signal);
      current(); const url = cloudRecordingUrl(this.#decodeResult(renewed), reference);
      if (reference.encryptedKey) {
        stage = "key";
        if (reference.cipherId === null) throw new CloudRecordingError("key");
        const label = randomIdentifier();
        const result = await this.#call("security", "/v3/web/cipher/dec_aes_keys", {
          user_id: reference.keyOwner,
          cipher_keys: [{ cipher_id: reference.cipherId, aes_keys: { uuid: label, [label]: reference.encryptedKey } }],
        }, false, undefined, signal);
        current(); key = cloudRecordingKey(this.#decodeResult(result), reference.cipherId, label);
      }
      stage = "download"; media = await this.#downloadCloudRecording(url, signal);
      current(); stage = "video";
      const clip = await prepareCloudRecording(media, key, signal);
      try { current(); } catch (error) { clip.fill(0); throw error; }
      return clip;
    } catch (error) {
      throw error instanceof CloudRecordingError ? error : new CloudRecordingError(signal.aborted ? "cancelled" : stage);
    } finally { key?.fill(0); media?.fill(0); }
  }

  /** Download only the selected native media location, with no account headers to object storage. */
  async #downloadCloudRecording(value: string, signal: AbortSignal): Promise<Buffer> {
    const url = allowedMediaUrl(value, new RegExp(`${MEDIA_HOST.source}|${MEDIA_OBJECT_HOST.source}`));
    const response = MEDIA_HOST.test(url.hostname) ? (await this.#fetchMedia(url, signal)).response
      : await this.#fetch(url, { redirect: "manual", signal });
    if (!response.ok) { await response.body?.cancel(); throw new CloudRecordingError("download"); }
    return await readBoundedResponse(response, 32 * 1024 * 1024, signal);
  }

  /** Read the established Security inventory field without retaining its other device data. */
  async #legacyChargingDays(cancellation?: AbortSignal): Promise<ReadonlyMap<string, unknown>> {
    const result = await this.#call("security", "/v2/house/device_list", {
      device_sn: "",
      num: 1_000,
      orderby: "",
      page: 0,
      station_sn: "",
      time_zone: new Date(this.#now()).getTimezoneOffset() * -60_000,
      transaction: `${this.#now()}`,
    }, true, undefined, cancellation);
    const decoded = this.#decodeResult(result);
    const rows = Array.isArray(decoded)
      ? decoded
      : isRecord(decoded) && Array.isArray(decoded.devices) ? decoded.devices : [];
    const values = new Map<string, unknown>();
    for (const row of rows) {
      if (isRecord(row) && typeof row.device_sn === "string" && "charging_days" in row) {
        values.set(row.device_sn, row.charging_days);
      }
    }
    return values;
  }

  /**
   * Identify rejected sessions for the caller's one-shot inventory recovery.
   * The normal login path retains CAPTCHA and verification challenges.
   */
  isSessionInvalidError(error: unknown): boolean {
    return error instanceof Error && (error.message === "Mega request failed (HTTP 401)" || [...AUTH_SESSION_INVALID_CODES].some((code) => error.message.includes(`Mega request failed (${code}:`)) ||
      /Mega request failed \(401:.*token not exist/i.test(error.message));
  }

  /** Fetch the short-lived DSK lookup keys used by Eufy's native PPCS camera path. */
  async dskKeys(stationSerials: readonly string[]): Promise<Record<string, { readonly key: string; readonly expiresAt: number | null }>> {
    this.#requireAuthentication();
    const deviceDsks = stationSerials.map((serial) => ({ invalid_dsk: "", device_sn: serial, category: "eufy_security" }));
    const result = await this.#call("devicerelation", "/app/devicerelation/get_dsk_keys", {
      device_dsks: deviceDsks,
      invalid_dsks: Object.fromEntries(stationSerials.map((serial) => [serial, ""])),
      station_sns: [...stationSerials],
      transaction: `${Date.now()}`,
    });
    const decoded = this.#decodeResult(result);
    const value: Record<string, unknown> = isRecord(decoded) ? decoded : {};
    const output: Record<string, { readonly key: string; readonly expiresAt: number | null }> = {};
    const keys = Array.isArray(value.device_dsks) ? value.device_dsks : [];
    const entries = keys.length > 0
      ? keys.map((raw) => [isRecord(raw) ? stringValue(raw.device_sn) : null, raw] as const)
      : Object.entries(value);
    for (const [serial, raw] of entries) {
      if (!serial) continue;
      if (!isRecord(raw)) continue;
      const key = stringValue(raw.dsk_key);
      if (!key) continue;
      const expiration = numberValue(raw.expiration);
      output[serial] = { key, expiresAt: expiration === null ? null : expiration * 1_000 };
    }
    return output;
  }

  /** Fetch the ECC private keys used by direct media or a station's level-two PPCS session. */
  async getCiphers(cipherIds: readonly number[], userId: string, stationSerial: string): Promise<readonly Record<string, unknown>[]> {
    this.#requireAuthentication();
    const result = await this.#call("security", "/v3/app/cipher/get_ciphers", {
      cipher_ids: [...cipherIds], user_id: userId, station_sn: stationSerial,
    });
    const decoded = this.#decodeResult(result);
    if (Array.isArray(decoded)) return decoded.filter(isRecord);
    if (!isRecord(decoded)) return [];
    const values = Array.isArray(decoded.ciphers) ? decoded.ciphers : Array.isArray(decoded.data) ? decoded.data : [];
    return values.filter(isRecord);
  }

  /**
   * Resolve an owned event-picture key from account encryption metadata.
   * Picture key identifiers are separate from live transport cipher identifiers.
   * Shared-owner and protected keys fail closed. The returned buffer belongs to
   * the caller, which must clear it after use. This method never caches or
   * persists keys; response strings remain subject to JavaScript heap cleanup.
   */
  async getEventImageKey(keyId: number, ownerId: string): Promise<Buffer> {
    if (!this.isAuthenticated || !Number.isInteger(keyId) || keyId < 2 || keyId > 255 ||
      !ownerId || ownerId !== this.#session!.userId) {
      throw new Error("Event picture key unavailable");
    }
    const token = this.#session!.authToken;
    const signal = this.#requestLifetime.signal;
    let decoded: unknown;
    try {
      const result = await this.#call("security", "/v2/commerce/get_current_subscription", {
        new_etoe_version: 1, service_code: "all.service", is_new_version: 1,
        has_eufy_protection_pro: 2, transaction: `${this.#now()}`,
      }, false);
      decoded = this.#decodeResult(result);
    } catch {
      throw new Error("Event picture key lookup failed");
    }
    if (signal.aborted) throw new Error("Event picture key lookup failed");
    if (signal !== this.#requestLifetime.signal || this.#session?.authToken !== token ||
      this.#session.userId !== ownerId) {
      throw new Error("Event picture key session changed");
    }
    if (!isRecord(decoded) || !Array.isArray(decoded.simple_security_keys) || decoded.simple_security_keys.length > 256) {
      throw new Error("Event picture key unavailable");
    }
    const matches = decoded.simple_security_keys.filter((entry: unknown) =>
      isRecord(entry) && Number.isInteger(entry.pincode_id) && entry.pincode_id === keyId);
    const value: unknown = matches.length === 1 ? matches[0].private_key : undefined;
    if (typeof value !== "string" || !/^[a-fA-F0-9]{64}$/.test(value)) {
      throw new Error("Event picture key unavailable");
    }
    return Buffer.from(value, "hex");
  }

  /**
   * Register one Firebase identity with both account notification backends.
   *
   * Security delivery requires its registration and activation check even when
   * Mega registration succeeds. Reuse this session, never perform a second
   * login. The receiver must log in before these requests and owns retries.
   * A rejected Security step restores the proven Mega registration last and
   * returns a degraded result. Failure of that restoration still throws so the
   * receiver can retry without claiming either notification route is usable.
   */
  async registerPushToken(token: string): Promise<PushActivationResult> {
    this.#requireAuthentication();
    await this.#registerMegaPushToken(token);
    const securityRegistration = await this.#securityPushStep("/v1/apppush/register_push_token", {
      token,
      is_notification_enable: true,
      transaction: `${this.#now()}`,
    });
    if (!securityRegistration || !isSuccess(securityRegistration.code)) {
      const code = typeof securityRegistration?.code === "number" && Number.isFinite(securityRegistration.code)
        ? securityRegistration.code
        : null;
      await this.#registerMegaPushToken(token);
      return {
        activated: false,
        code,
        failedSecurityStage: "registration",
        megaRegistrationRestored: true,
      };
    }
    const activation = await this.#securityPushStep("/v1/app/review/app_push_check", {
      app_type: "eufySecurity",
      transaction: `${this.#now()}`,
    });
    const code = typeof activation?.code === "number" && Number.isFinite(activation.code)
      ? activation.code
      : null;
    if (activation && isSuccess(activation.code)) return { activated: true, code };
    await this.#registerMegaPushToken(token);
    return { activated: false, code, failedSecurityStage: "activation", megaRegistrationRestored: true };
  }

  /** Treat a failed Security step as degraded so the accepted Mega registration can be restored once. */
  async #securityPushStep(path: "/v1/apppush/register_push_token" | "/v1/app/review/app_push_check",
    payload: unknown): Promise<MegaResult | null> {
    const lifetime = this.#requestLifetime.signal;
    try {
      return await this.#call("security", path, payload, false);
    } catch {

      // Closing or replacing this client's request lifetime must never revive registration.
      lifetime.throwIfAborted();
      return null;
    }
  }

  /** Register the current Firebase identity through the proven Mega notification path. */
  async #registerMegaPushToken(token: string): Promise<void> {
    const result = await this.#call("push", "/app/push/register_push_token", {
      token,
      is_notification_enable: true,
      voip_token: "",
    }, false);
    if (!isSuccess(result.code)) throw new Error(`Mega push registration failed (${result.code})`);
  }

  /** Download authenticated temporary media through Eufy's allowlisted object-store redirect. */
  async download(url: string, maximumBytes = 20 * 1024 * 1024): Promise<Buffer> {
    return (await this.downloadWithMetadata(url, maximumBytes)).data;
  }

  /**
   * Read allowlisted media within one 30-second lifetime, retrying only404 while
   * a cloud object becomes ready. Discarded bodies and delay timers retire on
   * shutdown. Metadata contains no private headers or object-store URL.
   */
  async downloadWithMetadata(url: string, maximumBytes = 20 * 1024 * 1024): Promise<{ data: Buffer } & EventImageResponseMetadata> {
    const parsed = allowedMediaUrl(url, MEDIA_HOST);
    const signal = AbortSignal.any([this.#requestLifetime.signal, AbortSignal.timeout(30_000)]);
    let response: Response | null = null;
    let request: { response: Response; initial: string; redirect?: string } | null = null;
    let attempts = 0;
    for (let attempt = 0; attempt <= MEDIA_NOT_READY_DELAYS_MS.length; attempt += 1) {
      signal.throwIfAborted();
      request = await this.#fetchMedia(parsed, signal);
      response = request.response;
      attempts += 1;
      if (response.status !== 404 || attempt === MEDIA_NOT_READY_DELAYS_MS.length) break;
      const delay = MEDIA_NOT_READY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await this.#discardMediaResponse(response, signal);
      await this.#waitForMediaRetry(delay, signal);
    }
    if (!response) throw new Error("Mega media download failed");
    if (!response.ok) {
      await this.#discardMediaResponse(response, signal);
      signal.throwIfAborted();
      throw new Error(`Mega media download failed (HTTP ${response.status}); attempts=${attempts}; hop=${request?.redirect ? "redirect" : "initial"}; initial=${request?.initial}${request?.redirect ? `; redirect=${request.redirect}` : ""}`);
    }
    const data = await readBoundedResponse(response, maximumBytes, signal);
    return { data, ...eventImageResponseMetadata(response) };
  }

  async #discardMediaResponse(response: Response, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new Error("Media request cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      await Promise.race([Promise.resolve().then(() => response.body?.cancel()).catch(() => undefined), cancelled]);
      signal.throwIfAborted();
    } finally { signal.removeEventListener("abort", abort); }
  }

  #waitForMediaRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error !== undefined) reject(error); else resolve();
      };
      const abort = (): void => finish(signal.reason ?? new Error("Media request cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      if (this.#wait) {
        try { void this.#wait(milliseconds).then(() => finish(), error => finish(error)); }
        catch (error) { finish(error); }
      } else timer = setTimeout(() => finish(), milliseconds);
    });
  }

  /** Perform one authenticated media lookup and its optional credential-free object-store redirect. */
  async #fetchMedia(url: URL, signal: AbortSignal): Promise<{ response: Response; initial: string; redirect?: string }> {
    signal.throwIfAborted();
    let response = await this.#fetch(url, {
      headers: this.#mediaHeaders(), redirect: "manual", signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await this.#discardMediaResponse(response, signal);
      if (!location) throw new Error("Mega media download rejected");
      const target = allowedMediaUrl(location, MEDIA_OBJECT_HOST);
      signal.throwIfAborted();
      response = await this.#fetch(target, { redirect: "manual", signal });
      return { response, initial: mediaRequestDiagnostic(url), redirect: mediaRequestDiagnostic(target) };
    }
    return { response, initial: mediaRequestDiagnostic(url) };
  }

  /** Obtain a transient, private NVR join context without another login or session bypass. */
  async nvrSignallingContext(station: string, region: "auto" | "us" | "eu" | "ie", cancellation: AbortSignal): Promise<NvrSignallingContext> {
    this.#requireAuthentication();
    const session = this.#session!;
    let selected = region;
    if (selected === "auto") {
      const domain = session.domains.eufy_security;
      if (domain === "security-app-ie.eufylife.com") selected = "ie";
      else if (domain === "security-app-eu.eufylife.com") selected = "eu";
      else if (domain === "security-app.eufylife.com") selected = session.megaDomain.includes("-us-") ? "us" : "eu";
      else throw new NvrTrialError("region_or_authorization_rejected");
    }
    const host = selected === "us" ? "security-smart.eufylife.com" : `security-smart-${selected}.eufylife.com`;
    const deadline = AbortSignal.any([cancellation, AbortSignal.timeout(10_000)]);
    const pending = this.#enqueue(async lifetime => {
      const signal = AbortSignal.any([lifetime, deadline]); signal.throwIfAborted();
      try {
        const response = await this.#fetch(`https://${host}/v1/smart/nvr/ws/sign?station_sn=${encodeURIComponent(station)}`, {
          headers: { "app-name": "eufy_mega", "model-type": "WEB", "web-country": this.#country.toUpperCase(),
            gtoken: megaUserToken(session.userId), "x-auth-token": session.authToken, authorization: session.authToken },
          redirect: "manual", signal,
        });
        if (!response.ok) { await response.body?.cancel(); throw new NvrTrialError("region_or_authorization_rejected"); }
        const value: unknown = JSON.parse((await readBoundedResponse(response, 65536, signal)).toString("utf8"));
        if (!isRecord(value) || value.code !== 0 || typeof value.data !== "string" || !value.data.length || value.data.length > 8192) {
          throw new NvrTrialError("region_or_authorization_rejected");
        }
        if (this.#session !== session) throw new NvrTrialError("cancelled");
        return { host, region: selected.toUpperCase() as "US" | "EU" | "IE", authToken: session.authToken,
          gtoken: megaUserToken(session.userId), sign: value.data };
      } catch (error) {
        throw error instanceof NvrTrialError ? error : new NvrTrialError(cancellation.aborted ? "cancelled" : "sign");
      }
    });
    return await new Promise<NvrSignallingContext>((resolve, reject) => {
      const abort = (): void => { deadline.removeEventListener("abort", abort);
        reject(new NvrTrialError(cancellation.aborted ? "cancelled" : "sign")); };
      deadline.addEventListener("abort", abort, { once: true });
      void pending.then(resolve, reject).finally(() => deadline.removeEventListener("abort", abort));
      if (deadline.aborted) abort();
    });
  }

  #mediaHeaders(): Record<string, string> {
    this.#requireAuthentication();
    return {
      accept: "image/*",
      "app-name": "eufy_mega",
      "model-type": "PHONE",
      "user-agent": "Dalvik/2.1.0 (Linux; U; Android 14; SM-G991B Build/UP1A.231005.007)",
      gtoken: megaUserToken(this.#session!.userId),
      "x-auth-token": this.#session!.authToken,
    };
  }

  async #restore(): Promise<void> {
    const restored = await this.#store.load();
    if (!restored) {
      const openUdid = await this.#store.loadRetiredOpenUdid();
      if (openUdid) {
        this.#session = emptySession(
          this.#country,
          openUdid,
          credentialVerifier(openUdid, this.#email, this.#password),
        );
      }
      return;
    }
    const expectedVerifier = credentialVerifier(restored.openUdid, this.#email, this.#password);
    if (restored.country.toLowerCase() !== this.#country || restored.credentialVerifier !== expectedVerifier) {
      this.#session = emptySession(this.#country, restored.openUdid, expectedVerifier);
      if (restored.generalRtcIdentity) {
        await this.#store.save(nativeOnlySession(restored));
        createLogger("mega").info("general_rtc_identity_dropped", "reason=binding");
      }
      return;
    }
    this.#session = restored;
    if (restored.generalRtcIdentity && (!this.#experimentalGeneralRtc || !this.generalRtcCipher())) {
      const nativeSession = nativeOnlySession(restored);
      this.#session = nativeSession;
      createLogger("mega").info("general_rtc_identity_dropped", this.#experimentalGeneralRtc ? "reason=binding" : "reason=disabled");
      await this.#store.save(nativeSession);
    }
  }

  async #ensureDomain(): Promise<void> {
    if (this.#session?.megaDomain) return;
    const host = `mega-${this.#country === "us" ? "us" : "eu"}-pr.eufy.com`;
    const result = await this.#postClear(host, "/passport/estimate_domain", { ab: this.#country, mode: 1 });
    if (!isSuccess(result.code) || !isRecord(result.data)) {
      throw new Error(`Mega domain discovery failed (${result.code}: ${safeMegaMessage(result.msg)})`);
    }
    const domain = stringValue(result.data.domain);
    if (!domain || !isStringRecord(result.data.product_domains)) throw new Error("Mega returned an invalid domain profile");
    const openUdid = this.#session?.openUdid ?? randomIdentifier();
    this.#session = {
      ...(this.#session ?? emptySession(this.#country, openUdid, credentialVerifier(openUdid, this.#email, this.#password))),
      megaDomain: domain,
      domains: result.data.product_domains,
    };
  }

  #clusterHost(service: string): string {
    if (service === "security" && this.#session?.domains.eufy_security) {
      const host = this.#session.domains.eufy_security;
      return host === "security-app.eufylife.com"
        ? (this.#session.megaDomain.includes("-us-") ? "security-app.eufylife.com" : "security-app-eu.eufylife.com")
        : host;
    }
    if (this.#session?.megaDomain.startsWith("mega-")) {
      return this.#session.megaDomain.replace(/^mega-/, `app-${service}-`);
    }
    return `app-${service}-${this.#country === "us" ? "us" : "eu"}-pr.eufy.com`;
  }

  async #identity(host: string): Promise<MegaIdentity> {
    const saved = this.#session?.identities[host];
    if (saved) return saved;
    const flight = this.#identityFlights.get(host);
    if (flight) return flight;
    const exchange = this.#exchangeIdentity(host);
    this.#identityFlights.set(host, exchange);
    try {
      return await exchange;
    } finally {
      if (this.#identityFlights.get(host) === exchange) this.#identityFlights.delete(host);
    }
  }

  async #exchangeIdentity(host: string): Promise<MegaIdentity> {
    const lifetime = this.#requestLifetime.signal;
    const eufyLife = host.endsWith(".eufylife.com");
    const localKey = eufyLife ? EUFYLIFE_PRESET_KEY : MEGA_PRESET_KEY;
    const pending = beginKeyExchange(localKey);
    const result = await this.#signedPost(host, eufyLife ? "/v3/openapi/oauth/key/exchange" : "/openapi/oauth/key/exchange", undefined, undefined, {
      keyIdent: pending.keyIdent,
      encryptedPublicKey: pending.encryptedPublicKey,
    });
    if (!isSuccess(result.code) || !isRecord(result.data)) {
      throw new Error(`Mega key exchange failed (${result.code}: ${safeMegaMessage(result.msg)})`);
    }
    const encryptedServerPublicKey = stringValue(result.data.server_public_key);
    if (!encryptedServerPublicKey) throw new Error("Mega key exchange omitted the server public key");
    lifetime.throwIfAborted();
    const identity = finishKeyExchange(pending, encryptedServerPublicKey, localKey);
    const base = this.#session ?? emptySession(this.#country, randomIdentifier(), "");
    this.#session = { ...base, identities: { ...base.identities, [host]: identity } };
    return identity;
  }

  #cachedNativeIdentity(host: string): MegaIdentity | null {
    const identity = this.#session?.identities[host];
    return identity && /^[A-Za-z0-9_-]{1,128}$/.test(identity.keyIdent) && /^[a-f0-9]{64}$/i.test(identity.sharedKey)
      ? identity : null;
  }

  #generalRtcResult(result: MegaResult, stage: GeneralRtcStage): unknown {
    if (result.code !== 0) throw new GeneralRtcError(stage, TRANSIENT_IDENTITY_ERRORS.has(result.code) ? "native_identity_rejected" : "response");
    return this.#decodeResult(result);
  }

  async #call(service: string, path: string, payload: unknown, retryIdentity = true, appScope?: "eufy_security", cancellation?: AbortSignal,
    options?: GeneralRtcCallOptions): Promise<MegaResult> {
    const lifetime = cancellation ? AbortSignal.any([this.#requestLifetime.signal, cancellation]) : this.#requestLifetime.signal;
    lifetime.throwIfAborted();
    const host = this.#clusterHost(service);
    const identityHost = host.endsWith(".eufylife.com") ? host : this.#clusterHost("openapi");
    const identity = options?.cachedIdentityOnly ? this.#cachedNativeIdentity(identityHost) : await this.#identity(identityHost);
    if (!identity) throw new GeneralRtcError("admission", "native_identity_missing");
    if (options?.cachedIdentityOnly) retryIdentity = false;
    lifetime.throwIfAborted();
    const trialAccount = options?.cachedIdentityOnly ? this.generalRtcAccount() : null;
    const onDispatch = options?.cachedIdentityOnly ? (): void => {
      const current = this.generalRtcAccount();
      const cached = this.#cachedNativeIdentity(identityHost);
      if (!cached || cached !== identity) throw new GeneralRtcError("admission", cached ? "native_identity_rejected" : "native_identity_missing");
      if (!current || !trialAccount || current.token !== trialAccount.token || current.userId !== trialAccount.userId
        || current.cipher?.bindingKey !== trialAccount.cipher?.bindingKey) throw new GeneralRtcError("binding", "binding");
      options.onDispatch?.();
    } : undefined;
    let result: MegaResult;
    try {
      const pending = this.#signedPost(host, path, payload, identity, undefined, appScope, cancellation, onDispatch);
      result = options?.cachedIdentityOnly ? await generalRtcAwait(pending, lifetime, "admission") : await pending;
    } catch (error) {
      lifetime.throwIfAborted();
      if (!retryIdentity || path !== "/v3/app/cipher/get_ciphers" || !(error instanceof MegaHttpRejection)
        || !["empty", "empty_or_truncated"].includes(error.responseKind)) throw error;

      // An empty rejection does not prove expiry. Replay only this read, with
      // key exchange rather than login, and cap attempts across all cameras.
      if (this.#session?.identities[identityHost] === identity) {
        const previous = this.#cipherIdentityRecoveryAt.get(identityHost);
        const now = this.#now();
        if (previous !== undefined && now - previous < CIPHER_IDENTITY_RECOVERY_INTERVAL_MS) throw error;
        this.#cipherIdentityRecoveryAt.set(identityHost, now);
      }
      const refreshedIdentity = await this.#renewIdentity(identityHost, identity);
      lifetime.throwIfAborted();
      return this.#signedPost(host, path, payload, refreshedIdentity, undefined, appScope, cancellation);
    }
    lifetime.throwIfAborted();
    if (retryIdentity && TRANSIENT_IDENTITY_ERRORS.has(result.code)) {
      const refreshedIdentity = await this.#renewIdentity(identityHost, identity);
      lifetime.throwIfAborted();
      const retried = await this.#signedPost(host, path, payload, refreshedIdentity, undefined, appScope, cancellation, options?.onDispatch);
      lifetime.throwIfAborted();
      return retried;
    }
    return result;
  }

  async #renewIdentity(host: string, rejected: MegaIdentity): Promise<MegaIdentity> {
    const flight = this.#identityRecoveryFlights.get(host);
    if (flight) return flight;
    if (this.#session?.identities[host] !== rejected) return this.#identity(host);
    const lifetime = this.#requestLifetime.signal;
    const renewal = (async () => {
      const identities = { ...this.#session!.identities };
      delete identities[host];
      this.#session = { ...this.#session!, identities };
      const identity = await this.#identity(host);
      lifetime.throwIfAborted();

      // Share persistence as well as exchange so concurrent rejected reads
      // cannot race the session store's atomic replacement file.
      await this.#save();
      lifetime.throwIfAborted();
      return identity;
    })();
    this.#identityRecoveryFlights.set(host, renewal);
    try {
      return await renewal;
    } finally {
      if (this.#identityRecoveryFlights.get(host) === renewal) this.#identityRecoveryFlights.delete(host);
    }
  }

  async #signedPost(
    host: string,
    path: string,
    payload: unknown,
    identity?: MegaIdentity,
    bootstrap?: { readonly keyIdent: string; readonly encryptedPublicKey: string },
    appScope?: "eufy_security",
    cancellation?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<MegaResult> {
    return this.#enqueue(async (lifetime) => {
      const signal = cancellation ? AbortSignal.any([lifetime, cancellation]) : lifetime;
      signal.throwIfAborted();
      const timestamp = `${Math.floor(this.#now() / 1_000)}`;
      const nonce = randomIdentifier();
      const encrypted = bootstrap?.encryptedPublicKey ?? encryptEnvelope(JSON.stringify(payload), sharedAesKey(identity!.sharedKey));
      const body = bootstrap ? JSON.stringify({ client_public_key: encrypted }) : encrypted;
      const signingKey = bootstrap
        ? (host.endsWith(".eufylife.com") ? EUFYLIFE_PRESET_KEY : MEGA_PRESET_KEY)
        : sharedSigningKey(identity!.sharedKey);
      const headers = this.#headers(
        bootstrap?.keyIdent ?? identity!.keyIdent, timestamp, nonce,
        requestSignature(signingKey, timestamp, nonce, encrypted),
      );

      // EufyLife data requests carry opaque encrypted text. Mega and the
      // JSON key-exchange bootstrap retain their existing content types.
      if (!bootstrap && host.endsWith(".eufylife.com")) headers["content-type"] = "text/plain";

      // The native cipher API routes the Security family independently of app-name.
      if (!bootstrap && host.endsWith(".eufylife.com") && path === "/v3/app/cipher/get_ciphers") {
        headers["app-tab"] = "eufy_security";
      }
      if (appScope) headers["app-name"] = appScope;
      if (path === "/v3/web/wp/verify_captcha") headers["X-Auto-Ts"] = timestamp;
      const result = await this.#post(host, path, body, headers, signal, onDispatch);
      this.#responseOperations.set(result, megaOperation(path));
      if (identity) {

        // Only the normal general-client family has an established response
        // signature contract. Bootstrap and native Mega do not inherit it.
        if (host.endsWith(".eufylife.com") && typeof result.data === "string" && result.data) {
          const signature = (result as MegaResult & { signature?: unknown }).signature;
          const required = path.startsWith("/v3/event/") || path === "/v3/web/cipher/dec_aes_keys";
          if (required || signature !== undefined) {
            const expected = requestSignature(signingKey, timestamp, nonce, result.data);
            if (typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature) ||
              !timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) {
              throw new Error("Mega response validation failed (signature)");
            }
          }
        }
        this.#responseIdentities.set(result, identity);
      }
      return result;
    });
  }

  async #postClear(host: string, path: string, payload: unknown): Promise<MegaResult> {
    return this.#enqueue((signal) => this.#post(host, path, JSON.stringify(payload), {
      "app-name": "eufy_mega",
      "app-version": "6.0.51_26722",
      "os-type": "android",
      "content-type": "application/json",
    }, signal));
  }

  async #enqueue<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = this.#requestLifetime.signal;
    signal.throwIfAborted();
    const job = this.#requestTail.then(async () => {
      signal.throwIfAborted();
      const wait = this.#lastRequestAt + this.#minimumRequestIntervalMs - this.#now();
      if (wait > 0) await delay(wait, undefined, { signal });
      signal.throwIfAborted();
      this.#lastRequestAt = this.#now();
      return operation(AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
    });

    // A refused or cancelled job must not poison the next queue position.
    this.#requestTail = job.catch(() => undefined);
    return job;
  }

  async #post(host: string, path: string, body: string, headers: Record<string, string>, signal: AbortSignal, onDispatch?: () => void): Promise<MegaResult> {
    let response: Response;
    signal.throwIfAborted();
    onDispatch?.();
    try {
      response = await this.#fetch(`https://${host}${path}`, {
        method: "POST", headers, body, signal, redirect: "error",
      });
    } catch {
      signal.throwIfAborted();
      throw new Error("Mega request failed (transport)");
    }
    signal.throwIfAborted();
    if (response.status !== 200) {
      if (response.status === 463) {
        let applicationCode: number | undefined;
        let responseKind = "unavailable";
        try {
          const body = await readBoundedResponse(response, 2 * 1024 * 1024, signal);
          responseKind = body.length === 0 ? "empty" : "non_json";
          const value: unknown = JSON.parse(body.toString("utf8"));
          responseKind = "json_without_numeric_code";
          if (isRecord(value) && Number.isSafeInteger(value.code)) {
            applicationCode = value.code as number;
            if (TRANSIENT_IDENTITY_ERRORS.has(applicationCode)) return value as unknown as MegaResult;
          }
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof Error && error.message === "Cloud response is empty or truncated") {
            responseKind = "empty_or_truncated";
          }
        }
        if (applicationCode !== undefined) throw new Error(`Mega request failed (HTTP 463 code ${applicationCode})`);
        throw new MegaHttpRejection(responseKind);
      }
      await response.body?.cancel();
      throw new Error(`Mega request failed (HTTP ${response.status})`);
    }
    let value: unknown;
    try {
      value = JSON.parse((await readBoundedResponse(response, 2 * 1024 * 1024, signal)).toString("utf8"));
    } catch {
      signal.throwIfAborted();
      throw new Error("Mega response validation failed (JSON)");
    }
    signal.throwIfAborted();
    if (!isRecord(value) || !Number.isInteger(value.code)) throw new Error("Mega response validation failed (envelope)");
    return value as unknown as MegaResult;
  }

  #headers(keyIdent: string, timestamp: string, nonce: string, signature: string): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "accept-charset": "UTF-8",
      "accept-language": "en-US,en;q=0.9",
      "app-name": "eufy_mega",
      "app-version": "6.0.51_26722",
      app_version: "6.0.51_26722",
      "os-type": "android",
      os_type: "android",
      "os-version": "14",
      os_version: "14",
      "model-type": "PHONE",
      "phone-model": "Home Assistant Eufy Gateway",
      phone_model: "Home Assistant Eufy Gateway",
      openudid: this.#session?.openUdid ?? "",
      "test-flag": "false",
      priority: "u=3, i",
      "user-agent": "ktor-client",
      "content-type": "application/json",
      "x-encryption-info": "algo_ecdh",
      "x-key-ident": keyIdent,
      "x-request-ts": timestamp,
      "x-request-once": nonce,
      "x-replay-info": "replay",
      "x-signature": signature,
      country: this.#country.toUpperCase(),
      language: "en",
      ab_code: this.#country,
    };
    if (this.#session?.userId) headers.gtoken = megaUserToken(this.#session.userId);
    if (this.#session?.authToken) {
      headers["x-auth-token"] = this.#session.authToken;
      headers.authorization = this.#session.authToken;
    }
    return headers;
  }

  #decodeResult(result: MegaResult): unknown {
    const operation = this.#responseOperations.get(result) ?? "unknown";
    if (!isSuccess(result.code)) {
      if (result.code === VERIFICATION_REQUIRED || CAPTCHA_REQUIRED.has(result.code)) return result.data;
      if (operation === "login" && result.code === LOGIN_CREDENTIALS_REJECTED) {
        throw new Error("Mega request failed (26108: Eufy rejected the login, which the official app reports as an incorrect email or password) operation=login");
      }
      throw new Error(`Mega request failed (${result.code}: ${safeMegaMessage(result.msg)}) operation=${operation}`);
    }
    if (typeof result.data !== "string") return result.data;
    const identity = this.#responseIdentities.get(result);
    if (!identity) throw new Error("Mega response cannot be decrypted without a session identity");
    try {
      return JSON.parse(decryptEnvelope(result.data, sharedAesKey(identity.sharedKey)));
    } catch {
      throw new Error(`Mega response validation failed (encrypted data) operation=${operation}`);
    }
  }

  async #requestCaptcha(): Promise<MegaCaptcha> {

    // Login uses the native no-parameter CAPTCHA overload.
    const result = await this.#call("passport", "/passport/generate/captcha", {}, false);
    const value = this.#decodeResult(result);
    if (!isRecord(value)) throw new Error("Mega returned an invalid CAPTCHA challenge");
    const id = stringValue(value.captcha_id);
    const image = stringValue(value.item);
    if (!id || !image) throw new Error("Mega returned an incomplete CAPTCHA challenge");
    return { id, image };
  }

  #setAuth(
    authToken: string,
    userId: string,
    tokenExpiresAt: number | null,
    verificationPending: boolean,
  ): void {
    if (!this.#session) throw new Error("Mega session was not initialized");
    const base = nativeOnlySession(this.#session);
    this.#session = {
      ...base,
      authToken,
      userId,
      verificationPending,
      tokenExpiresAt: tokenExpiresAt ?? Math.floor(this.#now() / 1_000) + 30 * 24 * 60 * 60,
    };
  }

  async #save(): Promise<void> {
    if (!this.#session) throw new Error("Mega session was not initialized");
    await this.#store.save(this.#session);
  }

  #requireAuthentication(): void {
    if (!this.isAuthenticated) throw new Error("Mega authentication is required");
  }
}

function nativeOnlySession(session: MegaSession): MegaSession {
  const { generalRtcIdentity: retiredIdentity, ...nativeSession } = session;
  void retiredIdentity;
  return nativeSession;
}

function generalRtcRequestFailure(error: unknown, stage: GeneralRtcStage): GeneralRtcError {
  return new GeneralRtcError(stage, error instanceof GeneralRtcError ? error.reason : "response");
}

function chargingDaysFromRows(rows: readonly unknown[]): ReadonlyMap<string, unknown> {
  const values = new Map<string, unknown>();
  for (const row of rows) {
    if (isRecord(row) && typeof row.device_sn === "string" && "charging_days" in row) values.set(row.device_sn, row.charging_days);
  }
  return values;
}

function projectMegaInventory(value: Record<string, unknown>, chargingDays: ReadonlyMap<string, unknown>): MegaInventory {
  if (!Array.isArray(value.devices)) throw new Error("Mega returned an invalid device inventory");
  return {
    devices: value.devices.filter(isMegaDevice).map(device => {
      const { charging_days: _placeholder, ...withoutChargingDays } = device;
      return chargingDays.has(device.device_sn) ? { ...withoutChargingDays, charging_days: chargingDays.get(device.device_sn) } : withoutChargingDays;
    }),
    groups: Array.isArray(value.groups) ? value.groups : [],
  };
}

function allowedMediaUrl(value: string, hostPattern: RegExp): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Mega media URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !hostPattern.test(url.hostname)) {
    throw new Error("Mega media URL is not an allowed Eufy host");
  }
  return url;
}

function emptySession(country: string, openUdid: string, verifier: string): MegaSession {
  return {
    version: 2,
    country,
    openUdid,
    credentialVerifier: verifier,
    authToken: "",
    tokenExpiresAt: 0,
    userId: "",
    verificationPending: false,
    megaDomain: "",
    domains: {},
    identities: {},
  };
}

function isSuccess(code: number): boolean {
  return code === 0 || code === 200;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMegaDevice(value: unknown): value is MegaInventory["devices"][number] {
  return isRecord(value) && typeof value.device_sn === "string" && value.device_sn.length > 0;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeMegaMessage(value: string | undefined): string {
  const known = new Set(["get identity error", "token not exist", "Failed to login."]);
  return value && known.has(value) ? value : "application error";
}
