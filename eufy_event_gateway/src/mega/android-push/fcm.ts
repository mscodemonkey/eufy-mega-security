/**
 * Owns Android FCM registration for the gateway's first-party Mega push path.
 *
 * Flow: generate a Firebase Installation ID (FID) → register it with Firebase
 * installations → GServices check-in (→ androidId + securityToken) → GCM
 * register3 (→ FCM token). Persisted Android and installation credentials survive
 * reconnects. An older notification token can be rechecked on that identity.
 *
 * The Firebase project constants below were read from the v6 APK
 * (com.oceanwing.battery.cam): project batterycam-3250a, sender 348804314802 —
 * identical to the legacy app, so registering here receives v6 account pushes.
 * Adapted from mega-yfue/eufy-sdk (Apache-2.0), with gateway-specific logging
 * and module boundaries. Credentials are returned for private persistence and
 * are never written to diagnostics.
 */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { checkinRoot } from "./proto.js";
import type { FcmCredentials } from "./types.js";
import { createLogger } from "../../logging.js";
import { readBoundedResponse } from "../bounded-response.js";

const logger = createLogger("android-push");

/** Android application identity used by Eufy's FCM registration endpoints. */
export const FCM = {
  PROJECT_ID: "batterycam-3250a",
  API_KEY: "AIzaSyCSz1uxGrHXsEktm7O3_wv-uLGpC9BvXR8",
  APP_ID: "1:348804314802:android:440a6773b3620da7",
  SENDER_ID: "348804314802",
  PACKAGE: "com.oceanwing.battery.cam",
  CERT_SHA1: "F051262F9F99B638F3C76DE349830638555B4A0A",
  AUTH_VERSION: "FIS_v2",
  SDK_VERSION: "a:16.3.1",
} as const;

/** Generate a valid Firebase Installation ID (22 url-safe chars, starts c-f). */
export function generateFid(): string {
  const b = randomBytes(17);
  b[0] = 0b01110000 + ((b[0] ?? 0) % 0b00010000); // 4-bit FID header
  return b.toString("base64url").slice(0, 22);
}

interface FidInstallation {
  refreshToken: string;
  authToken: { token: string };
}

type FcmFailureStage = "credentials" | "installation_auth" | "registration";
type FcmFailureReason = "invalid" | "http" | "response" | "transport" | "timeout" | "cancelled";

/**
 * Carries only fixed failure categories from a registrar request to the receiver.
 * Instances retain no response, URL, credentials or original exception. The
 * receiver may log these fields while preserving its saved notification identity.
 */
export class FcmRequestError extends Error {

  /** HTTP status when the server rejected the request, otherwise null. */
  readonly httpStatus: number | null;

  /**
   * Describe the first failing request boundary without retaining private data.
   * @param stage The credential or remote-service boundary that failed.
   * @param reason Whether that boundary rejected, timed out or returned invalid data.
   */
  constructor(readonly stage: FcmFailureStage, readonly reason: FcmFailureReason, httpStatus?: number) {
    super("Firebase token renewal unavailable");
    this.name = "FcmRequestError";
    this.httpStatus = Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599 ? httpStatus! : null;
  }
}

/**
 * Registers one fresh Firebase installation as the Android Eufy application.
 *
 * MegaPushReceiver creates an installation only when no Android identity exists.
 * It can renew an older notification token using the same installation and MCS
 * credentials. Renewal never deletes an installation or creates a replacement.
 * The registrar owns the short-lived Firebase and GServices requests, returns
 * private credentials to its caller, and does not maintain a socket or save
 * credentials itself.
 */
export class FcmRegistrar {

