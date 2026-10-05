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
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
import { projectCloudHistory, validateCloudHistoryQuery, type CloudHistoryQuery, type CloudHistoryRecord } from "./cloud-history.js";
import { readBoundedResponse } from "./bounded-response.js";
import { MegaSessionStore } from "./session-store.js";
import type { MegaAuthResult, MegaCaptcha, MegaIdentity, MegaInventory, MegaResult, MegaSession } from "./types.js";

// These codes are handled at the transport boundary so every caller gets the
// same challenge and session-recovery behaviour.
const CAPTCHA_REQUIRED = new Set([100032, 100033]);
const VERIFICATION_REQUIRED = 26052;
const TRANSIENT_IDENTITY_ERRORS = new Set([4404, 100028, 100030]);
const AUTH_SESSION_INVALID_CODES = new Set([4404, 26084, 26884]);
const MEDIA_HOST = /^security-app(?:-(?:eu|ie))?\.eufylife\.com$/;
const MEDIA_OBJECT_HOST = /^zhixin-security-[a-z0-9]+(?:-[a-z0-9]+)*\.s3(?:\.[a-z]{2}(?:-[a-z0-9]+)+-\d)?\.amazonaws\.com$/;
const MEDIA_NOT_READY_DELAYS_MS = [1_000, 2_000] as const;

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
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #minimumRequestIntervalMs: number;
  #lastRequestAt = 0;
  #connectionFlight: { readonly arguments: string; readonly promise: Promise<MegaAuthResult> } | null = null;
  #requestTail: Promise<unknown> = Promise.resolve();
  #requestLifetime = new AbortController();
  readonly #identityFlights = new Map<string, Promise<MegaIdentity>>();
  readonly #responseIdentities = new WeakMap<MegaResult, MegaIdentity>();
  #session: MegaSession | null = null;
  #pendingCaptcha: MegaCaptcha | null = null;

  constructor(options: MegaClientOptions) {
    this.#email = options.email;
    this.#password = options.password;
    this.#country = options.country.toLowerCase();
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#minimumRequestIntervalMs = options.minimumRequestIntervalMs ?? 3_000;
    this.#store = new MegaSessionStore(join(options.persistentDirectory, "mega-session.json"));
  }

  /**
   * Cancel queued and active cloud work when the provider shuts down.
   * A later connect starts a new lifetime, but cancelled jobs cannot dispatch.
   */
  cancelPendingRequests(): void {
    this.#requestLifetime.abort();
    this.#identityFlights.clear();
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
    if (forceLogin) this.#session = null;
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
    const password = encryptPassword(this.#password);
    const result = await this.#call("passport", "/passport/login", {
      email: this.#email,
      password: password.encrypted,
      ab: this.#country,
      client_secret_info: { public_key: password.clientPublicKey },
      answer: captchaAnswer ?? "",
      captcha_id: captchaAnswer ? this.#pendingCaptcha?.id ?? "" : "",
      verify_code: verificationCode ?? "",
      login_id: "",
    }, false);

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
    await this.#save();
    return { state: "authenticated" };
  }

  /** Fetch the account's devices and groups after authentication. */
  async inventory(): Promise<MegaInventory> {
    this.#requireAuthentication();
    const lifetime = this.#requestLifetime.signal;
    const result = await this.#call("house", "/app/house/get_devs_list", { house_id: "", device_sns: {} });
    const value = this.#decodeResult(result);
    if (!isRecord(value) || !Array.isArray(value.devices)) throw new Error("Mega returned an invalid device inventory");
    lifetime.throwIfAborted();
    const chargingDays = await this.#legacyChargingDays().catch(() => new Map<string, unknown>());
    lifetime.throwIfAborted();
    return {
      devices: value.devices.filter(isMegaDevice).map((device) => {
        const { charging_days: _placeholder, ...withoutChargingDays } = device;
        return chargingDays.has(device.device_sn)
          ? { ...withoutChargingDays, charging_days: chargingDays.get(device.device_sn) }
          : withoutChargingDays;
      }),
      groups: Array.isArray(value.groups) ? value.groups : [],
    };
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

  /** Read the established Security inventory field without retaining its other device data. */
  async #legacyChargingDays(): Promise<ReadonlyMap<string, unknown>> {
    const result = await this.#call("security", "/v2/house/device_list", {
      device_sn: "",
      num: 1_000,
      orderby: "",
      page: 0,
      station_sn: "",
      time_zone: new Date(this.#now()).getTimezoneOffset() * -60_000,
      transaction: `${this.#now()}`,
    });
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
    const securityRegistration = await this.#call("security", "/v1/apppush/register_push_token", {
      token,
      is_notification_enable: true,
      transaction: `${this.#now()}`,
    }, false);
    if (!isSuccess(securityRegistration.code)) {
      const code = typeof securityRegistration.code === "number" && Number.isFinite(securityRegistration.code)
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
    const activation = await this.#call("security", "/v1/app/review/app_push_check", {
      app_type: "eufySecurity",
      transaction: `${this.#now()}`,
    }, false);
    const code = typeof activation.code === "number" && Number.isFinite(activation.code)
      ? activation.code
      : null;
    if (isSuccess(activation.code)) return { activated: true, code };
    await this.#registerMegaPushToken(token);
    return { activated: false, code, failedSecurityStage: "activation", megaRegistrationRestored: true };
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
    const parsed = allowedMediaUrl(url, MEDIA_HOST);
    const signal = AbortSignal.any([this.#requestLifetime.signal, AbortSignal.timeout(30_000)]);
    let response: Response | null = null;
    for (let attempt = 0; attempt <= MEDIA_NOT_READY_DELAYS_MS.length; attempt += 1) {
      response = await this.#fetchMedia(parsed, signal);
      if (response.status !== 404 || attempt === MEDIA_NOT_READY_DELAYS_MS.length) break;
      const delay = MEDIA_NOT_READY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await this.#wait(delay);
    }
    if (!response) throw new Error("Mega media download failed");
    if (!response.ok) throw new Error(`Mega media download failed (HTTP ${response.status})`);
    return readBoundedResponse(response, maximumBytes, signal);
  }

  /** Perform one authenticated media lookup and its optional credential-free object-store redirect. */
  async #fetchMedia(url: URL, signal: AbortSignal): Promise<Response> {
    let response = await this.#fetch(url, {
      headers: this.#mediaHeaders(), redirect: "manual", signal,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Mega media download rejected");
      const target = allowedMediaUrl(location, MEDIA_OBJECT_HOST);
      response = await this.#fetch(target, { redirect: "manual", signal });
    }
    return response;
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
      return;
    }
    this.#session = restored;
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

  async #call(service: string, path: string, payload: unknown, retryIdentity = true): Promise<MegaResult> {
    const lifetime = this.#requestLifetime.signal;
    lifetime.throwIfAborted();
    const host = this.#clusterHost(service);
    const identityHost = host.endsWith(".eufylife.com") ? host : this.#clusterHost("openapi");
    const identity = await this.#identity(identityHost);
    lifetime.throwIfAborted();
    const result = await this.#signedPost(host, path, payload, identity);
    lifetime.throwIfAborted();
    if (retryIdentity && TRANSIENT_IDENTITY_ERRORS.has(result.code)) {
      if (this.#session?.identities[identityHost] === identity) {
        const identities = { ...this.#session.identities };
        delete identities[identityHost];
        this.#session = { ...this.#session, identities };
      }
      const refreshedIdentity = await this.#identity(identityHost);
      lifetime.throwIfAborted();
      await this.#save();
      lifetime.throwIfAborted();
      const retried = await this.#signedPost(host, path, payload, refreshedIdentity);
      lifetime.throwIfAborted();
      return retried;
    }
    return result;
  }

  async #signedPost(
    host: string,
    path: string,
    payload: unknown,
    identity?: MegaIdentity,
    bootstrap?: { readonly keyIdent: string; readonly encryptedPublicKey: string },
  ): Promise<MegaResult> {
    return this.#enqueue(async (signal) => {
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
      const result = await this.#post(host, path, body, headers, signal);
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

  async #post(host: string, path: string, body: string, headers: Record<string, string>, signal: AbortSignal): Promise<MegaResult> {
    let response: Response;
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
    if (!isSuccess(result.code)) {
      if (result.code === VERIFICATION_REQUIRED || CAPTCHA_REQUIRED.has(result.code)) return result.data;
      throw new Error(`Mega request failed (${result.code}: ${safeMegaMessage(result.msg)})`);
    }
    if (typeof result.data !== "string") return result.data;
    const identity = this.#responseIdentities.get(result);
    if (!identity) throw new Error("Mega response cannot be decrypted without a session identity");
    try {
      return JSON.parse(decryptEnvelope(result.data, sharedAesKey(identity.sharedKey)));
    } catch {
      throw new Error("Mega response validation failed (encrypted data)");
    }
  }

  async #requestCaptcha(): Promise<MegaCaptcha> {
    const result = await this.#call("passport", "/passport/generate/captcha", { captcha_type: "PIC", biz_type: 0 }, false);
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
    const base = this.#session;
    if (!base) throw new Error("Mega session was not initialized");
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
