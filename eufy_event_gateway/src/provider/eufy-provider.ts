/**
 * Adapts Eufy's Mega cloud and PPCS camera protocols to the gateway contract.
 *
 * Startup authenticates one account, parses and filters inventory, retrieves
 * station DSK material, registers Android FCM delivery, and reports camera
 * identities to `GatewayState`. Push callbacks become motion, person, or doorbell press events
 * and verified JPEG snapshots. A live request creates a first-party PPCS
 * session and exposes only its byte stream to `LiveStreamManager`. This is the
 * sole production translation point from Eufy-specific data to normalized
 * provider callbacks; Home Assistant-specific naming stays downstream. The
 * provider also emits field-limited push summaries for support logs without
 * forwarding private event fields into the logger.
 */
import { join } from "node:path";

import type { BatteryState, CameraIdentity, DetectionKind, HomeBaseState, InventoryDiagnostic, NightVisionMode, SecuritySensorState } from "../domain/types.js";
import { createLogger } from "../logging.js";
import { MegaClient } from "../mega/client.js";
import { decodeEventImage, isJpeg } from "../mega/image.js";
import { MegaPushReceiver, type MegaPushEvent } from "../mega/push.js";
import { CameraControlAcknowledgementTimeoutError, FirstPartyPpcsSession, hasDecoderReadyKeyframe } from "../stream/first-party-ppcs.js";
import { HomeBaseCommandAcknowledgementTimeoutError, HomeBasePpcsSession, type HomeBaseChildParam, type HomeBasePpcsState, type HomeBaseStorageDiagnostic } from "../stream/homebase-ppcs.js";
import { cameraCapabilityLogSummaries, describeCameraCapabilities, isSupportedCameraType, describeDeviceCapabilities, deviceCapabilityLogSummaries } from "./device-capabilities-core.js";
import { catalogueIntegrationStatus, hasMainsBatterySentinel } from "./camera-capability-core.js";
import type { CameraProvider, CaptchaChallenge, CaptchaProvider, ProviderEvents } from "./provider.js";
import { PushEventDeduplicator } from "./push-event-deduplicator.js";
import { resolveDeviceRoute } from "./device-routing.js";

const logger = createLogger("provider");
const DSK_REFRESH_SKEW_MILLISECONDS = 60_000;

/** Return whether a cached PPCS lookup key should be replaced before another session starts. */
export function dskKeyNeedsRefresh(
  value: { readonly expiresAt: number | null } | null | undefined,
  now = Date.now(),
): boolean {
  return !value || (value.expiresAt !== null && value.expiresAt <= now + DSK_REFRESH_SKEW_MILLISECONDS);
}

/** Credentials, storage, and transport limits for one Mega account. */
export interface EufyProviderConfig {
  readonly username: string;
  readonly password: string;
  readonly country: string;
  readonly persistentDirectory: string;
  readonly verifyCode?: string;
  readonly maxStreamSeconds: number;
}

/** Normalized Mega inventory row used to decide camera support and routing. */
export interface MegaInventoryDevice {
  readonly serial: string;
  readonly name: string;
  readonly model: string;
  readonly parentSerial: string;
  readonly deviceType: number | null;
  readonly category: string | null;
  readonly channel: number | null;
  readonly p2pDid: string | null;
  readonly p2pConnection: string | null;
  readonly localAddress: string | null;
  readonly cipherId: number | null;
  readonly adminUserId: string | null;
  readonly userName: string | null;
  readonly firmware: string | null;
  readonly paramTypes: readonly number[];
  readonly reads: MegaInventoryReads;
}

/** Allowlisted, validated current values retained from one Mega inventory row. */
export interface MegaInventoryReads {
  readonly enabled?: boolean;
  readonly motionDetectionEnabled?: boolean;
  readonly autoNightVisionEnabled?: boolean;
  readonly nightVisionMode?: number;
  readonly batteryLevel?: number;
  readonly batteryCharging?: boolean;
  readonly batteryHealth?: number;
  readonly batteryTemperature?: number;
  readonly lastChargingDays?: number;
  readonly contactOpen?: boolean;
  readonly lastSeen?: string;

  /** Latest standalone PIR event time in Unix seconds, retained for delayed cloud fallback. */
  readonly motionEventSeconds?: number;
}

const COLOUR_NIGHT_VISION_MODELS: ReadonlySet<string> = new Set([
  "T8144",
  "T8160",
  "T8162",
  "T817L",
  "T8P00",
  "T8P10",
]);
const AUTO_NIGHT_VISION_DOORBELL_MODELS: ReadonlySet<string> = new Set([
  "T8210",
  "T8210C",
]);
const TIMED_LIGHT_JSON_DEVICE_TYPES: ReadonlySet<number> = new Set([151, 10005]);

/** Return whether a device uses the verified timed JSON wall-light command. */
export function supportsTimedCameraLight(
  device: Pick<MegaInventoryDevice, "deviceType">,
): boolean {
  return device.deviceType !== null && TIMED_LIGHT_JSON_DEVICE_TYPES.has(device.deviceType);
}

function isAutoNightVisionDoorbell(
  device: Pick<MegaInventoryDevice, "model" | "deviceType" | "category">,
): boolean {
  return isDoorbellDevice(device) && AUTO_NIGHT_VISION_DOORBELL_MODELS.has(device.model);
}

/** Return the three labels used by this non-doorbell camera family. */
export function nightVisionModes(
  device: Pick<MegaInventoryDevice, "model" | "reads" | "deviceType" | "category">,
): readonly NightVisionMode[] {
  if (device.reads.nightVisionMode === undefined || isDoorbellDevice(device)) return [];
  const modeZeroName = COLOUR_NIGHT_VISION_MODELS.has(device.model) ? "Colour" : "Off";
  return [
    { value: 0, name: modeZeroName },
    { value: 1, name: "Infrared" },
    { value: 2, name: "Spotlight" },
  ];
}

/** Safe, grouped inventory evidence suitable for copied support logs. */
export interface InventoryLogSummary {
  readonly count: number;
  readonly model: string;
  readonly deviceType: number | null;
  readonly category: string | null;
  readonly hasParent: boolean;
  readonly hasChannel: boolean;
  readonly acceptedAsCamera: boolean;
  readonly stationPresent: boolean;
  readonly stationPpcsReady: boolean;
  readonly stationDskReady: boolean;
  readonly streamRoute: "homebase" | "direct" | "unavailable";
  readonly peerPpcsReady: boolean;
  readonly peerDskReady: boolean;
  readonly streamSupported: boolean;
}

/** Selects the peer that owns a camera's PPCS connection and DSK key. */
export interface PpcsStreamRoute {
  readonly peer: MegaInventoryDevice;
  readonly homeBaseAttached: boolean;
}

/**
 * Bridges Mega cloud observations and first-party PPCS streams into callbacks.
 *
 * Startup is deliberately ordered. The provider authenticates, discovers all
 * devices, obtains the station keys needed for camera sessions, then starts
 * push delivery. A stream request creates one PPCS session per camera and
 * closes it when the last consumer releases the source.
 */
