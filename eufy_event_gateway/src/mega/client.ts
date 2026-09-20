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
import { join } from "node:path";

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

  /** Return the pending image challenge, if login requested one. */
  get captcha(): MegaCaptcha | null {
    return this.#pendingCaptcha;
  }

  /** Return true only while the cached token has a one-minute safety margin. */
  get isAuthenticated(): boolean {
    return this.#session !== null && this.#session.authToken.length > 0 &&
      this.#session.userId.length > 0 && this.#now() / 1_000 < this.#session.tokenExpiresAt - 60;
  }

  /**
   * Restore or establish the account session.
   *
   * @returns An authentication state. Challenge states are expected and let
   * the provider expose the right next step to the user.
   */
  async connect(verificationCode?: string, captchaAnswer?: string, forceLogin = false): Promise<MegaAuthResult> {
    if (forceLogin) this.#session = null;
    if (!this.#session && !forceLogin) await this.#restore();
    if (!forceLogin && this.isAuthenticated && !verificationCode && !captchaAnswer) {
      if (this.#session) await this.#store.save(this.#session);
      return { state: "authenticated" };
    }


    // Domain discovery and key exchange happen before login because the
    // regional API host and its signing identity are account-specific.
    await this.#ensureDomain();
    const openApiHost = this.#clusterHost("openapi");
    await this.#identity(openApiHost);
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

    const decoded = this.#decodeResult(result, openApiHost);
    if (!isRecord(decoded)) throw new Error(`Mega login failed (${result.code}: ${safeMegaMessage(result.msg)})`);
    const authToken = stringValue(decoded.auth_token) ?? stringValue(decoded.token);
    const userId = stringValue(decoded.user_id) ?? stringValue(decoded.userId);
    if (authToken && userId) this.#setAuth(authToken, userId, numberValue(decoded.token_expires_at));

    if (result.code === VERIFICATION_REQUIRED || isRecord(decoded.fa_info) && decoded.fa_info.step === VERIFICATION_REQUIRED) {
      await this.#call("push", "/app/sendmsg/verify_code", {
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
    const result = await this.#call("house", "/app/house/get_devs_list", { house_id: "", device_sns: {} });
    const value = this.#decodeResult(result, this.#clusterHost("openapi"));
    if (!isRecord(value) || !Array.isArray(value.devices)) throw new Error("Mega returned an invalid device inventory");
    const chargingDays = await this.#legacyChargingDays().catch(() => new Map<string, unknown>());
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
    const decoded = this.#decodeResult(result, this.#clusterHost("security"));
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

  /** Identify errors that should trigger a fresh Mega login attempt. */
  isSessionInvalidError(error: unknown): boolean {
    return error instanceof Error && ([...AUTH_SESSION_INVALID_CODES].some((code) => error.message.includes(`Mega request failed (${code}:`)) ||
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
    const decoded = this.#decodeResult(result, this.#clusterHost("openapi"));
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
    const decoded = this.#decodeResult(result, this.#clusterHost("security"));
    if (Array.isArray(decoded)) return decoded.filter(isRecord);
    if (!isRecord(decoded)) return [];
    const values = Array.isArray(decoded.ciphers) ? decoded.ciphers : Array.isArray(decoded.data) ? decoded.data : [];
    return values.filter(isRecord);
  }

  /** Register the persistent Firebase token with Mega notification service. */
  async registerPushToken(token: string): Promise<void> {
    this.#requireAuthentication();
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
    const signal = AbortSignal.timeout(30_000);
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
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > maximumBytes) throw new Error("Mega media exceeds the safety limit");
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0 || data.length > maximumBytes) throw new Error("Mega media has an invalid size");
    return data;
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
    const identity = finishKeyExchange(pending, encryptedServerPublicKey, localKey);
    const base = this.#session ?? emptySession(this.#country, randomIdentifier(), "");
    this.#session = { ...base, identities: { ...base.identities, [host]: identity } };
    return identity;
  }

  async #call(service: string, path: string, payload: unknown, retryIdentity = true): Promise<MegaResult> {
    const host = this.#clusterHost(service);
    const identityHost = host.endsWith(".eufylife.com") ? host : this.#clusterHost("openapi");
    const identity = await this.#identity(identityHost);
    const result = await this.#signedPost(host, path, payload, identity);
    if (retryIdentity && TRANSIENT_IDENTITY_ERRORS.has(result.code)) {
      if (this.#session) this.#session = { ...this.#session, identities: {} };
      const refreshedIdentity = await this.#identity(identityHost);
      await this.#save();
      return this.#signedPost(host, path, payload, refreshedIdentity);
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
    const timestamp = `${Math.floor(this.#now() / 1_000)}`;
    const nonce = randomIdentifier();
    const encrypted = bootstrap?.encryptedPublicKey ?? encryptEnvelope(JSON.stringify(payload), sharedAesKey(identity!.sharedKey));
    const body = bootstrap ? JSON.stringify({ client_public_key: encrypted }) : encrypted;
    const headers = this.#headers(
      bootstrap?.keyIdent ?? identity!.keyIdent,
      timestamp,
      nonce,
      requestSignature(bootstrap ? (host.endsWith(".eufylife.com") ? EUFYLIFE_PRESET_KEY : MEGA_PRESET_KEY) : sharedSigningKey(identity!.sharedKey), timestamp, nonce, encrypted),
    );
    return this.#post(host, path, body, headers);
  }

  async #postClear(host: string, path: string, payload: unknown): Promise<MegaResult> {
    return this.#post(host, path, JSON.stringify(payload), {
      "app-name": "eufy_mega",
      "app-version": "6.0.51_26722",
      "os-type": "android",
      "content-type": "application/json",
    });
  }

  async #post(host: string, path: string, body: string, headers: Record<string, string>): Promise<MegaResult> {

    // Mega rate-limits aggressively. Serializing requests here also prevents
    // parallel startup calls from invalidating the short-lived identity.
    const wait = this.#lastRequestAt + this.#minimumRequestIntervalMs - this.#now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.#lastRequestAt = this.#now();
    const response = await this.#fetch(`https://${host}${path}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`Mega request failed (HTTP ${response.status}, invalid JSON at ${host}${path}: ${text.slice(0, 160)})`);
    }
    if (!isRecord(value) || typeof value.code !== "number") throw new Error("Mega returned an invalid response");
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

  #decodeResult(result: MegaResult, identityHost: string): unknown {
    if (!isSuccess(result.code)) {
      if (result.code === VERIFICATION_REQUIRED || CAPTCHA_REQUIRED.has(result.code)) return result.data;
      throw new Error(`Mega request failed (${result.code}: ${safeMegaMessage(result.msg)})`);
    }
    if (typeof result.data !== "string") return result.data;
    const identity = this.#session?.identities[identityHost];
    if (!identity) throw new Error("Mega response cannot be decrypted without a session identity");
    return JSON.parse(decryptEnvelope(result.data, sharedAesKey(identity.sharedKey)));
  }

  async #requestCaptcha(): Promise<MegaCaptcha> {
    const result = await this.#call("passport", "/passport/generate/captcha", { captcha_type: "PIC", biz_type: 0 }, false);
    const value = this.#decodeResult(result, this.#clusterHost("openapi"));
    if (!isRecord(value)) throw new Error("Mega returned an invalid CAPTCHA challenge");
    const id = stringValue(value.captcha_id);
    const image = stringValue(value.item);
    if (!id || !image) throw new Error("Mega returned an incomplete CAPTCHA challenge");
    return { id, image };
  }

  #setAuth(authToken: string, userId: string, tokenExpiresAt: number | null): void {
    const base = this.#session;
    if (!base) throw new Error("Mega session was not initialized");
    this.#session = {
      ...base,
      authToken,
      userId,
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
  return (value ?? "unknown error").replace(/token\s*=\s*[^\s,]+/gi, "token=[redacted]");
}