  /**
   * Recheck one existing installation's notification token within fifteen seconds.
   * The receiver owns persistence and fallback. A failure leaves the supplied
   * credentials untouched, and cancellation cannot publish a late replacement.
   */
  async refresh(credentials: FcmCredentials, signal: AbortSignal): Promise<FcmCredentials> {
    const scoped = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    let stage: FcmFailureStage = "credentials";
    let reason: FcmFailureReason = "invalid";
    try {
      scoped.throwIfAborted();
      if (!/^[A-Za-z0-9_-]{22}$/.test(credentials.fid) || !credentials.refreshToken
        || credentials.refreshToken.length > 4096 || /[\s\x00-\x1f\x7f]/u.test(credentials.refreshToken)) {
        throw new FcmRequestError(stage, reason);
      }
      stage = "installation_auth";
      reason = "transport";
      const response = await fetch(`https://firebaseinstallations.googleapis.com/v1/projects/${FCM.PROJECT_ID}/installations/${credentials.fid}/authTokens:generate`, {
        method: "POST", signal: scoped, redirect: "error",
        headers: { "Content-Type": "application/json", "X-Android-Package": FCM.PACKAGE,
          "X-Android-Cert": FCM.CERT_SHA1, "x-goog-api-key": FCM.API_KEY,
          Authorization: `${FCM.AUTH_VERSION} ${credentials.refreshToken}` },
        body: JSON.stringify({ installation: { sdkVersion: FCM.SDK_VERSION } }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new FcmRequestError(stage, "http", response.status);
      }
      reason = "response";
      const value: unknown = JSON.parse((await readBoundedResponse(response, 16_384, scoped)).toString("utf8"));
      const token = typeof value === "object" && value !== null && "token" in value ? value.token : null;
      if (typeof token !== "string" || token.length < 1 || token.length > 8192 || /[\s\x00-\x1f\x7f]/u.test(token)) {
        throw new FcmRequestError(stage, reason);
      }
      stage = "registration";
      reason = "transport";
      const fcmToken = await this.gcmRegister(credentials.fid, credentials.androidId, credentials.securityToken, token, scoped, 1);
      scoped.throwIfAborted();
      return { ...credentials, fcmToken, tokenCheckedAt: Date.now() };
    } catch (error) {
      if (signal.aborted) throw new FcmRequestError(stage, "cancelled");
      if (scoped.aborted) throw new FcmRequestError(stage, "timeout");
      if (error instanceof FcmRequestError) throw error;
      throw new FcmRequestError(stage, reason);
    }
  }

  /**
   * Create one installation within thirty seconds, including retry delays and
   * response bodies. Receiver shutdown cancels outstanding requests. No partial
   * credentials are published, and failed setup does not log response contents.
   */
  async register(signal?: AbortSignal): Promise<FcmCredentials> {
    const scoped = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
    scoped.throwIfAborted();
    const fid = generateFid();
    const install = await this.installFid(fid, scoped);
    const { androidId, securityToken } = await this.checkin(scoped);
    const fcmToken = await this.gcmRegister(fid, androidId, securityToken, install.authToken.token, scoped);
    scoped.throwIfAborted();
    logger.info("fcm_registered", "Android FCM registration completed");
    return { fid, androidId, securityToken, fcmToken, refreshToken: install.refreshToken, createdAt: Date.now() };
  }

  private async installFid(fid: string, signal: AbortSignal): Promise<FidInstallation> {
    const url = `https://firebaseinstallations.googleapis.com/v1/projects/${FCM.PROJECT_ID}/installations`;
    const res = await fetch(url, {
      method: "POST", signal, redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "X-Android-Package": FCM.PACKAGE,
        "X-Android-Cert": FCM.CERT_SHA1,
        "x-goog-api-key": FCM.API_KEY,
      },
      body: JSON.stringify({ fid, appId: FCM.APP_ID, authVersion: FCM.AUTH_VERSION, sdkVersion: FCM.SDK_VERSION }),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error("Firebase installation unavailable");
    }
    const value = JSON.parse((await readBoundedResponse(res, 16_384, signal)).toString("utf8")) as Partial<FidInstallation>;
    if (typeof value?.refreshToken !== "string" || !value.refreshToken || value.refreshToken.length > 4096
      || typeof value.authToken?.token !== "string" || !value.authToken.token || value.authToken.token.length > 8192
      || /[\s\x00-\x1f\x7f]/u.test(value.refreshToken + value.authToken.token)) {
      throw new Error("Firebase installation unavailable");
    }
    return { refreshToken: value.refreshToken, authToken: { token: value.authToken.token } };
  }

  private async checkin(signal: AbortSignal): Promise<{ androidId: string; securityToken: string }> {
    const CheckinRequest = checkinRoot().lookupType("CheckinRequest");
    const CheckinResponse = checkinRoot().lookupType("CheckinResponse");
    const payload = {
      androidId: 0,
      checkin: {
        build: {
          fingerprint: "google/razor/flo:5.0.1/LRX22C/1602158:user/release-keys",
          hardware: "flo",
          brand: "google",
          radio: "FLO-04.04",
          clientId: "android-google",
        },
        lastCheckinMs: 0,
      },
      locale: "en",
      loggingId: 1234567890,
      timeZone: "GMT",
      version: 3,
      fragment: 0,
      userSerialNumber: 0,
    };
    const body = CheckinRequest.encode(CheckinRequest.create(payload)).finish();
    const res = await fetch("https://android.clients.google.com/checkin", {
      method: "POST", signal, redirect: "error",
      headers: { "Content-Type": "application/x-protobuf" },
      body: Buffer.from(body),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error("Android check-in unavailable");
    }
    const obj = CheckinResponse.toObject(CheckinResponse.decode(await readBoundedResponse(res, 65_536, signal)), {
      longs: String,
    });
    if (!obj.androidId || !obj.securityToken) throw new Error("checkin returned no androidId/securityToken");
    return { androidId: String(obj.androidId), securityToken: String(obj.securityToken) };
  }

  private async gcmRegister(
    fid: string,
    androidId: string,
    securityToken: string,
    fidAuthToken: string,
    signal?: AbortSignal,
    maximumAttempts = 5,
  ): Promise<string> {
    const params = new URLSearchParams({
      "X-subtype": FCM.SENDER_ID,
      sender: FCM.SENDER_ID,
      "X-app_ver": "741",
      "X-osv": "25",
      "X-cliv": "fiid-20.2.0",
      "X-gmsv": "201216023",
      "X-appid": fid,
      "X-scope": "*",
      "X-Goog-Firebase-Installations-Auth": fidAuthToken,
      "X-gmp_app_id": FCM.APP_ID,
      "X-firebase-app-name-hash": "R1dAH9Ui7M-ynoznwBdw01tLxhI",
      "X-Firebase-Client-Log-Type": "1",
      app: FCM.PACKAGE,
      device: androidId,
      app_ver: "741",
      gcm_ver: "201216023",
      plat: "0",
      cert: FCM.CERT_SHA1,
      target_ver: "28",
    });

    // Retain the existing finite retries inside the caller's overall deadline.
    let last = "";
    for (let attempt = 0; attempt < maximumAttempts; attempt++) {
      const res = await fetch("https://android.clients.google.com/c2dm/register3", {
        method: "POST",
        ...(signal ? { signal } : {}),
        redirect: "error",
        headers: {
          Authorization: `AidLogin ${androidId}:${securityToken}`,
          app: FCM.PACKAGE,
          gcm_ver: "201216023",
          "User-Agent": "Android-GCM/1.5",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });
      if (signal && !res.ok) {
        await res.body?.cancel();
        throw new FcmRequestError("registration", "http", res.status);
      }
      try {
        last = signal ? (await readBoundedResponse(res, 16_384, signal)).toString("utf8") : await res.text();
      } catch {
        throw new FcmRequestError("registration", "response");
      }
      const m = last.match(/^token=([^\s\x00-\x1f\x7f]+)\s*$/u);
      if (m?.[1]) return m[1].trim();
      if (attempt + 1 === maximumAttempts) break;
      logger.warn("fcm_registration_retry", `Android FCM registration attempt ${attempt + 1} failed`);
      await sleep(1000 * (attempt + 1), undefined, { signal });
    }
    throw new FcmRequestError("registration", "response");
  }
}