export class EufyProvider implements CameraProvider, CaptchaProvider {
  readonly #client: MegaClient;
  readonly #devices = new Map<string, MegaInventoryDevice>();
  readonly #ppcsStreams = new Map<string, FirstPartyPpcsSession>();
  readonly #dskKeys = new Map<string, { readonly key: string; readonly expiresAt: number | null }>();
  readonly #dskRefreshes = new Map<string, Promise<{ readonly key: string; readonly expiresAt: number | null } | null>>();
  readonly #cipherKeys = new Map<number, string>();
  readonly #pushSnapshotQueues = new Map<string, Promise<void>>();
  readonly #pushDeduplicator = new PushEventDeduplicator();
  readonly #stationRefreshFailures = new Map<string, number>();
  readonly #stationReadConfirmed = new Set<string>();
  readonly #stationStorageDiagnosticLogged = new Set<string>();
  readonly #stations = new Map<string, HomeBaseState>();
  readonly #stationOperations = new Map<string, Promise<HomeBaseState>>();
  readonly #cameraOperations = new Map<string, Promise<CameraIdentity>>();
  readonly #motionOperations = new Map<string, Promise<CameraIdentity>>();
  readonly #nightVisionOperations = new Map<string, Promise<CameraIdentity>>();
  readonly #lightOperations = new Map<string, Promise<void>>();
  readonly #pendingSensorMotionCloudConfirmations = new Set<string>();
  readonly #liveDeviceReads = new Map<string, MegaInventoryReads>();
  readonly #liveDeviceParamTypes = new Map<string, readonly number[]>();
  #push: MegaPushReceiver | null = null;
  #events: ProviderEvents | null = null;
  #captchaChallenge: CaptchaChallenge | null = null;
  #verificationRequired = false;
  #stationRefreshTimer: ReturnType<typeof setInterval> | null = null;
  #inventoryRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: EufyProviderConfig) {
    this.#client = new MegaClient({
      email: config.username,
      password: config.password,
      country: config.country,
      persistentDirectory: config.persistentDirectory,
    });
  }

  async #resolveCipherKey(cipherId: number, peer: MegaInventoryDevice): Promise<string | undefined> {
    const cached = this.#cipherKeys.get(cipherId);
    if (cached) return cached;
    if (!peer.adminUserId) return undefined;
    try {
      const ciphers = await this.#client.getCiphers([cipherId], peer.adminUserId, peer.serial);
      for (const cipher of ciphers) {
        const id = typeof cipher.cipher_id === "number" ? cipher.cipher_id : Number(cipher.cipher_id);
        const key = typeof cipher.ecc_private_key === "string" ? cipher.ecc_private_key : "";
        if (Number.isInteger(id) && key) this.#cipherKeys.set(id, key);
      }
    } catch (error) {
      logger.warn("cipher_lookup_unavailable", `Mega cipher lookup unavailable: ${safeError(error)}`);
    }
    return this.#cipherKeys.get(cipherId);
  }

  async #dskKey(peerSerial: string): Promise<{ readonly key: string; readonly expiresAt: number | null } | null> {
    const cached = this.#dskKeys.get(peerSerial);
    if (!dskKeyNeedsRefresh(cached)) return cached ?? null;
    const pending = this.#dskRefreshes.get(peerSerial);
    if (pending) return await pending;
    const refresh = this.#client.dskKeys([peerSerial]).then((keys) => {
      const replacement = keys[peerSerial] ?? null;
      if (replacement) {
        this.#dskKeys.set(peerSerial, replacement);
        return replacement;
      }
      if (cached && cached.expiresAt !== null && cached.expiresAt > Date.now()) {
        logger.warn("dsk_refresh_deferred", "PPCS lookup-key refresh returned no replacement before expiry; using the still-valid cached key");
        return cached;
      }
      return null;
    }).catch((error: unknown) => {
      if (cached && cached.expiresAt !== null && cached.expiresAt > Date.now()) {
        logger.warn("dsk_refresh_deferred", "PPCS lookup-key refresh failed before expiry; using the still-valid cached key");
        return cached;
      }
      throw error;
    }).finally(() => {
      if (this.#dskRefreshes.get(peerSerial) === refresh) this.#dskRefreshes.delete(peerSerial);
    });
    this.#dskRefreshes.set(peerSerial, refresh);
    return await refresh;
  }

  async start(events: ProviderEvents): Promise<void> {
    this.#events = events;
    const auth = await this.#client.connect(this.config.verifyCode);
    if (auth.state !== "authenticated") {
      this.#captchaChallenge = auth.captcha ?? null;
      this.#verificationRequired = auth.state === "verification-required";
      const detail = auth.state === "captcha-required"
        ? "Open the add-on web interface to complete Eufy's CAPTCHA"
        : "Open the add-on web interface to enter Eufy's email verification code";
      events.connection("authentication-required", detail);
      return;
    }
    await this.#completeStartup(events);
  }

  async startStream(serial: string): Promise<void> {
    const device = this.#devices.get(serial);
    if (!device || !isSupportedMegaCamera(device)) throw new Error(`Unknown Eufy camera: ${serial}`);
    const route = ppcsStreamRoute(device, this.#devices);
    const peer = route?.peer;
    const dsk = peer ? await this.#dskKey(peer.serial) : null;

    // The production path is deliberately first-party Mega/PPCS.
    if (route && peer?.p2pDid && peer.p2pConnection && dsk && device.channel !== null) {
      this.#ppcsStreams.get(serial)?.close("replaced");
      const initialEccPrivateKey = !route.homeBaseAttached && device.cipherId !== null
        ? await this.#resolveCipherKey(device.cipherId, peer)
        : undefined;
      const stream = new FirstPartyPpcsSession({
        stationSerial: peer.serial, p2pDid: peer.p2pDid, appConnection: peer.p2pConnection,
        localAddress: peer.localAddress,
        dskKey: dsk.key, channel: device.channel, cameraModel: device.model, stationModel: peer.model,
        accountId: device.adminUserId,
        homeBaseAttached: route.homeBaseAttached,
        cipherId: device.cipherId,
        ...(initialEccPrivateKey ? { initialEccPrivateKey } : {}),
        resolveCipherKey: (cipherId: number) => this.#resolveCipherKey(cipherId, peer),
        maxSeconds: this.config.maxStreamSeconds,
      });
      this.#ppcsStreams.set(serial, stream);
      try {
        await stream.start();
      } catch (error) {
        logger.warn(
          "camera_stream_start_failed",
          ppcsStreamLogSummary(device.model, route, stream.stats, error),
        );
        stream.close("start_failed");
        if (this.#ppcsStreams.get(serial) === stream) this.#ppcsStreams.delete(serial);
        throw error;
      }
      this.#events?.streamStarted(serial, stream.output, () => stream.videoCodec);
      const finalize = () => this.#finalizeStream(serial, stream, device, route);
      stream.output.once("end", finalize);
      stream.output.once("close", finalize);
      return;
    }
    throw new Error("First-party PPCS camera transport is unavailable for this camera");
  }

  async stopStream(serial: string): Promise<void> {
    const stream = this.#ppcsStreams.get(serial);
    const device = this.#devices.get(serial);
    if (!stream || !device) return;
    const route = ppcsStreamRoute(device, this.#devices);
    stream.close("client_stop");
    this.#finalizeStream(serial, stream, device, route);
  }

  /** Write camera enablement once and publish only cloud-confirmed state. */
  setCameraEnabled(serial: string, enabled: boolean): Promise<CameraIdentity> {
    const previous = this.#cameraOperations.get(serial) ?? Promise.resolve(this.#requireCameraIdentity(serial));
    const current = previous.catch(() => this.#requireCameraIdentity(serial)).then(async () => {
      const device = this.#devices.get(serial);
      if (!device || !isSupportedMegaCamera(device)) throw new Error(`Unknown Eufy camera: ${serial}`);
      const route = ppcsStreamRoute(device, this.#devices);
      const peer = route?.peer;
      const dsk = peer ? await this.#dskKey(peer.serial) : null;
      if (!route || !peer?.p2pDid || !peer.p2pConnection || !dsk || device.channel === null || !device.adminUserId) {
        throw new Error("Camera enablement control is unavailable for this camera");
      }
      await this.stopStream(serial);
      const session = new FirstPartyPpcsSession({
        stationSerial: peer.serial,
        p2pDid: peer.p2pDid,
        appConnection: peer.p2pConnection,
        localAddress: peer.localAddress,
        dskKey: dsk.key,
        channel: device.channel,
        cameraModel: device.model,
        accountId: device.adminUserId,
        homeBaseAttached: route.homeBaseAttached,
        purpose: "control",
        maxSeconds: 40,
        ...(route.homeBaseAttached ? {
          resolveCipherKey: async (cipherId: number) => {
            const cached = this.#cipherKeys.get(cipherId);
            if (cached) return cached;
            if (!peer.adminUserId) return undefined;
            const ciphers = await this.#client.getCiphers([cipherId], peer.adminUserId, peer.serial);
            for (const cipher of ciphers) {
              const id = typeof cipher.cipher_id === "number" ? cipher.cipher_id : Number(cipher.cipher_id);
              const key = typeof cipher.ecc_private_key === "string" ? cipher.ecc_private_key : "";
              if (Number.isInteger(id) && key) this.#cipherKeys.set(id, key);
            }
            return this.#cipherKeys.get(cipherId);
          },
        } : {}),
      });
      let acknowledgementTimedOut = false;
      try {
        await session.start();
        try {
          await session.writeCameraEnabled(cameraEnableRawValue(device.deviceType, enabled));
        } catch (error) {
          if (!(error instanceof CameraControlAcknowledgementTimeoutError)) throw error;
          acknowledgementTimedOut = true;
        }
      } finally {
        session.close();
      }
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await this.#refreshInventoryReads();
        const refreshed = this.#devices.get(serial);
        if (refreshed?.reads.enabled === enabled) {
          if (acknowledgementTimedOut) {
            logger.warn("camera_enablement_acknowledgement_missing", "Camera enablement was confirmed by cloud readback after its acknowledgement timed out");
          }
          return this.#cameraIdentity(refreshed);
        }
        await delay(2_000);
      }
      throw new Error("Camera enablement write was not confirmed by readback");
    }).catch((error: unknown) => {
      logger.warn("camera_enablement_failed", `Camera enablement command failed: error=${safeError(error)}`);
      throw error;
    });
    this.#cameraOperations.set(serial, current);
    void current.finally(() => {
      if (this.#cameraOperations.get(serial) === current) this.#cameraOperations.delete(serial);
    }).catch(() => undefined);
    return current;
  }

  /** Write the verified 1011 motion switch and publish fresh inventory state. */
  setCameraMotionDetection(serial: string, enabled: boolean): Promise<CameraIdentity> {
    const previous = this.#motionOperations.get(serial) ?? Promise.resolve(this.#requireCameraIdentity(serial));
    const current = previous.catch(() => this.#requireCameraIdentity(serial)).then(async () => {
      const device = this.#devices.get(serial);
      if (!device || !isSupportedMegaCamera(device)) throw new Error(`Unknown Eufy camera: ${serial}`);
      const route = ppcsStreamRoute(device, this.#devices);
      const peer = route?.peer;
      const dsk = peer ? await this.#dskKey(peer.serial) : null;
      if (!route?.homeBaseAttached || !peer?.p2pDid || !peer.p2pConnection || !dsk || device.channel === null || !device.adminUserId) {
        throw new Error("Camera motion detection control requires a HomeBase-attached camera");
      }
      const session = new FirstPartyPpcsSession({
        stationSerial: peer.serial, p2pDid: peer.p2pDid, appConnection: peer.p2pConnection,
        localAddress: peer.localAddress,
        dskKey: dsk.key, channel: device.channel, cameraModel: device.model,
        accountId: device.adminUserId, homeBaseAttached: true, purpose: "control", maxSeconds: 40,
        resolveCipherKey: (cipherId: number) => this.#resolveCipherKey(cipherId, peer),
      });
      try {
        await session.start();
        await session.writeMotionDetection(enabled);
      } finally {
        session.close();
      }
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await this.#refreshInventoryReads();
        const refreshed = this.#devices.get(serial);
        if (refreshed?.reads.motionDetectionEnabled === enabled) return this.#cameraIdentity(refreshed);
        await delay(2_000);
      }
      throw new Error("Camera motion detection write was not confirmed by readback");
    }).catch((error: unknown) => {
      logger.warn("camera_motion_detection_failed", `Camera motion command failed: error=${safeError(error)}`);
      throw error;
    });
    this.#motionOperations.set(serial, current);
    void current.finally(() => {
      if (this.#motionOperations.get(serial) === current) this.#motionOperations.delete(serial);
    }).catch(() => undefined);
    return current;
  }

  /** Write the camera family's night-vision control and publish fresh confirmed state. */
  setCameraNightVision(serial: string, mode: number): Promise<CameraIdentity> {
    if (!Number.isSafeInteger(mode) || mode < 0 || mode > 2) {
      return Promise.reject(new Error("Night vision mode must be 0, 1, or 2"));
    }
    const previous = this.#nightVisionOperations.get(serial) ?? Promise.resolve(this.#requireCameraIdentity(serial));
    const current = previous.catch(() => this.#requireCameraIdentity(serial)).then(async () => {
      const device = this.#devices.get(serial);
      if (!device || !isSupportedMegaCamera(device)) {
        throw new Error("Night vision control is not supported for this camera");
      }
      const autoNightVision = isAutoNightVisionDoorbell(device);
      const supportedModes = autoNightVision && device.reads.autoNightVisionEnabled !== undefined
        ? [0, 1]
        : nightVisionModes(device).map(({ value }) => value);
      if (!supportedModes.includes(mode)) {
        throw new Error("The selected night vision mode is not supported for this camera");
      }
      const route = ppcsStreamRoute(device, this.#devices);
      const peer = route?.peer;
      const dsk = peer ? await this.#dskKey(peer.serial) : null;
      if (!route?.homeBaseAttached || !peer?.p2pDid || !peer.p2pConnection || !dsk || device.channel === null || !device.adminUserId) {
        throw new Error("Night vision control requires a ready HomeBase-attached camera route");
      }
      const session = new FirstPartyPpcsSession({
        stationSerial: peer.serial, p2pDid: peer.p2pDid, appConnection: peer.p2pConnection,
        localAddress: peer.localAddress,
        dskKey: dsk.key, channel: device.channel, cameraModel: device.model,
        accountId: device.adminUserId, homeBaseAttached: true, purpose: "control", maxSeconds: 40,
        resolveCipherKey: (cipherId: number) => this.#resolveCipherKey(cipherId, peer),
      });
      let acknowledgementTimedOut = false;
      try {
        await session.start();
        try {
          if (autoNightVision) await session.writeAutoNightVision(mode === 1);
          else await session.writeNightVision(mode);
        } catch (error) {
          if (!(autoNightVision && error instanceof CameraControlAcknowledgementTimeoutError)) throw error;
          acknowledgementTimedOut = true;
        }
      } finally {
        session.close();
      }
      for (let attempt = 0; attempt < 12; attempt += 1) {
        if (autoNightVision) await this.refreshStation(peer.serial);
        else await this.#refreshInventoryReads();
        const refreshed = this.#devices.get(serial);
        const confirmed = autoNightVision
          ? refreshed?.reads.autoNightVisionEnabled === (mode === 1)
          : refreshed?.reads.nightVisionMode === mode;
        if (confirmed && refreshed) {
          if (acknowledgementTimedOut) {
            logger.warn("camera_auto_night_vision_acknowledgement_missing", "Auto night vision was confirmed by local readback after its acknowledgement timed out");
          }
          return this.#cameraIdentity(refreshed);
        }
        await delay(2_000);
      }
      throw new Error("Night vision write was not confirmed by readback");
    }).catch((error: unknown) => {
      logger.warn("camera_night_vision_failed", `Night vision command failed: error=${safeError(error)}`);
      throw error;
    });
    this.#nightVisionOperations.set(serial, current);
    void current.finally(() => {
      if (this.#nightVisionOperations.get(serial) === current) this.#nightVisionOperations.delete(serial);
    }).catch(() => undefined);
    return current;
  }

  #finalizeStream(
    serial: string,
    stream: FirstPartyPpcsSession,
    device: MegaInventoryDevice,
    route: PpcsStreamRoute | null,
  ): void {
    if (this.#ppcsStreams.get(serial) !== stream) return;
    logger.info("camera_stream_closed", ppcsStreamLogSummary(device.model, route, stream.stats));
    this.#ppcsStreams.delete(serial);
    this.#events?.streamStopped(serial);
  }

  async refreshStation(serial: string): Promise<HomeBaseState> {
    const identity = this.#devices.get(serial);
    if (!identity || !isDiscoveredHomeBase(identity)) {
      return Promise.reject(new Error("HomeBase state read is unavailable for this station"));
    }
    const station = await this.#queueStationOperation(
      serial,
      false,
      async (session) => session.readState(isHomeBase3(identity)),
      "discovered",
    );
    if (station.stateReadSupported && !this.#stationReadConfirmed.has(serial)) {
      this.#stationReadConfirmed.add(serial);
      logger.info(
        "station_state_read_ready",
        `HomeBase state read ready: model=${identity.model} guard_mode=${station.guardMode === null ? "missing" : "present"} effective_mode=${station.effectiveMode === null ? "missing" : "present"}`,
      );
    }
    return station;
  }

  async setGuardMode(serial: string, mode: number): Promise<HomeBaseState> {
    if (![0, 1, 2, 3, 4, 5, 47, 63].includes(mode)) throw new Error("Unsupported HomeBase guard mode");
    return this.#writeStationValue(serial, "guardMode", mode, (session) => session.setGuardMode(mode), "guard-mode");
  }

  async setAlarmVolume(serial: string, value: number): Promise<HomeBaseState> {
    if (!Number.isInteger(value) || value < 1 || value > 26) throw new Error("HomeBase alarm volume must be from 1 to 26");
    return this.#writeStationValue(serial, "alarmVolume", value, (session) => session.setAlarmVolume(value));
  }

  async setPromptVolume(serial: string, value: number): Promise<HomeBaseState> {
    if (!Number.isInteger(value) || value < 0 || value > 26) throw new Error("HomeBase prompt volume must be from 0 to 26");
    return this.#writeStationValue(serial, "promptVolume", value, (session) => session.setPromptVolume(value));
  }

  async setAlarmTone(serial: string, value: number): Promise<HomeBaseState> {
    if (value !== 1 && value !== 2) throw new Error("HomeBase alarm tone must be 1 or 2");
    return this.#writeStationValue(serial, "alarmTone", value, (session) => session.setAlarmTone(value));
  }

  async close(): Promise<void> {
    if (this.#stationRefreshTimer) clearInterval(this.#stationRefreshTimer);
    this.#stationRefreshTimer = null;
    if (this.#inventoryRefreshTimer) clearInterval(this.#inventoryRefreshTimer);
    this.#inventoryRefreshTimer = null;
    await this.#push?.close();
    this.#push = null;
    for (const stream of this.#ppcsStreams.values()) stream.close();
    this.#ppcsStreams.clear();
    await Promise.allSettled(this.#stationOperations.values());
    this.#stationOperations.clear();
    await Promise.allSettled(this.#cameraOperations.values());
    this.#cameraOperations.clear();
    await Promise.allSettled(this.#lightOperations.values());
    this.#lightOperations.clear();
    this.#pendingSensorMotionCloudConfirmations.clear();
    this.#liveDeviceReads.clear();
    this.#liveDeviceParamTypes.clear();
    this.#events = null;
  }

  getCaptchaChallenge(): CaptchaChallenge | null {
    return this.#captchaChallenge;
  }

  isVerificationRequired(): boolean {
    return this.#verificationRequired;
  }

  async submitCaptcha(answer: string): Promise<void> {
    if (!this.#captchaChallenge || !this.#events) throw new Error("No Eufy CAPTCHA is waiting for an answer");
    const result = await this.#client.connect(undefined, answer);
    if (result.state === "captcha-required") {
      this.#captchaChallenge = result.captcha ?? null;
      throw new Error("Eufy did not accept the CAPTCHA answer");
    }
    if (result.state === "verification-required") {
      this.#captchaChallenge = null;
      this.#verificationRequired = true;
      this.#events.connection("authentication-required", "Eufy sent a six-digit verification code; enter it in the add-on web interface");
      return;
    }
    this.#captchaChallenge = null;
    this.#verificationRequired = false;
    await this.#completeStartup(this.#events);
  }

  async submitVerification(code: string): Promise<void> {
    if (!this.#verificationRequired || !this.#events) throw new Error("No Eufy verification is waiting for a code");
    const result = await this.#client.connect(code);
    if (result.state !== "authenticated") throw new Error("Eufy did not accept the verification code");
    this.#verificationRequired = false;
    await this.#completeStartup(this.#events);
  }

  async #completeStartup(events: ProviderEvents): Promise<void> {
    let inventory;
    try {
      inventory = await this.#client.inventory();
    } catch (error) {
      if (!this.#client.isSessionInvalidError(error)) throw error;
      logger.warn("session_invalidated", "Mega session was invalidated; signing in again");
      const auth = await this.#client.connect(undefined, undefined, true);
      if (auth.state !== "authenticated") {
        this.#captchaChallenge = auth.captcha ?? null;
        this.#verificationRequired = auth.state === "verification-required";
        const detail = auth.state === "captcha-required"
          ? "Open the add-on web interface to complete Eufy's CAPTCHA"
          : "Open the add-on web interface to enter Eufy's email verification code";
        events.connection("authentication-required", detail);
        return;
      }
      inventory = await this.#client.inventory();
    }
    const devices = parseMegaInventory(inventory);
    this.#devices.clear();
    this.#pendingSensorMotionCloudConfirmations.clear();
    this.#liveDeviceReads.clear();
    this.#liveDeviceParamTypes.clear();
    for (const device of devices) {
      this.#devices.set(device.serial, device);
    }
    this.#dskKeys.clear();
    this.#cipherKeys.clear();
    const peerSerials = [...new Set(devices.filter((device) => (!device.parentSerial || device.parentSerial === device.serial) && device.p2pDid).map((device) => device.serial))];
    if (peerSerials.length > 0) {
      try {
        for (const [serial, key] of Object.entries(await this.#client.dskKeys(peerSerials))) this.#dskKeys.set(serial, key);
      } catch (error) {
        logger.warn("dsk_lookup_unavailable", `Mega DSK lookup unavailable: ${safeError(error)}`);
      }
    }
    const dskPeerSerials = new Set(this.#dskKeys.keys());
    for (const device of devices) {
      if (!isSupportedMegaCamera(device)) continue;
      events.camera(this.#cameraIdentity(device));
    }
    for (const device of devices) {
      const sensor = securitySensorState(device);
      if (sensor) events.sensor(sensor);
    }
    const manifests = devices.map((device) => describeCameraCapabilities(device, {
      doorbellSupported: isDoorbellDevice(device),
      streamSupported: isPpcsStreamSupported(device, this.#devices, dskPeerSerials),
      routeReady: isPpcsRouteReady(device, this.#devices, dskPeerSerials),
      homeBaseAttached: ppcsStreamRoute(device, this.#devices)?.homeBaseAttached ?? false,
    }));
    events.cameraCapabilities(manifests);
    for (const { count, message } of cameraCapabilityLogSummaries(manifests)) {
      logger.info("camera_capability_group", `count=${count} ${message}`);
    }
    const deviceManifests = devices.flatMap((device) => describeDeviceCapabilities(device, {
      homeBaseSupported: isHomeBase3(device),
      homeBaseGuardModeSupported: supportsHomeBaseGuardMode(device),
      homeBaseRouteReady: Boolean(device.p2pDid && device.p2pConnection && this.#dskKeys.has(device.serial)),
      doorbellSupported: isDoorbellDevice(device),
      cameraStreamSupported: isPpcsStreamSupported(device, this.#devices, dskPeerSerials),
    }));
    events.deviceCapabilities(deviceManifests);
    for (const { count, message } of deviceCapabilityLogSummaries(deviceManifests)) {
      logger.info("device_capability_group", `count=${count} ${message}`);
    }
    this.#stations.clear();
    for (const device of devices.filter(isDiscoveredHomeBase)) {
      const station = initialHomeBaseState(
        device,
        this.#dskKeys.has(device.serial),
      );
      this.#stations.set(device.serial, station);
      events.station(station);
    }
    const diagnostics = inventoryDiagnostics(devices);
    const summaries = inventoryLogSummaries(devices, new Set(this.#dskKeys.keys()));
    logger.info(
      "inventory_loaded",
      `Mega inventory loaded: devices=${devices.length} accepted=${diagnostics.filter(({ acceptedAsCamera }) => acceptedAsCamera).length} groups=${summaries.length}`,
    );
    for (const summary of summaries) {
      logger.info(
        "inventory_group",
        [
          `count=${summary.count}`,
          `model=${JSON.stringify(summary.model)}`,
          `device_type=${summary.deviceType ?? "missing"}`,
          `category=${summary.category ?? "missing"}`,
          `accepted=${summary.acceptedAsCamera}`,
          `has_parent=${summary.hasParent}`,
          `has_channel=${summary.hasChannel}`,
          `station_present=${summary.stationPresent}`,
          `station_ppcs_ready=${summary.stationPpcsReady}`,
          `station_dsk_ready=${summary.stationDskReady}`,
          `stream_route=${summary.streamRoute}`,
          `peer_ppcs_ready=${summary.peerPpcsReady}`,
          `peer_dsk_ready=${summary.peerDskReady}`,
          `stream_supported=${summary.streamSupported}`,
        ].join(" "),
      );
    }
    events.inventory(diagnostics);

    await this.#push?.close();
    this.#push = new MegaPushReceiver(
      this.#client,
      join(this.config.persistentDirectory, "mega-push.json"),
      (event) => this.#handlePush(events, event),
      (state) => events.eventReceiverState(state),
      (outcome) => events.eventDelivery(outcome),
    );
    await this.#push.start();
    events.connection("connected", "Gateway events and snapshots are ready; live viewing requires a validated PPCS camera path");
    await Promise.allSettled(
      [...this.#stations.values()].map(({ serial }) => this.refreshStation(serial).then(
        () => this.#recordStationRefreshSuccess(serial),
        (error: unknown) => this.#recordStationRefreshFailure(serial, error),
      )),
    );
    if (this.#stationRefreshTimer) clearInterval(this.#stationRefreshTimer);
    this.#stationRefreshTimer = setInterval(() => {
      for (const station of this.#stations.values()) {
        if (this.#stationOperations.has(station.serial)
          || this.#stationHasActiveMedia(station.serial)) continue;
        void this.refreshStation(station.serial).then(
          () => this.#recordStationRefreshSuccess(station.serial),
          (error: unknown) => this.#recordStationRefreshFailure(station.serial, error),
        );
      }
    }, 60_000);
    this.#stationRefreshTimer.unref();
    if (this.#inventoryRefreshTimer) clearInterval(this.#inventoryRefreshTimer);
    this.#inventoryRefreshTimer = setInterval(() => {
      void this.#refreshInventoryReads().catch((error: unknown) => {
        logger.warn("inventory_refresh_unavailable", `Mega read refresh unavailable: ${safeError(error)}`);
      });
    }, 60_000);
    this.#inventoryRefreshTimer.unref();
  }

  async #refreshInventoryReads(): Promise<void> {
    const refreshed = parseMegaInventory(await this.#client.inventory());
    for (const device of refreshed) {
      const known = this.#devices.get(device.serial);
      if (!known) continue;
      const motionOutcome = inventoryMotionOutcome(
        known.reads.motionEventSeconds,
        device.reads.motionEventSeconds,
        this.#pendingSensorMotionCloudConfirmations.has(device.serial),
      );
      const liveReads = this.#liveDeviceReads.get(device.serial);
      const liveParamTypes = this.#liveDeviceParamTypes.get(device.serial) ?? [];
      const merged = {
        ...known,
        paramTypes: [...new Set([...device.paramTypes, ...liveParamTypes])].sort((left, right) => left - right),
        reads: liveReads ? { ...device.reads, ...liveReads } : device.reads,
      };
      this.#devices.set(device.serial, merged);
      if (isSupportedMegaCamera(merged)) {
        this.#events?.camera(this.#cameraIdentity(merged));
      }
      const sensor = securitySensorState(merged);
      if (sensor) this.#events?.sensor(sensor);
      if (motionOutcome === "none") continue;
      this.#pendingSensorMotionCloudConfirmations.delete(device.serial);
      logger.info(
        "sensor_motion_cloud_observed",
        [
          `model=${JSON.stringify(device.model)}`,
          `channel=${device.channel ?? "missing"}`,
          `previous=${known.reads.motionEventSeconds ?? "missing"}`,
          `current=${device.reads.motionEventSeconds ?? "missing"}`,
          `outcome=${motionOutcome}`,
        ].join(" "),
      );
      if (motionOutcome === "cloud-motion") this.#events?.sensorMotion(device.serial, true);
    }
  }

  #requireCameraIdentity(serial: string): CameraIdentity {
    const device = this.#devices.get(serial);
    if (!device || !isSupportedMegaCamera(device)) throw new Error(`Unknown Eufy camera: ${serial}`);
    return this.#cameraIdentity(device);
  }

  #cameraIdentity(device: MegaInventoryDevice): CameraIdentity {
    const dskPeerSerials = new Set(this.#dskKeys.keys());
    return {
      serial: device.serial,
      name: device.name,
      model: device.model,
      catalogueStatus: catalogueIntegrationStatus(device.model, device.deviceType),
      stationSerial: device.parentSerial,
      doorbellSupported: isDoorbellDevice(device),
      streamSupported: isPpcsStreamSupported(device, this.#devices, dskPeerSerials),
      enabled: device.reads.enabled ?? null,
      enableControlSupported: device.reads.enabled !== undefined
        && device.channel !== null
        && device.adminUserId !== null
        && isPpcsRouteReady(device, this.#devices, dskPeerSerials),
      motionDetectionEnabled: device.reads.motionDetectionEnabled ?? null,
      motionDetectionControlSupported: device.reads.motionDetectionEnabled !== undefined
        && device.channel !== null
        && device.adminUserId !== null
        && isPpcsRouteReady(device, this.#devices, dskPeerSerials),
      nightVisionMode: device.reads.nightVisionMode ?? null,
      nightVisionModes: nightVisionModes(device),
      nightVisionControlSupported: device.reads.nightVisionMode !== undefined
        && !isDoorbellDevice(device)
        && device.channel !== null
        && device.adminUserId !== null
        && ppcsStreamRoute(device, this.#devices)?.homeBaseAttached === true
        && isPpcsRouteReady(device, this.#devices, dskPeerSerials),
      autoNightVisionEnabled: isAutoNightVisionDoorbell(device) && device.reads.autoNightVisionEnabled !== undefined
        ? device.reads.autoNightVisionEnabled
        : null,
      autoNightVisionControlSupported: device.reads.autoNightVisionEnabled !== undefined
        && isAutoNightVisionDoorbell(device)
        && device.channel !== null
        && device.adminUserId !== null
        && ppcsStreamRoute(device, this.#devices)?.homeBaseAttached === true
        && isPpcsRouteReady(device, this.#devices, dskPeerSerials),
      timedLightControlSupported: supportsTimedCameraLight(device)
        && ppcsStreamRoute(device, this.#devices)?.homeBaseAttached === false
        && device.channel !== null
        && isPpcsRouteReady(device, this.#devices, dskPeerSerials),
      cameraSirenControlSupported: device.paramTypes.includes(1015)
        && device.channel !== null
        && device.adminUserId !== null
        && isPpcsRouteReady(device, this.#devices, dskPeerSerials),
      battery: batteryState(device),
    };
  }

  /** Send the verified momentary wall-light command over a ready direct route. */
  setCameraLight(serial: string, enabled: boolean): Promise<void> {
    const previous = this.#lightOperations.get(serial) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const device = this.#devices.get(serial);
      if (!device || !isSupportedMegaCamera(device) || !supportsTimedCameraLight(device)) {
        throw new Error("Timed camera light control is not supported for this camera");
      }
      const route = ppcsStreamRoute(device, this.#devices);
      const peer = route?.peer;
      const dsk = peer ? await this.#dskKey(peer.serial) : null;
      if (route?.homeBaseAttached !== false || !peer?.p2pDid || !peer.p2pConnection || !dsk || device.channel === null) {
        throw new Error("Timed camera light control requires a ready standalone route");
      }
      const session = new FirstPartyPpcsSession({
        stationSerial: peer.serial,
        p2pDid: peer.p2pDid,
        appConnection: peer.p2pConnection,
        localAddress: peer.localAddress,
        dskKey: dsk.key,
        channel: device.channel,
        cameraModel: device.model,
        accountId: device.adminUserId,
        homeBaseAttached: false,
        purpose: "control",
        maxSeconds: 30,
      });
      try {
        await session.start();
        await session.writeTimedCameraLight(enabled);
      } finally {
        session.close();
      }
    }).catch((error: unknown) => {
      logger.warn("camera_light_failed", `Timed camera light command failed: error=${safeError(error)}`);
      throw error;
    });
    this.#lightOperations.set(serial, current);
    void current.finally(() => {
      if (this.#lightOperations.get(serial) === current) this.#lightOperations.delete(serial);
    }).catch(() => undefined);
    return current;
  }

  /** Trigger or stop the camera siren when inventory reports its EAS capability. */
  async setCameraSiren(serial: string, durationSeconds: number): Promise<void> {
    if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 900) {
      throw new Error("Camera siren duration must be a whole number from 0 to 900 seconds");
    }
    const device = this.#devices.get(serial);
    if (!device || !isSupportedMegaCamera(device) || !device.paramTypes.includes(1015)) {
      throw new Error("Camera siren control is not supported for this camera");
    }
    const route = ppcsStreamRoute(device, this.#devices);
    const peer = route?.peer;
    const dsk = peer ? await this.#dskKey(peer.serial) : null;
    if (!route?.homeBaseAttached || !peer?.p2pDid || !peer.p2pConnection || !dsk || device.channel === null || !device.adminUserId) {
      throw new Error("Camera siren control requires a ready HomeBase-attached camera route");
    }
    const session = new FirstPartyPpcsSession({
      stationSerial: peer.serial, p2pDid: peer.p2pDid, appConnection: peer.p2pConnection,
      localAddress: peer.localAddress,
      dskKey: dsk.key, channel: device.channel, cameraModel: device.model,
      accountId: device.adminUserId, homeBaseAttached: true, purpose: "control", maxSeconds: 30,
      resolveCipherKey: (cipherId: number) => this.#resolveCipherKey(cipherId, peer),
    });
    try {
      await session.start();
      await session.writeCameraSiren(durationSeconds);
    } finally {
      session.close();
    }
  }

  /** Trigger or stop a HomeBase siren through the station-side duration command. */
  async setHomeBaseSiren(serial: string, durationSeconds: number): Promise<HomeBaseState> {
    if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 900) {
      throw new Error("HomeBase siren duration must be a whole number from 0 to 900 seconds");
    }
    return this.#queueStationOperation(serial, true, async (session) => {
      await session.setSiren(durationSeconds);
      return session.readState(false);
    }, "discovered");
  }

  #recordStationRefreshFailure(serial: string, error: unknown): void {
    const failures = (this.#stationRefreshFailures.get(serial) ?? 0) + 1;
    this.#stationRefreshFailures.set(serial, failures);
    if (failures === 1 || failures % 15 === 0) {
      logger.warn("station_refresh_unavailable", `HomeBase state refresh unavailable: failures=${failures} error=${safeError(error)}`);
    }
  }

  #recordStationRefreshSuccess(serial: string): void {
    const failures = this.#stationRefreshFailures.get(serial) ?? 0;
    this.#stationRefreshFailures.delete(serial);
    if (failures > 0) logger.info("station_refresh_recovered", `HomeBase state refresh recovered after failures=${failures}`);
  }

  #handlePush(events: ProviderEvents, event: MegaPushEvent): void {
    const station = this.#stations.get(event.stationSerial);
    const stationIdentity = this.#devices.get(event.stationSerial);
    if (station?.guardModeControlSupported && event.eventType === 9) {
      const updated = {
        ...station,
        guardMode: validGuardMode(event.guardMode) ? event.guardMode : station.guardMode,
        effectiveMode: validGuardMode(event.effectiveMode) ? event.effectiveMode : station.effectiveMode,
      };
      this.#stations.set(station.serial, updated);
      events.station(updated);
    } else if (station?.controlsSupported && event.eventType === 10 && event.alarmType !== null) {
      const updated = { ...station, alarmActive: ![0, 1, 15, 16, 17].includes(event.alarmType) };
      this.#stations.set(station.serial, updated);
      events.station(updated);
    }
    const personName = personNameFromPush(event);
    events.pushDiagnostic({
      receivedAt: new Date().toISOString(),
      cameraSerial: event.cameraSerial,
      cameraName: event.cameraName,
      type: null,
      eventType: event.eventType,
      messageType: event.messageType,
      notificationStyle: event.notificationStyle,
      personName,
      hasPersonName: personName !== null,
      hasPictureUrl: event.pictureUrl !== null,
      hasFilePath: event.filePath !== null,
      hasFetchId: event.fetchId !== null,
      hasSenseId: event.senseId !== null,
    });
    logger.info(
      "push_received",
      safePushLogSummary(
        event,
        this.#devices.get(event.cameraSerial) ?? null,
        stationIdentity !== undefined && !stationIdentity.parentSerial,
        station !== undefined,
      ),
    );
    const device = this.#devices.get(event.cameraSerial);
    if (!device) return;
    const delivery = this.#pushDeduplicator.observe(event.cameraSerial, event.eventId, event.pictureUrl !== null);
    if (delivery.retainPicture && isSupportedMegaCamera(device)) this.#queuePushSnapshot(events, event);
    if (!delivery.handleState) return;
    if ((device.deviceType === 2 || device.deviceType === 126) && event.eventType === 3 && event.sensorOpen !== null) {
      events.sensorContact(event.cameraSerial, event.sensorOpen);
      return;
    }
    if ((device.deviceType === 10 || device.deviceType === 127) && event.eventType === 14) {
      this.#pendingSensorMotionCloudConfirmations.add(event.cameraSerial);
      events.sensorMotion(event.cameraSerial, true);
      return;
    }
    if (event.eventType === 3103 && isDoorbellDevice(device)) {
      events.doorbell(event.cameraSerial, true);
      return;
    }
    const detection = cameraDetectionKind(event.eventType);
    if (!detection) return;
    if (detection === "motion") {
      // Older HomeBase camera notifications use the generic security event.
      // A fetch id or structured AI result supplies the classification hidden
      // by that generic code. Motion remains true for every generic security
      // event, including those without more specific AI evidence.
      const kinds = event.eventType === 1 ? genericSecurityDetectionKinds(event) : ["motion"] as const;
      for (const kind of kinds) {
        if (kind === "motion") events.motion(event.cameraSerial, true);
        else if (kind === "person") events.person(event.cameraSerial, true, personName);
        else events.detection(event.cameraSerial, kind, true);
      }
    } else if (detection === "person") events.person(event.cameraSerial, true, personName);
    else events.detection(event.cameraSerial, detection, true);
  }

  async #writeStationValue(
    serial: string,
    field: "guardMode" | "alarmVolume" | "promptVolume" | "alarmTone",
    expected: number,
    write: (session: HomeBasePpcsSession) => Promise<void>,
    access: StationAccess = "managed",
  ): Promise<HomeBaseState> {
    try {
      return await this.#queueStationOperation(serial, true, async (session) => {
        const result = await confirmStationWrite(
          field,
          expected,
          () => write(session),
          () => session.readState(false),
        );
        if (result.acknowledgementTimedOut) {
          logger.warn(
            "station_command_acknowledgement_missing",
            `HomeBase command was confirmed by readback after its acknowledgement timed out: command=${field}`,
          );
        }
        return result.observed;
      }, access);
    } catch (error) {
      logger.warn(
        "station_command_failed",
        `HomeBase station command failed: command=${field} error=${safeError(error)}`,
      );
      throw error;
    }
  }

  #queueStationOperation(
    serial: string,
    interruptMedia: boolean,
    operation: (session: HomeBasePpcsSession) => Promise<HomeBasePpcsState>,
    access: StationAccess = "managed",
  ): Promise<HomeBaseState> {
    const previous = this.#stationOperations.get(serial) ?? Promise.resolve(this.#requireStation(serial));
    const current = previous.catch(() => this.#requireStation(serial)).then(async () => {
      const identity = this.#devices.get(serial);
      const accessSupported = identity && (
        access === "managed" ? isHomeBase3(identity)
          : access === "guard-mode" ? supportsHomeBaseGuardMode(identity)
            : isDiscoveredHomeBase(identity)
      );
      if (!identity || !accessSupported || !identity.p2pDid || !identity.adminUserId) {
        throw new Error("HomeBase local command identity is unavailable");
      }
      if (interruptMedia) await this.#stopStationMedia(serial);
      else if (this.#stationHasActiveMedia(serial)) return this.#requireStation(serial);
      const session = new HomeBasePpcsSession({
        serial,
        p2pDid: identity.p2pDid,
        accountId: identity.adminUserId,
        userName: identity.userName ?? "Home Assistant",
        localAddress: identity.localAddress,
      });
      try {
        await session.connect();
        const observed = await operation(session);
        this.#applyHomeBaseChildParams(serial, observed.childParams);
        if (observed.storageDiagnostic && !this.#stationStorageDiagnosticLogged.has(serial)) {
          this.#stationStorageDiagnosticLogged.add(serial);
          logger.info(
            "homebase_storage_observed",
            homeBaseStorageLogSummary(identity.model, observed.storageDiagnostic, observed.storage?.hdd ?? null),
          );
        }
        const updated = mergeHomeBaseState(this.#requireStation(serial), observed);
        this.#stations.set(serial, updated);
        this.#events?.station(updated);
        return updated;
      } catch (error) {
        const updated = { ...this.#requireStation(serial), connected: false };
        this.#stations.set(serial, updated);
        this.#events?.station(updated);
        throw error;
      } finally {
        session.close();
      }
    });
    this.#stationOperations.set(serial, current);
    void current.finally(() => {
      if (this.#stationOperations.get(serial) === current) this.#stationOperations.delete(serial);
    }).catch(() => undefined);
    return current;
  }

  #applyHomeBaseChildParams(stationSerial: string, params: readonly HomeBaseChildParam[]): void {
    const byChannel = new Map<number, HomeBaseChildParam[]>();
    for (const param of params) {
      const rows = byChannel.get(param.channel) ?? [];
      rows.push(param);
      byChannel.set(param.channel, rows);
    }
    for (const device of this.#devices.values()) {
      if (device.parentSerial !== stationSerial || device.channel === null) continue;
      const rows = byChannel.get(device.channel);
      if (!rows) {
        this.#liveDeviceReads.delete(device.serial);
        this.#liveDeviceParamTypes.delete(device.serial);
        continue;
      }
      const reads = safeInventoryReads(
        rows.map(({ type, value }) => ({ param_type: type, param_value: value })),
        device.deviceType,
      );
      const paramTypes = [...new Set(rows.map(({ type }) => type))].sort((left, right) => left - right);
      const previous = this.#liveDeviceReads.get(device.serial);
      this.#liveDeviceReads.set(device.serial, reads);
      this.#liveDeviceParamTypes.set(device.serial, paramTypes);
      const merged = {
        ...device,
        paramTypes: [...new Set([...device.paramTypes, ...paramTypes])].sort((left, right) => left - right),
        reads: { ...device.reads, ...reads },
      };
      this.#devices.set(device.serial, merged);
      if (previous?.batteryLevel !== reads.batteryLevel && reads.batteryLevel !== undefined) {
        logger.info(
          "camera_live_battery_observed",
          [
            `model=${JSON.stringify(device.model)}`,
            `channel=${device.channel}`,
            `cloud_level=${device.reads.batteryLevel ?? "missing"}`,
            `live_level=${reads.batteryLevel}`,
          ].join(" "),
        );
      }
      if (isSupportedMegaCamera(merged)) this.#events?.camera(this.#cameraIdentity(merged));
    }
  }

  #requireStation(serial: string): HomeBaseState {
    const station = this.#stations.get(serial);
    if (!station) throw new Error(`Unknown HomeBase: ${serial}`);
    return station;
  }

  #stationHasActiveMedia(stationSerial: string): boolean {
    return [...this.#ppcsStreams.keys()].some((serial) => this.#devices.get(serial)?.parentSerial === stationSerial);
  }

  async #stopStationMedia(stationSerial: string): Promise<void> {
    const serials = [...this.#ppcsStreams.keys()].filter((serial) => this.#devices.get(serial)?.parentSerial === stationSerial);
    await Promise.all(serials.map((serial) => this.stopStream(serial)));
  }

  #queuePushSnapshot(events: ProviderEvents, event: MegaPushEvent): void {
    const previous = this.#pushSnapshotQueues.get(event.cameraSerial) ?? Promise.resolve();
    const current = previous.then(async () => {
      const picture = await downloadPushSnapshot(this.#client, event, this.#devices);
      if (picture) {
        events.snapshot(event.cameraSerial, picture.data, "image/jpeg");
        logger.info("push_snapshot_updated", "Eufy push snapshot retained");
      }
    }).catch((error: unknown) => {
      logger.warn("push_snapshot_unavailable", `Eufy push snapshot unavailable: ${safeError(error)}`);
    });
    this.#pushSnapshotQueues.set(event.cameraSerial, current);
    void current.finally(() => {
      if (this.#pushSnapshotQueues.get(event.cameraSerial) === current) this.#pushSnapshotQueues.delete(event.cameraSerial);
    });
  }
}

/** Download and decode the image referenced by one normalized push event. */
export async function downloadPushSnapshot(
  client: Pick<MegaClient, "download">,
  event: Pick<MegaPushEvent, "pictureUrl" | "stationSerial">,
  devices: ReadonlyMap<string, Pick<MegaInventoryDevice, "p2pDid">>,
): Promise<{ data: Buffer } | null> {
  if (!event.pictureUrl) return null;
  const encoded = await client.download(event.pictureUrl);
  if (isJpeg(encoded)) return { data: encoded };
  const p2pDid = devices.get(event.stationSerial)?.p2pDid;
  if (!p2pDid) throw new Error("event image cannot be decoded without its HomeBase identity");
  const decoded = decodeEventImage(encoded, p2pDid);
  if (!isJpeg(decoded)) throw new Error("event image is not a valid JPEG");
  return { data: decoded };
}

/** Parse and normalize the untrusted device list returned by Mega. */
export function parseMegaInventory(response: unknown): MegaInventoryDevice[] {
  if (!isRecord(response) || !Array.isArray(response.devices)) return [];
  const devices: MegaInventoryDevice[] = [];
  const seen = new Set<string>();
  for (const value of response.devices) {
    if (!isRecord(value)) continue;
    const serial = safeValue(value.device_sn, 128);
    if (!serial || seen.has(serial)) continue;
    seen.add(serial);
    const model = safeValue(value.device_model, 100) ?? "Unknown Eufy device";
    const deviceType = integer(value.device_type);
    const reads = safeInventoryReads(value.params, deviceType);
    const lastChargingDays = safeLastChargingDays(value.charging_days);
    devices.push({
      serial,
      name: safeValue(value.device_name, 100) ?? model,
      model,
      parentSerial: safeValue(value.parent_sn, 128) ?? safeValue(value.station_sn, 128) ?? "",
      deviceType,
      category: safeValue(value.category, 100),
      channel: integer(value.device_channel) ?? integer(value.channel),
      p2pDid: safeValue(value.p2p_did, 128),
      p2pConnection: safeValue(value.p2p_conn, 512) ?? safeValue(value.app_conn, 512),
      localAddress: freshestLanAddress(value),
      cipherId: integer(value.cipher_id),
      adminUserId: isRecord(value.member) ? safeValue(value.member.admin_user_id, 128) : null,
      userName: isRecord(value.member) ? safeValue(value.member.nick_name, 128) : null,
      firmware: safeValue(value.main_sw_version, 100),
      paramTypes: safeParamTypes(value.params),
      reads: lastChargingDays === undefined ? reads : { ...reads, lastChargingDays },
    });
  }
  const adminUserIds = new Map(
    devices.filter((device) => device.adminUserId).map((device) => [device.serial, device.adminUserId!]),
  );
  return devices.map((device) => device.adminUserId || !device.parentSerial
    ? device
    : { ...device, adminUserId: adminUserIds.get(device.parentSerial) ?? null });
}

function safeLastChargingDays(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= 0 && parsed <= 36_500
    ? parsed
    : undefined;
}

function freshestLanAddress(value: Record<string, unknown>): string | null {
  let freshest: { readonly address: string; readonly updatedAt: number } | null = null;
  if (Array.isArray(value.params)) {
    for (const raw of value.params) {
      if (!isRecord(raw)) continue;
      const address = safeValue(raw.param_value, 45);
      if (!address || !isPrivateIpv4(address)) continue;
      const updatedAt = finiteNumber(raw.update_time) ?? 0;
      if (!freshest || updatedAt > freshest.updatedAt) freshest = { address, updatedAt };
    }
  }
  if (freshest) return freshest.address;
  for (const raw of [value.local_ip, value.ip_addr]) {
    const address = safeValue(raw, 45);
    if (address && isPrivateIpv4(address)) return address;
  }
  return null;
}

function isPrivateIpv4(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

/** Decode only capability-backed numeric inventory reads; arbitrary values are discarded. */
export function safeInventoryReads(value: unknown, deviceType: number | null = null): MegaInventoryReads {
  if (!Array.isArray(value)) return {};
  const params = new Map<number, unknown>();
  for (const row of value) {
    if (!isRecord(row)) continue;
    const type = integer(row.param_type);
    if (type !== null) params.set(type, row.param_value);
  }
  const percentage = (type: number): number | undefined => {
    const parsed = finiteNumber(params.get(type));
    return parsed !== null && parsed >= 0 && parsed <= 100 ? parsed : undefined;
  };
  const temperature = finiteNumber(params.get(1138));
  const batteryStatus = finiteNumber(params.get(2111));
  const contact = finiteNumber(params.get(1550));
  const contactLastSeen = validUnixSeconds(params.get(1551));
  const motionEventSeconds = deviceType === 10 || deviceType === 127
    ? validUnixSeconds(params.get(1605))
    : undefined;
  const lastSeen = contactLastSeen ?? motionEventSeconds;
  const batteryLevel = percentage(1101);
  const batteryHealth = percentage(1198);
  const openDevice = finiteNumber(params.get(2001));
  const cameraSwitch = finiteNumber(params.get(1035));
  const motionSwitch = finiteNumber(params.get(1011));
  const autoNightVision = finiteNumber(params.get(1013));
  const nightVisionMode = finiteNumber(params.get(1277));
  const enabled = openDevice === 0 || openDevice === 1
    ? openDevice === 1
    : cameraSwitch === 0 || cameraSwitch === 1
      ? cameraSwitch === cameraEnableRawValue(deviceType, true)
      : undefined;
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(motionSwitch === 0 || motionSwitch === 1 ? { motionDetectionEnabled: motionSwitch === 1 } : {}),
    ...(autoNightVision === 0 || autoNightVision === 1 ? { autoNightVisionEnabled: autoNightVision === 1 } : {}),
    ...(nightVisionMode === 0 || nightVisionMode === 1 || nightVisionMode === 2 ? { nightVisionMode } : {}),
    ...(batteryLevel !== undefined ? { batteryLevel } : {}),
    ...(batteryStatus !== null ? { batteryCharging: batteryStatus !== 0 && batteryStatus !== 2 } : {}),
    ...(batteryHealth !== undefined ? { batteryHealth } : {}),
    ...(temperature !== null && temperature >= -50 && temperature <= 100 ? { batteryTemperature: temperature } : {}),
    ...(contact === 0 || contact === 1 ? { contactOpen: contact === 1 } : {}),
    ...(lastSeen !== undefined
      ? { lastSeen: new Date(lastSeen * 1_000).toISOString() }
      : {}),
    ...(motionEventSeconds !== undefined ? { motionEventSeconds } : {}),
  };
}

/**
 * Decide whether a cloud PIR timestamp is a new fallback event or confirms a push already emitted.
 *
 * The first observed timestamp establishes a baseline unless a push is waiting for confirmation.
 * Equal or older values never replay historical motion after startup or a cloud rollback.
 */
export function inventoryMotionOutcome(
  previous: number | undefined,
  current: number | undefined,
  pushPending: boolean,
): "none" | "push-confirmed" | "cloud-motion" {
  if (current === undefined) return "none";
  if (previous === undefined) return pushPending ? "push-confirmed" : "none";
  if (current <= previous) return "none";
  return pushPending ? "push-confirmed" : "cloud-motion";
}

/** Resolve the family-specific raw 1035 value for a desired camera state. */
export function cameraEnableRawValue(deviceType: number | null, enabled: boolean): number {
  const directPolarity = deviceType === 31;
  return directPolarity ? (enabled ? 1 : 0) : enabled ? 0 : 1;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^-?\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validUnixSeconds(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 946_684_800 && parsed <= Date.now() / 1_000 + 86_400
    ? parsed
    : undefined;
}

/**
 * Confirm one non-retried HomeBase write, using readback after an ambiguous timeout.
 *
 * A T8030 can apply a command even when its result frame does not reach the
 * gateway. Only that timeout is recoverable: explicit rejection still fails,
 * while a matching fresh read proves the requested state without resending.
 */
export async function confirmStationWrite(
  field: "guardMode" | "alarmVolume" | "promptVolume" | "alarmTone",
  expected: number,
  write: () => Promise<void>,
  read: () => Promise<HomeBasePpcsState>,
): Promise<{ readonly observed: HomeBasePpcsState; readonly acknowledgementTimedOut: boolean }> {
  let acknowledgementTimedOut = false;
  try {
    await write();
  } catch (error) {
    if (!(error instanceof HomeBaseCommandAcknowledgementTimeoutError)) throw error;
    acknowledgementTimedOut = true;
  }

  let observed: HomeBasePpcsState;
  try {
    observed = await read();
  } catch (error) {
    if (!acknowledgementTimedOut) throw error;
    throw new Error(`HomeBase command acknowledgement timed out; readback failed: ${safeError(error)}`);
  }
  if (observed[field] !== expected) {
    const prefix = acknowledgementTimedOut
      ? "HomeBase command acknowledgement timed out and readback did not confirm"
      : "HomeBase did not confirm";
    throw new Error(`${prefix} ${field}`);
  }
  return { observed, acknowledgementTimedOut };
}

function batteryState(device: MegaInventoryDevice): BatteryState | null {
  if (!device.paramTypes.includes(1101) || hasMainsBatterySentinel(device.model)) return null;
  const supported: BatteryState["supported"] = [
    "level",
    ...(device.paramTypes.includes(2111) ? ["charging" as const] : []),
    ...(device.paramTypes.includes(1198) ? ["health" as const] : []),
    ...(device.paramTypes.includes(1138) ? ["temperature" as const] : []),
    ...(device.reads.lastChargingDays !== undefined ? ["lastChargingDays" as const] : []),
  ];
  return {
    supported,
    level: device.reads.batteryLevel ?? null,
    charging: device.reads.batteryCharging ?? null,
    health: device.reads.batteryHealth ?? null,
    temperature: device.reads.batteryTemperature ?? null,
    lastChargingDays: device.reads.lastChargingDays ?? null,
  };
}

function securitySensorState(device: MegaInventoryDevice): SecuritySensorState | null {
  const contact = device.paramTypes.includes(1550);
  const motion = device.deviceType === 10 || device.deviceType === 127;
  const battery = device.paramTypes.includes(1101);
  const lastSeen = device.paramTypes.includes(1551)
    || (motion && device.paramTypes.includes(1605));
  if (!contact && !motion && !battery && !lastSeen) return null;
  if (![2, 10, 20, 21, 22, 123, 126, 127].includes(device.deviceType ?? -1)) return null;
  return {
    serial: device.serial,
    name: device.name,
    model: device.model,
    deviceType: device.deviceType!,
    available: true,
    capabilities: [
      ...(battery ? ["battery" as const] : []),
      ...(contact ? ["contact" as const] : []),
      ...(lastSeen ? ["lastSeen" as const] : []),
      ...(motion ? ["motion" as const] : []),
    ],
    batteryLevel: device.reads.batteryLevel ?? null,
    contactOpen: device.reads.contactOpen ?? null,
    lastSeen: device.reads.lastSeen ?? null,
    motionDetected: false,
  };
}

/** Return whether normalized inventory identifies the supported HomeBase 3. */
export function isHomeBase3(device: Pick<MegaInventoryDevice, "category" | "deviceType" | "model">): boolean {
  return device.category === "eufy_security" && device.deviceType === 18 && device.model.startsWith("T8030");
}

/** Return whether inventory identifies a HomeBase model safe for read-only discovery. */
export function isDiscoveredHomeBase(
  device: Pick<MegaInventoryDevice, "category" | "deviceType" | "model">,
): boolean {
  return device.category === "eufy_security"
    && (isHomeBase3(device) || (device.deviceType === 0 && device.model.startsWith("T8010")));
}

/** Return whether inventory proves support for the wrapped guard-mode command. */
export function supportsHomeBaseGuardMode(
  device: Pick<MegaInventoryDevice, "category" | "deviceType" | "model" | "firmware">,
): boolean {
  if (isHomeBase3(device)) return true;
  if (!isDiscoveredHomeBase(device) || !device.firmware) return false;
  return compareFirmware(device.firmware, [2, 0, 7, 9]) >= 0;
}

/** Build inventory-owned station state without inferring an unverified command protocol. */
export function initialHomeBaseState(device: MegaInventoryDevice, dskReady: boolean): HomeBaseState {
  const controlsSupported = isHomeBase3(device);
  return {
    serial: device.serial,
    name: device.name,
    model: device.model,
    firmware: device.firmware,
    available: true,
    cameraRouteReady: Boolean(device.p2pDid && device.p2pConnection && dskReady),
    controlsSupported,
    guardModeControlSupported: supportsHomeBaseGuardMode(device),
    stateReadSupported: controlsSupported,
    homeBaseSirenControlSupported: isDiscoveredHomeBase(device),
    connected: false,
    guardMode: null,
    effectiveMode: null,
    alarmActive: null,
    alarmVolume: null,
    promptVolume: null,
    alarmTone: null,
    storage: { emmc: null, hdd: null },
  };
}

function mergeHomeBaseState(existing: HomeBaseState, observed: HomeBasePpcsState): HomeBaseState {
  return {
    ...existing,
    firmware: observed.firmware ?? existing.firmware,
    stateReadSupported: true,
    connected: true,
    guardMode: observed.guardMode,
    effectiveMode: observed.effectiveMode,
    alarmVolume: observed.alarmVolume,
    promptVolume: observed.promptVolume,
    alarmTone: observed.alarmTone,
    storage: observed.storage ?? existing.storage,
  };
}

/** Format one bounded HDD field inventory without exposing raw text values. */
export function homeBaseStorageLogSummary(
  model: string,
  diagnostic: HomeBaseStorageDiagnostic,
  normalized: HomeBaseState["storage"]["hdd"],
): string {
  const fields = (values: readonly string[]): string => values.length > 0 ? values.join(",") : "none";
  return [
    `HomeBase storage observed: model=${model}`,
    `hdd_present=${diagnostic.present}`,
    `calculated_total_bytes=${normalized?.totalBytes ?? "missing"}`,
    `calculated_free_bytes=${normalized?.freeBytes ?? "missing"}`,
    `hdd_numeric=${fields(diagnostic.numericFields)}`,
    `hdd_boolean=${fields(diagnostic.booleanFields)}`,
    `hdd_text_lengths=${fields(diagnostic.textFieldLengths)}`,
    `hdd_structured=${fields(diagnostic.structuredFields)}`,
  ].join(" ");
}

function validGuardMode(value: number | null): value is number {
  return value !== null && [0, 1, 2, 3, 4, 5, 47, 63].includes(value);
}

type StationAccess = "discovered" | "guard-mode" | "managed";

function compareFirmware(value: string, minimum: readonly number[]): number {
  const parts = value.match(/\d+/g)?.slice(0, minimum.length).map(Number) ?? [];
  if (parts.length < minimum.length) return -1;
  for (let index = 0; index < minimum.length; index++) {
    const difference = parts[index]! - minimum[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Explain camera filtering decisions without exposing raw cloud payloads. */
export function inventoryDiagnostics(devices: readonly MegaInventoryDevice[]): InventoryDiagnostic[] {
  return devices.map((device) => ({
    serial: device.serial,
    name: device.name,
    model: device.model,
    sources: ["mega"],
    upstreamIsCamera: false,
    acceptedAsCamera: isSupportedMegaCamera(device),
    megaDeviceType: device.deviceType,
    category: device.category,
  }));
}

/**
 * Group inventory classifications without exposing names or device serials.
 *
 * @param devices Normalized Mega inventory rows.
 * @param dskStationSerials Stations whose short-lived PPCS key was retrieved.
 * @returns Groups that explain camera acceptance and live-stream readiness.
 */
export function inventoryLogSummaries(
  devices: readonly MegaInventoryDevice[],
  dskStationSerials: ReadonlySet<string>,
): InventoryLogSummary[] {
  const bySerial = new Map(devices.map((device) => [device.serial, device]));
  const groups = new Map<string, InventoryLogSummary>();
  for (const device of devices) {
    const station = device.parentSerial ? bySerial.get(device.parentSerial) : undefined;
    const route = isSupportedMegaCamera(device) ? ppcsStreamRoute(device, bySerial) : null;
    const peer = route?.peer;
    const streamRoute: InventoryLogSummary["streamRoute"] = route
      ? route.homeBaseAttached ? "homebase" : "direct"
      : "unavailable";
    const values = {
      model: device.model,
      deviceType: device.deviceType,
      category: device.category,
      hasParent: device.parentSerial.length > 0,
      hasChannel: device.channel !== null,
      acceptedAsCamera: isSupportedMegaCamera(device),
      stationPresent: station !== undefined,
      stationPpcsReady: Boolean(station?.p2pDid && station.p2pConnection),
      stationDskReady: Boolean(station && dskStationSerials.has(station.serial)),
      streamRoute,
      peerPpcsReady: Boolean(peer?.p2pDid && peer.p2pConnection),
      peerDskReady: Boolean(peer && dskStationSerials.has(peer.serial)),
      streamSupported: isPpcsStreamSupported(device, bySerial, dskStationSerials),
    };
    const key = JSON.stringify(values);
    const existing = groups.get(key);
    groups.set(key, { count: (existing?.count ?? 0) + 1, ...values });
  }
  return [...groups.values()];
}

/** Return whether Mega metadata identifies a device as a supported camera. */
export function isSupportedMegaCamera(device: Pick<MegaInventoryDevice, "category" | "deviceType">): boolean {
  return isSupportedCameraType(device);
}

/** Retain only bounded numeric parameter IDs, never provider values or blobs. */
export function safeParamTypes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const types = new Set<number>();
  for (const row of value.slice(0, 512)) {
    if (!isRecord(row)) continue;
    const rawType = row.param_type;
    const type = typeof rawType === "number" && Number.isSafeInteger(rawType) ? rawType
      : typeof rawType === "string" && /^\d{1,5}$/.test(rawType) ? Number(rawType) : null;
    if (type !== null && type >= 0 && type <= 65_535) types.add(type);
  }
  return [...types].sort((left, right) => left - right);
}

/**
 * Identify the peer that provides PPCS connectivity for one camera.
 *
 * A HomeBase child uses its parent station. A parentless row or a row that
 * names itself as its station is a standalone camera and owns its own peer
 * connection. A missing non-self parent remains unavailable rather than being
 * guessed as a direct camera.
 */
export function ppcsStreamRoute(
  device: MegaInventoryDevice,
  devicesBySerial: ReadonlyMap<string, MegaInventoryDevice>,
): PpcsStreamRoute | null {
  const route = resolveDeviceRoute(device, devicesBySerial);
  return route ? { peer: route.peer, homeBaseAttached: route.homeBaseAttached } : null;
}

/** Return whether the selected PPCS peer has every prerequisite to stream. */
export function isPpcsStreamSupported(
  device: MegaInventoryDevice,
  devicesBySerial: ReadonlyMap<string, MegaInventoryDevice>,
  dskPeerSerials: ReadonlySet<string>,
): boolean {
  return isSupportedMegaCamera(device) && isPpcsRouteReady(device, devicesBySerial, dskPeerSerials);
}

/** Check peer transport prerequisites without treating the row as a camera. */
export function isPpcsRouteReady(
  device: MegaInventoryDevice,
  devicesBySerial: ReadonlyMap<string, MegaInventoryDevice>,
  dskPeerSerials: ReadonlySet<string>,
): boolean {
  const route = ppcsStreamRoute(device, devicesBySerial);
  return Boolean(
    route?.peer.p2pDid
    && route.peer.p2pConnection
    && device.channel !== null
    && dskPeerSerials.has(route.peer.serial),
  );
}

/** Build a privacy-safe PPCS outcome summary without peer identities or packet data. */
export function ppcsStreamLogSummary(
  model: string,
  route: PpcsStreamRoute | null,
  stats: Pick<FirstPartyPpcsSession["stats"], "camId" | "dataDatagrams" | "frameHeaders" | "videoFrames"> & Partial<Pick<FirstPartyPpcsSession["stats"], "alternateLookupCandidates" | "batteryHistory" | "closeReason" | "commands" | "directLookupCandidates" | "duplicateDatagrams" | "foreignVideoFrames" | "frameShapes" | "incompleteAccessUnitBytes" | "incompleteAccessUnits" | "localLookupCandidates" | "mediaStartAttempts" | "mediaStopAttempts" | "mediaStopProtocol" | "parserBlocked" | "parserResyncs" | "pendingBytes" | "sequenceGaps" | "sequenceRestarts" | "staleDatagrams" | "types" | "videoCodec" | "videoNalTypes" | "videoOutputFrames" | "videoResults">>,
  error?: unknown,
): string {
  const stage = stats.camId === 0 ? "lookup" : stats.videoFrames === 0 ? "first_frame" : "media";
  const nalTypes = stats.videoNalTypes ?? [];
  const codec = stats.videoCodec ?? "unknown";
  const codecBootstrap = codec === "h265"
    ? nalTypes.includes(32) && nalTypes.includes(33) && nalTypes.includes(34)
      ? "ready"
      : "incomplete"
    : codec === "h264"
      ? nalTypes.includes(7) && nalTypes.includes(8)
        ? "ready"
        : nalTypes.includes(7) ? "missing-pps" : "missing-sps"
      : "unknown";
  return [
    `model=${safeLogModel(model)}`,
    `route=${route ? route.homeBaseAttached ? "homebase" : "direct" : "unavailable"}`,
    `stage=${stage}`,
    `cam_id=${stats.camId}`,
    `local_lookup_candidates=${stats.localLookupCandidates ?? 0}`,
    `direct_lookup_candidates=${stats.directLookupCandidates ?? 0}`,
    `alternate_lookup_candidates=${stats.alternateLookupCandidates ?? 0}`,
    `data_datagrams=${stats.dataDatagrams}`,
    `frame_headers=${stats.frameHeaders}`,
    `video_frames=${stats.videoFrames}`,
    `video_output_frames=${stats.videoOutputFrames ?? 0}`,
    `incomplete_access_units=${stats.incompleteAccessUnits ?? 0}`,
    `incomplete_access_unit_bytes=${stats.incompleteAccessUnitBytes ?? 0}`,
    `foreign_video_frames=${stats.foreignVideoFrames ?? 0}`,
    `data_types=${stats.types?.join(",") || "none"}`,
    `commands=${stats.commands?.join(",") || "none"}`,
    `frame_shapes=${stats.frameShapes?.join(",") || "none"}`,
    `sequence_gaps=${stats.sequenceGaps ?? 0}`,
    `sequence_restarts=${stats.sequenceRestarts ?? 0}`,
    `duplicate_datagrams=${stats.duplicateDatagrams ?? 0}`,
    `stale_datagrams=${stats.staleDatagrams ?? 0}`,
    `parser_resyncs=${stats.parserResyncs ?? 0}`,
    `parser_blocked=${stats.parserBlocked ?? false}`,
    `pending_bytes=${stats.pendingBytes ?? 0}`,
    `video_results=${stats.videoResults?.join(",") || "none"}`,
    `video_codec=${codec}`,
    `video_nal_types=${nalTypes.join(",") || "none"}`,
    `codec_bootstrap=${codecBootstrap}`,
    `decoder_ready=${hasDecoderReadyKeyframe(codec, nalTypes)}`,
    `media_start_attempts=${stats.mediaStartAttempts ?? 0}`,
    `media_stop_attempts=${stats.mediaStopAttempts ?? 0}`,
    `media_stop_protocol=${stats.mediaStopProtocol ?? "none"}`,
    `close_reason=${stats.closeReason ?? "unknown"}`,
    `battery_history=${stats.batteryHistory ?? "not-reported"}`,
    ...(error === undefined ? [] : [`error=${safeError(error)}`]),
  ].join(" ");
}

/**
 * Summarize push routing for copyable logs without private device or event fields.
 *
 * @param stationPresent Whether the station serial matched any Mega inventory row.
 * @param stationManaged Whether the station has a supported local control entity.
 */
export function safePushLogSummary(
  event: Pick<MegaPushEvent, "eventType" | "messageType" | "notificationStyle" | "pictureUrl" | "alarmType">
    & Partial<Pick<MegaPushEvent, "detectionEvidence">>,
  device: Pick<MegaInventoryDevice, "model" | "category" | "deviceType"> | null,
  stationPresent: boolean,
  stationManaged: boolean,
): string {
  const deviceKnown = device !== null;
  const cameraAccepted = device !== null && isSupportedMegaCamera(device);
  let handling = "unhandled";
  if (stationManaged && event.eventType === 9) handling = "station_guard";
  else if (stationManaged && event.eventType === 10 && event.alarmType !== null) handling = "station_alarm";
  else if (cameraAccepted && event.eventType === 3103 && device !== null && isDoorbellDevice(device)) handling = "doorbell_press";
  else if (cameraAccepted && isCameraDetection(event.eventType)) {
    handling = cameraDetectionKind(event.eventType) ?? "unhandled";
  }
  const model = device?.model && /^T[0-9]{3,4}(?:[A-Z]{1,2}|-[A-Z]{1,2})?$/.test(device.model)
    ? device.model
    : "unknown";
  return [
    `model=${model}`,
    `device_known=${deviceKnown}`,
    `camera_accepted=${cameraAccepted}`,
    `station_present=${stationPresent}`,
    `station_managed=${stationManaged}`,
    `event_type=${safePushCode(event.eventType)}`,
    `message_type=${safePushCode(event.messageType)}`,
    `notification_style=${safePushCode(event.notificationStyle)}`,
    `handling=${handling}`,
    `picture_present=${event.pictureUrl !== null}`,
    `ai_evidence=${event.detectionEvidence?.join(",") || "none"}`,
  ].join(" ");
}

function safePushCode(value: number | null): number | "missing" {
  return value !== null && Number.isSafeInteger(value) && value >= 0 && value <= 65_535 ? value : "missing";
}

/**
 * Return motion plus any AI classifications proven by a generic security event.
 *
 * Motion is deliberately the first result for every event type `1`, including
 * events that have no AI evidence. A fetch id is retained as the legacy person
 * signal, while structured evidence can additionally identify other AI
 * meanings supported by the provider. Non-generic event types keep using their
 * explicit numeric mapping and return no fallback classifications.
 */
export function genericSecurityDetectionKinds(
  event: Pick<MegaPushEvent, "eventType" | "fetchId" | "detectionEvidence">,
): readonly Exclude<DetectionKind, "doorbell">[] {
  if (event.eventType !== 1) return [];
  const evidence = new Set<Exclude<DetectionKind, "doorbell">>(["motion", ...event.detectionEvidence]);
  if (event.fetchId !== null) evidence.add("person");
  return [...evidence];
}

/** Extract a recognized name only from push events that represent a person. */
export function personNameFromPush(message: Pick<MegaPushEvent, "eventType" | "personName" | "content">): string | null {
  const structured = safeLabel(message.personName);
  if (structured) return isGenericPersonLabel(structured) ? null : structured;
  if (message.eventType !== 3102 && message.eventType !== 3111) return null;
  const content = message.content?.trim();
  if (!content || content.length > 300) return null;
  const match = /^(?:[^:]{1,100}:\s*)?(.{1,100}?)\s+(?:has been|was)\s+(?:spotted|detected)(?:\b|[.!])/i.exec(content);
  const candidate = safeLabel(match?.[1] ?? null);
  return candidate && !isGenericPersonLabel(candidate) ? candidate : null;
}

function isCameraDetection(eventType: number | null): boolean {
  return cameraDetectionKind(eventType) !== null;
}

/** Map Eufy's confirmed camera push ids into protocol-neutral detection kinds. */
export function cameraDetectionKind(eventType: number | null): "motion" | "person" | "stranger" | "pet" | "vehicle" | "dog" | "crying" | "sound" | "packageStranded" | null {
  if (eventType === 1 || eventType === 3101) return "motion";
  if (eventType === 3102 || eventType === 3111) return "person";
  if (eventType === 3112) return "stranger";
  if (eventType === 3104) return "crying";
  if (eventType === 3105) return "sound";
  if (eventType === 3106) return "pet";
  if (eventType === 3107) return "vehicle";
  if (eventType === 3108 || eventType === 3109 || eventType === 3110) return "dog";
  if (eventType === 3304) return "packageStranded";
  return null;
}

/** Identify supported Mega doorbells that should expose a press sensor. */
export function isDoorbellDevice(device: Pick<MegaInventoryDevice, "deviceType" | "category">): boolean {
  return device.category === "eufy_security" && [5, 7, 91, 94, 96, 203].includes(device.deviceType ?? -1);
}

function isGenericPersonLabel(value: string): boolean {
  return /^(someone|stranger|unknown|unknown person|person)$/i.test(value);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message || error.name : "Unknown error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeLogModel(value: string): string {
  return /^T[0-9A-Z-]{3,12}$/.test(value) ? value : "unknown";
}

function safeValue(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  return candidate.length > 0 && candidate.length <= maxLength ? candidate : null;
}

function safeLabel(value: string | null | undefined): string | null {
  return safeValue(value, 100);
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}
