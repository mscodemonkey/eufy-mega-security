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
 * forwarding private event fields into the logger. Periodic cloud refreshes admit
 * newly added devices without replacing push receivers or active media sessions.
 */
import { nvrLiveProfile, NvrLiveControlError, type NvrLiveControl, type NvrLiveControlResult } from "./nvr-live-controls.js";
import type { NvrLiveSettings } from "../stream/nvr-live-control-protocol.js";
import { InventoryMotionClock, type InventoryMotionOutcome } from "./inventory-motion.js";

import { NvrPowerError, runNvrPowerTrial, type NvrPowerRequest, type NvrPowerSummary } from "./nvr-power-trial.js";
import { NvrGuardError, runNvrGuardTrial, type NvrGuardRequest, type NvrGuardState, type NvrGuardSummary } from "./nvr-guard-trial.js";
import { nvrGuardTimeZone, type NvrGuardEffective } from "./nvr-guard-schedule.js";
import { eventPictureUrl } from "./event-picture-url.js";
import { T85V0StatusError, validT85V0StatusIdentity, type T85V0StatusSummary } from "./t85v0-status.js";
import { LocalMotionCollector, LocalMotionError, type LocalMotionSummary } from "../stream/local-motion-trial.js";
import { C31IndexError, type C31IndexSummary } from "../stream/c31-recording-index.js";
import type { E30LockSettingChange, SmartLockState } from "../domain/types.js";
import { runS100SirenTrial, S100SirenTrialError, type S100SirenFailureStage } from "./s100-siren-trial.js";
import { E30LockProvider } from "./e30-lock-provider.js";
import { E30LockError } from "./e30-lock-protocol.js";
import { NvrRtcSession } from "../stream/nvr-rtc-session.js";
import { NvrTrialError, nvrTrialSensor, type NvrStateSummary } from "../stream/nvr-protocol.js";
import { modelControlTrialActions, parseModelControlTrial, runModelControlTrial, type ModelControlRoute, type ModelControlTrial, type ModelControlTrialResult } from "./model-control-trials.js";
import { join } from "node:path";
import { setTimeout as cancellableDelay } from "node:timers/promises";
import { createHmac, randomBytes } from "node:crypto";
import type { EventImageCapture, EventImageContext } from "../diagnostics/event-image-capture.js";
import { validateRecordingDate, type CameraStoredRecord, type StoredRecordingSummary } from "../stream/stored-recordings.js";

import type { BatteryState, CameraIdentity, CameraPresetPosition, DetectionKind, HomeBaseState, InventoryDiagnostic, NightVisionMode, SecuritySensorState } from "../domain/types.js";
import { createLogger } from "../logging.js";
import type { CloudHistoryQuery, CloudHistoryRecord } from "../mega/cloud-history.js";
import { CloudCalendarError, type CloudCalendarQuery, type CloudCalendarResult } from "../mega/cloud-calendar.js";
import type { MegaInventory } from "../mega/types.js";
import { guardModeCustomNames, guardModeMetadataShape, guardModeMetadataStructure } from "../mega/guard-mode-metadata.js";
import { MegaClient } from "../mega/client.js";
import { decodeEventImage, isJpeg } from "../mega/image.js";
import { parseV8EventImage, decodeV8EventImage } from "../mega/v8-image.js";
import { MegaPushReceiver, type MegaPushEvent } from "../mega/push.js";
import { CloudRecordingError } from "../stream/cloud-recordings.js";
import { DoorbellRtcSession } from "../stream/doorbell-rtc-session.js";
import { DoorbellRtcError } from "../stream/doorbell-rtc-offer.js";
import { CameraControlAcknowledgementTimeoutError, FirstPartyPpcsSession, PpcsLookupTimeoutError, hasDecoderReadyKeyframe } from "../stream/first-party-ppcs.js";
import { HomeBaseCommandAcknowledgementTimeoutError, HomeBasePpcsSession, type HomeBaseChildParam, type HomeBasePpcsState, type HomeBaseStorageDiagnostic } from "../stream/homebase-ppcs.js";
import type { SensorContactObservation } from "../stream/sensor-status-notification.js";
import { cameraCapabilityLogSummaries, describeCameraCapabilities, isSupportedCameraType, describeDeviceCapabilities, deviceCapabilityLogSummaries } from "./device-capabilities-core.js";
import { GeneralRtcTrial, GeneralRtcPinLimiter, type GeneralRtcTrialLease, type GeneralRtcBinding } from "./general-rtc-trial.js";
import { GeneralRtcError } from "../stream/general-rtc-protocol.js";
import { catalogueIntegrationStatus, hasMainsBatterySentinel } from "./camera-capability-core.js";
import type { CameraProvider, CaptchaChallenge, CaptchaProvider, ProviderEvents } from "./provider.js";
import { PushEventDeduplicator } from "./push-event-deduplicator.js";
import { resolveDeviceRoute } from "./device-routing.js";

import { CameraSettingError, cameraSettingProfile, cameraSettingWireValue, parseCameraSettingChange, readCameraSetting, runConfirmedCameraSetting, type CameraSettingChange } from "./camera-settings.js";
import { c31PreferenceNames, c31PreferenceValue, c31PreferenceReadField, validateC31Preference } from "./c31-preferences.js";

/** Classify a fresh cloud motion advance without retaining a sensor baseline. */
export { inventoryMotionOutcome } from "./inventory-motion.js";

const logger = createLogger("provider");
const DSK_REFRESH_SKEW_MILLISECONDS = 60_000;
const STATION_REFRESH_DISCONNECT_FAILURES = 4;

/** Return whether a cached PPCS lookup key should be replaced before another session starts. */
export function dskKeyNeedsRefresh(
  value: { readonly expiresAt: number | null } | null | undefined,
  now = Date.now(),
): boolean {
  return !value || (value.expiresAt !== null && value.expiresAt <= now + DSK_REFRESH_SKEW_MILLISECONDS);
}

/**
 * Keep an established station connection through isolated background read failures.
 *
 * Startup remains disconnected until a read succeeds. Once connected, four
 * consecutive failed refreshes are required before the command channel is
 * reported unavailable.
 */
export function stationConnectedAfterRefreshFailure(
  wasConnected: boolean,
  consecutiveFailures: number,
): boolean {
  return wasConnected && consecutiveFailures < STATION_REFRESH_DISCONNECT_FAILURES;
}

/** Credentials, storage, and transport limits for one Mega account. */
export interface EufyProviderConfig {
  readonly username: string;
  readonly password: string;
  readonly country: string;
  readonly persistentDirectory: string;
  readonly verifyCode?: string;
  readonly maxStreamSeconds: number;

  /** Explicit opt-in for exact official-model control trials, off by default. */
  readonly experimentalModelControls?: boolean;

  /** Explicit E30 MQTT opt-in, independent of camera admission and controls. */
  readonly experimentalE30Locks?: boolean;

  /** Default-off NVR transport admission for private Diagnostics tests. */
  readonly experimentalNvrLive?: boolean;

  /** Independent opt-in for a manually observed NVR camera-power and restore test. */
  readonly experimentalNvrControls?: boolean;

  /** Main-process promotion of hardware-confirmed NVR routes to normal live view. */
  readonly normalNvrLive?: boolean;

  /** Only presence is passed, never the gateway credential itself. */
  readonly apiAuthenticationConfigured?: boolean;

  /** Default-off, media-only native doorbell diagnostic trial. */
  readonly experimentalDoorbellRtc?: boolean;

  /** Default-off owner-account general portal diagnostic clip. */
  readonly experimentalGeneralRtc?: boolean;

  /** Default-off existing cloud recording download, independent of live camera capabilities. */
  readonly experimentalCloudRecordings?: boolean;
  readonly experimentalNvrRegion?: "auto" | "us" | "eu" | "ie";

  /** Optional process-owned evidence collector, closed by the composition root. */
  readonly eventImageCapture?: EventImageCapture;
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

  /** Camera-reported hardware revision, absent in older inventory responses. */
  readonly hardwareVersion?: string | null;

  /** Secondary firmware reported by this device, never inherited from its station. */
  readonly firmwareSubVersion?: string | null;

  /** Explicit cloud update flag. Absent or malformed flags remain unknown. */
  readonly firmwareUpdateAvailable?: boolean | null;

  /** Privacy-safe shape of custom-mode metadata, never the account labels. */
  readonly guardModeMetadataShape?: string;

  /** Document-local aliases preserve nesting without retaining private labels or keys. */
  readonly guardModeMetadataStructure?: string;

  /** Private custom-mode labels retained only for the owner's local Home Assistant UI. */
  readonly guardModeNames?: Readonly<Record<number, string>>;
  readonly paramTypes: readonly number[];
  readonly reads: MegaInventoryReads;
}

/** Allowlisted, validated current values retained from one Mega inventory row. */
export interface MegaInventoryReads {
  readonly ringtoneVolume?: number;
  readonly soundDetectionSensitivity?: number;
  readonly soundDetectionType?: number;

  /** Exact standalone C31 preferences, independent of detection or low-light results. */
  readonly soundRoundLookEnabled?: boolean;
  readonly enhanceLightingEnabled?: boolean;

  /** Exact C31 light setting and notification spacing, unrelated to recording intervals. */
  readonly lightBrightness?: number;
  readonly notificationIntervalMinutes?: number;

  /** Exact C31 publication and continuous recording switches, independent of active consumers. */
  readonly rtspPublicationEnabled?: boolean;
  readonly continuousRecordingEnabled?: boolean;
  readonly streamingQualityTier?: number;
  readonly recordingQualityTier?: number;
  readonly solarIntensity?: number;
  readonly solarConnected24h?: boolean;
  readonly notificationStyle?: number;
  readonly watermarkMode?: number;
  readonly antiTheftDetectionEnabled?: boolean;
  readonly spotlightEnabled?: boolean;
  readonly motionSensitivityRaw?: number;
  readonly motionSensitivityStep?: number;
  readonly workingMode?: string;
  readonly recordingDurationSeconds?: number;
  readonly recordingIntervalSeconds?: number;
  readonly recordingAutoStop?: boolean;
  readonly homebaseChimeEnabled?: boolean;
  readonly mechanicalChimeEnabled?: boolean;
  readonly wideDynamicRangeEnabled?: boolean;
  readonly chimeVolume?: number;
  readonly doorbellVideoQuality?: number;
  readonly highCompressionEncoding?: boolean;

  /** Native standalone C31 pre-recording preference, independent of clip contents. */
  readonly preRecordingEnabled?: boolean;

  readonly imageFlipped?: boolean;
  readonly statusLedEnabled?: boolean;
  readonly soundDetectionEnabled?: boolean;
  readonly microphoneEnabled?: boolean;
  readonly speakerEnabled?: boolean;
  readonly audioRecordingEnabled?: boolean;
  readonly speakerVolume?: number;
  readonly enabled?: boolean;

  /** Privacy-safe shape of parameter 1035 for support diagnostics. */
  readonly cameraSwitch1035?: "zero" | "one" | "other_number" | "boolean" | "text" | "structured" | "other";
  readonly motionDetectionEnabled?: boolean;

  /** Exact SoloCam tracking enable bit, independent of app-side cloud bookkeeping. */
  readonly aiTrackingEnabled?: boolean;
  readonly guardMode?: number;
  readonly autoNightVisionEnabled?: boolean;
  readonly nightVisionMode?: number;

  /** Raw parameter 6250 value, retained without assigning privacy-mode polarity. */
  readonly privacy6250Value?: 0 | 1;
  readonly batteryLevel?: number;
  readonly backupBatteryLevel?: number;
  readonly batteryCharging?: boolean;
  readonly batteryHealth?: number;
  readonly batteryTemperature?: number;
  readonly lastChargingDays?: number;
  readonly contactOpen?: boolean;
  readonly lastSeen?: string;
  readonly rssi?: number;

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

// Type 61 acknowledged this candidate without operating the reporter's light.
const INT_STRING_LIGHT_DEVICE_TYPES: ReadonlySet<number> = new Set([45]);
const STANDALONE_GUARD_MODE_MODELS: ReadonlySet<string> = new Set([
  "T8170", "T8171", "T8400", "T8410", "T8442",
]);
const PRIVACY_PARAMETER_PROBE_DEVICE_TYPES: ReadonlySet<number> = new Set([104, 105]);

/** Return whether a device uses the verified timed JSON wall-light command. */
export function supportsTimedCameraLight(
  device: Pick<MegaInventoryDevice, "deviceType">,
): boolean {
  return device.deviceType !== null && TIMED_LIGHT_JSON_DEVICE_TYPES.has(device.deviceType);
}

/** Select a direct-camera light wire format without broadening exact C31 model eligibility. */
export function cameraLightControlProtocol(
  device: Pick<MegaInventoryDevice, "deviceType"> & Partial<Pick<MegaInventoryDevice, "model">>,
): "timed-json" | "int-string" | "c31-json" | null {
  if (device.model === "T817L" && device.deviceType === 10031) return "c31-json";
  if (device.deviceType === null) return null;
  if (TIMED_LIGHT_JSON_DEVICE_TYPES.has(device.deviceType)) return "timed-json";
  if (INT_STRING_LIGHT_DEVICE_TYPES.has(device.deviceType)) return "int-string";
  return null;
}

/** Admit attached sirens by command evidence and the exact owned standalone C31 by native validation. */
export function supportsCameraSiren(
  device: Pick<MegaInventoryDevice, "paramTypes"> & Partial<Pick<MegaInventoryDevice, "serial" | "model" | "deviceType" | "channel" | "adminUserId">>,
  route: Pick<PpcsStreamRoute, "homeBaseAttached"> & Partial<Pick<PpcsStreamRoute, "peer">> | null,
): boolean {
  if (route?.homeBaseAttached === true) return device.paramTypes.includes(1015);
  return route?.homeBaseAttached === false && device.model === "T817L" && device.deviceType === 10_031
    && device.channel === 0 && Boolean(device.serial) && route.peer?.serial === device.serial && Boolean(device.adminUserId);
}

/** Return whether SDK evidence identifies this model as a standalone security endpoint. */
export function supportsStandaloneGuardMode(
  device: Pick<MegaInventoryDevice, "model">,
): boolean {
  return STANDALONE_GUARD_MODE_MODELS.has(device.model.toUpperCase());
}

/** Return whether a camera belongs to the narrowly scoped privacy-readback investigation. */
export function supportsPrivacyParameterProbe(
  device: Pick<MegaInventoryDevice, "deviceType">,
): boolean {
  return device.deviceType !== null && PRIVACY_PARAMETER_PROBE_DEVICE_TYPES.has(device.deviceType);
}

/** Describe parameter 6250 without claiming which raw value means physical privacy. */
export function privacyParameterLogSummary(
  device: Pick<MegaInventoryDevice, "deviceType" | "model" | "channel" | "paramTypes" | "reads">,
  previousValue?: 0 | 1,
): string | null {
  if (!supportsPrivacyParameterProbe(device)) return null;
  const value = device.reads.privacy6250Value;
  const status = value !== undefined
    ? String(value)
    : device.paramTypes.includes(6250) ? "invalid" : "missing";
  return [
    `model=${JSON.stringify(device.model)}`,
    `channel=${device.channel ?? "missing"}`,
    "parameter=6250",
    `value=${status}`,
    `previous=${previousValue ?? "missing"}`,
  ].join(" ");
}

function isAutoNightVisionDoorbell(
  device: Pick<MegaInventoryDevice, "model" | "deviceType" | "category">,
): boolean {
  return isDoorbellDevice(device) && AUTO_NIGHT_VISION_DOORBELL_MODELS.has(device.model);
}

/** Return model-specific wire values consumed by gateway and Home Assistant selects. */
export function nightVisionModes(
  device: Pick<MegaInventoryDevice, "model" | "reads" | "deviceType" | "category">,
): readonly NightVisionMode[] {
  if (device.reads.nightVisionMode === undefined || isDoorbellDevice(device)) return [];
  if (device.model === "T8171" && device.deviceType === 88) {
    return [
      { value: 3, name: "Infrared on" },
      { value: 1, name: "Infrared" },
      { value: 0, name: "Off" },
    ];
  }
  const modeZeroName = COLOUR_NIGHT_VISION_MODELS.has(device.model) ? "Colour" : "Off";
  return [
    { value: 0, name: modeZeroName },
    { value: 1, name: "Infrared" },
    { value: 2, name: "Spotlight" },
  ];
}

/** Require a verified camera profile, owned ready peer and known mode before offering a direct write. */
export function supportsStandaloneNightVision(
  device: Pick<MegaInventoryDevice, "serial" | "model" | "deviceType" | "category" | "channel" | "adminUserId" | "reads">,
  route: Pick<PpcsStreamRoute, "homeBaseAttached" | "peer"> | null,
  routeReady: boolean,
): boolean {
  return ((device.model === "T8171" && device.deviceType === 88) || (device.model === "T817L" && device.deviceType === 10_031)) && device.channel === 0
    && route?.homeBaseAttached === false && route.peer.serial === device.serial
    && device.reads.nightVisionMode !== undefined && Boolean(device.adminUserId)
    && routeReady && !isDoorbellDevice(device);
}

/** Admit verified standalone motion writes only with an owned, ready direct route and known state. */
export function supportsStandaloneMotionDetection(
  device: Pick<MegaInventoryDevice, "serial" | "model" | "deviceType" | "channel" | "adminUserId" | "reads">,
  route: Pick<PpcsStreamRoute, "homeBaseAttached" | "peer"> | null,
  routeReady: boolean,
): boolean {
  return ((device.model === "T8171" && device.deviceType === 88) || (device.model === "T817L" && device.deviceType === 10_031)) && device.channel === 0
    && route?.homeBaseAttached === false && route.peer.serial === device.serial
    && device.reads.motionDetectionEnabled !== undefined && Boolean(device.adminUserId) && routeReady;
}

/** Admit verified recording-audio switches only with an owned, ready standalone route and known state. */
export function supportsStandaloneAudioRecording(
  device: Pick<MegaInventoryDevice, "serial" | "model" | "deviceType" | "channel" | "adminUserId" | "reads">,
  route: Pick<PpcsStreamRoute, "homeBaseAttached" | "peer"> | null,
  routeReady: boolean,
): boolean {
  return ((device.model === "T8171" && device.deviceType === 88) || (device.model === "T817L" && device.deviceType === 10_031)) && device.channel === 0
    && route?.homeBaseAttached === false && route.peer.serial === device.serial
    && device.reads.audioRecordingEnabled !== undefined && Boolean(device.adminUserId) && routeReady;
}

/** Admit exact hardware-tested quality profiles only on an owned, ready standalone route. */
export function supportsStandaloneStreamingQuality(
  device: Pick<MegaInventoryDevice, "serial" | "model" | "deviceType" | "channel" | "adminUserId" | "reads">,
  route: Pick<PpcsStreamRoute, "homeBaseAttached" | "peer"> | null,
  routeReady: boolean,
): boolean {
  const choices = device.model === "T8171" && device.deviceType === 88 ? [0, 1, 2, 3]
    : device.model === "T817L" && device.deviceType === 10_031 ? [0, 2, 3] : [];
  return device.channel === 0 && route?.homeBaseAttached === false && route.peer.serial === device.serial
    && choices.includes(device.reads.streamingQualityTier ?? -1) && Boolean(device.adminUserId) && routeReady;
}

/** Admit the SoloCam's pan actions only through its hardware-tested, self-owned direct route. */
export function supportsStandalonePanControl(
  device: Pick<MegaInventoryDevice, "serial" | "model" | "deviceType" | "channel" | "adminUserId">,
  route: Pick<PpcsStreamRoute, "homeBaseAttached" | "peer"> | null,
  routeReady: boolean,
): boolean {
  return device.model === "T8171" && device.deviceType === 88 && device.channel === 0
    && route?.homeBaseAttached === false && route.peer.serial === device.serial
    && Boolean(device.adminUserId) && routeReady;
}

/** Admit C31 saved-position actions on its exact, authorized standalone route. */
export function supportsStandaloneC31Presets(
  device: Pick<MegaInventoryDevice, "serial" | "model" | "deviceType" | "channel" | "adminUserId">,
  route: Pick<PpcsStreamRoute, "homeBaseAttached" | "peer"> | null,
  routeReady: boolean,
): boolean {
  return device.model === "T817L" && device.deviceType === 10_031 && device.channel === 0
    && route?.homeBaseAttached === false && route.peer.serial === device.serial
    && Boolean(device.adminUserId) && routeReady;
}

/** Admit checked live AAC only on exact E30 routes and the owned standalone C31 route. */
export function supportsCameraLiveAudio(
  device: Pick<MegaInventoryDevice, "serial" | "model" | "deviceType" | "channel" | "adminUserId">,
  route: Pick<PpcsStreamRoute, "homeBaseAttached" | "peer"> | null,
  routeReady: boolean,
): boolean {
  if (!routeReady || !route || device.channel === null) return false;
  if (supportsStandaloneC31Presets(device, route, routeReady)) return true;
  return device.model === "T8171" && device.deviceType === 88
    && ((route.homeBaseAttached && route.peer.model === "T8030")
      || (!route.homeBaseAttached && device.channel === 0 && route.peer.serial === device.serial));
}

/** Admit preset movement only on the exact SoloCam direct or HomeBase route proven by saved target scenes. */
export function supportsSoloCamPresetControl(
  device: Pick<MegaInventoryDevice, "serial" | "model" | "deviceType" | "channel" | "adminUserId">,
  route: Pick<PpcsStreamRoute, "homeBaseAttached" | "peer"> | null,
  routeReady: boolean,
): boolean {
  return supportsStandalonePanControl(device, route, routeReady) ||
    (device.model === "T8171" && device.deviceType === 88 && device.channel === 1 && Boolean(device.adminUserId) && routeReady &&
      route?.homeBaseAttached === true && route.peer.model === "T8030" && route.peer.serial !== device.serial);
}

/** Admit stored media on verified direct E30/C31 routes or the tested E30 HomeBase 3 child channel. */
export function supportsSoloCamStoredRecordings(
  device: Pick<MegaInventoryDevice, "serial" | "model" | "deviceType" | "channel" | "adminUserId">,
  route: Pick<PpcsStreamRoute, "homeBaseAttached" | "peer"> | null,
  routeReady: boolean,
): boolean {
  return supportsStandalonePanControl(device, route, routeReady) ||
    supportsStandaloneC31Presets(device, route, routeReady) ||
    (device.model === "T8171" && device.deviceType === 88 && device.channel === 1 && Boolean(device.adminUserId) && routeReady &&
      route?.homeBaseAttached === true && route.peer.model === "T8030" && route.peer.serial !== device.serial);
}

/** Admit tracking only on the exact tested standalone camera routes with a known preference. */
export function supportsStandaloneAiTracking(
  device: Pick<MegaInventoryDevice, "serial" | "model" | "deviceType" | "channel" | "adminUserId" | "reads">,
  route: Pick<PpcsStreamRoute, "homeBaseAttached" | "peer"> | null,
  routeReady: boolean,
): boolean {
  return (supportsStandalonePanControl(device, route, routeReady)
    || supportsStandaloneC31Presets(device, route, routeReady))
    && typeof device.reads.aiTrackingEnabled === "boolean";
}

/** Return whether hardware has proven this model/type's preset query contract. */
export function supportsPresetPositions(
  device: Pick<MegaInventoryDevice, "model"> & Partial<Pick<MegaInventoryDevice, "deviceType">>,
): boolean {
  return device.model.toUpperCase().startsWith("T817L") || (device.model === "T8171" && device.deviceType === 88);
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
 * push delivery independently. Startup generations prevent late inventory or
 * receiver work from surviving close or replacement. A stream request creates one PPCS session per camera and
 * closes it when the last consumer releases the source. Runtime inventory refresh
 * owns additive discovery, while omitted devices retain their existing state.
 */
export class EufyProvider implements CameraProvider, CaptchaProvider {
  readonly #client: MegaClient;
  readonly #devices = new Map<string, MegaInventoryDevice>();
  readonly #generalRtcTrials = new Map<string, { parent: string; trial: GeneralRtcTrial }>();
  readonly #generalRtcPins = new GeneralRtcPinLimiter();
  readonly #generalRtcLockOperations = new Map<string, number>();
  readonly #nvrModePushTimes = new Map<string, number>();
  #nvrModePushStartedAt = 0;
  readonly #doorbellTrials = new Map<string, { controller: AbortController; device: MegaInventoryDevice; generation: number;
    connecting: boolean; session: DoorbellRtcSession | null; release: () => Promise<void> }>();
  readonly #ppcsStreams = new Map<string, FirstPartyPpcsSession>();
  readonly #streamStarts = new Map<string, { promise: Promise<void>; cancelled: boolean }>();
  readonly #nvrExplicitOwners = new Map<string, string>();
  readonly #nvrLiveJobs = new Set<string>();
  readonly #nvrLiveIntervals = new Map<string, number>();
  readonly #nvrReadIntervals = new Map<string, number>();
  readonly #nvrViews = new Map<string, { binding: string; value: 0 | 1 }>();
  readonly #nvrSettings = new Map<string, { binding: string; values: NvrLiveSettings; nightAt: number; qualityAt: number; timer: NodeJS.Timeout | null }>();
  #nvrMediaChecks: { viewer: (serial: string) => boolean; active: (serial: string) => boolean; recording: (serial: string) => boolean } | null = null;
  readonly #nvrTrials = new Map<string, { controller: AbortController; device: MegaInventoryDevice;
    station: MegaInventoryDevice; stateOnly: boolean; diagnostic: boolean; generation: number; sensor: 0 | 1; connecting: boolean; retiring: boolean; terminalRetirement: boolean;
    session: NvrRtcSession | null; release: () => Promise<void> }>();

  /** Private card references expire in memory and are never published as filesystem paths. */
  readonly #recordingReferences = new Map<string, { serial: string; record: CameraStoredRecord; expiresAt: number }>();
  readonly #recordingIdSecret = randomBytes(32);
  #recordingClosing = false;
  #recordingIndexActive = false;
  readonly #recordingIndexCooldowns = new Map<string, number>();
  readonly #recordingReservations = new Set<string>();
  readonly #trialPeers = new Map<string, symbol>();
  readonly #localMotionAborters = new Map<string, AbortController>();
  readonly #lockStatusAborters = new Map<string, AbortController>();
  readonly #lockStatusCooldowns = new Map<string, number>();
  #lockStatusTime = 0;
  #lockStatusSequence = 0;
  readonly #manualLightAborters = new Map<string, AbortController>();
  readonly #nvrPowerEntries = new Map<string, { controller: AbortController; session: NvrRtcSession | null }>();
  readonly #nvrPowerCooldowns = new Map<string, number>();
  readonly #nvrGuardEntries = new Map<string, { controller: AbortController; session: NvrRtcSession | null; attempted: boolean; warned: boolean }>();
  readonly #nvrGuardLatches = new Set<string>();
  readonly #nvrGuardCooldowns = new Map<string, number>();
  readonly #localMotionCooldowns = new Map<string, number>();
  readonly #trialSessions = new Map<string, FirstPartyPpcsSession>();
  readonly #trialSirenStops = new Map<string, { readonly cameraId: string; readonly stop: () => Promise<void>; readonly finished: Promise<void> }>();
  readonly #recordingSessions = new Map<string, FirstPartyPpcsSession>();
  readonly #dskKeys = new Map<string, { readonly key: string; readonly expiresAt: number | null }>();
  readonly #dskRefreshes = new Map<string, Promise<{ readonly key: string; readonly expiresAt: number | null } | null>>();
  readonly #cipherKeys = new Map<string, string>();
  readonly #cipherFlights = new Map<string, Promise<string | undefined>>();
  readonly #pushSnapshotQueues = new Map<string, Promise<void>>();
  readonly #pushDeduplicator = new PushEventDeduplicator();
  readonly #stationRefreshFailures = new Map<string, number>();
  readonly #stationReadConfirmed = new Set<string>();
  readonly #stationStorageDiagnosticLogged = new Set<string>();
  readonly #stations = new Map<string, HomeBaseState>();
  readonly #stationOperations = new Map<string, Promise<HomeBaseState>>();
  readonly #cameraOperations = new Map<string, Promise<CameraIdentity>>();
  readonly #cameraCapabilityOperations = new Map<string, Promise<CameraIdentity>>();
  readonly #streamingQualityOperations = new Map<string, Promise<CameraIdentity>>();
  readonly #audioRecordingOperations = new Map<string, Promise<CameraIdentity>>();
  readonly #motionOperations = new Map<string, Promise<CameraIdentity>>();
  readonly #guardModeOperations = new Map<string, Promise<CameraIdentity>>();
  readonly #nightVisionOperations = new Map<string, Promise<CameraIdentity>>();
  readonly #lightOperations = new Map<string, Promise<void>>();
  readonly #cameraSirenOperations = new Map<string, Promise<void>>();
  readonly #cameraSirenAborters = new Map<string, AbortController>();
  readonly #panControlOperations = new Map<string, Promise<void>>();
  readonly #pendingSensorMotionCloudConfirmations = new Map<string, { receivedAt: number }>();
  readonly #sensorMotionClocks = new Map<string, { device: MegaInventoryDevice; clock: InventoryMotionClock }>();
  readonly #liveDeviceReads = new Map<string, MegaInventoryReads>();
  readonly #liveDeviceParamTypes = new Map<string, readonly number[]>();
  #push: MegaPushReceiver | null = null;
  #startupGeneration = 0;
  #events: ProviderEvents | null = null;
  #captchaChallenge: CaptchaChallenge | null = null;
  #verificationRequired = false;
  #stationRefreshTimer: ReturnType<typeof setInterval> | null = null;
  #inventoryRefreshTimer: ReturnType<typeof setInterval> | null = null;
  #inventoryReadyGeneration: number | null = null;
  #inventoryRefresh: Promise<void> | null = null;
  #inventoryTrailingRefresh: Promise<void> | null = null;
  #inventoryKeyFailures = 0;

  #locks: E30LockProvider | null = null;

  constructor(private readonly config: EufyProviderConfig) {
    this.#client = new MegaClient({
      email: config.username,
      password: config.password,
      country: config.country,
      persistentDirectory: config.persistentDirectory,
      experimentalGeneralRtc: config.experimentalGeneralRtc === true,
    });
  }

  /** Query one opt-in lock through its separately owned MQTT operation. */
  async refreshLock(serial: string, signal?: AbortSignal): Promise<SmartLockState> {
    if (this.#generalRtcReserved(serial)) throw new E30LockError("busy");
    if (!this.#locks) throw new E30LockError("unavailable");
    return this.#withGeneralRtcLockOperation(serial, () => this.#locks!.refresh(serial, signal));
  }

  /** Change lock state once and require an independent correlated query response. */
  async setLockState(serial: string, locked: boolean, signal?: AbortSignal, onDispatch?: () => void): Promise<SmartLockState> {
    if (this.#generalRtcReserved(serial)) throw new E30LockError("busy");
    if (!this.#locks) throw new E30LockError("unavailable");
    return this.#withGeneralRtcLockOperation(serial, () => this.#locks!.setLocked(serial, locked, signal, onDispatch));
  }

  /** Forward one closed settings operation through the lock registry's shared lease. */
  async setLockSetting(serial: string, change: E30LockSettingChange, signal?: AbortSignal, onDispatch?: () => void): Promise<SmartLockState> {
    if (this.#generalRtcReserved(serial)) throw new E30LockError("busy");
    if (!this.#locks) throw new E30LockError("unavailable");
    return this.#withGeneralRtcLockOperation(serial, () => this.#locks!.setSetting(serial, change, signal, onDispatch));
  }


  async #resolveCipherKey(cipherId: number, peer: MegaInventoryDevice): Promise<string | undefined> {
    if (!peer.adminUserId) return undefined;
    const cacheKey = JSON.stringify([peer.serial, peer.adminUserId, cipherId]);
    const cached = this.#cipherKeys.get(cacheKey);
    if (cached) return cached;
    const pending = this.#cipherFlights.get(cacheKey);
    if (pending) return pending;
    const generation = this.#startupGeneration;
    const lookup = (async () => {
      try {
        const ciphers = await this.#client.getCiphers([cipherId], peer.adminUserId!, peer.serial);
        if (generation !== this.#startupGeneration || this.#recordingClosing
          || this.#devices.get(peer.serial)?.adminUserId !== peer.adminUserId) return undefined;
        const matches = ciphers.filter(cipher => {
          const id = cipher.cipher_id;
          return (typeof id === "number" && Number.isSafeInteger(id)
            || typeof id === "string" && /^\d{1,10}$/.test(id)) && Number(id) === cipherId;
        });
        const key = matches.length === 1 && typeof matches[0]!.ecc_private_key === "string"
          ? matches[0]!.ecc_private_key : undefined;
        if (key) this.#cipherKeys.set(cacheKey, key);
        return key;
      } catch (error) {
        if (generation === this.#startupGeneration && !this.#recordingClosing) {
          logger.warn("cipher_lookup_unavailable", `Mega cipher lookup unavailable: ${safeError(error)}`);
        }
        return undefined;
      }
    })();
    this.#cipherFlights.set(cacheKey, lookup);
    try { return await lookup; }
    finally {
      if (this.#cipherFlights.get(cacheKey) === lookup) this.#cipherFlights.delete(cacheKey);
    }
  }

  async #dskKey(peerSerial: string): Promise<{ readonly key: string; readonly expiresAt: number | null } | null> {
    const cached = this.#dskKeys.get(peerSerial);
    if (!dskKeyNeedsRefresh(cached)) return cached ?? null;
    const pending = this.#dskRefreshes.get(peerSerial);
    if (pending) return await pending;
    const generation = this.#startupGeneration;
    const refresh = this.#client.dskKeys([peerSerial]).then((keys) => {
      if (generation !== this.#startupGeneration) throw new Error("Device key lookup cancelled");
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
      if (generation !== this.#startupGeneration) throw new Error("Device key lookup cancelled");
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

  /** Read cloud metadata only for a camera admitted in the current account. */
  async cloudHistory(serial: string, query: CloudHistoryQuery): Promise<readonly CloudHistoryRecord[]> {
    const camera = this.#devices.get(serial);
    if (!camera || !isSupportedCameraType(camera)) throw new Error("Camera not found");
    return this.#client.cloudHistory(serial, query);
  }

  /** Read unconfirmed calendar hints without modifying inventory or retained media. */
  async cloudCalendar(serial: string, query: CloudCalendarQuery, signal: AbortSignal): Promise<CloudCalendarResult> {
    const original = this.#devices.get(serial), generation = this.#startupGeneration;
    if (!this.config.experimentalCloudRecordings || !original || !isSupportedCameraType(original)
      || !this.#client.isAuthenticated || this.#recordingClosing || signal.aborted) throw new CloudCalendarError("admission");
    const current = (): void => {
      if (signal.aborted || this.#recordingClosing || generation !== this.#startupGeneration) throw new CloudCalendarError("cancelled");
      if (!this.#client.isAuthenticated) throw new CloudCalendarError("auth");
      const live = this.#devices.get(serial);
      if (!live || inventoryBindingChanged(original, live)) throw new CloudCalendarError("inventory");
    };
    const fresh = async (): Promise<void> => {
      current();
      let inventory: MegaInventory;
      try { inventory = await this.#client.inventory(signal); }
      catch { throw new CloudCalendarError(signal.aborted ? "cancelled" : "inventory"); }
      current();
      if (!inventory || !Array.isArray(inventory.devices)) throw new CloudCalendarError("inventory");
      if (inventory.devices.filter(row => safeValue(row.device_sn, 128) === serial).length !== 1) throw new CloudCalendarError("inventory");
      const device = parseMegaInventory(inventory).find(row => row.serial === serial);
      if (!device || inventoryBindingChanged(original, device)) throw new CloudCalendarError("inventory");
    };
    await fresh();
    const result = await this.#client.cloudCalendar(serial, original.parentSerial || serial, query, signal);
    current(); await fresh(); current();
    logger.info("cloud_calendar_read", `days=${result.days.length} dropped_rows=${result.droppedRows}`);
    return { month: result.month, days: result.days };
  }

  /** Prepare existing cloud video for one currently admitted camera without waking or controlling it. */
  async cloudRecordingTrial(serial: string, id: string, query: CloudHistoryQuery, signal: AbortSignal): Promise<Buffer> {
    const device = this.#devices.get(serial), generation = this.#startupGeneration;
    if (!this.config.experimentalCloudRecordings || !device || !isSupportedCameraType(device)
      || this.#recordingClosing || signal.aborted || !this.#client.isAuthenticated) throw new CloudRecordingError("admission");
    const media = await this.#client.cloudRecordingTrial(serial, device.parentSerial, id, query, signal);
    const current = this.#devices.get(serial);
    if (signal.aborted || this.#recordingClosing || generation !== this.#startupGeneration || !current
      || inventoryBindingChanged(device, current) || current.adminUserId !== device.adminUserId) {
      media.fill(0); throw new CloudRecordingError("cancelled");
    }
    return media;
  }

  /**
   * Reserve one exact direct C31 for a manual index test without changing settings.
   * Fresh cloud bindings bracket the source-defined query. The result contains
   * no recording references, and its success does not establish playback.
   */
  async readRecordingIndexTrial(serial: string, signal: AbortSignal): Promise<C31IndexSummary> {
    const device = this.#devices.get(serial), generation = this.#startupGeneration;
    const route = device ? ppcsStreamRoute(device, this.#devices) : null;
    if (!this.config.experimentalModelControls || !device || device.model !== "T817L"
      || device.deviceType !== 10031 || device.channel !== 0 || !device.adminUserId
      || !route || route.homeBaseAttached || route.peer.serial !== device.serial
      || !isPpcsRouteReady(device, this.#devices, new Set(this.#dskKeys.keys()))) throw new C31IndexError("admission");
    if (this.#localMotionAborters.size || this.#recordingIndexActive || this.#panControlOperations.has(serial) || this.#recordingPeerReserved(serial)
      || this.#ppcsStreams.has(serial) || this.#streamStarts.has(serial)
      || (this.#recordingIndexCooldowns.get(serial) ?? 0) > Date.now()) throw new C31IndexError("busy");
    const current = (): void => {
      const fresh = this.#devices.get(serial);
      if (signal.aborted || this.#recordingClosing || generation !== this.#startupGeneration) throw new C31IndexError("cancelled");
      if (!fresh || inventoryBindingChanged(device, fresh) || fresh.adminUserId !== device.adminUserId) throw new C31IndexError("admission");
    };
    const freshBinding = async (): Promise<void> => {
      current();
      const inventory = await this.#client.inventory(signal);
      current();
      if (inventory.devices.filter(row => row.device_sn === serial).length !== 1) throw new C31IndexError("admission");
      const fresh = parseMegaInventory(inventory).find(row => row.serial === serial);
      if (!fresh || inventoryBindingChanged(device, fresh) || fresh.adminUserId !== device.adminUserId) throw new C31IndexError("admission");
    };
    this.#recordingIndexActive = true;
    this.#recordingReservations.add(serial);
    let session: FirstPartyPpcsSession | null = null;
    const abort = (): void => { session?.close(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await freshBinding();
      const peer = route.peer, dsk = await this.#dskKey(peer.serial);
      current();
      if (!dsk) throw new C31IndexError("admission");
      session = new FirstPartyPpcsSession({ stationSerial: peer.serial, p2pDid: peer.p2pDid!,
        appConnection: peer.p2pConnection!, localAddress: peer.localAddress, dskKey: dsk.key,
        channel: 0, cameraModel: "T817L", stationModel: peer.model, recordingCameraSerial: device.serial,
        accountId: device.adminUserId, homeBaseAttached: false, purpose: "control", maxSeconds: 45,
        resolveCipherKey: id => this.#resolveCipherKey(id, peer) });
      this.#recordingSessions.set(serial, session);
      await session.start(); current();
      const end = Math.floor(Date.now() / 1000);
      const result = await session.readC31RecordingIndex(end - 1800, end, current);
      current(); await freshBinding(); current();
      return result;
    } catch (error) {
      throw error instanceof C31IndexError ? error : new C31IndexError(signal.aborted ? "cancelled" : "session");
    } finally {
      signal.removeEventListener("abort", abort); session?.close();
      if (this.#recordingSessions.get(serial) === session) this.#recordingSessions.delete(serial);
      this.#recordingReservations.delete(serial); this.#recordingIndexActive = false;
      this.#recordingIndexCooldowns.delete(serial); this.#recordingIndexCooldowns.set(serial, Date.now() + 10_000);
      while (this.#recordingIndexCooldowns.size > 100) this.#recordingIndexCooldowns.delete(this.#recordingIndexCooldowns.keys().next().value!);
    }
  }

  /**
   * Watch one exact T8910 channel without changing sensor or phone settings.
   * A parent-wide lease excludes local controls and media. Results are candidate
   * counts only and are discarded if the fresh binding cannot be rechecked.
   */
  async readLocalMotionTrial(serial: string, signal: AbortSignal): Promise<LocalMotionSummary> {
    const device = this.#devices.get(serial), generation = this.#startupGeneration;
    const peer = device ? this.#devices.get(device.parentSerial) : undefined;
    const admitted = (rows: readonly MegaInventoryDevice[]): boolean => {
      if (!device || !peer || device.model !== "T8910" || device.deviceType !== 10
        || device.channel === null || !Number.isInteger(device.channel) || device.channel < 0 || device.channel > 254
        || !device.adminUserId || device.adminUserId !== peer.adminUserId
        || !((peer.model === "T8010" && peer.deviceType === 0) || (peer.model === "T8030" && peer.deviceType === 18))
        || device.parentSerial === device.serial || !peer.p2pDid || !peer.p2pConnection
        || !this.#dskKeys.has(peer.serial)) return false;
      const children = rows.filter(row => row.serial === serial);
      const parents = rows.filter(row => row.serial === peer.serial);
      return children.length === 1 && parents.length === 1
        && rows.filter(row => row.parentSerial === peer.serial && row.channel === device.channel).length === 1
        && !inventoryBindingChanged(device, children[0]!) && children[0]!.adminUserId === device.adminUserId
        && !inventoryBindingChanged(peer, parents[0]!) && parents[0]!.adminUserId === peer.adminUserId
        && parents[0]!.p2pDid === peer.p2pDid && parents[0]!.p2pConnection === peer.p2pConnection;
    };
    if (!this.config.experimentalModelControls || !admitted([...this.#devices.values()]) || signal.aborted || this.#recordingClosing) throw new LocalMotionError("admission");
    const station = peer!;
    const related = [...this.#devices.values()].filter(row => row.serial === station.serial || row.parentSerial === station.serial);
    const controls = [this.#cameraOperations, this.#cameraCapabilityOperations, this.#streamingQualityOperations,
      this.#audioRecordingOperations, this.#motionOperations, this.#nightVisionOperations, this.#guardModeOperations,
      this.#lightOperations, this.#panControlOperations, this.#cameraSirenOperations];
    if (this.#trialPeers.size || this.#recordingIndexActive || this.#localMotionAborters.size
      || this.#stationOperations.has(station.serial) || this.#stationHasActiveMedia(station.serial)
      || related.some(row => this.#streamStarts.has(row.serial) || controls.some(map => map.has(row.serial)))
      || (this.#localMotionCooldowns.get(station.serial) ?? 0) > Date.now()) throw new LocalMotionError("busy");
    const controller = new AbortController();
    const releaseTrialPeer = this.#reserveTrialPeer(station.serial); this.#localMotionAborters.set(station.serial, controller);
    let session: FirstPartyPpcsSession | null = null, collector: LocalMotionCollector | null = null;
    let failure: LocalMotionError | null = null, finished = false;
    let watchTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => { controller.abort(); session?.close(); };
    const deadline = setTimeout(() => { failure = new LocalMotionError("timeout"); abort(); }, 90_000);
    const bindingTimer = setInterval(() => {
      if (!admitted([...this.#devices.values()]) || generation !== this.#startupGeneration || this.#recordingClosing) {
        failure = new LocalMotionError("cancelled"); abort();
      }
    }, 1_000);
    signal.addEventListener("abort", abort, { once: true });
    const current = (): void => {
      if (controller.signal.aborted || signal.aborted || this.#recordingClosing || generation !== this.#startupGeneration) {
        throw failure ?? new LocalMotionError("cancelled");
      }
      if (!admitted([...this.#devices.values()])) throw new LocalMotionError("admission");
    };
    const owned = async <T>(operation: () => Promise<T>): Promise<T> => {
      current();
      let cancel!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(failure ?? new LocalMotionError("cancelled"));
        controller.signal.addEventListener("abort", cancel, { once: true });
        if (controller.signal.aborted) cancel();
      });
      try { const result = await Promise.race([operation(), aborted]); current(); return result; }
      finally { controller.signal.removeEventListener("abort", cancel); }
    };
    const fresh = async (): Promise<void> => {
      const inventory = await owned(() => this.#client.inventory(controller.signal));
      if (inventory.devices.filter(row => row.device_sn === serial).length !== 1
        || inventory.devices.filter(row => row.device_sn === station.serial).length !== 1
        || !admitted(parseMegaInventory(inventory))) throw new LocalMotionError("admission");
    };
    try {
      await fresh();
      const dsk = await owned(() => this.#dskKey(station.serial));
      if (!dsk) throw new LocalMotionError("admission");
      session = new FirstPartyPpcsSession({ stationSerial: station.serial, p2pDid: station.p2pDid!,
        appConnection: station.p2pConnection!, localAddress: station.localAddress, dskKey: dsk.key,
        channel: device!.channel!, cameraModel: "T8910", stationModel: station.model,
        accountId: station.adminUserId!, homeBaseAttached: true, purpose: "passive", maxSeconds: 65,
        resolveCipherKey: id => this.#resolveCipherKey(id, station),
        onSensorMotion: observation => {
          if (!collector || finished || controller.signal.aborted) return;
          try { current(); collector.observe(observation, Date.now()); }
          catch { failure = new LocalMotionError("admission"); abort(); }
        } });
      this.#trialSessions.set(station.serial, session);
      const closed = (): void => { if (!finished) { failure ??= new LocalMotionError("session"); controller.abort(); } };
      session.output.once("end", closed); session.output.resume();
      await owned(() => session!.start());
      if (session.stats.closeReason !== "open") throw new LocalMotionError("session");
      collector = new LocalMotionCollector(device!.channel!, Date.now());
      await owned(() => new Promise<void>(resolve => { watchTimer = setTimeout(resolve, 45_000); }));
      await fresh(); current();
      return collector.finish();
    } catch (error) {
      throw error instanceof LocalMotionError ? error : failure ?? new LocalMotionError(controller.signal.aborted ? "cancelled" : "session");
    } finally {
      finished = true; collector?.finish(); clearTimeout(deadline); clearInterval(bindingTimer); if (watchTimer) clearTimeout(watchTimer); signal.removeEventListener("abort", abort);
      controller.abort(); session?.close();
      if (this.#trialSessions.get(station.serial) === session) this.#trialSessions.delete(station.serial);
      this.#localMotionAborters.delete(station.serial); releaseTrialPeer();
      this.#localMotionCooldowns.delete(station.serial); this.#localMotionCooldowns.set(station.serial, Date.now() + 10_000);
      while (this.#localMotionCooldowns.size > 100) this.#localMotionCooldowns.delete(this.#localMotionCooldowns.keys().next().value!);
    }
  }


  /** Read source-derived attached FamiLock status under a fresh, exclusive parent lease. */
  async readT85V0StatusTrial(serial: string, signal: AbortSignal): Promise<T85V0StatusSummary> {
    const device = this.#devices.get(serial), generation = this.#startupGeneration;
    const peer = device ? this.#devices.get(device.parentSerial) : undefined;
    const admitted = (rows: readonly MegaInventoryDevice[]): boolean => {
      if (!device || !peer || device.model !== "T85V0" || device.deviceType !== 203
        || device.channel === null || !Number.isInteger(device.channel) || device.channel < 0 || device.channel > 254
        || !device.adminUserId || device.adminUserId !== peer.adminUserId
        || !(peer.model === "T8030" && peer.deviceType === 18)
        || !validT85V0StatusIdentity({ serial, accountId: device.adminUserId, channel: device.channel })
        || !this.#client.isAuthenticatedUser(device.adminUserId) || device.parentSerial === device.serial || !peer.p2pDid || !peer.p2pConnection
        || !this.#dskKeys.has(peer.serial)) return false;
      const children = rows.filter(row => row.serial === serial);
      const parents = rows.filter(row => row.serial === peer.serial);
      return children.length === 1 && parents.length === 1
        && rows.filter(row => row.parentSerial === peer.serial && row.channel === device.channel).length === 1
        && !inventoryBindingChanged(device, children[0]!) && children[0]!.adminUserId === device.adminUserId
        && !inventoryBindingChanged(peer, parents[0]!) && parents[0]!.adminUserId === peer.adminUserId
        && parents[0]!.p2pDid === peer.p2pDid && parents[0]!.p2pConnection === peer.p2pConnection;
    };
    if (!this.config.experimentalModelControls || !admitted([...this.#devices.values()]) || signal.aborted || this.#recordingClosing) throw new T85V0StatusError("admission");
    const station = peer!;
    const related = [...this.#devices.values()].filter(row => row.serial === station.serial || row.parentSerial === station.serial);
    const controls = [this.#cameraOperations, this.#cameraCapabilityOperations, this.#streamingQualityOperations,
      this.#audioRecordingOperations, this.#motionOperations, this.#nightVisionOperations, this.#guardModeOperations,
      this.#lightOperations, this.#panControlOperations, this.#cameraSirenOperations];
    if (this.#trialPeers.size || this.#recordingIndexActive || this.#localMotionAborters.size
      || this.#recordingPeerReserved(serial) || this.#stationOperations.has(station.serial) || this.#stationHasActiveMedia(station.serial)
      || related.some(row => this.#streamStarts.has(row.serial) || controls.some(map => map.has(row.serial)))
      || (this.#lockStatusCooldowns.get(station.serial) ?? 0) > Date.now()) throw new T85V0StatusError("busy");
    const controller = new AbortController();
    const releaseTrialPeer = this.#reserveTrialPeer(station.serial); this.#lockStatusAborters.set(station.serial, controller);
    let session: FirstPartyPpcsSession | null = null;
    let started = false;
    let failure: T85V0StatusError | null = null, finished = false;
    const abort = (): void => { controller.abort(); session?.close(); };
    const deadline = setTimeout(() => { failure = new T85V0StatusError("timeout"); abort(); }, 60_000);
    const bindingTimer = setInterval(() => {
      if (!admitted([...this.#devices.values()]) || generation !== this.#startupGeneration || this.#recordingClosing) {
        failure = new T85V0StatusError("cancelled"); abort();
      }
    }, 1_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const current = (): void => {
      if (controller.signal.aborted || signal.aborted || this.#recordingClosing || generation !== this.#startupGeneration || (session !== null && session.stats.closeReason !== "open")) {
        throw failure ?? new T85V0StatusError("cancelled");
      }
      if (!admitted([...this.#devices.values()])) throw new T85V0StatusError("admission");
    };
    const owned = async <T>(operation: () => Promise<T>): Promise<T> => {
      current();
      let cancel!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(failure ?? new T85V0StatusError("cancelled"));
        controller.signal.addEventListener("abort", cancel, { once: true });
        if (controller.signal.aborted) cancel();
      });
      try { const result = await Promise.race([operation(), aborted]); current(); return result; }
      finally { controller.signal.removeEventListener("abort", cancel); }
    };
    const fresh = async (): Promise<void> => {
      const inventory = await owned(() => this.#client.inventory(controller.signal));
      if (inventory.devices.filter(row => row.device_sn === serial).length !== 1
        || inventory.devices.filter(row => row.device_sn === station.serial).length !== 1
        || !admitted(parseMegaInventory(inventory))) throw new T85V0StatusError("admission");
    };
    try {
      await fresh();
      const dsk = await owned(() => this.#dskKey(station.serial));
      if (!dsk) throw new T85V0StatusError("admission");
      session = new FirstPartyPpcsSession({ stationSerial: station.serial, p2pDid: station.p2pDid!,
        appConnection: station.p2pConnection!, localAddress: station.localAddress, dskKey: dsk.key,
        channel: device!.channel!, cameraModel: "T85V0", stationModel: station.model,
        accountId: station.adminUserId!, homeBaseAttached: true, purpose: "control", maxSeconds: 45,
        resolveCipherKey: id => this.#resolveCipherKey(id, station) });
      this.#trialSessions.set(station.serial, session);
      const closed = (): void => { if (!finished) { failure ??= new T85V0StatusError("session"); controller.abort(); } };
      session.output.once("end", closed); session.output.resume();
      await owned(() => { started = true; return session!.start(); });
      if (session.stats.closeReason !== "open") throw new T85V0StatusError("session");
      await fresh(); current();
      const now = Math.floor(Date.now() / 1000);
      const keyTime = Math.max(now, this.#lockStatusTime + 1);
      if (keyTime > 0xffffffff || this.#lockStatusSequence >= 0xffffffff) throw new T85V0StatusError("admission");
      this.#lockStatusTime = keyTime;
      const sequence = ++this.#lockStatusSequence;
      const summary = await owned(() => session!.readT85V0Status({ serial, accountId: device!.adminUserId!, channel: device!.channel! }, keyTime, sequence, current));
      await fresh(); current();
      return summary;
    } catch (error) {
      throw error instanceof T85V0StatusError ? error : failure ?? new T85V0StatusError(controller.signal.aborted ? "cancelled" : "session");
    } finally {
      finished = true; clearTimeout(deadline); clearInterval(bindingTimer); signal.removeEventListener("abort", abort);
      controller.abort(); session?.close();
      if (this.#trialSessions.get(station.serial) === session) this.#trialSessions.delete(station.serial);
      this.#lockStatusAborters.delete(station.serial); releaseTrialPeer();
      if (started) {
        const now = Date.now();
        for (const [key, until] of this.#lockStatusCooldowns) if (until <= now) this.#lockStatusCooldowns.delete(key);
        this.#lockStatusCooldowns.delete(station.serial); this.#lockStatusCooldowns.set(station.serial, now + 10_000);
        while (this.#lockStatusCooldowns.size > 100) this.#lockStatusCooldowns.delete(this.#lockStatusCooldowns.keys().next().value!);
      }
    }
  }

  /** List validated, completed SoloCam event clips through its currently verified storage route. */
  async listStoredRecordings(serial: string, date: string, signal?: AbortSignal): Promise<readonly StoredRecordingSummary[]> {
    validateRecordingDate(date);
    return await this.#recordingOperation(serial, signal, async (session) => {
      const records = await session.listStoredRecordings(date, signal);
      for (const [id, reference] of this.#recordingReferences) {
        if (reference.expiresAt <= Date.now()) this.#recordingReferences.delete(id);
      }
      return records.map((record) => {
        const id = createHmac("sha256", this.#recordingIdSecret).update(`${serial}\0${record.storagePath}`).digest("hex");
        this.#recordingReferences.delete(id);
        this.#recordingReferences.set(id, { serial, record, expiresAt: Date.now() + 30 * 60_000 });
        while (this.#recordingReferences.size > 1_000) this.#recordingReferences.delete(this.#recordingReferences.keys().next().value!);
        return { id, startTime: record.startTime, endTime: record.endTime };
      });
    });
  }

  /** Resolve an opaque owned reference only while its verified storage route remains available. */
  async downloadStoredRecording(serial: string, id: string, signal?: AbortSignal): Promise<Buffer | null> {
    const reference = this.#recordingReferences.get(id);
    if (!reference || reference.serial !== serial || reference.expiresAt <= Date.now()) return null;
    return await this.#recordingOperation(serial, signal,
      async (session) => await session.downloadStoredRecording(reference.record, signal));
  }

  async #recordingOperation<T>(serial: string, signal: AbortSignal | undefined,
    operation: (session: FirstPartyPpcsSession) => Promise<T>): Promise<T> {
    const previous = this.#panControlOperations.get(serial) ?? Promise.resolve();
    let result!: T;
    const current = previous.catch(() => undefined).then(async () => {
      const device = this.#devices.get(serial);
      const route = device ? ppcsStreamRoute(device, this.#devices) : null;
      if (this.#recordingClosing || !device || !supportsSoloCamStoredRecordings(device, route,
        isPpcsRouteReady(device, this.#devices, new Set(this.#dskKeys.keys()))) || signal?.aborted) {
        throw new Error("Stored recordings require a verified ready SoloCam route");
      }
      if (this.#recordingPeerReserved(serial)) throw new Error("Wait for this camera peer's recording retrieval");
      if (this.#ppcsStreams.has(serial) || (route!.homeBaseAttached && this.#stationHasActiveMedia(route!.peer.serial))) {
        throw new Error("Close this camera peer's live views before browsing recordings");
      }
      this.#recordingReservations.add(serial);
      try {
        const peer = route!.peer;
        await this.#stationOperations.get(peer.serial)?.catch(() => undefined);
        const dsk = await this.#dskKey(peer.serial);
        if (!dsk || signal?.aborted || this.#recordingClosing || this.#ppcsStreams.has(serial)) throw new Error("Recording camera connection is unavailable");
        const session = new FirstPartyPpcsSession({ stationSerial: peer.serial, p2pDid: peer.p2pDid!,
          appConnection: peer.p2pConnection!, localAddress: peer.localAddress, dskKey: dsk.key,
          channel: device.channel!, cameraModel: device.model, stationModel: peer.model, recordingCameraSerial: device.serial,
          accountId: device.adminUserId!, homeBaseAttached: route!.homeBaseAttached,
          purpose: "control", maxSeconds: 120, resolveCipherKey: (id) => this.#resolveCipherKey(id, peer) });
        this.#recordingSessions.set(serial, session);
        const abort = (): void => session.close();
        signal?.addEventListener("abort", abort, { once: true });
        try {
          await session.start();
          result = await operation(session);
          const currentDevice = this.#devices.get(serial);
          if (!currentDevice || inventoryBindingChanged(device, currentDevice)) {
            throw new Error("Camera connection changed during recording retrieval");
          }
        } finally {
          signal?.removeEventListener("abort", abort);
          session.close();
          this.#recordingSessions.delete(serial);
        }
      } finally { this.#recordingReservations.delete(serial); }
    });
    this.#panControlOperations.set(serial, current);
    try { await current; return result; }
    finally { if (this.#panControlOperations.get(serial) === current) this.#panControlOperations.delete(serial); }
  }

  /** Authenticate and publish cameras independently of background push readiness. */
  async start(events: ProviderEvents): Promise<void> {
    this.#nvrModePushStartedAt = Date.now();
    this.#nvrModePushTimes.clear();
    for (const pending of this.#streamStarts.values()) pending.cancelled = true;
    this.#streamStarts.clear();
    this.#cipherFlights.clear();
    this.#recordingClosing = false;
    const generation = ++this.#startupGeneration;
    for (const serial of this.#nvrSettings.keys()) this.#clearNvrSettings(serial);
    this.#nvrViews.clear();
    this.#retireInventoryRefresh();
    this.#events = events;
    this.#locks?.close();
    this.#locks = this.config.experimentalE30Locks ? new E30LockProvider({
      accountName: this.config.username.split("@")[0] || "Home Assistant",
      credentials: () => this.#client.e30MqttCredentials(),
      freshDevices: async () => (await this.#client.inventory()).devices,
      changed: locks => { if (generation === this.#startupGeneration) events.locks?.(locks); },
    }) : null;
    let auth;
    try { auth = await this.#client.connect(this.config.verifyCode); }
    catch (error) { if (generation !== this.#startupGeneration) return; throw error; }
    if (generation !== this.#startupGeneration) return;
    if (auth.state !== "authenticated") {
      this.#captchaChallenge = auth.captcha ?? null;
      this.#verificationRequired = auth.state === "verification-required";
      const detail = auth.state === "captcha-required"
        ? "Open the add-on web interface to complete Eufy's CAPTCHA"
        : "Open the add-on web interface to enter Eufy's email verification code";
      events.connection("authentication-required", detail);
      return;
    }
    await this.#completeStartup(events, generation);
  }

  /** Return numeric evidence from an existing source, excluding wire prefixes and identities. */
  streamDiagnostic(serial: string) {
    const stats = this.#ppcsStreams.get(serial)?.stats;
    if (!stats) return null;
    return {
      stage: stats.camId === 0 ? "lookup" as const : stats.videoFrames === 0 ? "first-frame" as const : "media" as const,
      counters: {
        dataDatagrams: stats.dataDatagrams, frameHeaders: stats.frameHeaders, videoFrames: stats.videoFrames,
        videoOutputFrames: stats.videoOutputFrames, sequenceGaps: stats.sequenceGaps, sequenceRestarts: stats.sequenceRestarts,
        duplicateDatagrams: stats.duplicateDatagrams, staleDatagrams: stats.staleDatagrams, parserResyncs: stats.parserResyncs,
        pendingBytes: stats.pendingBytes, incompleteAccessUnits: stats.incompleteAccessUnits,
        incompleteAccessUnitBytes: stats.incompleteAccessUnitBytes,
      },
    };
  }

  #doorbellRtcBinding(device: MegaInventoryDevice | undefined): boolean {
    return this.config.experimentalDoorbellRtc === true && !!device && device.model === "T8224" && device.deviceType === 96
      && device.category === "eufy_security" && device.parentSerial === device.serial && !device.p2pConnection
      && !!device.adminUserId && device.channel !== null && Number.isInteger(device.channel)
      && device.channel >= 0 && device.channel <= 254;
  }

  /** Reserve a default-off owner-account clip without changing normal media admission. */
  reserveGeneralRtcTrial(serial: string, signal: AbortSignal): GeneralRtcTrialLease {
    if (!this.config.experimentalGeneralRtc || !this.config.apiAuthenticationConfigured || this.#recordingClosing || signal.aborted) throw new GeneralRtcError("admission");
    const account = this.#client.generalRtcAccount();
    if (!account || !this.#client.generalRtcHasNativeIdentities()) throw new GeneralRtcError("admission", "native_identity_missing");
    const device = this.#devices.get(serial);
    const parentSerial = device?.parentSerial || serial;
    const parent = this.#devices.get(parentSerial);
    if (!device || !parent || !isSupportedMegaCamera(device) || device.deviceType === null || parent.deviceType === null
      || device.category !== "eufy_security" || parent.category !== "eufy_security"
      || !/^[A-Za-z0-9_-]{1,128}$/.test(serial) || !/^[A-Za-z0-9_-]{1,128}$/.test(parentSerial)
      || !device.adminUserId || !/^[A-Za-z0-9_-]{1,255}$/.test(device.adminUserId)
      || device.adminUserId !== account.userId || parent.adminUserId !== account.userId
      || device.channel === null || !Number.isInteger(device.channel) || device.channel < 0 || device.channel > 254
      || parent.model === "T8N00" && parent.deviceType === 300 || parent.model === "T9000" && parent.deviceType === 27
      || device.model === "T8224" && device.deviceType === 96 || !account.smartHost || !/^[A-Z]{2}$/.test(account.country)
      || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,4096}$/.test(account.token)) throw new GeneralRtcError("admission");
    if (!account.cipher) throw new GeneralRtcError("reconnect_required");
    this.#generalRtcPins.check(account.userId);
    const related = new Set([parentSerial, ...[...this.#devices.values()]
      .filter(row => (row.parentSerial || row.serial) === parentSerial).map(row => row.serial)]);
    const busyMaps: readonly ReadonlyMap<string, unknown>[] = [this.#ppcsStreams, this.#streamStarts, this.#stationOperations,
      this.#cameraOperations, this.#cameraCapabilityOperations, this.#streamingQualityOperations, this.#audioRecordingOperations,
      this.#motionOperations, this.#guardModeOperations, this.#nightVisionOperations, this.#lightOperations,
      this.#cameraSirenOperations, this.#cameraSirenAborters, this.#panControlOperations, this.#nvrTrials, this.#doorbellTrials,
      this.#localMotionAborters, this.#lockStatusAborters, this.#manualLightAborters, this.#recordingSessions, this.#trialSirenStops,
      this.#generalRtcLockOperations];
    if (this.#recordingIndexActive || this.#recordingPeerReserved(serial) || this.#nvrControlReserved(parentSerial)
      || [...this.#nvrLiveJobs].some(id => related.has(id)) || [...this.#generalRtcTrials.values()].some(entry => entry.parent === parentSerial)
      || busyMaps.some(map => [...map.keys()].some(id => related.has(id)))) throw new GeneralRtcError("busy");
    const initial: GeneralRtcBinding = { child: { serial, model: device.model, type: device.deviceType, category: device.category,
      parent: parentSerial, channel: device.channel, administrator: account.userId }, parent: { serial: parentSerial,
      model: parent.model, type: parent.deviceType, category: parent.category, administrator: account.userId } };
    const generation = this.#startupGeneration;
    const releaseReservation = this.#reserveTrialPeer(parentSerial);
    let trial: GeneralRtcTrial;
    try {
      trial = new GeneralRtcTrial({ client: this.#client, initial, limiter: this.#generalRtcPins, signal,
        normalize: inventory => parseMegaInventory(inventory), releaseReservation,
        current: () => {
          const child = this.#devices.get(serial), station = this.#devices.get(parentSerial);
          return !this.#recordingClosing && generation === this.#startupGeneration && this.#generalRtcTrials.get(serial)?.trial === trial
            && !!child && !!station && !inventoryBindingChanged(device, child) && !inventoryBindingChanged(parent, station)
            && child.adminUserId === account.userId && station.adminUserId === account.userId;
        }, retired: () => { if (this.#generalRtcTrials.get(serial)?.trial === trial) this.#generalRtcTrials.delete(serial); },
      });
    } catch { releaseReservation(); throw new GeneralRtcError("admission"); }
    this.#generalRtcTrials.set(serial, { parent: parentSerial, trial });
    return trial;
  }

  /** Reserve one exact standalone doorbell for a private, video-only diagnostic clip. */
  reserveDoorbellRtcTrial(serial: string, signal: AbortSignal): () => Promise<void> {
    const device = this.#devices.get(serial);
    if (!this.#doorbellRtcBinding(device) || !device || signal.aborted || this.#recordingClosing
      || !this.#client.isAuthenticated || this.#localMotionAborters.size || this.#doorbellTrials.size || this.#nvrTrials.size
      || this.#trialPeers.has(serial) || this.#recordingPeerReserved(serial) || this.#stationHasActiveMedia(serial)) {
      throw new DoorbellRtcError("admission");
    }
    const controller = new AbortController();
    let closed: Promise<void> | null = null;
    const deadline = setTimeout(() => { void entry.release().catch(() => logger.warn("doorbell_rtc_trial_failed", "stage=stop")); }, 85_000);
    const entry = { controller, device, generation: this.#startupGeneration, connecting: false, session: null as DoorbellRtcSession | null,
      release: (): Promise<void> => {
        if (closed) return closed;
        controller.abort();
        closed = (async () => {
          clearTimeout(deadline);
          try { await entry.session?.close(); }
          finally {
            signal.removeEventListener("abort", abort);
            if (this.#doorbellTrials.get(serial) === entry) this.#doorbellTrials.delete(serial);
            releaseTrialPeer(); this.#events?.streamStopped(serial);
          }
        })();
        return closed;
      },
    };
    const abort = (): void => { void entry.release().catch(() => logger.warn("doorbell_rtc_trial_failed", "stage=stop")); };
    signal.addEventListener("abort", abort, { once: true });
    const releaseTrialPeer = this.#reserveTrialPeer(serial); this.#doorbellTrials.set(serial, entry);
    return entry.release;
  }

  async #startDoorbellRtcTrial(serial: string): Promise<void> {
    const entry = this.#doorbellTrials.get(serial)!;
    if (entry.connecting || entry.session || entry.controller.signal.aborted) throw new DoorbellRtcError("cancelled");
    entry.connecting = true;
    const generation = entry.generation;
    const current = (): boolean => {
      const device = this.#devices.get(serial);
      return generation === this.#startupGeneration && this.#doorbellTrials.get(serial) === entry
        && !this.#recordingClosing && !entry.controller.signal.aborted && !!device
        && this.#doorbellRtcBinding(device) && !inventoryBindingChanged(entry.device, device)
        && device.adminUserId === entry.device.adminUserId;
    };
    try {
      const context = await this.#client.nvrSignallingContext(serial, this.config.experimentalNvrRegion ?? "auto", entry.controller.signal);
      if (!current()) throw new DoorbellRtcError("cancelled");
      const session = entry.session = new DoorbellRtcSession({ station: serial,
        administrator: entry.device.adminUserId!, context, signal: entry.controller.signal, current,
        ready: output => {
          if (!current()) throw new DoorbellRtcError("cancelled");
          this.#events?.streamStarted(serial, output, () => "h264");
        },
      });
      session.output.once("error", error => logger.warn("doorbell_rtc_trial_failed",
        `stage=${error instanceof DoorbellRtcError ? error.stage : "video"} reason=${error instanceof DoorbellRtcError ? error.reason : "unspecified"}`));
      await session.start();
    } catch (error) {
      const failure = error instanceof DoorbellRtcError ? error : new DoorbellRtcError(entry.controller.signal.aborted ? "cancelled" : "sign");
      logger.warn("doorbell_rtc_trial_failed", `stage=${failure.stage} reason=${failure.reason}`);
      await entry.release(); throw failure;
    }
  }

  #nvrBinding(device: MegaInventoryDevice | undefined, station: MegaInventoryDevice | undefined): boolean {
    const parents = [["T8N00", 300], ["T9000", 27]] as const;
    return !!this.config.experimentalNvrLive && !!device && !!station
      && device.category === "eufy_security" && station.category === "eufy_security"
      && nvrTrialSensor(device.model, device.deviceType) !== null && device.channel !== null
      && Number.isInteger(device.channel) && device.channel >= 0 && device.channel <= 254
      && parents.some(([model, type]) => station.model === model && station.deviceType === type)
      && !!station.adminUserId && (device.adminUserId === null || device.adminUserId === station.adminUserId);
  }

  #nvrTrialIdentity(device: MegaInventoryDevice): Required<CameraIdentity> | null {
    const station = this.#devices.get(device.parentSerial);
    if (!this.#nvrBinding(device, station) && !this.#nvrLiveAdmitted(device, station)) return null;
    const profile = this.#normalNvrLiveBinding(device, station) && this.#nvrLiveAdmitted(device, station) ? nvrLiveProfile(device.model, device.deviceType) : null;
    const values = this.#nvrCachedSettings(device);
    const view = this.#nvrView(device);
    return {
      serial: device.serial, name: device.name, model: device.model, stationSerial: device.parentSerial,
      catalogueStatus: profile ? "ready_to_test" : "recognised", firmware: null, hardwareVersion: null, firmwareSubVersion: null,
      firmwareUpdateAvailable: null, rssi: null, audioSettings: null, reportedSettings: profile ? { streamingQualityTier: values.quality, imageFlipped: null, statusLedEnabled: null, soundDetectionEnabled: null } : null,
      enabled: null, motionDetectionEnabled: null, guardMode: null, nightVisionMode: values.night,
      nvrPanControlSupported: !!profile && (!profile.opticalZoom || view === 1),
      nvrOpticalZoomControlSupported: !!profile?.opticalZoom && view === 1,
      nvrViewOptions: profile?.views ?? [], nvrSelectedView: profile ? view : null,
      autoNightVisionEnabled: null, aiTrackingEnabled: null, battery: null,
      streamSupported: this.#normalNvrLiveBinding(device, station), startupSnapshotSupported: false,
      doorbellSupported: false, audioRecordingControlSupported: false,
      streamingQualityControlSupported: !!profile && values.quality !== null, storedRecordingsSupported: false, liveAudioSupported: false,
      talkbackSupported: false, enableControlSupported: false, motionDetectionControlSupported: false,
      guardModeControlSupported: false, guardModeRefreshSupported: false, nightVisionControlSupported: !!profile && values.night !== null,
      autoNightVisionControlSupported: false, cameraLightControlSupported: false, timedLightControlSupported: false,
      cameraSirenControlSupported: false, presetPositionControlSupported: false, aiTrackingControlSupported: false,
      autoCruiseControlSupported: false, motionSensitivityControlSupported: false, motionSensitivitySteps: null, homebaseChimeControlSupported: false, preferenceControls: [], streamingQualityModes: profile?.quality ?? [], nightVisionModes: profile?.night ?? [],
    };
  }

  /** Reserve an explicit diagnostic lease before credentials or sockets are requested. */
  reserveNvrLiveTrial(serial: string, signal: AbortSignal): () => Promise<void> {
    return this.#reserveNvrTrial(serial, signal, false, true);
  }

  #reserveNvrTrial(serial: string, signal: AbortSignal, stateOnly: boolean, diagnostic: boolean): () => Promise<void> {
    const device = this.#devices.get(serial), station = device ? this.#devices.get(device.parentSerial) : undefined;
    if (!this.config.experimentalNvrLive || this.#recordingClosing || signal.aborted || !this.#client.isAuthenticated
      || this.#localMotionAborters.size || this.#nvrTrials.size || !device || !station || this.#nvrControlReserved(station.serial) || !(diagnostic ? this.#nvrBinding(device, station) : this.#normalNvrLiveBinding(device, station)) || this.#recordingPeerReserved(serial) || this.#stationHasActiveMedia(station.serial)) throw new NvrTrialError("admission");
    const controller = new AbortController();
    let closed: Promise<void> | null = null;
    const deadline = diagnostic
      ? setTimeout(() => { controller.abort(); void entry.session?.close().catch(() => {}); }, 85_000)
      : null;
    const entry = { controller, device, station, stateOnly, diagnostic, generation: this.#startupGeneration,
      sensor: diagnostic ? nvrTrialSensor(device.model, device.deviceType)! : this.#nvrView(device), connecting: false, retiring: false, terminalRetirement: false,
      session: null as NvrRtcSession | null, release: (): Promise<void> => {
      if (closed) return closed;
      entry.retiring = true;

      // The media manager detaches its source listeners before stopping it.
      // Cancellation must still have an error sink during transport retirement.
      if (entry.session && entry.session.output.listenerCount("error") === 0) entry.session.output.on("error", () => {});
      controller.abort();
      closed = (async () => {
        if (deadline) clearTimeout(deadline);
        try { await entry.session?.close(); }
        finally {
          signal.removeEventListener("abort", abort);
          const owned = this.#nvrTrials.get(serial) === entry;
          if (owned) this.#nvrTrials.delete(serial);
          releaseTrialPeer();
          const waiting = this.#streamStarts.get(serial);

          // The manager already observed the terminal source. Its replacement
          // viewer may now be waiting here, so old cleanup must not stop it.
          const handingOff = entry.terminalRetirement && waiting && !waiting.cancelled
            && entry.generation === this.#startupGeneration;
          if (owned && !handingOff) this.#events?.streamStopped(serial);
        }
      })();
      return closed;
    } };
    const abort = (): void => { controller.abort(); void entry.session?.close().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    const releaseTrialPeer = this.#reserveTrialPeer(station.serial); this.#nvrTrials.set(serial, entry);
    return entry.release;
  }

  async #nvrTrialSession(serial: string): Promise<NvrRtcSession> {
    const entry = this.#nvrTrials.get(serial)!;
    if (entry.connecting || entry.session || entry.controller.signal.aborted) throw new NvrTrialError("cancelled");
    entry.connecting = true;
    const current = (): boolean => {
      const device = this.#devices.get(serial), station = this.#devices.get(entry.station.serial);
      return this.#nvrTrials.get(serial) === entry && entry.generation === this.#startupGeneration
        && (entry.diagnostic || this.#nvrView(entry.device) === entry.sensor) && !this.#recordingClosing && !entry.controller.signal.aborted
        && !!device && !!station && (entry.diagnostic ? this.#nvrBinding(device, station) : this.#normalNvrLiveBinding(device, station)) && !inventoryBindingChanged(entry.device, device)
        && station.deviceType === entry.station.deviceType && station.model === entry.station.model && station.adminUserId === entry.station.adminUserId;
    };
    let phaseAbort: (() => void) | undefined;
    try {
      const context = await Promise.race([
        this.#client.nvrSignallingContext(entry.station.serial, this.config.experimentalNvrRegion ?? "auto", entry.controller.signal),
        new Promise<never>((_, reject) => { phaseAbort = () => reject(new NvrTrialError("cancelled"));
          entry.controller.signal.addEventListener("abort", phaseAbort, { once: true }); }),
      ]);
      if (!current()) throw new NvrTrialError("cancelled");
      const session = new NvrRtcSession({ station: entry.station.serial, camera: serial, channel: entry.device.channel!,
        cameraType: entry.device.deviceType!, sensor: entry.sensor,
        liveControls: !entry.diagnostic && this.#nvrLiveAdmitted(entry.device, entry.station),
        administrator: entry.station.adminUserId!, context, signal: entry.controller.signal, current,
        maximumLifetimeMilliseconds: entry.diagnostic ? 75_000 : this.config.maxStreamSeconds * 1_000,
        ready: (output, codec) => this.#events?.streamStarted(serial, output, codec) });
      entry.session = session;
      return session;
    } finally { if (phaseAbort) entry.controller.signal.removeEventListener("abort", phaseAbort); }
  }

  async #startNvrTrial(serial: string): Promise<void> {
    const entry = this.#nvrTrials.get(serial)!;
    try {
      const session = await this.#nvrTrialSession(serial);
      let terminalHandled = false;
      const retire = (): void => {
        if (terminalHandled || entry.retiring) return;
        terminalHandled = true;
        entry.terminalRetirement = true;
        void entry.release().catch(() => {});
      };
      const failure = (error: unknown): void => {
        if (terminalHandled) return;
        const failure = error instanceof NvrTrialError ? error : new NvrTrialError("video");
        const details = `stage=${failure.stage} reason=${failure.reason} ${nvrTrialCounters(session)}`;
        if (failure.stage === "cancelled" && session.stats.video > 0) {
          logger.info(entry.diagnostic ? "nvr_live_trial_completed" : "nvr_live_stream_completed", `stage=completed ${nvrTrialCounters(session)}`);
        } else logger.warn(entry.diagnostic ? "nvr_live_trial_failed" : "nvr_live_stream_failed", details);
        if (!entry.diagnostic && !entry.stateOnly) retire();
      };
      if (entry.diagnostic || entry.stateOnly) session.output.once("error", failure);
      else {
        session.output.on("error", failure);
        session.output.once("end", retire);
        session.output.once("close", retire);

        // PassThrough finishes even when no reader consumes its readable side.
        session.output.once("finish", retire);
      }
      await session.start();
      if (!entry.diagnostic && this.#nvrLiveAdmitted(entry.device, entry.station)) {
        void session.initialLiveSettings().then(values => {
          if (this.#nvrTrials.get(serial) === entry && !entry.retiring && !entry.controller.signal.aborted) this.#publishNvrSettings(entry.device, values);
        }).catch(() => {});
      }
    }
    catch (error) {
      const failure = error instanceof NvrTrialError ? error : new NvrTrialError("sign");
      logger.warn(entry.diagnostic ? "nvr_live_trial_failed" : "nvr_live_stream_failed",
        `stage=${failure.stage} reason=${failure.reason}${entry.session ? " " + nvrTrialCounters(entry.session) : ""}`);
      await entry.release(); throw failure;
    }
  }

  /** Query selected NVR settings under an exclusive lease, without media or writes. */
  async readNvrStateTrial(serial: string, signal: AbortSignal): Promise<NvrStateSummary> {
    let release: (() => Promise<void>) | undefined;
    try {
      release = this.#reserveNvrTrial(serial, signal, true, true);
      const entry = this.#nvrTrials.get(serial)!;
      const startedAt = Date.now();
      const current = (): void => {
        if (signal.aborted || entry.controller.signal.aborted || this.#nvrTrials.get(serial) !== entry || this.#recordingClosing) {
          throw new NvrTrialError("cancelled");
        }
        const child = this.#devices.get(serial), parent = this.#devices.get(entry.station.serial);
        if (!child || !parent || inventoryBindingChanged(entry.device, child)
          || inventoryBindingChanged(entry.station, parent)) throw new NvrTrialError("state", "state_binding_changed");
        if (Date.now() < startedAt || Date.now() - startedAt > 45_000) throw new NvrTrialError("state", "state_inventory_expired");
      };
      const freshInventory = async (): Promise<MegaInventoryDevice> => {
        current();
        const inventory = await this.#client.inventory(entry.controller.signal);
        current();
        if (inventory.devices.filter(device => device.device_sn === serial).length !== 1
          || inventory.devices.filter(device => device.device_sn === entry.station.serial).length !== 1) {
          throw new NvrTrialError("state", "state_binding_changed");
        }
        const devices = parseMegaInventory(inventory);
        const children = devices.filter(device => device.serial === serial);
        const parents = devices.filter(device => device.serial === entry.station.serial);
        const child = children[0], parent = parents[0];
        if (children.length !== 1 || parents.length !== 1 || !child || !parent || !this.#nvrBinding(child, parent)
          || inventoryBindingChanged(entry.device, child) || inventoryBindingChanged(entry.station, parent)) {
          throw new NvrTrialError("state", "state_binding_changed");
        }
        return parent;
      };
      await freshInventory();
      const result = await (await this.#nvrTrialSession(serial)).readState();
      current();
      const station = await freshInventory();
      current();
      const configured = station.reads.guardMode ?? null;
      return { ...result,
        configuredGuardMode: validGuardMode(configured) ? configured : null,
        configuredGuardModeSource: validGuardMode(configured) ? "inventory" : null,
        inventoryQueriedAt: new Date().toISOString(),
        effectiveGuardMode: entry.station.model === "T8N00" ? null : result.effectiveGuardMode,
        cameraPowerSource: result.cameraPower === null ? null : "query",
      };
    } catch (error) {
      const failure = error instanceof NvrTrialError ? error : new NvrTrialError(signal.aborted ? "cancelled" : "state");
      logger.warn("nvr_state_trial_failed", `stage=${failure.stage} reason=${failure.reason}`);
      throw failure;
    } finally {
      try { await release?.(); }
      catch { throw new NvrTrialError("state"); }
    }
  }

  /** Test one separately admitted NVR camera and retain its lease through recovery. */
  async testNvrCameraPower(serial: string, request: NvrPowerRequest, signal: AbortSignal): Promise<NvrPowerSummary> {
    const device = this.#devices.get(serial), generation = this.#startupGeneration;
    const station = device ? this.#devices.get(device.parentSerial) : undefined;
    const valid = (rows: readonly MegaInventoryDevice[]): boolean => {
      if (!device || !station || device.model !== "T8E00" || device.deviceType !== 301
        || station.model !== "T8N00" || station.deviceType !== 300 || device.parentSerial === serial
        || device.channel === null || !Number.isInteger(device.channel) || device.channel < 0 || device.channel > 254
        || !device.adminUserId || device.adminUserId !== station.adminUserId
        || !/^[A-Za-z0-9_-]{1,255}$/.test(device.adminUserId) || !this.#client.isAuthenticatedUser(device.adminUserId)) return false;
      const children = rows.filter(row => row.serial === serial), parents = rows.filter(row => row.serial === station.serial);
      return children.length === 1 && parents.length === 1
        && rows.filter(row => row.serial !== station.serial && row.parentSerial === station.serial && row.channel === device.channel).length === 1
        && !inventoryBindingChanged(device, children[0]!) && !inventoryBindingChanged(station, parents[0]!);
    };
    if (!this.config.experimentalNvrControls || !this.config.experimentalModelControls || !this.config.experimentalNvrLive
      || !valid([...this.#devices.values()]) || !["on", "off"].includes(request.originalPower) || !["on", "off"].includes(request.target)
      || signal.aborted || this.#recordingClosing) throw new NvrPowerError("admission");
    const peer = station!;
    const now = performance.now();
    for (const [key, until] of this.#nvrPowerCooldowns) if (until <= now) this.#nvrPowerCooldowns.delete(key);
    const controls = [this.#cameraOperations, this.#cameraCapabilityOperations, this.#streamingQualityOperations,
      this.#audioRecordingOperations, this.#motionOperations, this.#nightVisionOperations, this.#guardModeOperations,
      this.#lightOperations, this.#panControlOperations, this.#cameraSirenOperations];
    const related = [...this.#devices.values()].filter(row => row.serial === peer.serial || row.parentSerial === peer.serial);
    if (this.#trialPeers.has(peer.serial) || this.#recordingPeerReserved(serial) || this.#recordingIndexActive
      || this.#stationOperations.has(peer.serial) || this.#nvrPowerEntries.has(peer.serial) || this.#nvrGuardEntries.has(peer.serial)
      || (this.#nvrPowerCooldowns.get(peer.serial) ?? 0) > performance.now()
      || (this.#nvrGuardCooldowns.get(peer.serial) ?? 0) > performance.now() || this.#nvrGuardLatches.has(peer.serial)
      || this.#nvrPowerCooldowns.size + this.#nvrPowerEntries.size >= 100
      || [...this.#nvrTrials.values()].some(row => row.station.serial === peer.serial)
      || related.some(row => this.#ppcsStreams.has(row.serial) || this.#streamStarts.has(row.serial) || controls.some(map => map.has(row.serial)))) {
      throw new NvrPowerError("busy");
    }
    const entry = { controller: new AbortController(), session: null as NvrRtcSession | null };
    const releaseTrialPeer = this.#reserveTrialPeer(peer.serial); this.#nvrPowerEntries.set(peer.serial, entry);
    let invalid = false, recovering = false, attempted = false;
    const current = (): void => {
      if (this.#recordingClosing || entry.controller.signal.aborted) throw new NvrPowerError("shutdown", attempted);
      if (invalid || generation !== this.#startupGeneration || this.#nvrPowerEntries.get(peer.serial) !== entry
        || !valid([...this.#devices.values()])) throw new NvrPowerError("identity", attempted);
    };
    const bounded = async <T>(operation: (signal: AbortSignal) => Promise<T>, phase: AbortSignal): Promise<T> => {
      const ownedSignal = AbortSignal.any([phase, entry.controller.signal, AbortSignal.timeout(5_000)]);
      current(); ownedSignal.throwIfAborted();
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new NvrPowerError("inventory", attempted));
        ownedSignal.addEventListener("abort", abort, { once: true });
        if (ownedSignal.aborted) abort();
      });
      try { const value = await Promise.race([operation(ownedSignal), cancelled]); current(); ownedSignal.throwIfAborted(); return value; }
      finally { ownedSignal.removeEventListener("abort", abort); }
    };
    const inventory = async (recovery: boolean, phase: AbortSignal): Promise<void> => {
      current(); phase.throwIfAborted();
      let raw: Awaited<ReturnType<MegaClient["inventory"]>>;
      try {
        raw = await bounded(cancellation => this.#client.inventory(cancellation), phase);
      } catch (error) {
        current(); phase.throwIfAborted();
        if (!recovery || invalid || !entry.session) throw error instanceof NvrPowerError ? error : new NvrPowerError("inventory", attempted);

        // Only request failure can use the same-session recovery fallback.
        await bounded(cancellation => entry.session!.validatePowerTrial(cancellation), phase);
        return;
      }
      try {
        if (!Array.isArray(raw.devices) || raw.devices.filter(row => row.device_sn === serial).length !== 1
          || raw.devices.filter(row => row.device_sn === peer.serial).length !== 1
          || raw.devices.filter(row => row.device_sn === serial || row.device_sn === peer.serial).some(row => !isRecord(row.member) || row.member.admin_user_id !== peer.adminUserId)
          || !valid(parseMegaInventory(raw))) {
          throw new NvrPowerError("identity", attempted);
        }
      } catch {
        invalid = true;
        throw new NvrPowerError("identity", attempted);
      }
      current();
    };
    const deadline = setTimeout(() => entry.controller.abort(), 120_000);
    const bindingTimer = setInterval(() => {
      try { current(); } catch { entry.controller.abort(); }
    }, 1_000);
    const transport = {
      prepare: async (phase: AbortSignal): Promise<void> => {
        await inventory(false, phase); current(); phase.throwIfAborted();
        const context = await bounded(cancellation => this.#client.nvrSignallingContext(peer.serial, this.config.experimentalNvrRegion ?? "auto", cancellation), phase);
        current(); phase.throwIfAborted();
        entry.session = new NvrRtcSession({ station: peer.serial, camera: serial, channel: device!.channel!, cameraType: 301,
          administrator: peer.adminUserId!, context, signal: entry.controller.signal, powerTrial: true, maximumLifetimeMilliseconds: 120_000,
          current: () => { try { current(); return true; } catch { return false; } }, ready: () => { throw new NvrPowerError("identity"); } });
        await entry.session.preparePowerTrial(); current(); phase.throwIfAborted();
      },
      validate: async (recovery: boolean, phase: AbortSignal): Promise<void> => {
        recovering = recovery;
        await inventory(recovery, phase); current(); phase.throwIfAborted();
        if (!entry.session) throw new NvrPowerError("identity", attempted);
        await entry.session.validatePowerTrial(phase); current();
      },
      read: async (phase: AbortSignal) => {
        current(); phase.throwIfAborted();
        if (!entry.session) throw new NvrPowerError("identity", attempted);
        const value = await entry.session.readPowerTrial(phase);
        await inventory(recovering, phase); current();
        return value;
      },
      write: async (value: "on" | "off", phase: AbortSignal, dispatched: () => void): Promise<void> => {
        current(); phase.throwIfAborted();
        if (!entry.session) throw new NvrPowerError("identity", attempted);
        await entry.session.writePowerTrial(value, phase, () => { current(); phase.throwIfAborted(); attempted = true; dispatched(); });
      },
      close: async (): Promise<void> => { await entry.session?.close(); },
    };
    try {
      const result = await runNvrPowerTrial(transport, request, signal);
      logger.info("nvr_power_trial_result", `outcome=${result.outcome} restored=true physical_confirmation_required=true`);
      return result;
    } catch (error) {
      const failure = error instanceof NvrPowerError ? error : new NvrPowerError("restore", attempted);
      logger.warn("nvr_power_trial_failed", `stage=${failure.stage} manual_restore_required=${failure.manualRestoreRequired}`);
      throw failure;
    } finally {
      clearTimeout(deadline); clearInterval(bindingTimer); entry.controller.abort();
      if (attempted) this.#nvrPowerCooldowns.set(peer.serial, performance.now() + 60_000);
      if (this.#nvrPowerEntries.get(peer.serial) === entry) {
        this.#nvrPowerEntries.delete(peer.serial); releaseTrialPeer();
      }
    }
  }

  /** Temporarily change one exact T8N00 from Schedule to Home and restore it. */
  async testNvrGuardMode(serial: string, request: NvrGuardRequest, signal: AbortSignal): Promise<NvrGuardSummary> {
    nvrGuardTimeZone(request.timeZone);
    const device = this.#devices.get(serial), generation = this.#startupGeneration;
    const station = device ? this.#devices.get(device.parentSerial) : undefined;
    const valid = (rows: readonly MegaInventoryDevice[]): boolean => {
      if (!device || !station || device.model !== "T8E00" || device.deviceType !== 301
        || station.model !== "T8N00" || station.deviceType !== 300 || device.parentSerial === serial
        || device.channel === null || !Number.isInteger(device.channel) || device.channel < 0 || device.channel > 254
        || !device.adminUserId || device.adminUserId !== station.adminUserId
        || !/^[A-Za-z0-9_-]{1,255}$/.test(device.adminUserId) || !this.#client.isAuthenticatedUser(device.adminUserId)) return false;
      const children = rows.filter(row => row.serial === serial), parents = rows.filter(row => row.serial === station.serial);
      return children.length === 1 && parents.length === 1
        && rows.filter(row => row.serial !== station.serial && row.parentSerial === station.serial && row.channel === device.channel).length === 1
        && !inventoryBindingChanged(device, children[0]!) && !inventoryBindingChanged(station, parents[0]!);
    };
    const state = (raw: unknown): NvrGuardState | null => {
      if (!isRecord(raw) || !Array.isArray(raw.devices)) return null;
      const matches = raw.devices.filter((row: unknown) => isRecord(row) && row.device_sn === station?.serial);
      if (matches.length !== 1 || !isRecord(matches[0]) || !Array.isArray(matches[0].params)) return null;
      const parameter = (type: number): unknown => {
        const rows = matches[0]!.params.filter((row: unknown) => isRecord(row) && integer(row.param_type) === type);
        if (rows.length !== 1) throw new NvrGuardError("inventory");
        return rows[0]!.param_value;
      };
      const configured = integer(parameter(1224));
      const schedule = parameter(1254);
      return { mode: configured !== null && [0, 1, 2, 3, 4, 5, 47, 63].includes(configured) ? configured : null,
        schedule: typeof schedule === "string" && schedule.length > 0 && schedule.length <= 65_536 ? schedule : null };
    };
    if (!this.config.experimentalNvrControls || !this.config.experimentalModelControls || !this.config.experimentalNvrLive
      || !valid([...this.#devices.values()]) || request.target !== "home" || signal.aborted || this.#recordingClosing) {
      throw new NvrGuardError("admission");
    }
    const peer = station!;
    const now = performance.now();
    for (const [key, until] of this.#nvrGuardCooldowns) if (until <= now) this.#nvrGuardCooldowns.delete(key);
    const controls = [this.#cameraOperations, this.#cameraCapabilityOperations, this.#streamingQualityOperations,
      this.#audioRecordingOperations, this.#motionOperations, this.#nightVisionOperations, this.#guardModeOperations,
      this.#lightOperations, this.#panControlOperations, this.#cameraSirenOperations];
    const related = [...this.#devices.values()].filter(row => row.serial === peer.serial || row.parentSerial === peer.serial);
    if (this.#trialPeers.has(peer.serial) || this.#recordingPeerReserved(serial) || this.#recordingIndexActive
      || this.#stationOperations.has(peer.serial) || this.#nvrPowerEntries.has(peer.serial) || this.#nvrGuardEntries.has(peer.serial)
      || (this.#nvrPowerCooldowns.get(peer.serial) ?? 0) > performance.now()
      || (this.#nvrGuardCooldowns.get(peer.serial) ?? 0) > performance.now() || this.#nvrGuardLatches.has(peer.serial)
      || this.#nvrGuardCooldowns.size + this.#nvrGuardEntries.size + this.#nvrGuardLatches.size >= 100
      || [...this.#nvrTrials.values()].some(row => row.station.serial === peer.serial)
      || related.some(row => this.#ppcsStreams.has(row.serial) || this.#streamStarts.has(row.serial)
        || controls.some(map => map.has(row.serial)))) throw new NvrGuardError("busy");
    const entry = { controller: new AbortController(), session: null as NvrRtcSession | null, attempted: false, warned: false };
    const releaseTrialPeer = this.#reserveTrialPeer(peer.serial); this.#nvrGuardEntries.set(peer.serial, entry);
    let invalid = false, recovering = false, attempted = false;
    const current = (): void => {
      if (this.#recordingClosing || entry.controller.signal.aborted) throw new NvrGuardError("shutdown", attempted);
      if (invalid || generation !== this.#startupGeneration || this.#nvrGuardEntries.get(peer.serial) !== entry
        || !attempted && !valid([...this.#devices.values()])) throw new NvrGuardError("identity", attempted);
    };
    const bounded = async <T>(operation: (owned: AbortSignal) => Promise<T>, phase: AbortSignal): Promise<T> => {
      const ownedSignal = AbortSignal.any([phase, entry.controller.signal, AbortSignal.timeout(5_000)]);
      current(); ownedSignal.throwIfAborted();
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new NvrGuardError("inventory", attempted));
        ownedSignal.addEventListener("abort", abort, { once: true });
        if (ownedSignal.aborted) abort();
      });
      try { const value = await Promise.race([operation(ownedSignal), cancelled]); current(); ownedSignal.throwIfAborted(); return value; }
      finally { ownedSignal.removeEventListener("abort", abort); }
    };
    let reads = 0, nextRead = 0, backoff = 2_000;
    const inventory = async (recovery: boolean, phase: AbortSignal): Promise<NvrGuardState> => {
      if (++reads > 60) throw new NvrGuardError("inventory", attempted);
      if (performance.now() < nextRead) await guardDelay(nextRead - performance.now(), phase);
      nextRead = performance.now() + backoff;
      current(); phase.throwIfAborted();
      let raw: Awaited<ReturnType<MegaClient["inventory"]>>;
      try { raw = await bounded(cancellation => this.#client.inventory(cancellation), phase); }
      catch (error) {
        backoff = Math.min(8_000, backoff * 2);
        current(); phase.throwIfAborted();
        if (!recovery || invalid || !entry.session) throw error instanceof NvrGuardError
          ? error : new NvrGuardError("inventory", attempted);
        await bounded(cancellation => entry.session!.validateGuardTrial(cancellation), phase);
        throw new NvrGuardError("inventory", attempted);
      }
      if (!this.#client.isAuthenticatedUser(peer.adminUserId!)) {
        if (this.#client.isAuthenticated) { invalid = true; throw new NvrGuardError("identity", attempted); }
        throw new NvrGuardError("inventory", attempted);
      }
      try {
        if (!Array.isArray(raw.devices) || raw.devices.filter(row => row.device_sn === serial).length !== 1
          || raw.devices.filter(row => row.device_sn === peer.serial).length !== 1
          || raw.devices.filter(row => row.device_sn === serial || row.device_sn === peer.serial).some(row => !isRecord(row.member) || row.member.admin_user_id !== peer.adminUserId)
          || !valid(parseMegaInventory(raw))) {
          throw new NvrGuardError("identity", attempted);
        }
      } catch { invalid = true; throw new NvrGuardError("identity", attempted); }
      backoff = 2_000;
      const projected = state(raw);
      if (!projected) throw new NvrGuardError("inventory", attempted);
      current(); return projected;
    };
    const deadline = setTimeout(() => entry.controller.abort(), 180_000);
    const bindingTimer = setInterval(() => { try { current(); } catch { entry.controller.abort(); } }, 1_000);
    const transport = {
      prepare: async (phase: AbortSignal): Promise<void> => {
        await inventory(false, phase); current(); phase.throwIfAborted();
        const context = await bounded(cancellation => this.#client.nvrSignallingContext(peer.serial,
          this.config.experimentalNvrRegion ?? "auto", cancellation), phase);
        current(); phase.throwIfAborted();
        entry.session = new NvrRtcSession({ station: peer.serial, camera: serial, channel: device!.channel!, cameraType: 301,
          administrator: peer.adminUserId!, userName: peer.userName ?? "", context, signal: entry.controller.signal,
          guardTrial: true, maximumLifetimeMilliseconds: 175_000,
          current: () => { try { current(); return true; } catch { return false; } },
          ready: () => { throw new NvrGuardError("identity"); } });
        await entry.session.prepareGuardTrial(); current(); phase.throwIfAborted();
      },
      validate: async (recovery: boolean, phase: AbortSignal): Promise<void> => {
        recovering = recovery;
        if (!recovery) await inventory(false, phase);
        current(); phase.throwIfAborted();
        const currentChild = this.#devices.get(serial), currentParent = this.#devices.get(peer.serial);
        if (!currentChild || !currentParent || inventoryBindingChanged(device!, currentChild)
          || inventoryBindingChanged(peer, currentParent)) { invalid = true; throw new NvrGuardError("identity", attempted); }
        if (!this.#client.isAuthenticatedUser(peer.adminUserId!)) {
          if (this.#client.isAuthenticated) { invalid = true; throw new NvrGuardError("identity", attempted); }
          throw new NvrGuardError("inventory", attempted);
        }
        if (!entry.session) throw new NvrGuardError("identity", attempted);
        await entry.session.validateGuardTrial(phase, recovery); current();
      },
      read: async (phase: AbortSignal): Promise<NvrGuardState> => inventory(recovering, phase),
      write: async (mode: 1 | 2, phase: AbortSignal, dispatched: () => void): Promise<void> => {
        current(); phase.throwIfAborted();
        if (!entry.session) throw new NvrGuardError("identity", attempted);
        await entry.session.writeGuardTrial(mode, phase, () => {
          current(); phase.throwIfAborted();
          const child = this.#devices.get(serial), parent = this.#devices.get(peer.serial);
          if (!child || !parent || inventoryBindingChanged(device!, child) || inventoryBindingChanged(peer, parent)) {
            invalid = true; throw new NvrGuardError("identity", attempted);
          }
          if (!this.#client.isAuthenticatedUser(peer.adminUserId!)) throw new NvrGuardError("inventory", attempted);
          attempted = true; entry.attempted = true; dispatched();
        });
      },
      effective: async (mode: NvrGuardEffective, phase: AbortSignal): Promise<void> => {
        current(); phase.throwIfAborted();
        if (!entry.session) throw new NvrGuardError("identity", attempted);
        await entry.session.confirmGuardEffectiveTrial(mode, phase); current();
      },
      close: async (): Promise<void> => { await entry.session?.close(); },
    };
    try {
      const result = await runNvrGuardTrial(transport, request, signal);
      logger.info("nvr_guard_trial_result", "outcome=" + result.outcome
        + " restored=true schedule_unchanged=true physical_confirmation_required=true");
      return result;
    } catch (error) {
      const failure = error instanceof NvrGuardError ? error : new NvrGuardError("restore", attempted);
      if (attempted && failure.manualRestoreRequired) this.#nvrGuardLatches.add(peer.serial);
      if (!entry.warned) logger.warn("nvr_guard_trial_failed", `stage=${failure.stage} manual_restore_required=${failure.manualRestoreRequired}`);
      throw failure;
    } finally {
      clearTimeout(deadline); clearInterval(bindingTimer); entry.controller.abort();
      if (attempted) this.#nvrGuardCooldowns.set(peer.serial, performance.now() + 60_000);
      if (this.#nvrGuardEntries.get(peer.serial) === entry) {
        this.#nvrGuardEntries.delete(peer.serial); releaseTrialPeer();
      }
    }
  }

  /** Share an in-flight media start and retire bounded lookup retries on stop. */
  async startStream(serial: string): Promise<void> {
    const nvrStartingDevice = this.#devices.get(serial);
    if (nvrStartingDevice && this.#nvrLiveJobs.has(nvrStartingDevice.parentSerial)) throw new NvrLiveControlError("busy");
    if (this.#doorbellTrials.has(serial)) return this.#startDoorbellRtcTrial(serial);
    const nvrTrial = this.#nvrTrials.get(serial);
    if (nvrTrial?.stateOnly) throw new NvrTrialError("admission");
    if (nvrTrial?.diagnostic && nvrTrial.retiring) throw new NvrTrialError("cancelled");
    if (nvrTrial && !nvrTrial.retiring) return this.#startNvrTrial(serial);
    const pending = this.#streamStarts.get(serial);
    if (pending && !pending.cancelled) return pending.promise;
    const ticket = { promise: Promise.resolve(), cancelled: false };
    const generation = this.#startupGeneration;
    const current = (): void => {
      if (ticket.cancelled || this.#streamStarts.get(serial) !== ticket
        || this.#recordingClosing || generation !== this.#startupGeneration) {
        throw new Error("Camera stream start cancelled");
      }
    };
    ticket.promise = Promise.resolve().then(async () => {
      current();
      if (nvrTrial?.retiring) {
        await nvrTrial.release().catch(() => {});
        current();
        if (this.#nvrTrials.has(serial)) throw new NvrTrialError("admission");
      }
      const nvrDevice = this.#devices.get(serial);
      const nvrStation = nvrDevice ? this.#devices.get(nvrDevice.parentSerial) : undefined;
      if (nvrStation && this.#nvrControlReserved(nvrStation.serial)) throw new NvrTrialError("admission");
      if (nvrDevice && this.#normalNvrLiveBinding(nvrDevice, nvrStation)) {
        this.#reserveNvrTrial(serial, new AbortController().signal, false, false);
        return this.#startNvrTrial(serial);
      }
      for (let attempt = 0; ; attempt++) {
        current();
        try { await this.#startStreamOnce(serial, current); return; }
        catch (error) {
          current();
          const device = this.#devices.get(serial);
          const route = device ? ppcsStreamRoute(device, this.#devices) : null;
          if (!(error instanceof PpcsLookupTimeoutError) || attempt >= 3 || !route || route.homeBaseAttached
            || device?.model !== "T8170" || device.deviceType !== 48) throw error;
        }
      }
    });
    this.#streamStarts.set(serial, ticket);
    try { await ticket.promise; }
    finally { if (this.#streamStarts.get(serial) === ticket) this.#streamStarts.delete(serial); }
  }

  #normalNvrLiveBinding(device: MegaInventoryDevice, station: MegaInventoryDevice | undefined): boolean {
    if (this.#nvrLiveAdmitted(device, station) && device.model === "T8416") return true;
    if (!this.config.normalNvrLive || !this.#nvrBinding(device, station) || !station) return false;
    return station.model === "T8N00" && station.deviceType === 300 && device.model === "T8E00" && device.deviceType === 301
      || station.model === "T9000" && station.deviceType === 27 && device.model === "T8140-Z" && device.deviceType === 14;
  }

  /** Install read-only media facts. The manager remains the sole owner of sources and viewers. */
  setNvrLiveMediaChecks(checks: { viewer: (serial: string) => boolean; active: (serial: string) => boolean; recording: (serial: string) => boolean }): void {
    this.#nvrMediaChecks = checks;
  }

  #nvrBindingKey(device: MegaInventoryDevice): string {
    const station = this.#devices.get(device.parentSerial);
    return JSON.stringify([device.model, device.deviceType, device.parentSerial, device.channel, device.adminUserId,
      station?.model, station?.deviceType, station?.adminUserId, this.#startupGeneration]);
  }

  #nvrView(device: MegaInventoryDevice): 0 | 1 {
    const preference = this.#nvrViews.get(device.serial);
    if (preference?.binding === this.#nvrBindingKey(device)) return preference.value;
    this.#nvrViews.delete(device.serial);
    return nvrLiveProfile(device.model, device.deviceType)?.defaultView ?? nvrTrialSensor(device.model, device.deviceType) ?? 0;
  }

  #nvrLiveAdmitted(device: MegaInventoryDevice, station: MegaInventoryDevice | undefined): boolean {
    return !this.#recordingClosing && !!this.config.normalNvrLive && !!this.config.experimentalNvrLive && !!this.config.experimentalModelControls && !!this.config.experimentalNvrControls
      && !!this.config.apiAuthenticationConfigured && !!nvrLiveProfile(device.model, device.deviceType)
      && device.category === "eufy_security" && !!station && station.category === "eufy_security" && station.model === "T8N00" && station.deviceType === 300 && !!station.adminUserId
      && /^[A-Za-z0-9_-]{1,255}$/.test(station.adminUserId) && this.#client.isAuthenticatedUser(station.adminUserId) && device.adminUserId === station.adminUserId
      && this.#nvrExplicitOwners.get(device.serial) === station.adminUserId && this.#nvrExplicitOwners.get(station.serial) === station.adminUserId
      && Number.isInteger(device.channel) && device.channel !== null && device.channel >= 0 && device.channel <= 254
      && [...this.#devices.values()].filter(row => row.parentSerial === station.serial && row.serial !== station.serial && row.channel === device.channel).length === 1;
  }

  /** Query current provider admission only. Optional quality validates the closed profile. */
  nvrLiveSettingAdmitted(serial: string, quality?: number): boolean {
    const device = this.#devices.get(serial);
    if (!device || !this.#nvrLiveAdmitted(device, this.#devices.get(device.parentSerial))) return false;
    return quality === undefined || nvrLiveProfile(device.model, device.deviceType)!.quality.some(mode => mode.value === quality);
  }

  #clearNvrSettings(serial: string): void {
    const cached = this.#nvrSettings.get(serial); if (cached?.timer) clearTimeout(cached.timer);
    this.#nvrSettings.delete(serial); this.#nvrViews.delete(serial);
  }

  #nvrObserveOwners(raw: Awaited<ReturnType<MegaClient["inventory"]>>): void {
    this.#nvrExplicitOwners.clear();
    for (const row of raw.devices) {
      if (raw.devices.filter(other => other.device_sn === row.device_sn).length !== 1 || !isRecord(row.member)
        || typeof row.member.admin_user_id !== "string" || typeof row.device_sn !== "string") continue;
      this.#nvrExplicitOwners.set(row.device_sn, row.member.admin_user_id);
    }
  }

  #nvrCachedSettings(device: MegaInventoryDevice): NvrLiveSettings {
    if (!this.#nvrLiveAdmitted(device, this.#devices.get(device.parentSerial))) {
      this.#clearNvrSettings(device.serial); return { night: null, quality: null };
    }
    const value = this.#nvrSettings.get(device.serial), now = Date.now();
    if (value && value.binding === this.#nvrBindingKey(device)) return {
      night: now >= value.nightAt && now - value.nightAt < 1800000 ? value.values.night : null,
      quality: now >= value.qualityAt && now - value.qualityAt < 1800000 ? value.values.quality : null,
    };
    if (value) this.#clearNvrSettings(device.serial);
    return { night: null, quality: null };
  }

  #publishNvrSettings(device: MegaInventoryDevice, values: NvrLiveSettings, field?: "night" | "quality" | "expiry"): void {
    const profile = nvrLiveProfile(device.model, device.deviceType), stored = this.#devices.get(device.serial);
    if (!stored || inventoryBindingChanged(device, stored) || !profile || !this.#nvrLiveAdmitted(stored, this.#devices.get(stored.parentSerial))) {
      this.#clearNvrSettings(device.serial); return;
    }
    const previous = this.#nvrSettings.get(device.serial); if (previous?.timer) clearTimeout(previous.timer);
    const bound = this.#nvrBindingKey(device), now = Date.now();
    const nightAt = (field === "quality" || field === "expiry") && previous?.binding === bound ? previous.nightAt : now;
    const qualityAt = (field === "night" || field === "expiry") && previous?.binding === bound ? previous.qualityAt : now;
    const filtered = {
      night: profile.night.some(mode => mode.value === values.night) && now >= nightAt && now - nightAt < 1800000 ? values.night : null,
      quality: profile.quality.some(mode => mode.value === values.quality) && now >= qualityAt && now - qualityAt < 1800000 ? values.quality : null,
    };
    const expiries = [filtered.night === null ? Infinity : nightAt + 1800000, filtered.quality === null ? Infinity : qualityAt + 1800000];
    const nextExpiry = Math.min(...expiries);
    const timer = Number.isFinite(nextExpiry) ? setTimeout(() => {
      if (this.#nvrSettings.get(device.serial)?.timer !== timer) return;
      const current = this.#devices.get(device.serial);
      if (current) this.#publishNvrSettings(current, this.#nvrCachedSettings(current), "expiry");
    }, Math.max(1, nextExpiry - now)) : null; timer?.unref();
    this.#nvrSettings.set(device.serial, { binding: bound, nightAt, qualityAt, timer, values: filtered });
    const identity = this.#nvrTrialIdentity(device); if (identity) this.#events?.camera(identity);
  }

  /** Change the next normal source only while the entire camera is idle. */
  async setNvrView(serial: string, view: number): Promise<CameraIdentity> {
    const device = this.#devices.get(serial), station = device && this.#devices.get(device.parentSerial);
    if (!device || !this.#nvrLiveAdmitted(device, station)) throw new NvrLiveControlError("disabled");
    if (view !== 0 && view !== 1) throw new NvrLiveControlError("unavailable");
    if (!this.#nvrMediaChecks || this.#nvrMediaChecks.active(serial) || this.#nvrTrials.has(serial) || this.#streamStarts.has(serial)
      || this.#nvrLiveJobs.has(device.parentSerial) || this.#recordingPeerReserved(serial) || this.#nvrControlReserved(device.parentSerial)) throw new NvrLiveControlError("busy");
    this.#nvrViews.set(serial, { binding: this.#nvrBindingKey(device), value: view });
    this.#publishNvrSettings(device, { night: null, quality: null });
    return this.#nvrTrialIdentity(device)!;
  }

  /** Submit one click or absolute optical step. A receipt never confirms physical movement. */
  async performNvrLiveControl(serial: string, request: NvrLiveControl, signal = AbortSignal.timeout(90000)): Promise<NvrLiveControlResult> {
    await this.#runNvrLiveControl(serial, request, signal);
    return { outcome: "request_accepted", physicalConfirmationRequired: true };
  }

  async #runNvrLiveControl(serial: string, request: NvrLiveControl | { kind: "night"; value: number } | { kind: "quality"; value: number }, external?: AbortSignal): Promise<CameraIdentity> {
    const device = this.#devices.get(serial), station = device && this.#devices.get(device.parentSerial);
    if (!device || !station || !this.#nvrLiveAdmitted(device, station)) throw new NvrLiveControlError("disabled");
    const profile = nvrLiveProfile(device.model, device.deviceType)!;
    const movement = request.kind === "pan" || request.kind === "zoom";
    const entry = this.#nvrTrials.get(serial), binding = this.#nvrBindingKey(device), view = this.#nvrView(device);
    const signal = AbortSignal.any([external ?? new AbortController().signal, entry?.controller.signal ?? AbortSignal.abort(), AbortSignal.timeout(90000)]);
    const current = (): void => {
      const child = this.#devices.get(serial), parent = this.#devices.get(station.serial);
      if (signal.aborted || this.#recordingClosing || !child || !parent || this.#nvrBindingKey(child) !== binding
        || !this.#nvrLiveAdmitted(child, parent) || this.#nvrView(child) !== view || this.#nvrTrials.get(serial) !== entry || entry?.generation !== this.#startupGeneration || entry?.sensor !== view || entry?.controller.signal.aborted) throw new NvrLiveControlError("unavailable");
      if (!entry || entry.diagnostic || entry.stateOnly || !entry.session || !this.#nvrMediaChecks
        || [...this.#devices.values()].some(row => row.parentSerial === station.serial && this.#nvrMediaChecks!.recording(row.serial)) || movement && !this.#nvrMediaChecks.viewer(serial)
        || this.#nvrControlReserved(station.serial) || this.#recordingIndexActive || this.#recordingReservations.size) throw new NvrLiveControlError("busy");
    };
    current();
    if (this.#nvrLiveJobs.has(station.serial)) throw new NvrLiveControlError("busy");
    if (movement && profile.opticalZoom && view !== 1 || request.kind === "zoom" && (!profile.opticalZoom || ![1, 2, 3].includes(request.level))
      || request.kind === "night" && !profile.night.some(mode => mode.value === request.value)
      || request.kind === "quality" && !profile.quality.some(mode => mode.value === request.value)) throw new NvrLiveControlError("unavailable");
    const last = this.#nvrLiveIntervals.get(station.serial);
    if (last !== undefined && performance.now() - last < 1000) throw new NvrLiveControlError("rate_limited");
    this.#nvrLiveJobs.add(station.serial); this.#nvrLiveIntervals.set(station.serial, performance.now());
    let dispatched = false;
    try {
      const raw = await this.#client.inventory(signal); current();
      const rows = parseMegaInventory(raw);
      if ([device, station].some(expected => {
        const originals = raw.devices.filter(row => row.device_sn === expected.serial);
        const parsed = rows.filter(row => row.serial === expected.serial);
        return originals.length !== 1 || !isRecord(originals[0]?.member) || originals[0].member.admin_user_id !== station.adminUserId
          || parsed.length !== 1 || inventoryBindingChanged(expected, parsed[0]!);
      }) || rows.filter(row => row.parentSerial === station.serial && row.serial !== station.serial && row.channel === device.channel).length !== 1) throw new NvrLiveControlError("unavailable");
      const session = entry!.session!;
      await session.prepareLiveControl(movement); current();
      if (request.kind === "night" || request.kind === "quality") {
        const field = request.kind;
        try {
          const initial = await session.readLiveSettings(signal);
          if (initial[field] === null) throw new NvrLiveControlError("unavailable");
        } catch {
          this.#publishNvrSettings(device, { ...this.#nvrCachedSettings(device), [field]: null }, field);
          throw new NvrLiveControlError("unavailable");
        }
      }
      const before = (): void => { current(); dispatched = true; };
      if (request.kind === "quality" || request.kind === "night") {
        const field = request.kind;
        this.#publishNvrSettings(device, { ...this.#nvrCachedSettings(device), [field]: null }, field);
        if (request.kind === "quality") {
          await session.writeLiveControl({ ...request, sensor: 0 }, signal, before);
          await session.writeLiveControl({ ...request, sensor: 1 }, signal, before);
        } else await session.writeLiveControl(request, signal, before);
        const until = performance.now() + Math.min(10000, Math.max(0, session.remainingLifetimeMilliseconds - 2000));
        while (performance.now() < until) {
          current(); const remaining = Math.floor(until - performance.now());
          if (remaining < 1) break;
          const value = await session.readLiveSettings(signal, Math.min(5000, remaining)); current();
          if (value[field] === request.value) {
            this.#publishNvrSettings(device, { ...this.#nvrCachedSettings(device), [field]: request.value }, field);
            return this.#nvrTrialIdentity(device)!;
          }
          await cancellableDelay(Math.min(1000, Math.max(1, until - performance.now())), undefined, { signal });
        }
        throw new NvrLiveControlError("outcome_unknown", "dispatch");
      }
      await session.writeLiveControl(request, signal, before);
      logger.info("nvr_live_control_completed", `stage=request_accepted pan_data=${session.controlStats.panData} pan_ack_without_data=${session.controlStats.panAcknowledgedWithoutData}`);
      return this.#nvrTrialIdentity(device)!;
    } catch (error) {
      logger.warn("nvr_live_control_failed", `stage=${error instanceof NvrLiveControlError ? error.stage : "request"} pan_data=${entry?.session?.controlStats.panData ?? 0} pan_ack_without_data=${entry?.session?.controlStats.panAcknowledgedWithoutData ?? 0} pan_timeouts=${entry?.session?.controlStats.panTimeouts ?? 0}`);
      if (!this.nvrLiveSettingAdmitted(serial)) this.#clearNvrSettings(serial);
      if (dispatched) throw new NvrLiveControlError("outcome_unknown", "dispatch");
      throw error instanceof NvrLiveControlError ? error : new NvrLiveControlError("unavailable");
    } finally { this.#nvrLiveJobs.delete(station.serial); }
  }

  async #refreshNvrLiveCapabilities(serial: string): Promise<CameraIdentity> {
    const device = this.#devices.get(serial), station = device && this.#devices.get(device.parentSerial);
    if (!device || !station || !this.#nvrLiveAdmitted(device, station)) throw new NvrLiveControlError("disabled");
    if (this.#nvrLiveJobs.has(station.serial) || this.#streamStarts.has(serial) || this.#nvrControlReserved(station.serial)
      || this.#nvrMediaChecks?.recording(serial)) throw new NvrLiveControlError("busy");
    const last = this.#nvrReadIntervals.get(station.serial);
    if (last !== undefined && performance.now() - last < 10000) throw new NvrLiveControlError("rate_limited");
    this.#nvrReadIntervals.set(station.serial, performance.now()); this.#nvrLiveJobs.add(station.serial);
    let release: (() => Promise<void>) | undefined;
    try {
      let entry = this.#nvrTrials.get(serial);
      if (entry && (entry.generation !== this.#startupGeneration || entry.diagnostic || entry.stateOnly || !entry.session)) throw new NvrLiveControlError("busy");
      if (!entry) { release = this.#reserveNvrTrial(serial, AbortSignal.timeout(30000), true, false); entry = this.#nvrTrials.get(serial)!; }
      const session = entry.session ?? await this.#nvrTrialSession(serial);
      let values: NvrLiveSettings;
      try { await session.initialLiveSettings(); values = await session.readLiveSettings(entry.controller.signal); }
      catch { this.#publishNvrSettings(device, { night: null, quality: null }); throw new NvrLiveControlError("unavailable", "reply"); }
      if (this.#nvrTrials.get(serial) !== entry || entry.generation !== this.#startupGeneration || entry.controller.signal.aborted) throw new NvrLiveControlError("unavailable");
      this.#publishNvrSettings(device, values); return this.#nvrTrialIdentity(device)!;
    } catch (error) {
      if (error instanceof NvrLiveControlError) throw error;
      throw new NvrLiveControlError(error instanceof NvrTrialError && error.stage === "admission" ? "busy" : "unavailable");
    } finally { try { await release?.(); } finally { this.#nvrLiveJobs.delete(station.serial); } }
  }

  async #startStreamOnce(serial: string, current: () => void): Promise<void> {
    current();
    if (this.#recordingPeerReserved(serial)) throw new Error("Wait for recording retrieval before starting live view");
    const device = this.#devices.get(serial);
    if (!device || !isSupportedMegaCamera(device)) throw new Error(`Unknown Eufy camera: ${serial}`);
    const route = ppcsStreamRoute(device, this.#devices);
    const peer = route?.peer;
    const dsk = peer ? await this.#dskKey(peer.serial) : null;
    current();

    // The production path is deliberately first-party Mega/PPCS.
    if (route && peer?.p2pDid && peer.p2pConnection && dsk && device.channel !== null) {
      if (this.#recordingPeerReserved(serial)) throw new Error("Wait for recording retrieval before starting live view");
      this.#ppcsStreams.get(serial)?.close("replaced");
      const initialEccPrivateKey = !route.homeBaseAttached && device.cipherId !== null
        ? await this.#resolveCipherKey(device.cipherId, peer)
        : undefined;
      current();
      if (this.#recordingPeerReserved(serial)) throw new Error("Wait for recording retrieval before starting live view");
      const stream = new FirstPartyPpcsSession({
        ...(device.model === "T8170" && device.deviceType === 48 && !route.homeBaseAttached ? { lookupTimeoutMs: 8_000 } : {}),
        stationSerial: peer.serial, p2pDid: peer.p2pDid, appConnection: peer.p2pConnection,
        localAddress: peer.localAddress,
        dskKey: dsk.key, channel: device.channel, cameraModel: device.model, stationModel: peer.model,
        accountId: device.adminUserId,
        homeBaseAttached: route.homeBaseAttached,
        cipherId: device.cipherId,
        ...(initialEccPrivateKey ? { initialEccPrivateKey } : {}),
        resolveCipherKey: (cipherId: number) => this.#resolveCipherKey(cipherId, peer),
        maxSeconds: this.config.maxStreamSeconds,
        onSensorContact: (observation) => {
          const observed = resolveHomeBaseContactObservation(this.#devices.values(), peer.serial, observation);
          if (!observed) return;
          this.#devices.set(observed.serial, observed);
          const cached = this.#liveDeviceReads.get(observed.serial) ?? {};
          this.#liveDeviceReads.set(observed.serial, { ...cached, contactOpen: observation.open });
          publishHomeBaseChildSensorObservation(observed, this.#events);
        },
      });
      this.#ppcsStreams.set(serial, stream);
      try {
        await stream.start();
        current();
      } catch (error) {
        logger.warn(
          "camera_stream_start_failed",
          ppcsStreamLogSummary(device.model, route, stream.stats, error),
        );
        stream.close("start_failed");
        if (this.#ppcsStreams.get(serial) === stream) this.#ppcsStreams.delete(serial);
        throw error;
      }
      const audio = supportsCameraLiveAudio(device, route, true)
        ? stream.audioOutput : undefined;
      this.#events?.streamStarted(serial, stream.output, () => stream.videoCodec, audio);
      const finalize = () => this.#finalizeStream(serial, stream, device, route);
      stream.output.once("end", finalize);
      stream.output.once("close", finalize);
      return;
    }
    throw new Error("First-party PPCS camera transport is unavailable for this camera");
  }

  async stopStream(serial: string): Promise<void> {
    const doorbell = this.#doorbellTrials.get(serial);
    if (doorbell) { await doorbell.release(); return; }
    const pending = this.#streamStarts.get(serial);
    if (pending) pending.cancelled = true;
    const trial = this.#nvrTrials.get(serial);
    if (trial) { await trial.release(); return; }
    const stream = this.#ppcsStreams.get(serial);
    const device = this.#devices.get(serial);
    if (!stream || !device) return;
    const route = ppcsStreamRoute(device, this.#devices);
    stream.close("client_stop");
    this.#finalizeStream(serial, stream, device, route);
  }

  /** Borrow the server-leased media source for one exact C31 speaker operation. */
  async playCameraAudio(serial: string, audio: Buffer, signal?: AbortSignal): Promise<void> {
    const previous = this.#panControlOperations.get(serial) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const device = this.#devices.get(serial);
      const route = device ? ppcsStreamRoute(device, this.#devices) : null;
      const session = this.#ppcsStreams.get(serial);
      if (!device || !session || this.#recordingClosing || !supportsStandaloneC31Presets(device, route, true)
        || device.reads.speakerEnabled !== true) throw new Error("Speaker playback requires an enabled speaker on the owned standalone C31");
      await session.playC31Audio(audio, signal);
    });
    this.#panControlOperations.set(serial, current);
    try { await current; }
    finally { if (this.#panControlOperations.get(serial) === current) this.#panControlOperations.delete(serial); }
  }

  /** Write camera enablement once and publish only cloud-confirmed state. */
  setCameraEnabled(serial: string, enabled: boolean): Promise<CameraIdentity> {
    this.#assertNoModelTrial(serial);
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
      if (device.model === "T817L" && !route.homeBaseAttached
        && (!supportsStandaloneC31Presets(device, route, true)
          || ![0, 1].includes(device.reads.privacy6250Value ?? -1))) {
        throw new Error("C31 enablement requires a known owned standalone channel-zero privacy setting");
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
        ...((route.homeBaseAttached || supportsStandaloneC31Presets(device, route, true)) ? {
          resolveCipherKey: (cipherId: number) => this.#resolveCipherKey(cipherId, peer),
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
      if (supportsStandaloneC31Presets(device, route, true)) {
        this.#invalidateLiveReads(serial, ["enabled", "privacy6250Value"]);
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

  /** Write a known standalone C31 preference and publish only fresh camera confirmation. */
  setCameraPreference(serial: string, name: string, value: number): Promise<CameraIdentity> {
    this.#assertNoModelTrial(serial);
    const preference = validateC31Preference(name, value);
    const previous = this.#cameraOperations.get(serial) ?? Promise.resolve(this.#requireCameraIdentity(serial));
    const current = previous.catch(() => this.#requireCameraIdentity(serial)).then(async () => {
      const device = this.#devices.get(serial);
      const route = device ? ppcsStreamRoute(device, this.#devices) : null;
      const peer = route?.peer;
      const dsk = peer ? await this.#dskKey(peer.serial) : null;
      if (!device || !route || !peer?.p2pDid || !peer.p2pConnection || !dsk
        || !supportsStandaloneC31Presets(device, route, true) || c31PreferenceValue(device.reads, preference) === undefined) {
        throw new Error("Camera preference requires a known owned standalone C31 setting");
      }
      await this.stopStream(serial);
      const session = new FirstPartyPpcsSession({ stationSerial: peer.serial, p2pDid: peer.p2pDid,
        appConnection: peer.p2pConnection, localAddress: peer.localAddress, dskKey: dsk.key,
        channel: 0, cameraModel: device.model, accountId: device.adminUserId!, homeBaseAttached: false,
        purpose: "control", maxSeconds: 40, resolveCipherKey: (id) => this.#resolveCipherKey(id, peer) });
      try {
        await session.start();
        await session.writeC31Preference(preference, value);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await delay(500);
          try {
            const params = await session.readCameraInfo();
            const freshReads = safeInventoryReads(params, device.deviceType, device.model, true);
            if (c31PreferenceValue(freshReads, preference) === value) {
              return this.#cameraIdentity(this.#mergeCameraInfo(device, params));
            }
          } catch {

            // Retry a missed read without resending the write, then fall back to fresh cloud state.
            continue;
          }
        }
      } finally { session.close(); }

      // A previous direct parameter query must not shadow this fresh cloud read.
      const retained = this.#liveDeviceReads.get(serial);
      if (retained) {
        const remaining = { ...retained };
        delete remaining[c31PreferenceReadField(preference)];
        this.#liveDeviceReads.set(serial, remaining);
      }
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await this.#refreshInventoryReads();
        const refreshed = this.#devices.get(serial);
        if (refreshed && supportsStandaloneC31Presets(refreshed, ppcsStreamRoute(refreshed, this.#devices), true)
          && c31PreferenceValue(refreshed.reads, preference) === value) return this.#cameraIdentity(refreshed);
        await delay(2_000);
      }
      throw new Error("Camera preference write was not confirmed by fresh readback");
    });
    this.#cameraOperations.set(serial, current);
    void current.finally(() => {
      if (this.#cameraOperations.get(serial) === current) this.#cameraOperations.delete(serial);
    }).catch(() => undefined);
    return current;
  }

  /** Own one peer until a single reviewed setting is freshly confirmed or invalidated. */
  async setCameraSetting(serial: string, input: CameraSettingChange, signal?: AbortSignal): Promise<CameraIdentity> {
    const change = parseCameraSettingChange(input);
    const device = this.#devices.get(serial);
    const route = device ? ppcsStreamRoute(device, this.#devices) : null;
    const peer = route?.peer;
    const profile = device && route ? cameraSettingProfile(this.#modelTrialRoute(device, route), change.setting) : null;
    if (!device || !route || !peer || !profile || !device.adminUserId || this.#recordingClosing) throw new CameraSettingError("unavailable");
    cameraSettingWireValue(profile, change);
    const controlMaps = [this.#cameraOperations, this.#cameraCapabilityOperations, this.#streamingQualityOperations,
      this.#audioRecordingOperations, this.#motionOperations, this.#nightVisionOperations, this.#guardModeOperations,
      this.#lightOperations, this.#panControlOperations, this.#cameraSirenOperations];
    const related = [...this.#devices.values()].filter(row => (row.parentSerial || row.serial) === peer.serial || row.serial === peer.serial);
    if (this.#trialPeers.has(peer.serial) || this.#recordingPeerReserved(serial) || this.#stationOperations.has(peer.serial)
      || related.some(row => this.#ppcsStreams.has(row.serial) || controlMaps.some(map => map.has(row.serial)))) throw new CameraSettingError("busy");
    const releaseTrialPeer = this.#reserveTrialPeer(peer.serial);
    const generation = this.#startupGeneration;
    const deadline = Date.now() + 90_000;
    const field = change.setting === "motionSensitivity" ? "motionSensitivityStep" : "homebaseChimeEnabled";
    let session: FirstPartyPpcsSession | null = null;
    let dispatched = false;
    const check = (): void => {
      const current = this.#devices.get(serial), currentPeer = this.#devices.get(peer.serial);
      if (this.#recordingClosing || generation !== this.#startupGeneration || Date.now() >= deadline || (!dispatched && signal?.aborted)
        || !current || !currentPeer || inventoryBindingChanged(device, current) || inventoryBindingChanged(peer, currentPeer)
        || currentPeer.p2pDid !== peer.p2pDid || currentPeer.p2pConnection !== peer.p2pConnection) throw new CameraSettingError("unavailable");
    };
    const clear = (): void => {
      this.#invalidateLiveReads(serial, [field]);
      const current = this.#devices.get(serial);
      if (current && !inventoryBindingChanged(device, current)) {
        const reads = { ...current.reads }; delete reads[field];
        this.#devices.set(serial, { ...current, reads });
      }
    };
    const open = async (): Promise<FirstPartyPpcsSession> => {
      if (session) return session;
      const dsk = await this.#dskKey(peer.serial); check();
      if (!dsk || !peer.p2pDid || !peer.p2pConnection || device.channel === null) throw new CameraSettingError("unavailable");
      session = new FirstPartyPpcsSession({ stationSerial: peer.serial, p2pDid: peer.p2pDid,
        appConnection: peer.p2pConnection, localAddress: peer.localAddress, dskKey: dsk.key,
        channel: device.channel, cameraModel: device.model, accountId: device.adminUserId!,
        homeBaseAttached: route.homeBaseAttached, purpose: "control", maxSeconds: 90,
        resolveCipherKey: id => this.#resolveCipherKey(id, peer) });
      this.#trialSessions.set(peer.serial, session);
      await session.start(); check(); return session;
    };
    const originalPublic = this.#cameraIdentity(device);
    const abort = (): void => { if (!dispatched) session?.close(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await runConfirmedCameraSetting({ deadline, ...(signal ? { signal } : {}), check,
        read: async () => {
          if (!route.homeBaseAttached && (session !== null || !dispatched)) {
            const owned = await open(); check();
            try {
              const params = await owned.readCameraInfo(); check();
              const value = readCameraSetting(params, device.model, device.deviceType, true, change.setting);
              clear(); this.#mergeCameraInfo(this.#devices.get(serial)!, params);
              return value;
            } catch (error) {
              check();
              if (!dispatched) throw error;
              session?.close(); session = null; this.#trialSessions.delete(peer.serial);
            }
          }
          clear(); await this.#refreshInventoryReads(); check();
          return this.#devices.get(serial)?.reads[field];
        },
        write: async onDispatch => {
          const owned = await open(); check();
          await owned.writeReviewedCameraSetting(change, this.#modelTrialRoute(device, route), () => {
            check(); onDispatch(); dispatched = true;
          });
          check();
          if (route.homeBaseAttached) { owned.close(); session = null; this.#trialSessions.delete(peer.serial); }
        },
        invalidate: () => { clear(); const current = this.#devices.get(serial); if (current) this.#events?.camera(this.#cameraIdentity(current)); },
      }, change.value);
      check();
      const identity = this.#cameraIdentity(this.#devices.get(serial)!); this.#events?.camera(identity); return identity;
    } catch (error) {
      if (!dispatched && generation === this.#startupGeneration) this.#events?.camera(originalPublic);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.#trialSessions.get(peer.serial)?.close(); this.#trialSessions.delete(peer.serial); releaseTrialPeer();
    }
  }

  /** List trials independently of normal hardware-verified capability flags. */
  modelControlTrials(serial: string): readonly ModelControlTrial["action"][] {
    if (!this.config.experimentalModelControls || this.#recordingClosing) return [];
    const device = this.#devices.get(serial);
    const route = device ? ppcsStreamRoute(device, this.#devices) : null;
    if (!device || !route || !device.adminUserId || !route.peer.p2pDid || !route.peer.p2pConnection) return [];
    const actions = modelControlTrialActions(this.#modelTrialRoute(device, route));
    if (actions.includes("manualLight") && (route.peer.adminUserId !== device.adminUserId
      || !this.#client.isAuthenticatedUser(device.adminUserId)
      || [...this.#devices.values()].filter(row => row.parentSerial === route.peer.serial && row.channel === device.channel).length !== 1)) return [];
    return actions;
  }

  /** Own one peer exclusively for an explicit trial, publishing only fresh native state. */
  async performModelControlTrial(serial: string, input: ModelControlTrial, signal?: AbortSignal): Promise<ModelControlTrialResult> {
    const request = parseModelControlTrial(input);
    if (request.action === "manualLight") return await this.#performS120LightTrial(serial, request, signal);
    if (!this.modelControlTrials(serial).includes(request.action)) throw new Error("Experimental model control is unavailable");
    const device = this.#devices.get(serial)!;
    const route = ppcsStreamRoute(device, this.#devices)!;
    const peer = route.peer;
    const activeSiren = this.#trialSirenStops.get(peer.serial);
    if (request.action === "siren" && !request.enabled && activeSiren?.cameraId === serial) {
      try {
        await activeSiren.stop().finally(() => activeSiren.finished);
        logger.info("model_control_trial_result", `Model control trial: model=${safeLogModel(device.model)} action=siren outcome=acknowledged physical_confirmation_required=true`);
        return { outcome: "acknowledged", physicalConfirmationRequired: true, stoppedEarly: true };
      } catch (error) {
        const failure = error instanceof S100SirenTrialError ? error : new S100SirenTrialError(["session_prepare"]);
        logger.warn("model_control_trial_failed", `Model control trial failed: model=${safeLogModel(device.model)} action=siren stages=${failure.stages.join(",")}`);
        throw failure;
      }
    }
    const controlMaps = [this.#cameraOperations, this.#cameraCapabilityOperations, this.#streamingQualityOperations,
      this.#audioRecordingOperations, this.#motionOperations, this.#nightVisionOperations, this.#guardModeOperations,
      this.#lightOperations, this.#panControlOperations, this.#cameraSirenOperations];
    const related = [...this.#devices.values()].filter(row => (row.parentSerial || row.serial) === peer.serial || row.serial === peer.serial);
    if (this.#localMotionAborters.size || this.#trialPeers.has(peer.serial) || this.#recordingPeerReserved(serial)
      || this.#stationOperations.has(peer.serial) || related.some(row => this.#ppcsStreams.has(row.serial)
        || controlMaps.some(map => map.has(row.serial)))) throw new Error("Stop live view and wait for other device operations before a control trial");
    const releaseTrialPeer = this.#reserveTrialPeer(peer.serial);
    let session: FirstPartyPpcsSession | null = null;
    let finishSiren: (() => void) | undefined;
    let sirenSetupStage: S100SirenFailureStage = "session_key";
    const checkOwnership = () => {
      const current = this.#devices.get(serial);
      const currentPeer = this.#devices.get(peer.serial);
      if (this.#recordingClosing || !current || !currentPeer || inventoryBindingChanged(device, current)
        || inventoryBindingChanged(peer, currentPeer) || currentPeer.p2pDid !== peer.p2pDid
        || currentPeer.p2pConnection !== peer.p2pConnection) {
        if (request.action === "sirenConnection") throw new S100SirenTrialError(["session_prepare"]);
        throw new Error("Model control route changed or closed");
      }
    };
    try {
      const dsk = await this.#dskKey(peer.serial);
      checkOwnership();
      if (!dsk || !peer.p2pDid || !peer.p2pConnection || device.channel === null || !device.adminUserId) {
        throw new Error("Model control session keys unavailable");
      }
      sirenSetupStage = "session_connect";
      session = new FirstPartyPpcsSession({ stationSerial: peer.serial, p2pDid: peer.p2pDid,
        appConnection: peer.p2pConnection, localAddress: peer.localAddress, dskKey: dsk.key,
        channel: device.channel, cameraModel: device.model, accountId: device.adminUserId,
        homeBaseAttached: route.homeBaseAttached, purpose: "control", modelControlTrial: true, maxSeconds: 40,
        resolveCipherKey: cipherId => this.#resolveCipherKey(cipherId, peer) });
      this.#trialSessions.set(peer.serial, session);
      await session.start();
      sirenSetupStage = "session_prepare";
      checkOwnership();
      const owned = session;
      const profile = this.#modelTrialRoute(device, route);
      let result: ModelControlTrialResult;
      if (request.action === "sirenConnection") {

        // HTTP cancellation cannot authorize a stop or sound command. Provider shutdown closes the session.
        await owned.prepareS100SirenTrial(profile, false);
        checkOwnership();
        result = { outcome: "prepared", physicalConfirmationRequired: true };
      } else if (request.action === "siren") {
        const transport = await owned.prepareS100SirenTrial(profile, request.enabled);
        checkOwnership();
        const controller = new AbortController();
        const stop = () => { controller.abort(); return transport.stop(); };
        const finished = new Promise<void>(resolve => { finishSiren = resolve; });
        this.#trialSirenStops.set(peer.serial, { cameraId: serial, stop, finished });
        result = await runS100SirenTrial(transport, request.enabled, controller.signal, checkOwnership);
      } else {
        result = await runModelControlTrial({
          read: async () => {
            const params = await owned.readCameraInfo();
            checkOwnership();
            return safeInventoryReads(params, device.deviceType, device.model, !route.homeBaseAttached && device.channel === 0);
          },
          write: async value => { checkOwnership(); await owned.writeModelControlTrial(value, profile); },
        }, request, checkOwnership, error => error instanceof CameraControlAcknowledgementTimeoutError);
      }
      if (request.action === "motion" || request.action === "spotlight") {
        const field = request.action === "motion" ? "motionDetectionEnabled" : "spotlightEnabled";
        this.#liveDeviceReads.set(serial, { ...this.#liveDeviceReads.get(serial), [field]: request.enabled });
        const current = this.#devices.get(serial)!;
        const refreshed = { ...current, reads: { ...current.reads, [field]: request.enabled } };
        this.#devices.set(serial, refreshed);
        this.#events?.camera(this.#cameraIdentity(refreshed));
      }
      logger.info("model_control_trial_result", `Model control trial: model=${safeLogModel(device.model)} action=${request.action} outcome=${result.outcome} physical_confirmation_required=true`);
      return result;
    } catch (error) {
      const s100 = request.action === "siren" || request.action === "sirenConnection";
      const stages = error instanceof S100SirenTrialError ? error.stages : [sirenSetupStage];
      logger.warn("model_control_trial_failed", `Model control trial failed: model=${safeLogModel(device.model)} action=${request.action}${s100 ? ` stages=${stages.join(",")}` : ""}`);
      if (s100) throw new S100SirenTrialError(stages, request.action === "sirenConnection");
      throw error;
    } finally {
      session?.close();
      this.#trialSirenStops.delete(peer.serial);
      this.#trialSessions.delete(peer.serial);
      releaseTrialPeer();
      finishSiren?.();
    }
  }

  async #performS120LightTrial(serial: string, request: Extract<ModelControlTrial, { action: "manualLight" }>,
    signal?: AbortSignal): Promise<ModelControlTrialResult> {
    const unknown = (): Error => new Error("Manual light test did not confirm the light state. Check the light and restore it before trying again.");
    const device = this.#devices.get(serial), peer = device ? this.#devices.get(device.parentSerial) : undefined;
    const route = device ? ppcsStreamRoute(device, this.#devices) : null;
    if (!this.config.experimentalModelControls || !device || !peer || !route
      || !modelControlTrialActions(this.#modelTrialRoute(device, route)).includes("manualLight")
      || !device.adminUserId || device.adminUserId !== peer.adminUserId
      || !this.#client.isAuthenticatedUser(device.adminUserId) || signal?.aborted || this.#recordingClosing
      || !isPpcsRouteReady(device, this.#devices, new Set(this.#dskKeys.keys()))) throw unknown();
    const controls = [this.#cameraOperations, this.#cameraCapabilityOperations, this.#streamingQualityOperations,
      this.#audioRecordingOperations, this.#motionOperations, this.#nightVisionOperations, this.#guardModeOperations,
      this.#lightOperations, this.#panControlOperations, this.#cameraSirenOperations];
    const related = [...this.#devices.values()].filter(row => row.serial === peer.serial || row.parentSerial === peer.serial);
    if (this.#localMotionAborters.size || this.#trialPeers.has(peer.serial) || this.#recordingPeerReserved(serial)
      || this.#stationOperations.has(peer.serial) || related.some(row => this.#ppcsStreams.has(row.serial)
        || this.#streamStarts.has(row.serial) || controls.some(map => map.has(row.serial)))) throw unknown();
    const controller = new AbortController(), generation = this.#startupGeneration;
    const releaseTrialPeer = this.#reserveTrialPeer(peer.serial); this.#manualLightAborters.set(peer.serial, controller);
    let session: FirstPartyPpcsSession | null = null;
    const abort = (): void => { controller.abort(); session?.close(); };
    const deadline = setTimeout(abort, 60_000);
    signal?.addEventListener("abort", abort, { once: true });
    const valid = (rows: readonly MegaInventoryDevice[]): boolean => {
      const child = rows.filter(row => row.serial === serial), parent = rows.filter(row => row.serial === peer.serial);
      return child.length === 1 && parent.length === 1
        && rows.filter(row => row.parentSerial === peer.serial && row.channel === device.channel).length === 1
        && !inventoryBindingChanged(device, child[0]!) && !inventoryBindingChanged(peer, parent[0]!)
        && parent[0]!.p2pDid === peer.p2pDid && parent[0]!.p2pConnection === peer.p2pConnection
        && child[0]!.adminUserId === device.adminUserId && parent[0]!.adminUserId === device.adminUserId;
    };
    const current = (): void => {
      if (controller.signal.aborted || signal?.aborted || this.#recordingClosing || generation !== this.#startupGeneration
        || (session !== null && session.stats.closeReason !== "open") || !this.#client.isAuthenticatedUser(device.adminUserId!) || !valid([...this.#devices.values()])) throw unknown();
    };
    const owned = async <T>(operation: () => Promise<T>): Promise<T> => {
      current();
      let cancel!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(unknown()); controller.signal.addEventListener("abort", cancel, { once: true });
        if (controller.signal.aborted) cancel();
      });
      try { const result = await Promise.race([operation(), cancelled]); current(); return result; }
      finally { controller.signal.removeEventListener("abort", cancel); }
    };
    const fresh = async (): Promise<void> => {
      const inventory = await owned(() => this.#client.inventory(controller.signal));
      if (inventory.devices.filter(row => row.device_sn === serial).length !== 1
        || inventory.devices.filter(row => row.device_sn === peer.serial).length !== 1
        || !valid(parseMegaInventory(inventory))) throw unknown();
    };
    try {
      await fresh();
      const dsk = await owned(() => this.#dskKey(peer.serial));
      if (!dsk) throw unknown();
      session = new FirstPartyPpcsSession({ stationSerial: peer.serial, p2pDid: peer.p2pDid!, appConnection: peer.p2pConnection!,
        localAddress: peer.localAddress, dskKey: dsk.key, channel: device.channel!, cameraModel: device.model,
        stationModel: peer.model, accountId: device.adminUserId!, homeBaseAttached: true, purpose: "control",
        modelControlTrial: true, maxSeconds: 40, resolveCipherKey: id => this.#resolveCipherKey(id, peer) });
      this.#trialSessions.set(peer.serial, session); session.output.once("end", abort); session.output.resume();
      await owned(() => session!.start()); await fresh();
      await owned(() => session!.writeModelControlTrial(request, this.#modelTrialRoute(device, route), current));
      current();
      logger.info("model_control_trial_result", "Model control trial: model=T81A0 action=manualLight outcome=acknowledged physical_confirmation_required=true");
      return { outcome: "acknowledged", physicalConfirmationRequired: true };
    } catch {
      throw unknown();
    } finally {
      clearTimeout(deadline); signal?.removeEventListener("abort", abort);
      session?.output.removeListener("end", abort); controller.abort(); session?.close();
      if (this.#trialSessions.get(peer.serial) === session) this.#trialSessions.delete(peer.serial);
      this.#manualLightAborters.delete(peer.serial); releaseTrialPeer();
    }
  }

  #assertNoModelTrial(serial: string): void {
    const peer = this.#devices.get(serial)?.parentSerial || serial;
    if (this.#trialPeers.has(peer) || this.#trialPeers.has(serial)) throw new Error("Wait for the model control trial to finish");
  }

  #modelTrialRoute(device: MegaInventoryDevice, route: NonNullable<ReturnType<typeof ppcsStreamRoute>>): ModelControlRoute {
    return { model: device.model, deviceType: device.deviceType, channel: device.channel,
      homeBaseAttached: route.homeBaseAttached, peerModel: route.peer.model, peerDeviceType: route.peer.deviceType, selfPeer: route.peer.serial === device.serial };
  }

  /** Write the model's verified motion command and require fresh inventory confirmation. */
  setCameraMotionDetection(serial: string, enabled: boolean): Promise<CameraIdentity> {
    this.#assertNoModelTrial(serial);
    const previous = this.#motionOperations.get(serial) ?? Promise.resolve(this.#requireCameraIdentity(serial));
    const current = previous.catch(() => this.#requireCameraIdentity(serial)).then(async () => {
      const device = this.#devices.get(serial);
      if (!device || !isSupportedMegaCamera(device)) throw new Error(`Unknown Eufy camera: ${serial}`);
      const route = ppcsStreamRoute(device, this.#devices);
      const soloCam = (device.deviceType === 88 && device.model === "T8171")
        || (device.deviceType === 10_031 && device.model === "T817L" && route?.homeBaseAttached === false);
      const peer = route?.peer;
      const dsk = peer ? await this.#dskKey(peer.serial) : null;
      if (!route || !peer?.p2pDid || !peer.p2pConnection || !dsk || device.channel === null || !device.adminUserId) {
        throw new Error("Camera motion detection control is unavailable for this camera");
      }
      if (soloCam && (route.homeBaseAttached || peer.serial !== device.serial || device.channel !== 0
        || device.reads.motionDetectionEnabled === undefined)) {
        throw new Error("SoloCam motion control requires a known standalone channel-zero setting");
      }
      if (soloCam) await this.stopStream(serial);
      for (let operation = 0; operation < (soloCam ? 2 : 1); operation += 1) {
        const session = new FirstPartyPpcsSession({
          stationSerial: peer.serial, p2pDid: peer.p2pDid, appConnection: peer.p2pConnection,
          localAddress: peer.localAddress,
          dskKey: dsk.key, channel: device.channel, cameraModel: device.model,
          accountId: device.adminUserId, homeBaseAttached: route.homeBaseAttached, purpose: "control", maxSeconds: 40,
          resolveCipherKey: (cipherId: number) => this.#resolveCipherKey(cipherId, peer),
        });
        try {
          await session.start();
          await session.writeMotionDetection(enabled);
        } catch (error) {
          if (!soloCam) throw error;

          // A failed send can still have changed the setting. Read it before retrying.
        } finally {
          session.close();
        }
        if (supportsStandaloneC31Presets(device, route, true)) {
          this.#invalidateLiveReads(serial, ["motionDetectionEnabled"]);
        }
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await this.#refreshInventoryReads();
          const refreshed = this.#devices.get(serial);
          if (refreshed?.reads.motionDetectionEnabled === enabled) return this.#cameraIdentity(refreshed);
          await delay(2_000);
        }
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

  /** Write the model's verified audio-recording command and require fresh inventory confirmation. */
  setCameraAudioRecording(serial: string, enabled: boolean): Promise<CameraIdentity> {
    this.#assertNoModelTrial(serial);
    const previous = this.#audioRecordingOperations.get(serial) ?? Promise.resolve(this.#requireCameraIdentity(serial));
    const current = previous.catch(() => this.#requireCameraIdentity(serial)).then(async () => {
      const device = this.#devices.get(serial);
      if (!device || !isSupportedMegaCamera(device)) throw new Error(`Unknown Eufy camera: ${serial}`);
      if (!((device.deviceType === 88 && device.model === "T8171") || (device.deviceType === 10_031 && device.model === "T817L"))) throw new Error("Audio recording control is unavailable for this camera");
      const route = ppcsStreamRoute(device, this.#devices);
      const peer = route?.peer;
      const dsk = peer ? await this.#dskKey(peer.serial) : null;
      if (!route || !peer?.p2pDid || !peer.p2pConnection || !dsk || device.channel === null || !device.adminUserId) {
        throw new Error("Camera audio recording control is unavailable for this camera");
      }
      if (route.homeBaseAttached || peer.serial !== device.serial || device.channel !== 0
        || device.reads.audioRecordingEnabled === undefined) {
        throw new Error("SoloCam audio recording control requires a known standalone channel-zero setting");
      }
      await this.stopStream(serial);
      for (let operation = 0; operation < 2; operation += 1) {
        const session = new FirstPartyPpcsSession({
          stationSerial: peer.serial, p2pDid: peer.p2pDid, appConnection: peer.p2pConnection,
          localAddress: peer.localAddress,
          dskKey: dsk.key, channel: device.channel, cameraModel: device.model,
          accountId: device.adminUserId, homeBaseAttached: route.homeBaseAttached, purpose: "control", maxSeconds: 40,
          resolveCipherKey: (cipherId: number) => this.#resolveCipherKey(cipherId, peer),
        });
        try {
          await session.start();
          await session.writeAudioRecording(enabled);
        } catch {

          // A failed send can still have changed the setting. Read it before retrying.
        } finally {
          session.close();
        }
        if (supportsStandaloneC31Presets(device, route, true)) {
          this.#invalidateLiveReads(serial, ["audioRecordingEnabled"]);
        }
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await this.#refreshInventoryReads();
          const refreshed = this.#devices.get(serial);
          if (refreshed?.reads.audioRecordingEnabled === enabled) return this.#cameraIdentity(refreshed);
          await delay(2_000);
        }
      }
      throw new Error("Camera audio recording write was not confirmed by readback");
    }).catch((error: unknown) => {
      logger.warn("camera_audio_recording_failed", `Camera audio-recording command failed: error=${safeError(error)}`);
      throw error;
    });
    this.#audioRecordingOperations.set(serial, current);
    void current.finally(() => {
      if (this.#audioRecordingOperations.get(serial) === current) this.#audioRecordingOperations.delete(serial);
    }).catch(() => undefined);
    return current;
  }

  /** Write the admitted route's native live-quality preference and require fresh readback. */
  setCameraStreamingQuality(serial: string, quality: number, signal?: AbortSignal): Promise<CameraIdentity> {
    const nvr = this.#devices.get(serial);
    if (nvr && this.#nvrLiveAdmitted(nvr, this.#devices.get(nvr.parentSerial))) return this.#runNvrLiveControl(serial, { kind: "quality", value: quality }, signal);
    this.#assertNoModelTrial(serial);
    if (!Number.isInteger(quality) || quality < 0 || quality > 3) return Promise.reject(new Error("Unsupported streaming quality"));
    const previous = this.#streamingQualityOperations.get(serial) ?? Promise.resolve(this.#requireCameraIdentity(serial));
    const current = previous.catch(() => this.#requireCameraIdentity(serial)).then(async () => {
      const device = this.#devices.get(serial);
      if (!device || !isSupportedMegaCamera(device)) throw new Error(`Unknown Eufy camera: ${serial}`);
      const c31 = device.deviceType === 10_031 && device.model === "T817L";
      if (!(device.deviceType === 88 && device.model === "T8171") && !c31) throw new Error("Streaming quality control is unavailable for this camera");
      if (c31 && ![0, 2, 3].includes(quality)) throw new Error("Unsupported C31 streaming quality");
      const route = ppcsStreamRoute(device, this.#devices);
      const peer = route?.peer;
      const dsk = peer ? await this.#dskKey(peer.serial) : null;
      if (!route || !peer?.p2pDid || !peer.p2pConnection || !dsk || device.channel === null || !device.adminUserId) {
        throw new Error("Camera streaming quality control is unavailable for this camera");
      }
      if (!supportsStandaloneStreamingQuality(device, route, true)) {
        throw new Error("SoloCam streaming quality control requires a known standalone channel-zero setting");
      }
      await this.stopStream(serial);
      const session = new FirstPartyPpcsSession({
        stationSerial: peer.serial, p2pDid: peer.p2pDid, appConnection: peer.p2pConnection,
        localAddress: peer.localAddress,
        dskKey: dsk.key, channel: device.channel, cameraModel: device.model,
        accountId: device.adminUserId, homeBaseAttached: route.homeBaseAttached, purpose: "control", maxSeconds: 40,
        resolveCipherKey: (cipherId: number) => this.#resolveCipherKey(cipherId, peer),
      });
      try {
        await session.start();
        await session.writeStreamingQuality(quality);
      } catch {

        // A failed send can still have changed the setting. Read it before reporting failure.
      } finally {
        session.close();
      }

      // A cached local read predates this write and must not confirm it.
      const cached = this.#liveDeviceReads.get(serial);
      if (cached) {
        const { streamingQualityTier: _stale, ...remaining } = cached;
        this.#liveDeviceReads.set(serial, remaining);
      }
      const readDeadline = Date.now() + 65_000;
      for (let attempt = 0; attempt < 13 && Date.now() < readDeadline; attempt += 1) {
        await this.#refreshInventoryReads();
        const refreshed = this.#devices.get(serial);
        if (refreshed?.reads.streamingQualityTier === quality) return this.#cameraIdentity(refreshed);
        await delay(5_000);
      }
      throw new Error("Camera streaming quality write was not confirmed by readback");
    }).catch((error: unknown) => {
      logger.warn("camera_streaming_quality_failed", `Camera streaming-quality command failed: error=${safeError(error)}`);
      throw error;
    });
    this.#streamingQualityOperations.set(serial, current);
    void current.finally(() => {
      if (this.#streamingQualityOperations.get(serial) === current) this.#streamingQualityOperations.delete(serial);
    }).catch(() => undefined);
    return current;
  }

  /** Refresh a direct camera's known reads from its read-only parameter table. */
  refreshCameraCapabilities(serial: string): Promise<CameraIdentity> {
    const nvr = this.#devices.get(serial);
    if (nvr && this.#nvrLiveAdmitted(nvr, this.#devices.get(nvr.parentSerial))) return this.#refreshNvrLiveCapabilities(serial);
    this.#assertNoModelTrial(serial);
    const previous = this.#cameraCapabilityOperations.get(serial)
      ?? Promise.resolve(this.#requireCameraIdentity(serial));
    const current = previous.catch(() => this.#requireCameraIdentity(serial)).then(async () => {
      const device = this.#devices.get(serial);
      if (!device || !isSupportedMegaCamera(device)) throw new Error(`Unknown Eufy camera: ${serial}`);
      const route = ppcsStreamRoute(device, this.#devices);
      const peer = route?.peer;
      if (route?.homeBaseAttached && peer) {
        await this.refreshStation(peer.serial);
        return this.#cameraIdentity(this.#devices.get(serial) ?? device);
      }
      const dsk = peer ? await this.#dskKey(peer.serial) : null;
      if (!route || !peer?.p2pDid || !peer.p2pConnection || !dsk
        || device.channel === null || !device.adminUserId) {
        throw new Error("Camera capability refresh requires a ready PPCS route");
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
        homeBaseAttached: false,
        purpose: "control",
        maxSeconds: 40,
        resolveCipherKey: (cipherId: number) => this.#resolveCipherKey(cipherId, peer),
      });
      let params;
      try {
        await session.start();
        params = await session.readCameraInfo();
      } finally {
        session.close();
      }
      const merged = this.#mergeCameraInfo(device, params);
      const identity = this.#cameraIdentity(merged);
      this.#events?.camera(identity);
      logger.info(
        "camera_capability_refresh",
        `Camera capability refresh completed: model=${safeLogModel(device.model)} param_count=${merged.paramTypes.length} guard_mode=${merged.reads.guardMode === undefined ? "not-reported" : "reported"}`,
      );
      return identity;
    }).catch((error: unknown) => {
      logger.warn("camera_capability_refresh_failed", `Camera capability refresh failed: error=${safeError(error)}`);
      throw error;
    });
    this.#cameraCapabilityOperations.set(serial, current);
    void current.finally(() => {
      if (this.#cameraCapabilityOperations.get(serial) === current) this.#cameraCapabilityOperations.delete(serial);
    }).catch(() => undefined);
    return current;
  }

  /** Set a standalone camera guard mode and require fresh local readback. */
  setCameraGuardMode(serial: string, mode: number): Promise<CameraIdentity> {
    this.#assertNoModelTrial(serial);
    if (![0, 1, 63].includes(mode)) return Promise.reject(new Error("Unsupported standalone camera guard mode"));
    const previous = this.#guardModeOperations.get(serial) ?? Promise.resolve(this.#requireCameraIdentity(serial));
    const current = previous.catch(() => this.#requireCameraIdentity(serial)).then(async () => {
      const device = this.#devices.get(serial);
      if (!device || !isSupportedMegaCamera(device) || !supportsStandaloneGuardMode(device)) {
        throw new Error("Standalone camera guard mode is not supported for this camera");
      }
      const route = ppcsStreamRoute(device, this.#devices);
      const peer = route?.peer;
      const dsk = peer ? await this.#dskKey(peer.serial) : null;
      if (!route || route.homeBaseAttached || !peer?.p2pDid || !peer.p2pConnection || !dsk
        || device.channel !== 0 || !device.adminUserId || !device.userName) {
        throw new Error("Standalone camera guard mode requires a ready direct route and account identity");
      }
      await this.stopStream(serial);
      const session = new FirstPartyPpcsSession({
        stationSerial: peer.serial, p2pDid: peer.p2pDid, appConnection: peer.p2pConnection,
        localAddress: peer.localAddress, dskKey: dsk.key, channel: device.channel,
        cameraModel: device.model, accountId: device.adminUserId,
        homeBaseAttached: false, purpose: "control", maxSeconds: 40,
      });
      try {
        await session.start();
        await session.writeStandaloneGuardMode(mode, device.userName);
        for (let attempt = 0; attempt < 6; attempt += 1) {
          await delay(1_000);
          const params = await session.readCameraInfo();
          const refreshed = this.#mergeCameraInfo(this.#devices.get(serial) ?? device, params);
          if (refreshed.reads.guardMode === mode) return this.#cameraIdentity(refreshed);
        }
      } finally {
        session.close();
      }
      throw new Error("Standalone camera guard mode write was not confirmed by local readback");
    }).catch((error: unknown) => {
      logger.warn("camera_guard_mode_failed", `Standalone camera guard mode failed: error=${safeError(error)}`);
      throw error;
    });
    this.#guardModeOperations.set(serial, current);
    void current.finally(() => {
      if (this.#guardModeOperations.get(serial) === current) this.#guardModeOperations.delete(serial);
    }).catch(() => undefined);
    return current;
  }

  /** Write the camera family's night-vision control and publish fresh confirmed state. */
  setCameraNightVision(serial: string, mode: number, signal?: AbortSignal): Promise<CameraIdentity> {
    const nvr = this.#devices.get(serial);
    if (nvr && this.#nvrLiveAdmitted(nvr, this.#devices.get(nvr.parentSerial))) return this.#runNvrLiveControl(serial, { kind: "night", value: mode }, signal);
    this.#assertNoModelTrial(serial);
    if (!Number.isSafeInteger(mode) || mode < 0 || mode > 3) {
      return Promise.reject(new Error("Night vision mode must be an integer from 0 through 3"));
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
      const standaloneNightVisionSupported = supportsStandaloneNightVision(device, route,
        isPpcsRouteReady(device, this.#devices, new Set(dsk && peer ? [peer.serial] : [])));
      if ((!route?.homeBaseAttached && !standaloneNightVisionSupported) || !peer?.p2pDid || !peer.p2pConnection || !dsk || device.channel === null || !device.adminUserId) {
        throw new Error("Night vision control requires a ready HomeBase-attached camera route");
      }

      // Closing this camera's media frees its direct peer. Consumers request a new stream.
      if (standaloneNightVisionSupported) await this.stopStream(serial);
      const session = new FirstPartyPpcsSession({
        stationSerial: peer.serial, p2pDid: peer.p2pDid, appConnection: peer.p2pConnection,
        localAddress: peer.localAddress,
        dskKey: dsk.key, channel: device.channel, cameraModel: device.model,
        accountId: device.adminUserId, homeBaseAttached: route!.homeBaseAttached, purpose: "control", maxSeconds: 40,
        ...(standaloneNightVisionSupported ? { standaloneNightVisionSupported: true } : {}),
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
      if (supportsStandaloneC31Presets(device, route, true)) {
        this.#invalidateLiveReads(serial, ["nightVisionMode", "autoNightVisionEnabled"]);
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
    let rawRead: HomeBasePpcsState | null = null;
    const station = await this.#queueStationOperation(
      serial,
      false,
      async (session) => {
        rawRead = await session.readState(true);
        return rawRead;
      },
      "discovered",
    );
    if (rawRead !== null && !this.#stationReadConfirmed.has(serial)) {
      this.#stationReadConfirmed.add(serial);
      logger.info(
        "station_state_read_ready",
        homeBaseReadLogSummary(identity.model, rawRead),
      );
    }
    return station;
  }

  async setGuardMode(serial: string, mode: number): Promise<HomeBaseState> {
    this.#assertNoModelTrial(serial);
    if (![0, 1, 2, 3, 4, 5, 47, 63].includes(mode)) throw new Error("Unsupported HomeBase guard mode");
    return this.#writeStationValue(serial, "guardMode", mode, (session) => session.setGuardMode(mode), "guard-mode");
  }

  async setAlarmVolume(serial: string, value: number): Promise<HomeBaseState> {
    this.#assertNoModelTrial(serial);
    if (!Number.isInteger(value) || value < 1 || value > 26) throw new Error("HomeBase alarm volume must be from 1 to 26");
    return this.#writeStationValue(serial, "alarmVolume", value, (session) => session.setAlarmVolume(value));
  }

  async setPromptVolume(serial: string, value: number): Promise<HomeBaseState> {
    this.#assertNoModelTrial(serial);
    if (!Number.isInteger(value) || value < 1 || value > 26) throw new Error("HomeBase prompt volume must be from 1 to 26");
    return this.#writeStationValue(serial, "promptVolume", value, (session) => session.setPromptVolume(value));
  }

  async setAlarmTone(serial: string, value: number): Promise<HomeBaseState> {
    this.#assertNoModelTrial(serial);
    if (value !== 1 && value !== 2) throw new Error("HomeBase alarm tone must be 1 or 2");
    return this.#writeStationValue(serial, "alarmTone", value, (session) => session.setAlarmTone(value));
  }

  /** Retire startup and push synchronously before cancelling shared cloud work. */
  async close(): Promise<void> {
    for (const entry of this.#nvrGuardEntries.values()) {
      if (entry.attempted && !entry.warned) {
        entry.warned = true;
        logger.warn("nvr_guard_trial_failed", "stage=shutdown manual_restore_required=true");
      }
      entry.controller.abort();
    }
    this.#recordingClosing = true;
    for (const pending of this.#streamStarts.values()) pending.cancelled = true;
    this.#streamStarts.clear();
    this.#cipherFlights.clear();
    this.#cipherKeys.clear();
    for (const [peer, session] of this.#trialSessions) {
      if (!this.#trialSirenStops.has(peer)) session.close();
    }
    ++this.#startupGeneration;
    this.#locks?.close();
    this.#locks = null;
    this.#retireInventoryRefresh();
    const push = this.#push;
    this.#push = null;
    const closingPush = push?.close();
    if (this.#events) this.#clearNvrEffectiveModes(this.#events);
    this.#nvrModePushTimes.clear();
    try { this.#events?.eventReceiverState("stopped"); } catch {}
    for (const value of this.#nvrSettings.values()) if (value.timer) clearTimeout(value.timer);
    this.#nvrSettings.clear(); this.#nvrViews.clear(); this.#nvrExplicitOwners.clear();
    await Promise.allSettled([...this.#nvrTrials.values()].map(trial => trial.release()));
    await Promise.allSettled([...this.#doorbellTrials.values()].map(trial => trial.release()));
    if (this.#generalRtcTrials.size) {
      await Promise.allSettled([...this.#generalRtcTrials.values()].map(entry => entry.trial.release("shutdown")));
    }
    this.#client.cancelPendingRequests();
    for (const controller of this.#localMotionAborters.values()) controller.abort();
    for (const controller of this.#manualLightAborters.values()) controller.abort();
    for (const entry of this.#nvrPowerEntries.values()) entry.controller.abort();
    for (const controller of this.#lockStatusAborters.values()) controller.abort();
    if (this.#stationRefreshTimer) clearInterval(this.#stationRefreshTimer);
    this.#stationRefreshTimer = null;
    if (this.#inventoryRefreshTimer) clearInterval(this.#inventoryRefreshTimer);
    this.#inventoryRefreshTimer = null;
    let sirenDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.#trialSirenStops.values()].map(trial => trial.stop().finally(() => trial.finished))),
        new Promise<void>(resolve => { sirenDeadline = setTimeout(resolve, 7000); }),
      ]);
    } finally { if (sirenDeadline) clearTimeout(sirenDeadline); }
    for (const session of this.#trialSessions.values()) session.close();
    await closingPush;
    for (const stream of this.#ppcsStreams.values()) stream.close();
    this.#ppcsStreams.clear();
    for (const session of this.#recordingSessions.values()) session.close();
    this.#recordingSessions.clear();
    this.#recordingReferences.clear();
    await Promise.allSettled(this.#stationOperations.values());
    this.#stationOperations.clear();
    for (const controller of this.#cameraSirenAborters.values()) controller.abort();
    await Promise.allSettled(this.#cameraSirenOperations.values());
    this.#cameraSirenOperations.clear();
    this.#cameraSirenAborters.clear();
    await Promise.allSettled(this.#cameraOperations.values());
    this.#cameraOperations.clear();
    await Promise.allSettled(this.#lightOperations.values());
    this.#lightOperations.clear();
    await Promise.allSettled(this.#panControlOperations.values());
    this.#panControlOperations.clear();
    this.#pendingSensorMotionCloudConfirmations.clear();
    this.#sensorMotionClocks.clear();
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
    const generation = this.#startupGeneration;
    let result;
    try { result = await this.#client.connect(undefined, answer); }
    catch (error) { if (generation !== this.#startupGeneration) return; throw error; }
    if (generation !== this.#startupGeneration || !this.#events) return;
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
    const generation = this.#startupGeneration;
    let result;
    try { result = await this.#client.connect(code); }
    catch (error) { if (generation !== this.#startupGeneration) return; throw error; }
    if (generation !== this.#startupGeneration || !this.#events) return;
    if (result.state !== "authenticated") throw new Error("Eufy did not accept the verification code");
    this.#verificationRequired = false;
    await this.#completeStartup(this.#events);
  }

  async #completeStartup(events: ProviderEvents, generation = ++this.#startupGeneration): Promise<void> {
    this.#retireInventoryRefresh();
    try { await this.#runStartup(events, generation); }
    catch (error) { if (generation !== this.#startupGeneration) return; throw error; }
  }

  async #runStartup(events: ProviderEvents, generation: number): Promise<void> {
    let inventory;
    try {
      inventory = await this.#client.inventory();
      if (generation !== this.#startupGeneration) return;
    } catch (error) {
      if (generation !== this.#startupGeneration) return;
      if (!this.#client.isSessionInvalidError(error)) throw error;
      for (const serial of this.#nvrSettings.keys()) this.#clearNvrSettings(serial);
      this.#nvrViews.clear();
      logger.warn("session_invalidated", "Mega session was invalidated; signing in again");
      const auth = await this.#client.connect(undefined, undefined, true);
      if (generation !== this.#startupGeneration) return;
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
      if (generation !== this.#startupGeneration) return;
    }
    this.#nvrObserveOwners(inventory);
    const devices = parseMegaInventory(inventory);
    this.#locks?.inventory(inventory.devices, true);
    this.#devices.clear();
    this.#pendingSensorMotionCloudConfirmations.clear();
    this.#sensorMotionClocks.clear();
    this.#liveDeviceReads.clear();
    this.#liveDeviceParamTypes.clear();
    const sensorReceivedAt = Date.now();
    for (const [index, device] of devices.entries()) {
      const clock = this.#inventoryMotionClock(device, undefined, sensorReceivedAt);
      clock?.observe(device.reads.motionEventSeconds, false, sensorReceivedAt);
      const observed = clock ? this.#motionBaselineReads(device, clock) : device;
      devices[index] = observed;
      this.#devices.set(device.serial, observed);
    }
    this.#dskKeys.clear();
    this.#cipherKeys.clear();
    const peerSerials = [...new Set(devices.filter((device) => (!device.parentSerial || device.parentSerial === device.serial) && device.p2pDid).map((device) => device.serial))];
    if (peerSerials.length > 0) {
      try {
        const keys = await this.#client.dskKeys(peerSerials);
        if (generation !== this.#startupGeneration) return;
        for (const [serial, key] of Object.entries(keys)) this.#dskKeys.set(serial, key);
      } catch (error) {
        if (generation !== this.#startupGeneration) return;
        logger.warn("dsk_lookup_unavailable", `Mega DSK lookup unavailable: ${safeError(error)}`);
      }
    }
    const dskPeerSerials = new Set(this.#dskKeys.keys());
    for (const device of devices) {
      const normalNvr = this.#normalNvrLiveBinding(device, this.#devices.get(device.parentSerial))
        ? this.#nvrTrialIdentity(device) : null;
      if (normalNvr) events.camera(normalNvr);
      else if (isSupportedMegaCamera(device)) events.camera(this.#cameraIdentity(device));
      else { const trial = this.#nvrTrialIdentity(device); if (trial) events.camera(trial); }
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
      standaloneNightVisionSupported: supportsStandaloneNightVision(device, ppcsStreamRoute(device, this.#devices),
        isPpcsRouteReady(device, this.#devices, dskPeerSerials)),
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
    for (const device of devices.filter(isInventoryStation)) {
      const station = initialHomeBaseState(
        device,
        this.#dskKeys.has(device.serial),
      );
      this.#stations.set(device.serial, station);
      events.station(station);
      logger.info("guard_mode_names_observed", `Guard mode names observed: model=${safeLogModel(device.model)} ${device.guardModeMetadataShape ?? "missing"}`);
      if (device.guardModeMetadataStructure !== undefined) {
        logger.info("guard_mode_metadata_observed", `model=${safeLogModel(device.model)} structure=${device.guardModeMetadataStructure}`);
      }
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
    for (const device of devices) {
      const summary = privacyParameterLogSummary(device);
      if (summary) logger.info("camera_privacy_parameter_observed", summary);
    }
    events.inventory(diagnostics);

    const previousPush = this.#push;
    this.#push = null;
    await previousPush?.close();
    if (generation !== this.#startupGeneration) return;
    const push = new MegaPushReceiver(
      this.#client,
      join(this.config.persistentDirectory, "mega-push.json"),
      (event) => { if (this.#push === push) this.#handlePush(events, event); },
      (state) => {
        if (this.#push !== push) return;
        if (["disconnected", "stopped", "degraded", "activation-unconfirmed"].includes(state)) this.#clearNvrEffectiveModes(events);
        events.eventReceiverState(state);
      },
      (outcome) => { if (this.#push === push) events.eventDelivery(outcome); },
    );
    this.#push = push;
    void push.start().catch(() => {
      if (this.#push !== push || generation !== this.#startupGeneration) return;
      events.eventReceiverState("degraded");
      logger.warn("push_start_unavailable", "Push startup unavailable. Camera startup remains independent.");
    });
    if (generation !== this.#startupGeneration) return;
    events.connection("connected", "Cameras and snapshots are ready. Push event delivery is reported separately.");
    await Promise.allSettled(
      [...this.#stations.values()]
        .filter(({ serial }) => {
          const identity = this.#devices.get(serial);
          return identity !== undefined && isDiscoveredHomeBase(identity);
        })
        .map(({ serial }) => this.refreshStation(serial).then(
        () => this.#recordStationRefreshSuccess(serial),
        (error: unknown) => this.#recordStationRefreshFailure(serial, error),
      )),
    );
    if (generation !== this.#startupGeneration) return;
    if (this.#stationRefreshTimer) clearInterval(this.#stationRefreshTimer);
    this.#stationRefreshTimer = setInterval(() => {
      for (const station of this.#stations.values()) {
        const identity = this.#devices.get(station.serial);
        if (!identity || !isDiscoveredHomeBase(identity)) continue;
        if (this.#stationOperations.has(station.serial)
          || this.#stationHasActiveMedia(station.serial)) continue;
        void this.refreshStation(station.serial).then(
          () => this.#recordStationRefreshSuccess(station.serial),
          (error: unknown) => this.#recordStationRefreshFailure(station.serial, error),
        );
      }
    }, 60_000);
    this.#stationRefreshTimer.unref();
    this.#inventoryReadyGeneration = generation;
    if (this.#inventoryRefreshTimer) clearInterval(this.#inventoryRefreshTimer);
    this.#inventoryRefreshTimer = setInterval(() => {
      void this.#refreshInventoryReads(false).catch((error: unknown) => {
        logger.warn("inventory_refresh_unavailable", `Mega read refresh unavailable: ${safeError(error)}`);
      });
    }, 60_000);
    this.#inventoryRefreshTimer.unref();
  }

  /** Detach generation-owned flights so replacement startup cannot join retired work. */
  #retireInventoryRefresh(): void {
    this.#inventoryReadyGeneration = null;
    this.#inventoryRefresh = null;
    this.#inventoryTrailingRefresh = null;
    this.#inventoryKeyFailures = 0;
    this.#dskRefreshes.clear();
  }

  /** Join timer reads, but queue a post-command read when a control needs fresh state. */
  async #refreshInventoryReads(requireFresh = true): Promise<void> {
    const generation = this.#startupGeneration;
    const events = this.#events;
    if (this.#inventoryReadyGeneration !== generation || !events) return;
    const pending = this.#inventoryRefresh;
    if (pending) {
      if (!requireFresh) return pending;
      if (this.#inventoryTrailingRefresh) return this.#inventoryTrailingRefresh;
      const trailing = pending.catch(() => undefined).then(() => {
        if (generation !== this.#startupGeneration) throw new Error("Inventory refresh cancelled");
        if (this.#inventoryTrailingRefresh === trailing) this.#inventoryTrailingRefresh = null;
        return this.#refreshInventoryReads(false);
      }).finally(() => {
        if (this.#inventoryTrailingRefresh === trailing) this.#inventoryTrailingRefresh = null;
      });
      this.#inventoryTrailingRefresh = trailing;
      return trailing;
    }
    const refresh = this.#runInventoryRefresh(events, generation).finally(() => {
      if (this.#inventoryRefresh === refresh) this.#inventoryRefresh = null;
    });
    this.#inventoryRefresh = refresh;
    return refresh;
  }

  /** Merge routing peers before publishing additive discovery through the captured generation. */
  async #runInventoryRefresh(events: ProviderEvents, generation: number): Promise<void> {
    const inventory = await this.#client.inventory();
    const receivedAt = Date.now();
    const pushesAtReceipt = new Map(this.#pendingSensorMotionCloudConfirmations);
    const refreshed = parseMegaInventory(inventory);
    if (generation !== this.#startupGeneration) throw new Error("Inventory refresh cancelled");
    this.#nvrObserveOwners(inventory);
    this.#locks?.inventory(inventory.devices);
    if (refreshed.length === 0) return;
    const previous = new Map(this.#devices);
    const motionOutcomes = new Map<string, InventoryMotionOutcome>();
    for (const device of refreshed) {
      const known = this.#devices.get(device.serial);
      const refreshedDevice = known ? mergeInventoryMetadata(known, device) : device;
      if (known && inventoryBindingChanged(known, refreshedDevice)) {
        const stream = this.#ppcsStreams.get(device.serial);
        if (stream) {
          stream.close("replaced");
          this.#finalizeStream(device.serial, stream, known, ppcsStreamRoute(known, previous));
        }
        this.#recordingSessions.get(device.serial)?.close();
        for (const [id, reference] of this.#recordingReferences) {
          if (reference.serial === device.serial) this.#recordingReferences.delete(id);
        }
        this.#liveDeviceReads.delete(device.serial);
        this.#liveDeviceParamTypes.delete(device.serial);
      }
      const clock = this.#inventoryMotionClock(device, known, receivedAt);
      const pendingAt = this.#pendingSensorMotionCloudConfirmations.get(device.serial);
      const recentPush = pendingAt !== undefined && receivedAt >= pendingAt.receivedAt && receivedAt - pendingAt.receivedAt <= 60_000;
      if (!recentPush) this.#pendingSensorMotionCloudConfirmations.delete(device.serial);
      const outcome = clock?.observe(device.reads.motionEventSeconds, false, receivedAt) ?? "none";
      motionOutcomes.set(device.serial, outcome);
      const observed = clock ? this.#motionBaselineReads(refreshedDevice, clock) : refreshedDevice;
      const liveReads = this.#liveDeviceReads.get(device.serial);
      const liveParamTypes = this.#liveDeviceParamTypes.get(device.serial) ?? [];
      this.#devices.set(device.serial, {
        ...observed,
        paramTypes: [...new Set([...device.paramTypes, ...liveParamTypes])].sort((left, right) => left - right),
        reads: liveReads ? { ...observed.reads, ...liveReads } : observed.reads,
      });
    }
    const missingPeers = [...this.#devices.values()].filter((device) =>
      (!device.parentSerial || device.parentSerial === device.serial)
      && device.p2pDid && device.p2pConnection && !this.#dskKeys.has(device.serial)
      && !(device.category === "eufy_security"
        && ((device.deviceType === 27 && device.model.startsWith("T9000"))
          || (device.deviceType === 300 && device.model.startsWith("T8N00")))));
    if (missingPeers.length > 0) {
      try {
        const keys = await this.#client.dskKeys(missingPeers.map(({ serial }) => serial));
        if (generation !== this.#startupGeneration) throw new Error("Inventory refresh cancelled");
        for (const peer of missingPeers) {
          const key = keys[peer.serial];
          if (key) this.#dskKeys.set(peer.serial, key);
        }
        if (missingPeers.some(({ serial }) => !this.#dskKeys.has(serial))) this.#recordInventoryKeyFailure();
        else this.#inventoryKeyFailures = 0;
      } catch (error) {
        if (generation !== this.#startupGeneration) throw new Error("Inventory refresh cancelled");
        this.#recordInventoryKeyFailure();
      }
    }
    const devices = [...this.#devices.values()];
    const dskPeers = new Set(this.#dskKeys.keys());
    for (const device of devices) {
      const normalNvr = this.#normalNvrLiveBinding(device, this.#devices.get(device.parentSerial))
        ? this.#nvrTrialIdentity(device) : null;
      if (normalNvr) events.camera(normalNvr);
      else if (isSupportedMegaCamera(device)) events.camera(this.#cameraIdentity(device));
      else { const trial = this.#nvrTrialIdentity(device); if (trial) events.camera(trial); }
    }
    for (const device of devices) {
      const sensor = securitySensorState(device);
      if (sensor) events.sensor(sensor);
    }
    for (const device of devices.filter(isInventoryStation)) {
      const known = this.#stations.get(device.serial);
      const station = known
        ? {
          ...refreshInventoryStationState(known, device),
          cameraRouteReady: initialHomeBaseState(device, this.#dskKeys.has(device.serial)).cameraRouteReady,
        }
        : initialHomeBaseState(device, this.#dskKeys.has(device.serial));
      this.#stations.set(device.serial, station);
      events.station(station);
    }
    events.inventory(inventoryDiagnostics(devices));
    events.cameraCapabilities(devices.map((device) => describeCameraCapabilities(device, {
      doorbellSupported: isDoorbellDevice(device),
      streamSupported: isPpcsStreamSupported(device, this.#devices, dskPeers),
      routeReady: isPpcsRouteReady(device, this.#devices, dskPeers),
      homeBaseAttached: ppcsStreamRoute(device, this.#devices)?.homeBaseAttached ?? false,
      standaloneNightVisionSupported: supportsStandaloneNightVision(device, ppcsStreamRoute(device, this.#devices),
        isPpcsRouteReady(device, this.#devices, dskPeers)),
    })));
    events.deviceCapabilities(devices.flatMap((device) => describeDeviceCapabilities(device, {
      homeBaseSupported: isHomeBase3(device),
      homeBaseGuardModeSupported: supportsHomeBaseGuardMode(device),
      homeBaseRouteReady: Boolean(device.p2pDid && device.p2pConnection && this.#dskKeys.has(device.serial)),
      doorbellSupported: isDoorbellDevice(device),
      cameraStreamSupported: isPpcsStreamSupported(device, this.#devices, dskPeers),
    })));
    for (const device of refreshed) {
      const known = previous.get(device.serial);
      const merged = this.#devices.get(device.serial)!;
      if (known?.reads.privacy6250Value !== merged.reads.privacy6250Value) {
        const summary = privacyParameterLogSummary(merged, known?.reads.privacy6250Value);
        if (summary) logger.info("camera_privacy_parameter_observed", summary);
      }
      let motionOutcome = motionOutcomes.get(device.serial) ?? "none";
      if (motionOutcome === "none") continue;
      const publishedAt = Date.now(), timestamp = device.reads.motionEventSeconds;
      if (timestamp === undefined || publishedAt - Math.round(timestamp * 1_000) > 60_000
        || Math.round(timestamp * 1_000) - publishedAt > 2_000) continue;
      const pendingAt = this.#pendingSensorMotionCloudConfirmations.get(device.serial);
      if (pendingAt !== undefined && publishedAt >= pendingAt.receivedAt && publishedAt - pendingAt.receivedAt <= 60_000) {
        motionOutcome = "push-confirmed";
        if (pendingAt === pushesAtReceipt.get(device.serial)) this.#pendingSensorMotionCloudConfirmations.delete(device.serial);
      } else this.#pendingSensorMotionCloudConfirmations.delete(device.serial);
      logger.info("sensor_motion_cloud_observed",
        `model=${safeLogModel(device.model)} outcome=${motionOutcome}`);
      if (motionOutcome === "cloud-motion") events.sensorMotion(device.serial, true);
    }
  }

  #inventoryMotionClock(device: MegaInventoryDevice, previous: MegaInventoryDevice | undefined,
    receivedAt: number): InventoryMotionClock | null {
    if (device.deviceType !== 10 && device.deviceType !== 127) return null;
    const entry = this.#sensorMotionClocks.get(device.serial);
    if (entry && !inventoryBindingChanged(entry.device, device)) return entry.clock;
    const sameBinding = previous && !inventoryBindingChanged(previous, device);
    const clock = new InventoryMotionClock(sameBinding ? previous.reads.motionEventSeconds : undefined, receivedAt);
    this.#sensorMotionClocks.delete(device.serial);
    this.#sensorMotionClocks.set(device.serial, { device, clock });
    while (this.#sensorMotionClocks.size > 1_000) this.#sensorMotionClocks.delete(this.#sensorMotionClocks.keys().next().value!);
    return clock;
  }

  #motionBaselineReads(device: MegaInventoryDevice, clock: InventoryMotionClock): MegaInventoryDevice {
    const reads = { ...device.reads };
    delete reads.motionEventSeconds;
    const fromMotion = device.reads.motionEventSeconds !== undefined
      && device.reads.lastSeen === new Date(device.reads.motionEventSeconds * 1_000).toISOString();
    const replaceLastSeen = fromMotion || reads.lastSeen === undefined;
    if (replaceLastSeen) delete reads.lastSeen;
    const seconds = clock.baselineSeconds;
    if (seconds !== undefined) {
      reads.motionEventSeconds = seconds;
      if (replaceLastSeen) reads.lastSeen = new Date(seconds * 1_000).toISOString();
    }
    return { ...device, reads };
  }

  /** Limit repeated missing-key warnings while discovery remains available. */
  #recordInventoryKeyFailure(): void {
    const failures = ++this.#inventoryKeyFailures;
    if (failures === 1 || failures % 15 === 0) {
      logger.warn("inventory_dsk_unavailable", "Connection keys unavailable for discovered peers. Discovery continues and the next inventory refresh will retry.");
    }
  }

  #requireCameraIdentity(serial: string): CameraIdentity {
    const device = this.#devices.get(serial);
    if (!device || !isSupportedMegaCamera(device)) throw new Error(`Unknown Eufy camera: ${serial}`);
    return this.#cameraIdentity(device);
  }

  /** Drop only pre-write local values so an owned control must obtain fresh confirmation. */
  #invalidateLiveReads(serial: string, fields: readonly (keyof MegaInventoryReads)[]): void {
    const cached = this.#liveDeviceReads.get(serial);
    if (!cached) return;
    const remaining = { ...cached };
    for (const field of fields) delete remaining[field];
    this.#liveDeviceReads.set(serial, remaining);
  }

  #mergeCameraInfo(
    device: MegaInventoryDevice,
    params: readonly { readonly param_type: number; readonly param_value: string | number | boolean }[],
  ): MegaInventoryDevice {
    const reads = safeInventoryReads(params, device.deviceType, device.model,
      (!device.parentSerial || device.parentSerial === device.serial) && device.channel === 0);
    const paramTypes = [...new Set(params.map(({ param_type }) => param_type))]
      .sort((left, right) => left - right);
    const merged = {
      ...device,
      paramTypes: [...new Set([...device.paramTypes, ...paramTypes])].sort((left, right) => left - right),
      reads: { ...device.reads, ...reads },
    };
    this.#liveDeviceReads.set(device.serial, reads);
    this.#liveDeviceParamTypes.set(device.serial, paramTypes);
    this.#devices.set(device.serial, merged);
    return merged;
  }

  #cameraIdentity(device: MegaInventoryDevice): CameraIdentity {
    const dskPeerSerials = new Set(this.#dskKeys.keys());
    const route = ppcsStreamRoute(device, this.#devices);
    const settingRoute = route ? this.#modelTrialRoute(device, route) : null;
    const sensitivityProfile = settingRoute ? cameraSettingProfile(settingRoute, "motionSensitivity") : null;
    const chimeProfile = settingRoute ? cameraSettingProfile(settingRoute, "homebaseChime") : null;
    const settingRouteReady = Boolean(device.adminUserId) && isPpcsRouteReady(device, this.#devices, dskPeerSerials);
    const t817lControlsSupported = device.model.toUpperCase().startsWith("T817L")
      && route?.homeBaseAttached === true
      && device.channel !== null
      && device.adminUserId !== null
      && isPpcsRouteReady(device, this.#devices, dskPeerSerials);
    const soloCamPanControlsSupported = supportsSoloCamPresetControl(
      device, route, isPpcsRouteReady(device, this.#devices, dskPeerSerials),
    );
    return {
      serial: device.serial,
      name: device.name,
      model: device.model,
      catalogueStatus: catalogueIntegrationStatus(device.model, device.deviceType),
      firmware: device.firmware,
      hardwareVersion: device.hardwareVersion ?? null,
      firmwareSubVersion: device.firmwareSubVersion ?? null,
      firmwareUpdateAvailable: device.firmwareUpdateAvailable ?? null,
      rssi: device.reads.rssi ?? null,
      audioSettings: {
        microphoneEnabled: device.reads.microphoneEnabled ?? null,
        speakerEnabled: device.reads.speakerEnabled ?? null,
        recordingEnabled: device.reads.audioRecordingEnabled ?? null,
        speakerVolume: device.reads.speakerVolume ?? null,
      },
      talkbackSupported: supportsStandaloneC31Presets(device, route, isPpcsRouteReady(device, this.#devices, dskPeerSerials)),
      motionSensitivityControlSupported: settingRouteReady && sensitivityProfile !== null && device.reads.motionSensitivityStep !== undefined,
      motionSensitivitySteps: sensitivityProfile?.ladder?.length ?? null,
      homebaseChimeControlSupported: settingRouteReady && chimeProfile !== null && device.reads.homebaseChimeEnabled !== undefined,
      preferenceControls: supportsStandaloneC31Presets(device, route, isPpcsRouteReady(device, this.#devices, dskPeerSerials))
        ? c31PreferenceNames.filter((name) => c31PreferenceValue(device.reads, name) !== undefined) : [],
      reportedSettings: {
        preRecordingEnabled: device.reads.preRecordingEnabled ?? null,
        ringtoneVolume: device.reads.ringtoneVolume ?? null,
        soundDetectionSensitivity: device.reads.soundDetectionSensitivity ?? null,
        soundDetectionType: device.reads.soundDetectionType ?? null,
        soundRoundLookEnabled: device.reads.soundRoundLookEnabled ?? null,
        enhanceLightingEnabled: device.reads.enhanceLightingEnabled ?? null,
        lightBrightness: device.reads.lightBrightness ?? null,
        notificationIntervalMinutes: device.reads.notificationIntervalMinutes ?? null,
        rtspPublicationEnabled: device.reads.rtspPublicationEnabled ?? null,
        continuousRecordingEnabled: device.reads.continuousRecordingEnabled ?? null,
        streamingQualityTier: device.reads.streamingQualityTier ?? null,
        recordingQualityTier: device.reads.recordingQualityTier ?? null,
        solarIntensity: device.reads.solarIntensity ?? null,
        solarConnected24h: device.reads.solarConnected24h ?? null,
        notificationStyle: device.reads.notificationStyle ?? null,
        watermarkMode: device.reads.watermarkMode ?? null,
        antiTheftDetectionEnabled: device.reads.antiTheftDetectionEnabled ?? null,
        spotlightEnabled: device.reads.spotlightEnabled ?? null,
        motionSensitivityRaw: device.reads.motionSensitivityRaw ?? null,
        motionSensitivityStep: device.reads.motionSensitivityStep ?? null,
        imageFlipped: device.reads.imageFlipped ?? null,
        statusLedEnabled: device.reads.statusLedEnabled ?? null,
        soundDetectionEnabled: device.reads.soundDetectionEnabled ?? null,
        homebaseChimeEnabled: device.reads.homebaseChimeEnabled ?? null,
        mechanicalChimeEnabled: device.reads.mechanicalChimeEnabled ?? null,
        wideDynamicRangeEnabled: device.reads.wideDynamicRangeEnabled ?? null,
        chimeVolume: device.reads.chimeVolume ?? null,
        doorbellVideoQuality: device.reads.doorbellVideoQuality ?? null,
        highCompressionEncoding: device.reads.highCompressionEncoding ?? null,
        workingMode: device.reads.workingMode ?? null,
        recordingDurationSeconds: device.reads.recordingDurationSeconds ?? null,
        recordingIntervalSeconds: device.reads.recordingIntervalSeconds ?? null,
        recordingAutoStop: device.reads.recordingAutoStop ?? null,
      },
      stationSerial: device.parentSerial,
      doorbellSupported: isDoorbellDevice(device),
      streamSupported: isPpcsStreamSupported(device, this.#devices, dskPeerSerials),
      liveAudioSupported: supportsCameraLiveAudio(device, route, isPpcsStreamSupported(device, this.#devices, dskPeerSerials)),
      enabled: device.reads.enabled ?? null,
      enableControlSupported: device.reads.enabled !== undefined
        && device.channel === 0
        && device.adminUserId !== null
        && isPpcsRouteReady(device, this.#devices, dskPeerSerials),
      streamingQualityControlSupported: supportsStandaloneStreamingQuality(device, route, isPpcsRouteReady(device, this.#devices, dskPeerSerials)),
      streamingQualityModes: supportsStandaloneStreamingQuality(device, route, isPpcsRouteReady(device, this.#devices, dskPeerSerials)) ? device.model === "T817L" ? [
        { value: 0, name: "Auto" }, { value: 2, name: "Medium" }, { value: 3, name: "High" },
      ] : [
        { value: 0, name: "Auto" }, { value: 1, name: "HD (720P)" },
        { value: 2, name: "Full HD (1080P)" }, { value: 3, name: "2K" },
      ] : [],
      audioRecordingControlSupported: supportsStandaloneAudioRecording(device, route, isPpcsRouteReady(device, this.#devices, dskPeerSerials)),
      motionDetectionEnabled: device.reads.motionDetectionEnabled ?? null,
      motionDetectionControlSupported: device.reads.motionDetectionEnabled !== undefined
        && ((device.deviceType === 88 && device.model === "T8171") || (device.deviceType === 10_031 && device.model === "T817L" && route?.homeBaseAttached === false)
          ? supportsStandaloneMotionDetection(device, route, isPpcsRouteReady(device, this.#devices, dskPeerSerials))
          : supportsMotionDetectionControlRoute(route))
        && device.channel !== null
        && device.adminUserId !== null
        && isPpcsRouteReady(device, this.#devices, dskPeerSerials),
      guardMode: device.reads.guardMode ?? null,
      guardModeControlSupported: device.reads.guardMode !== undefined
        && supportsStandaloneGuardMode(device)
        && route?.homeBaseAttached === false
        && device.channel === 0
        && device.adminUserId !== null
        && device.userName !== null
        && isPpcsRouteReady(device, this.#devices, dskPeerSerials),
      guardModeRefreshSupported: supportsStandaloneGuardMode(device)
        && route?.homeBaseAttached === false
        && device.channel === 0
        && device.adminUserId !== null
        && isPpcsRouteReady(device, this.#devices, dskPeerSerials),
      nightVisionMode: device.reads.nightVisionMode ?? null,
      nightVisionModes: nightVisionModes(device),
      nightVisionControlSupported: supportsStandaloneNightVision(device, route,
        isPpcsRouteReady(device, this.#devices, dskPeerSerials)) || (device.reads.nightVisionMode !== undefined
        && !isDoorbellDevice(device)
        && device.channel !== null
        && device.adminUserId !== null
        && ppcsStreamRoute(device, this.#devices)?.homeBaseAttached === true
        && isPpcsRouteReady(device, this.#devices, dskPeerSerials)),
      autoNightVisionEnabled: isAutoNightVisionDoorbell(device) && device.reads.autoNightVisionEnabled !== undefined
        ? device.reads.autoNightVisionEnabled
        : null,
      autoNightVisionControlSupported: device.reads.autoNightVisionEnabled !== undefined
        && isAutoNightVisionDoorbell(device)
        && device.channel !== null
        && device.adminUserId !== null
        && ppcsStreamRoute(device, this.#devices)?.homeBaseAttached === true
        && isPpcsRouteReady(device, this.#devices, dskPeerSerials),
      cameraLightControlSupported: cameraLightControlProtocol(device) !== null
        && (cameraLightControlProtocol(device) !== "c31-json"
          || supportsStandaloneC31Presets(device, route, isPpcsRouteReady(device, this.#devices, dskPeerSerials)))
        && ppcsStreamRoute(device, this.#devices)?.homeBaseAttached === false
        && device.channel !== null
        && isPpcsRouteReady(device, this.#devices, dskPeerSerials),
      timedLightControlSupported: supportsTimedCameraLight(device)
        && ppcsStreamRoute(device, this.#devices)?.homeBaseAttached === false
        && device.channel !== null
        && isPpcsRouteReady(device, this.#devices, dskPeerSerials),
      cameraSirenControlSupported: supportsCameraSiren(device, ppcsStreamRoute(device, this.#devices))
        && device.channel !== null
        && device.adminUserId !== null
        && isPpcsRouteReady(device, this.#devices, dskPeerSerials),
      presetPositionControlSupported: t817lControlsSupported || soloCamPanControlsSupported
        || supportsStandaloneC31Presets(device, route, isPpcsRouteReady(device, this.#devices, dskPeerSerials)),
      storedRecordingsSupported: supportsSoloCamStoredRecordings(device, route, isPpcsRouteReady(device, this.#devices, dskPeerSerials)),
      aiTrackingControlSupported: t817lControlsSupported || supportsStandaloneAiTracking(
        device, route, isPpcsRouteReady(device, this.#devices, dskPeerSerials),
      ),
      aiTrackingEnabled: device.reads.aiTrackingEnabled ?? null,
      autoCruiseControlSupported: t817lControlsSupported
        || supportsStandaloneC31Presets(device, route, isPpcsRouteReady(device, this.#devices, dskPeerSerials)),
      battery: batteryState(device),
    };
  }

  /** Send a source-backed momentary camera-light command over a ready direct route. */
  setCameraLight(serial: string, enabled: boolean): Promise<void> {
    this.#assertNoModelTrial(serial);
    const previous = this.#lightOperations.get(serial) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const device = this.#devices.get(serial);
      const protocol = device ? cameraLightControlProtocol(device) : null;
      if (!device || !isSupportedMegaCamera(device) || protocol === null) {
        throw new Error("Camera light control is not supported for this camera");
      }
      const route = ppcsStreamRoute(device, this.#devices);
      if (protocol === "c31-json" && !supportsStandaloneC31Presets(device, route, true)) {
        throw new Error("C31 light control requires its authorized direct channel-zero route");
      }
      const peer = route?.peer;
      const dsk = peer ? await this.#dskKey(peer.serial) : null;
      if (
        route?.homeBaseAttached !== false
        || !peer?.p2pDid
        || !peer.p2pConnection
        || !dsk
        || device.channel === null
      ) {
        throw new Error("Camera light control requires a ready standalone route");
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
        ...(protocol === "c31-json"
          ? { resolveCipherKey: (cipherId: number) => this.#resolveCipherKey(cipherId, peer) } : {}),
      });
      try {
        await session.start();
        if (protocol === "c31-json") await session.writeStandaloneC31Light(enabled);
        else if (protocol === "int-string") await session.writeStandaloneCameraLight(enabled);
        else await session.writeTimedCameraLight(enabled);
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

  /**
   * Trigger or stop a proven camera siren, interrupting an earlier owned C31 pulse.
   *
   * C31 pulses retain their connection until an explicit stop is sent, including
   * cancellation and shutdown. Their promise covers the pulse and stop attempt,
   * not readable alarm state. Attached cameras retain their native duration path.
   */
  setCameraSiren(serial: string, durationSeconds: number): Promise<void> {
    this.#assertNoModelTrial(serial);
    if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 900) {
      return Promise.reject(new Error("Camera siren duration must be a whole number from 0 to 900 seconds"));
    }
    if (this.#recordingClosing) return Promise.reject(new Error("Camera provider is closing"));
    const device = this.#devices.get(serial);
    const route = device ? ppcsStreamRoute(device, this.#devices) : null;
    if (device && supportsStandaloneC31Presets(device, route, true) && durationSeconds > 30) {
      return Promise.reject(new Error("Standalone C31 siren pulses support at most 30 seconds"));
    }
    this.#cameraSirenAborters.get(serial)?.abort();
    const controller = new AbortController();
    this.#cameraSirenAborters.set(serial, controller);
    const previous = this.#cameraSirenOperations.get(serial) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      if (!controller.signal.aborted) await this.#writeCameraSiren(serial, durationSeconds, controller.signal);
    });
    this.#cameraSirenOperations.set(serial, current);
    void current.finally(() => {
      if (this.#cameraSirenOperations.get(serial) === current) this.#cameraSirenOperations.delete(serial);
      if (this.#cameraSirenAborters.get(serial) === controller) this.#cameraSirenAborters.delete(serial);
    }).catch(() => undefined);
    return current;
  }

  /** Own one siren transport and ensure every attempted C31 start has an explicit stop. */
  async #writeCameraSiren(serial: string, durationSeconds: number, signal: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 900) {
      throw new Error("Camera siren duration must be a whole number from 0 to 900 seconds");
    }
    const device = this.#devices.get(serial);
    const route = device ? ppcsStreamRoute(device, this.#devices) : null;
    if (!device || !route || !isSupportedMegaCamera(device) || !supportsCameraSiren(device, route)) {
      throw new Error("Camera siren control is not supported for this camera");
    }
    const peer = route?.peer;
    const dsk = peer ? await this.#dskKey(peer.serial) : null;
    if (!peer?.p2pDid || !peer.p2pConnection || !dsk || device.channel === null || !device.adminUserId) {
      throw new Error("Camera siren control requires a ready camera route");
    }
    const session = new FirstPartyPpcsSession({
      stationSerial: peer.serial, p2pDid: peer.p2pDid, appConnection: peer.p2pConnection,
      localAddress: peer.localAddress,
      dskKey: dsk.key, channel: device.channel, cameraModel: device.model,
      accountId: device.adminUserId, homeBaseAttached: route.homeBaseAttached, purpose: "control", maxSeconds: 50,
      resolveCipherKey: (cipherId: number) => this.#resolveCipherKey(cipherId, peer),
    });
    const c31 = supportsStandaloneC31Presets(device, route, true);
    if (c31 && durationSeconds > 30) throw new Error("Standalone C31 siren pulses support at most 30 seconds");
    let stopNeeded = false;
    try {
      await session.start();
      if (c31) {
        if (signal.aborted) return;
        stopNeeded = durationSeconds > 0;
        await session.writeStandaloneC31Siren(durationSeconds > 0);
        if (durationSeconds > 0) {
          try { await cancellableDelay(durationSeconds * 1_000, undefined, { signal }); }
          catch (error) { if (!signal.aborted) throw error; }
        }
      } else {
        await session.writeCameraSiren(durationSeconds);
      }
    } finally {
      try { if (stopNeeded) await session.writeStandaloneC31Siren(false); }
      finally { session.close(); }
    }
  }

  /** Serialize a fresh preset query with movement and tracking on the verified camera route. */
  async getCameraPresetPositions(serial: string): Promise<readonly CameraPresetPosition[]> {
    this.#assertNoModelTrial(serial);
    let positions: readonly CameraPresetPosition[] = [];
    await this.#queuePanControl(serial, "preset_query", async (session) => {
      positions = await session.queryPresetPositions();
    });
    return positions;
  }

  /** Move once to an enabled stored position after refreshing slot occupancy. */
  selectCameraPresetPosition(serial: string, index: number): Promise<void> {
    this.#assertNoModelTrial(serial);
    if (!Number.isSafeInteger(index) || index < 0 || index > 9) {
      return Promise.reject(new Error("Camera preset index must be between 0 and 9"));
    }
    return this.#queuePanControl(serial, "preset_position", async (session) => {
      const positions = await session.queryPresetPositions();
      if (!positions.some((position) => position.index === index && position.enabled)) {
        throw new Error("Camera preset position is not enabled");
      }
      await session.selectPresetPosition(index);
    });
  }

  /** Write verified tracking and require fresh cloud confirmation on admitted standalone routes. */
  setCameraAiTracking(serial: string, enabled: boolean): Promise<void> {
    this.#assertNoModelTrial(serial);
    return this.#queuePanControl(serial, "ai_tracking", async (session) => {
      const device = this.#devices.get(serial);
      const confirmPreference = device
        && supportsStandaloneAiTracking(device, ppcsStreamRoute(device, this.#devices), true);
      await session.writeAiTracking(enabled);
      if (!confirmPreference) return;

      // Pre-write device-info overrides must not satisfy a fresh cloud confirmation.
      const cached = this.#liveDeviceReads.get(serial);
      if (cached) {
        const { aiTrackingEnabled: _stale, ...remaining } = cached;
        this.#liveDeviceReads.set(serial, remaining);
      }
      const readDeadline = Date.now() + 65_000;
      for (let attempt = 0; attempt < 13 && Date.now() < readDeadline; attempt += 1) {
        await this.#refreshInventoryReads();
        if (this.#devices.get(serial)?.reads.aiTrackingEnabled === enabled) return;
        await delay(5_000);
      }
      throw new Error("Camera AI tracking write was not confirmed by readback");
    });
  }

  /** Send the reversible automatic-cruise action proven on local hardware. */
  setCameraAutoCruise(serial: string, enabled: boolean): Promise<void> {
    this.#assertNoModelTrial(serial);
    return this.#queuePanControl(serial, "auto_cruise", (session) => session.writeAutoCruise(enabled));
  }

  /** Serialize pan actions on an existing decoded viewer or a newly owned control session. */
  #queuePanControl(
    serial: string,
    action: string,
    operation: (session: FirstPartyPpcsSession) => Promise<void>,
  ): Promise<void> {
    const previous = this.#panControlOperations.get(serial) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const device = this.#devices.get(serial);
      if (!device || !isSupportedMegaCamera(device) || !supportsPresetPositions(device)) {
        throw new Error("Pan and tracking controls are not supported for this camera");
      }
      if (this.#recordingPeerReserved(serial)) {
        throw new Error("Wait for this camera peer's recording retrieval before using pan controls");
      }
      if (action === "auto_cruise" && !device.model.toUpperCase().startsWith("T817L")) {
        throw new Error("Automatic cruise has not been verified for this camera");
      }
      if (action === "ai_tracking" && (device.model === "T8171"
        || ppcsStreamRoute(device, this.#devices)?.homeBaseAttached === false)
        && !supportsStandaloneAiTracking(device, ppcsStreamRoute(device, this.#devices),
          isPpcsRouteReady(device, this.#devices, new Set(this.#dskKeys.keys())))) {
        throw new Error("Camera AI tracking requires a known preference and ready direct route");
      }
      const active = this.#ppcsStreams.get(serial);
      const route = ppcsStreamRoute(device, this.#devices);
      if (route?.homeBaseAttached === false && device.model === "T817L"
        && action !== "preset_query" && action !== "preset_position" && action !== "auto_cruise" && action !== "ai_tracking") {
        throw new Error("This standalone camera action has not been verified");
      }
      if (active && !(device.model === "T817L" && action === "ai_tracking")
        && (supportsSoloCamPresetControl(device, route, true)
        || supportsStandaloneC31Presets(device, route, true))
        && active.stats.closeReason === "open" && active.stats.camId > 0
        && active.stats.videoOutputFrames > 0) {

        // Admitted pan controls share the decoded viewer connection and its owner.
        // C31 tracking retains its separately verified owned control session.
        await operation(active);
        return;
      }
      await this.stopStream(serial);
      const session = await this.#panControlSession(device);
      try {
        await session.start();
        await operation(session);
      } finally {
        session.close();
      }
    }).catch((error: unknown) => {
      logger.warn("camera_t817l_control_failed", `Camera pan control failed: action=${action} error=${safeError(error)}`);
      throw error;
    });
    this.#panControlOperations.set(serial, current);
    void current.finally(() => {
      if (this.#panControlOperations.get(serial) === current) this.#panControlOperations.delete(serial);
    }).catch(() => undefined);
    return current;
  }

  /** Build a control session for a hardware-verified pan route without broadening AI tracking eligibility. */
  async #panControlSession(device: MegaInventoryDevice): Promise<FirstPartyPpcsSession> {
    const route = ppcsStreamRoute(device, this.#devices);
    const peer = route?.peer;
    const dsk = peer ? await this.#dskKey(peer.serial) : null;
    if (!route || !peer?.p2pDid || !peer.p2pConnection || !dsk || device.channel === null || !device.adminUserId
      || (route.homeBaseAttached
        ? !device.model.toUpperCase().startsWith("T817L") && !supportsSoloCamPresetControl(device, route, true)
        : !supportsStandalonePanControl(device, route, true) && !supportsStandaloneC31Presets(device, route, true))) {
      throw new Error("Camera pan controls require a verified ready route");
    }
    return new FirstPartyPpcsSession({
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
      maxSeconds: device.model === "T8171" && device.deviceType === 88 ? 60 : 40,
      resolveCipherKey: (cipherId: number) => this.#resolveCipherKey(cipherId, peer),
    });
  }

  /** Trigger or stop a HomeBase siren through the station-side duration command. */
  async setHomeBaseSiren(serial: string, durationSeconds: number): Promise<HomeBaseState> {
    this.#assertNoModelTrial(serial);
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
    const station = this.#stations.get(serial);
    if (station) {
      const connected = stationConnectedAfterRefreshFailure(station.connected, failures);
      if (connected !== station.connected) {
        const updated = { ...station, connected };
        this.#stations.set(serial, updated);
        this.#events?.station(updated);
      }
    }
    if (failures === 1 || failures % 15 === 0) {
      logger.warn("station_refresh_unavailable", `HomeBase state refresh unavailable: failures=${failures} error=${safeError(error)}`);
    }
  }

  #recordStationRefreshSuccess(serial: string): void {
    const failures = this.#stationRefreshFailures.get(serial) ?? 0;
    this.#stationRefreshFailures.delete(serial);
    if (failures > 0) logger.info("station_refresh_recovered", `HomeBase state refresh recovered after failures=${failures}`);
  }

  #clearNvrEffectiveModes(events: ProviderEvents): void {
    for (const station of this.#stations.values()) {
      if (!station.effectiveModeReportedAt) continue;
      const updated = { ...station, effectiveMode: null, effectiveModeReportedAt: null };
      this.#stations.set(station.serial, updated);
      try { events.station(updated); } catch {}
    }
  }

  #handlePush(events: ProviderEvents, event: MegaPushEvent): void {
    const station = this.#stations.get(event.stationSerial);
    const stationIdentity = this.#devices.get(event.stationSerial);
    const nvrState = station && stationIdentity ? applyNvrModePush(station, stationIdentity, event,
      this.#nvrModePushStartedAt, this.#nvrModePushTimes.get(station.serial) ?? null, Date.now()) : null;
    if (nvrState) {
      this.#nvrModePushTimes.set(station!.serial, event.transportSentAtMilliseconds!);
      this.#stations.set(station!.serial, nvrState); events.station(nvrState);
    } else if (station?.guardModeControlSupported && event.eventType === 9) {
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
    const delivery = this.#pushDeduplicator.observe(
      event.cameraSerial,
      event.eventId,
      event.eventType,
      event.pictureUrl !== null,
    );
    if (delivery.retainPicture && isSupportedMegaCamera(device)) this.#queuePushSnapshot(events, event);
    if (!delivery.handleState) return;
    if ((device.deviceType === 2 || device.deviceType === 126) && event.eventType === 3 && event.sensorOpen !== null) {
      events.sensorContact(event.cameraSerial, event.sensorOpen);
      return;
    }
    if ((device.deviceType === 10 || device.deviceType === 127) && event.eventType === 14) {
      this.#pendingSensorMotionCloudConfirmations.set(event.cameraSerial, { receivedAt: Date.now() });
      events.sensorMotion(event.cameraSerial, true);
      return;
    }
    const doorbellPush = doorbellPushKind(event);
    if (doorbellPush !== null && isDoorbellDevice(device)) {
      if (doorbellPush === "press") {
        events.doorbell(event.cameraSerial, true);
        return;
      }
      const kinds = new Set(event.detectionEvidence);
      if (personName !== null) kinds.add("person");
      if (kinds.has("person")) events.person(event.cameraSerial, true, personName);
      events.motion(event.cameraSerial, true);
      for (const kind of kinds) {
        if (kind !== "person") events.detection(event.cameraSerial, kind, true);
      }
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
      if (this.#stationHasRecordingReservation(serial)) {
        if (interruptMedia) throw new Error("Wait for HomeBase recording retrieval before changing station settings");
        return this.#requireStation(serial);
      }
      if (interruptMedia) await this.#stopStationMedia(serial);
      else if (this.#stationHasActiveMedia(serial)) return this.#requireStation(serial);
      const session = new HomeBasePpcsSession({
        serial,
        p2pDid: identity.p2pDid,
        accountId: identity.adminUserId,
        userName: identity.userName ?? "Home Assistant",
        localAddress: identity.localAddress,
        storageProtocol: isHomeBase3(identity) ? "homebase3" : "homebase2",
        firmware: identity.firmware,
      });
      try {
        await session.connect();
        const observed = await operation(session);
        this.#applyHomeBaseChildParams(serial, observed.childParams);
        if (observed.storageDiagnostic && !this.#stationStorageDiagnosticLogged.has(serial)) {
          this.#stationStorageDiagnosticLogged.add(serial);
          const storageMedium = isHomeBase3(identity) ? "hdd" : "sd";
          logger.info(
            "homebase_storage_observed",
            homeBaseStorageLogSummary(
              identity.model,
              observed.storageDiagnostic,
              observed.storage?.[storageMedium] ?? null,
              storageMedium,
            ),
          );
        }
        const updated = mergeHomeBaseState(this.#requireStation(serial), observed);
        this.#stations.set(serial, updated);
        this.#events?.station(updated);
        return updated;
      } catch (error) {
        if (interruptMedia) {
          const updated = { ...this.#requireStation(serial), connected: false };
          this.#stations.set(serial, updated);
          this.#events?.station(updated);
        }
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
        device.model,
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
      publishHomeBaseChildSensorObservation(merged, this.#events);
    }
  }

  #requireStation(serial: string): HomeBaseState {
    const station = this.#stations.get(serial);
    if (!station) throw new Error(`Unknown HomeBase: ${serial}`);
    return station;
  }

  #reserveTrialPeer(peer: string): () => void {
    if (this.#trialPeers.has(peer)) throw new Error("Wait for the model control trial to finish");
    const owner = Symbol();
    this.#trialPeers.set(peer, owner);
    return () => { if (this.#trialPeers.get(peer) === owner) this.#trialPeers.delete(peer); };
  }

  #generalRtcReserved(serial: string): boolean {
    const parent = this.#devices.get(serial)?.parentSerial || serial;
    return [...this.#generalRtcTrials.values()].some(entry => entry.parent === parent);
  }

  async #withGeneralRtcLockOperation<T>(serial: string, operation: () => Promise<T>): Promise<T> {
    this.#generalRtcLockOperations.set(serial, (this.#generalRtcLockOperations.get(serial) ?? 0) + 1);
    try { return await operation(); }
    finally {
      const remaining = (this.#generalRtcLockOperations.get(serial) ?? 1) - 1;
      if (remaining) this.#generalRtcLockOperations.set(serial, remaining);
      else this.#generalRtcLockOperations.delete(serial);
    }
  }

  #nvrControlReserved(peer: string): boolean {
    const now = performance.now();
    return this.#nvrGuardLatches.has(peer) || this.#nvrGuardEntries.has(peer) || this.#nvrPowerEntries.has(peer)
      || (this.#nvrGuardCooldowns.get(peer) ?? 0) > now || (this.#nvrPowerCooldowns.get(peer) ?? 0) > now;
  }

  #recordingPeerReserved(serial: string): boolean {
    const peer = this.#devices.get(serial)?.parentSerial || serial;
    if (this.#trialPeers.has(peer)) return true;
    return [...this.#recordingReservations].some((camera) => (this.#devices.get(camera)?.parentSerial || camera) === peer);
  }

  #stationHasRecordingReservation(stationSerial: string): boolean {
    if (this.#trialPeers.has(stationSerial)) return true;
    return [...this.#recordingReservations].some((serial) => this.#devices.get(serial)?.parentSerial === stationSerial);
  }

  #stationHasActiveMedia(stationSerial: string): boolean {
    return this.#stationHasRecordingReservation(stationSerial) || [...this.#ppcsStreams.keys()].some((serial) => this.#devices.get(serial)?.parentSerial === stationSerial);
  }

  async #stopStationMedia(stationSerial: string): Promise<void> {
    const serials = [...this.#ppcsStreams.keys()].filter((serial) => this.#devices.get(serial)?.parentSerial === stationSerial);
    await Promise.all(serials.map((serial) => this.stopStream(serial)));
  }

  #queuePushSnapshot(events: ProviderEvents, event: MegaPushEvent): void {
    const generation = this.#startupGeneration;
    const previous = this.#pushSnapshotQueues.get(event.cameraSerial) ?? Promise.resolve();
    const current = previous.then(async () => {
      if (generation !== this.#startupGeneration) return;
      const camera = this.#devices.get(event.cameraSerial);
      const context: EventImageContext = camera ? {
        model: camera.model,
        ...(camera.deviceType !== null ? { deviceType: camera.deviceType } : {}),
        ...(camera.parentSerial ? { topology: camera.parentSerial !== camera.serial ? "attached" : "direct" } : {}),
      } : {};
      const picture = await downloadPushSnapshot(this.#client, event, this.#devices, this.config.eventImageCapture, context);
      if (picture) {
        if (generation !== this.#startupGeneration) {
          picture.data.fill(0);
          return;
        }
        events.snapshot(event.cameraSerial, picture.data, "image/jpeg");
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

/**
 * Download and decode the image referenced by one normalized push event.
 * An opt-in process-owned collector can retain original failed decode inputs.
 * Download errors and last-good image ownership stay with their existing boundaries.
 */
export async function downloadPushSnapshot(
  client: Pick<MegaClient, "download"> & Partial<Pick<MegaClient, "downloadWithMetadata" | "getEventImageKey">>,
  event: Pick<MegaPushEvent, "pictureUrl" | "stationSerial">,
  devices: ReadonlyMap<string, Pick<MegaInventoryDevice, "p2pDid"> & Partial<Pick<MegaInventoryDevice, "adminUserId">>>,
  capture?: EventImageCapture,
  context: EventImageContext = {},
): Promise<{ data: Buffer } | null> {
  const pictureUrl = eventPictureUrl(event.pictureUrl);
  if (!pictureUrl) return null;
  const response = capture && client.downloadWithMetadata ? await client.downloadWithMetadata(pictureUrl) : null;
  const encoded = response?.data ?? await client.download(pictureUrl);
  if (isJpeg(encoded)) return { data: encoded };
  let original: Buffer | null = null;
  try { original = capture?.prepare(encoded) ?? null; } catch {
    logger.warn("event_image_capture_unavailable", "Failed event-image evidence could not be captured");
  }
  try {
    const v8 = parseV8EventImage(encoded);
    if (v8) {
      if (v8.stationSerial !== event.stationSerial) {
        throw new Error("event image decode failed: format=v8 result=station_mismatch");
      }
      const owner = devices.get(event.stationSerial)?.adminUserId;
      if (!owner || !client.getEventImageKey) {
        throw new Error("event image decode failed: format=v8 result=key_unavailable");
      }
      let privateKey: Buffer;
      try {
        privateKey = await client.getEventImageKey(v8.keyId, owner);
      } catch (error) {
        const result = error instanceof Error && error.message === "Event picture key unavailable"
          ? "key_unavailable" : error instanceof Error && error.message === "Event picture key session changed"
            ? "owner_changed" : "key_lookup_failed";
        throw new Error(`event image decode failed: format=v8 result=${result}`);
      }
      try {
        if (devices.get(event.stationSerial)?.adminUserId !== owner) {
          throw new Error("event image decode failed: format=v8 result=owner_changed");
        }
        return { data: decodeV8EventImage(v8, privateKey) };
      } finally {
        privateKey.fill(0);
      }
    }
    const p2pDid = devices.get(event.stationSerial)?.p2pDid;
    if (!p2pDid && eventImageFormat(encoded) === "legacy") throw new Error("event image cannot be decoded without its HomeBase identity");
    const decoded = decodeEventImage(encoded, p2pDid ?? "");
    if (!isJpeg(decoded)) {
      throw new Error(
        `event image decode failed: format=${eventImageFormat(encoded)} size=${eventImageSize(encoded)} result=${jpegBoundaryResult(decoded)}`,
      );
    }
    return { data: decoded };
  } catch (error) {
    try {
      capture?.capture(original ?? encoded, context, response ?? undefined);
    } catch {
      logger.warn("event_image_capture_unavailable", "Failed event-image evidence could not be captured");
    }
    throw error;
  } finally {
    original?.fill(0);
  }
}

/** Classify an event-image body without retaining its contents or identity. */
function eventImageFormat(data: Buffer): "binary" | "empty" | "gzip" | "html" | "jpeg" | "json" | "legacy" | "png" | "v2" | "v8" | "webp" {
  if (data.length === 0) return "empty";
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) return "jpeg";
  if (data.subarray(0, 16).toString("latin1") === "v2_eufysecurity:") return "v2";
  if (data.subarray(0, 16).toString("latin1") === "v8_eufysecurity:") return "v8";
  if (data.subarray(0, 12).toString("latin1") === "eufysecurity") return "legacy";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) return "gzip";
  const prefix = data.subarray(0, 64);
  let index = prefix.length >= 3 && prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf ? 3 : 0;
  while (index < prefix.length && [0x20, 0x09, 0x0a, 0x0d].includes(prefix[index]!)) index += 1;
  if (prefix[index] === 0x7b || prefix[index] === 0x5b) return "json";
  if (prefix[index] === 0x3c) return "html";
  return "binary";
}

/** Bucket the downloaded event-image size without exposing its exact length. */
function eventImageSize(data: Buffer): "0" | "<1KiB" | "<64KiB" | "<1MiB" | ">=1MiB" {
  if (data.length === 0) return "0";
  if (data.length < 1_024) return "<1KiB";
  if (data.length < 65_536) return "<64KiB";
  if (data.length < 1_048_576) return "<1MiB";
  return ">=1MiB";
}

/** Describe only which JPEG boundary marker is absent after local decoding. */
function jpegBoundaryResult(data: Buffer): "missing_both" | "missing_end" | "missing_start" {
  const starts = data.length >= 2 && data[0] === 0xff && data[1] === 0xd8;
  const ends = data.length >= 2 && data.at(-2) === 0xff && data.at(-1) === 0xd9;
  if (starts) return "missing_end";
  if (ends) return "missing_start";
  return "missing_both";
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
    const parentSerial = safeValue(value.parent_sn, 128) ?? safeValue(value.station_sn, 128) ?? "";
    const channel = integer(value.device_channel) ?? integer(value.channel);
    const reads = safeInventoryReads(value.params, deviceType, model, (!parentSerial || parentSerial === serial) && channel === 0);
    const lastChargingDays = safeLastChargingDays(value.charging_days);
    devices.push({
      serial,
      name: safeValue(value.device_name, 100) ?? model,
      model,
      parentSerial,
      deviceType,
      category: safeValue(value.category, 100),
      channel,
      p2pDid: safeValue(value.p2p_did, 128),
      p2pConnection: safeValue(value.p2p_conn, 512) ?? safeValue(value.app_conn, 512),
      localAddress: freshestLanAddress(value),
      cipherId: integer(value.cipher_id),
      adminUserId: isRecord(value.member) ? safeValue(value.member.admin_user_id, 128) : null,
      userName: isRecord(value.member) ? safeValue(value.member.nick_name, 128) : null,
      firmware: safeValue(value.main_sw_version, 100),
      hardwareVersion: safeValue(value.main_hw_version, 100),
      firmwareSubVersion: safeValue(value.sec_sw_version, 100),
      firmwareUpdateAvailable: value.needUpdate === true || value.needUpdate === 1 || value.needUpdate === "1"
        ? true : value.needUpdate === false || value.needUpdate === 0 || value.needUpdate === "0" ? false : null,
      ...(safeParamTypes(value.params).includes(1256) ? (() => {
        const metadata = Array.isArray(value.params)
          ? value.params.find((row: unknown) => isRecord(row) && integer(row.param_type) === 1256)?.param_value
          : undefined;
        const guardModeNames = guardModeCustomNames(metadata);
        return {
          guardModeMetadataShape: guardModeMetadataShape(metadata),
          guardModeMetadataStructure: guardModeMetadataStructure(metadata),
          ...(guardModeNames === undefined ? {} : { guardModeNames }),
        };
      })() : {}),
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

/**
 * Refresh complete cloud device rows, including renamed cameras and new station bindings.
 * Clearly partial metadata rows retain their prior routing identity. The provider
 * retires sessions and route-local overlays before publishing a changed binding.
 */
export function mergeInventoryMetadata(existing: MegaInventoryDevice, fresh: MegaInventoryDevice): MegaInventoryDevice {
  if (existing.serial !== fresh.serial) throw new Error("Inventory metadata ownership changed");
  const complete = fresh.model !== "Unknown Eufy device" && fresh.deviceType !== null && fresh.category !== null;
  return {
    ...(complete ? fresh : existing),
    firmware: fresh.firmware,
    hardwareVersion: fresh.hardwareVersion ?? null,
    firmwareSubVersion: fresh.firmwareSubVersion ?? null,
    firmwareUpdateAvailable: fresh.firmwareUpdateAvailable ?? null,
  };
}

/** Identify changes that invalidate an already owned camera session or local parameter overlay. */
function inventoryBindingChanged(existing: MegaInventoryDevice, fresh: MegaInventoryDevice): boolean {
  return existing.parentSerial !== fresh.parentSerial || existing.channel !== fresh.channel
    || existing.model !== fresh.model || existing.deviceType !== fresh.deviceType
    || existing.category !== fresh.category || existing.adminUserId !== fresh.adminUserId;
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

/**
 * Decode only capability-backed inventory reads; arbitrary values are discarded.
 *
 * The caller explicitly identifies standalone channel-zero inventory before
 * model-specific fields can override legacy HomeBase meanings. Reported state
 * does not authorize a write or establish the physical effect of a control.
 */
export function safeInventoryReads(value: unknown, deviceType: number | null = null, model?: string, standaloneChannelZero = false): MegaInventoryReads {
  if (!Array.isArray(value)) return {};
  const params = new Map<number, unknown>();
  for (const row of value) {
    if (!isRecord(row)) continue;
    const type = integer(row.param_type);
    if (type !== null) params.set(type, row.param_value);
  }
  const settingRows = value.flatMap(row => {
    if (!isRecord(row)) return [];
    const type = integer(row.param_type);
    return type === null ? [] : [{ param_type: type, param_value: row.param_value }];
  });
  const motionStep = readCameraSetting(settingRows, model ?? "", deviceType, standaloneChannelZero, "motionSensitivity");
  const reviewedChime = readCameraSetting(settingRows, model ?? "", deviceType, standaloneChannelZero, "homebaseChime");
  const percentage = (type: number): number | undefined => {
    const parsed = finiteNumber(params.get(type));
    return parsed !== null && parsed >= 0 && parsed <= 100 ? parsed : undefined;
  };
  const temperature = finiteNumber(params.get(1138));
  const batteryStatus = finiteNumber(params.get(2111));
  const contact = finiteNumber(params.get(1550));
  const rssi = finiteNumber(params.get(1141));
  const contactLastSeen = validUnixSeconds(params.get(1551));
  const motionValue = params.get(1605);
  const milliseconds = deviceType === 10 && model === "T8910"
    && (typeof motionValue === "number" || typeof motionValue === "string" && /^\d+$/.test(motionValue))
    && Number.isSafeInteger(Number(motionValue)) && Number(motionValue) >= 946_684_800_000
    ? Number(motionValue) / 1_000 : undefined;
  const motionEventSeconds = deviceType === 10 || deviceType === 127
    ? validUnixSeconds(milliseconds ?? motionValue)
    : undefined;
  const lastSeen = contactLastSeen ?? motionEventSeconds;
  const batteryLevel = percentage(1101);
  const backupRows = deviceType === 203 && model === "T85V0"
    ? value.filter(row => isRecord(row) && (row.param_type === 6485 || row.param_type === "6485")) : [];
  const backupValue = backupRows.length === 1 && isRecord(backupRows[0]) ? backupRows[0].param_value : undefined;
  const backupNumber = typeof backupValue === "number" ? backupValue
    : typeof backupValue === "string" && /^(?:[1-9]\d?|100)$/.test(backupValue) ? Number(backupValue) : NaN;
  const backupBatteryLevel = Number.isInteger(backupNumber) && backupNumber >= 1 && backupNumber <= 100
    ? backupNumber : undefined;
  const imageFlipped = finiteNumber(params.get(1207));
  const doorbell = isDoorbellDevice({ deviceType, category: "eufy_security" });
  const soundDetection = finiteNumber(params.get(6043));
  const microphone = finiteNumber(params.get(1240));
  const speaker = finiteNumber(params.get(1241));
  const recordMute = finiteNumber(params.get(1288));
  const soloE30 = deviceType === 88 && model === "T8171";
  const c31 = standaloneChannelZero && deviceType === 10_031 && model === "T817L";
  const statusLed = finiteNumber(params.get(c31 ? 6014 : doorbell ? 1716 : 1045));
  const preRecording = c31 ? finiteNumber(params.get(6257)) : null;
  const soloAudioRecording = soloE30 || c31 ? finiteNumber(params.get(6012)) : null;
  const soloAiTracking = soloE30 || (deviceType === 10_031 && model === "T817L")
    ? finiteNumber(params.get(6016)) : null;
  const speakerVolume = percentage(1230);

  // These reads have model-specific evidence. Shared parameter IDs alone do not
  // establish their meaning for every device that reports them.
  const verifiedDoorbell = deviceType === 5 || deviceType === 94;
  const homebaseChime = reviewedChime !== undefined ? (reviewedChime ? 1 : 0) : verifiedDoorbell ? finiteNumber(params.get(1702)) : null;
  const mechanicalChime = verifiedDoorbell ? finiteNumber(params.get(1703)) : null;
  const wideDynamicRange = verifiedDoorbell ? finiteNumber(params.get(1704)) : null;
  const chimeVolume = verifiedDoorbell ? percentage(1717) : undefined;
  const ringtoneVolume = deviceType === 94 ? percentage(1708) : undefined;
  const soundFamily = deviceType === 31 && /^T8410(?:$|[A-Z0-9-])/.test(model ?? "");
  const soundSensitivity = soundFamily || c31 ? finiteNumber(params.get(6044)) : null;
  const soundType = soundFamily || c31 ? finiteNumber(params.get(6046)) : null;
  const soundRoundLook = c31 ? finiteNumber(params.get(6208)) : null;
  const lightBrightness = c31 ? percentage(1401) : undefined;
  const notificationInterval = c31 ? finiteNumber(params.get(1250)) : null;
  const rtspPublication = c31 ? finiteNumber(params.get(1145)) : null;
  const continuousRecording = c31 ? finiteNumber(params.get(6010)) : null;
  const enhanceLighting = c31 ? finiteNumber(params.get(6484)) : null;
  const qualityFamily = deviceType === 48 && /^T8170(?:$|[A-Z0-9-])/.test(model ?? "");
  const t8171 = deviceType === 88 && /^T8171(?:$|[A-Z0-9-])/.test(model ?? "");
  const t8425 = deviceType === 47 && /^T8425(?:$|[A-Z0-9-])/.test(model ?? "");
  const streamingQuality = c31 ? activeRecordingQuality(params.get(2730), 0) ?? null
    : qualityFamily || t8171 ? finiteNumber(params.get(1020)) : null;
  const recordingQuality = c31 ? activeRecordingQuality(params.get(2731), 2)
    : qualityFamily || soloE30 ? activeRecordingQuality(params.get(2731)) : undefined;
  const solarIntensity = qualityFamily ? finiteNumber(params.get(1309)) : null;
  const solarConnected = qualityFamily ? finiteNumber(params.get(6482)) : null;
  const notificationStyle = t8171 ? finiteNumber(params.get(6020)) : null;
  const watermark = t8425 || c31 ? finiteNumber(params.get(1214)) : null;
  const antiTheft = t8425 ? finiteNumber(params.get(1015)) : null;
  const nativeLightProfile = (deviceType === 38 && model === "T8423")
    || (deviceType === 105 && model === "T8417")
    || (deviceType === 151 && model === "T84A1");
  const spotlight = qualityFamily || nativeLightProfile ? finiteNumber(params.get(1403)) : null;
  const sensitivity = qualityFamily ? finiteNumber(params.get(1276)) : null;
  const compositeQuality = deviceType === 5 ? finiteNumber(params.get(1705)) : null;
  const validComposite = compositeQuality !== null && Number.isInteger(compositeQuality)
    && [0, 1, 2, 3, 5, 6, 7, 8].includes(compositeQuality);
  const recordingPolicy = deviceType === 48 && /^T8170(?:$|[A-Z0-9-])/.test(model ?? "");
  const mode = recordingPolicy ? finiteNumber(params.get(1246)) : null;
  const modeNames = ["Optimal Battery Life", "Optimal Surveillance", "Customize Recording"] as const;
  const autoStop = recordingPolicy ? finiteNumber(params.get(1251)) : null;
  const recordingSeconds = (type: number): number | undefined => {
    const seconds = recordingPolicy ? finiteNumber(params.get(type)) : null;
    return seconds !== null && Number.isInteger(seconds) && seconds >= 0 && seconds <= 0xffff_ffff
      ? seconds : undefined;
  };
  const duration = recordingSeconds(1249);
  const interval = recordingSeconds(1250);
  const batteryHealth = percentage(1198);
  const openDevice = finiteNumber(params.get(2001));
  const cameraSwitch = finiteNumber(params.get(1035));
  const cameraSwitch1035 = params.has(1035) ? diagnosticCameraSwitch(params.get(1035)) : undefined;

  // The selected standalone profiles report detection through their native switch.
  // A conflicting legacy bit must not override that model-specific read.
  const nativeLightMotion = standaloneChannelZero && nativeLightProfile;
  const motionSwitch = finiteNumber(params.get(soloE30 || c31 || nativeLightMotion ? 6040 : 1011));
  const guardMode = finiteNumber(params.get(1224));
  const autoNightVision = finiteNumber(params.get(1013));
  const nightVisionMode = finiteNumber(params.get(1277));
  const privacy6250 = finiteNumber(params.get(6250));
  const enabled = c31
    ? privacy6250 === 0 || privacy6250 === 1 ? privacy6250 === 0 : undefined
    : openDevice === 0 || openDevice === 1
    ? openDevice === 1
    : cameraSwitch === 0 || cameraSwitch === 1
      ? cameraSwitch === cameraEnableRawValue(deviceType, true)
      : undefined;
  return {
    ...(ringtoneVolume !== undefined && Number.isInteger(ringtoneVolume) ? { ringtoneVolume } : {}),
    ...(soundSensitivity !== null && Number.isInteger(soundSensitivity) && (c31 ? soundSensitivity >= 1 && soundSensitivity <= 5 : [1, 3, 5].includes(soundSensitivity))
      ? { soundDetectionSensitivity: soundSensitivity } : {}),
    ...((c31 ? soundType === 128 || soundType === 256 : soundType === 1 || soundType === 2) ? { soundDetectionType: soundType! } : {}),
    ...(lightBrightness !== undefined && Number.isInteger(lightBrightness) ? { lightBrightness } : {}),
    ...(rtspPublication === 0 || rtspPublication === 1 ? { rtspPublicationEnabled: rtspPublication === 1 } : {}),
    ...(continuousRecording === 0 || continuousRecording === 1 ? { continuousRecordingEnabled: continuousRecording === 1 } : {}),
    ...(notificationInterval !== null && Number.isInteger(notificationInterval) && notificationInterval >= 0 && notificationInterval <= 300 && notificationInterval % 60 === 0 ? { notificationIntervalMinutes: notificationInterval / 60 } : {}),
    ...(soundRoundLook === 0 || soundRoundLook === 1 ? { soundRoundLookEnabled: soundRoundLook === 1 } : {}),
    ...(enhanceLighting === 0 || enhanceLighting === 1 ? { enhanceLightingEnabled: enhanceLighting === 0 } : {}),
    ...(streamingQuality !== null && Number.isInteger(streamingQuality) && streamingQuality >= 0 && streamingQuality <= 3
      ? { streamingQualityTier: streamingQuality } : {}),
    ...(recordingQuality !== undefined ? { recordingQualityTier: recordingQuality } : {}),
    ...(solarIntensity !== null && solarIntensity >= 0 && solarIntensity <= Number.MAX_SAFE_INTEGER
      ? { solarIntensity } : {}),
    ...(solarConnected === 0 || solarConnected === 1 ? { solarConnected24h: solarConnected === 1 } : {}),
    ...(notificationStyle !== null && [1, 2, 3].includes(notificationStyle) ? { notificationStyle } : {}),
    ...(watermark !== null && [0, 1, 2].includes(watermark) ? { watermarkMode: watermark } : {}),
    ...(antiTheft === 0 || antiTheft === 1 ? { antiTheftDetectionEnabled: antiTheft === 1 } : {}),
    ...(spotlight === 0 || spotlight === 1 ? { spotlightEnabled: spotlight === 1 } : {}),
    ...(typeof motionStep === "number" ? { motionSensitivityStep: motionStep } : {}),
    ...(sensitivity !== null && Number.isInteger(sensitivity) && sensitivity >= 1 && sensitivity <= 7
      ? { motionSensitivityRaw: sensitivity } : {}),
    ...(mode !== null && Number.isInteger(mode) && mode >= 0 && mode <= 2 ? { workingMode: modeNames[mode]! } : {}),
    ...(duration !== undefined ? { recordingDurationSeconds: duration } : {}),
    ...(interval !== undefined ? { recordingIntervalSeconds: interval } : {}),

    // This setting reports a disable bit: zero means stop early when motion ends.
    ...(autoStop === 0 || autoStop === 1 ? { recordingAutoStop: autoStop === 0 } : {}),
    ...(homebaseChime === 0 || homebaseChime === 1 ? { homebaseChimeEnabled: homebaseChime === 1 } : {}),
    ...(mechanicalChime === 0 || mechanicalChime === 1 ? { mechanicalChimeEnabled: mechanicalChime === 1 } : {}),
    ...(wideDynamicRange === 0 || wideDynamicRange === 1 ? { wideDynamicRangeEnabled: wideDynamicRange === 1 } : {}),
    ...(chimeVolume !== undefined && Number.isInteger(chimeVolume) ? { chimeVolume } : {}),
    ...(validComposite ? {
      doorbellVideoQuality: compositeQuality! % 5,
      highCompressionEncoding: compositeQuality! >= 5,
    } : {}),
    ...(preRecording === 0 || preRecording === 1 ? { preRecordingEnabled: preRecording === 1 } : {}),
    ...(imageFlipped === 0 || imageFlipped === 1 ? { imageFlipped: imageFlipped === 1 } : {}),
    ...(statusLed === 0 || statusLed === 1 ? { statusLedEnabled: statusLed === 1 } : {}),
    ...(soundDetection === 0 || soundDetection === 1 ? { soundDetectionEnabled: soundDetection === 1 } : {}),
    ...(microphone === 0 || microphone === 1 ? { microphoneEnabled: microphone === 1 } : {}),
    ...(speaker === 0 || speaker === 1 ? { speakerEnabled: speaker === 1 } : {}),

    // Verified standalone profiles report an enable bit. Other models retain
    // the inverted mute field. Missing native state cannot use the legacy bit.
    ...(soloE30 || c31
      ? soloAudioRecording === 0 || soloAudioRecording === 1 ? { audioRecordingEnabled: soloAudioRecording === 1 } : {}
      : recordMute === 0 || recordMute === 1 ? { audioRecordingEnabled: recordMute === 0 } : {}),
    ...(speakerVolume !== undefined ? { speakerVolume } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(cameraSwitch1035 !== undefined ? { cameraSwitch1035 } : {}),
    ...(motionSwitch === 0 || motionSwitch === 1 ? { motionDetectionEnabled: motionSwitch === 1 } : {}),
    ...(soloAiTracking === 0 || soloAiTracking === 1 ? { aiTrackingEnabled: soloAiTracking === 1 } : {}),
    ...(guardMode !== null && [0, 1, 2, 3, 4, 5, 6, 47, 63].includes(guardMode) ? { guardMode } : {}),
    ...(autoNightVision === 0 || autoNightVision === 1 ? { autoNightVisionEnabled: autoNightVision === 1 } : {}),
    ...(nightVisionMode === 0 || nightVisionMode === 1 || nightVisionMode === 2
      || (deviceType === 88 && model === "T8171" && nightVisionMode === 3) ? { nightVisionMode } : {}),
    ...(privacy6250 === 0 || privacy6250 === 1 ? { privacy6250Value: privacy6250 } : {}),
    ...(batteryLevel !== undefined ? { batteryLevel } : {}),
    ...(backupBatteryLevel !== undefined ? { backupBatteryLevel } : {}),
    ...(batteryStatus !== null ? { batteryCharging: batteryStatus !== 0 && batteryStatus !== 2 } : {}),
    ...(batteryHealth !== undefined ? { batteryHealth } : {}),
    ...(temperature !== null && temperature >= -50 && temperature <= 100 ? { batteryTemperature: temperature } : {}),
    ...(contact === 0 || contact === 1 ? { contactOpen: contact === 1 } : {}),
    ...(rssi !== null && rssi >= -150 && rssi <= -1 ? { rssi } : {}),
    ...(lastSeen !== undefined
      ? { lastSeen: new Date(lastSeen * 1_000).toISOString() }
      : {}),
    ...(motionEventSeconds !== undefined ? { motionEventSeconds } : {}),
  };
}

/** Classify parameter 1035 without retaining untrusted text or structured values. */
function diagnosticCameraSwitch(value: unknown): NonNullable<MegaInventoryReads["cameraSwitch1035"]> {
  const numeric = finiteNumber(value);
  if (numeric === 0) return "zero";
  if (numeric === 1) return "one";
  if (numeric !== null) return "other_number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "text";
  if (Array.isArray(value) || isRecord(value)) return "structured";
  return "other";
}

/** Decode plain or canonical base64 JSON and require an explicitly selected recording mode. */
function activeRecordingQuality(value: unknown, minimum = 1): number | undefined {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (value.length > 4096) return undefined;
    try { parsed = JSON.parse(value); } catch {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
      const decoded = Buffer.from(value, "base64");
      if (decoded.toString("base64") !== value) return undefined;
      try { parsed = JSON.parse(decoded.toString("utf8")); } catch { return undefined; }
    }
  }
  if (!isRecord(parsed)) return undefined;
  const mode = parsed.cur_mode;
  if (typeof mode !== "number" || !Number.isSafeInteger(mode) || mode < 0 || mode > 255) return undefined;
  const selected = parsed[`mode_${mode}`];
  if (!isRecord(selected)) return undefined;
  const tier = selected.quality;
  return typeof tier === "number" && Number.isInteger(tier) && tier >= minimum && tier <= 3 ? tier : undefined;
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
  const backup = device.model === "T85V0" && device.deviceType === 203 && device.paramTypes.includes(6485);
  if ((!device.paramTypes.includes(1101) && !backup) || hasMainsBatterySentinel(device.model)) return null;
  const supported: BatteryState["supported"] = [
    ...(device.paramTypes.includes(1101) ? ["level" as const] : []),
    ...(backup ? ["backupLevel" as const] : []),
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
    ...(backup ? { backupLevel: device.reads.backupBatteryLevel ?? null } : {}),
  };
}

/**
 * Publish validated child-sensor reads after an existing HomeBase state refresh.
 *
 * The caller owns channel-to-device matching and merging partial reads. The
 * gateway owns transient motion timers. This does not connect, request data or
 * infer a contact state from a missing value, and unsupported devices stay absent.
 */
export function publishHomeBaseChildSensorObservation(
  device: MegaInventoryDevice,
  events: Pick<ProviderEvents, "sensor"> | null | undefined,
): void {
  const sensor = securitySensorState(device);
  if (sensor) events?.sensor(sensor);
}

/** Match a passive contact value to exactly one known sensor behind its originating station. */
export function resolveHomeBaseContactObservation(
  devices: Iterable<MegaInventoryDevice>,
  stationSerial: string,
  observation: SensorContactObservation,
): MegaInventoryDevice | null {
  const matches = [...devices].filter((device) => device.parentSerial === stationSerial
    && device.channel === observation.channel && (device.deviceType === 2 || device.deviceType === 126));
  if (matches.length !== 1) return null;
  const device = matches[0]!;
  return {
    ...device,
    paramTypes: [...new Set([...device.paramTypes, 1550])],
    reads: { ...device.reads, contactOpen: observation.open },
  };
}

function securitySensorState(device: MegaInventoryDevice): SecuritySensorState | null {
  const contact = device.paramTypes.includes(1550);
  const motion = device.deviceType === 10 || device.deviceType === 127;
  const battery = device.paramTypes.includes(1101);
  const lastSeen = device.paramTypes.includes(1551)
    || (motion && device.paramTypes.includes(1605));
  const rssi = device.paramTypes.includes(1141);
  if (!contact && !motion && !battery && !lastSeen && !rssi) return null;
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
      ...(rssi ? ["rssi" as const] : []),
    ],
    batteryLevel: device.reads.batteryLevel ?? null,
    contactOpen: device.reads.contactOpen ?? null,
    lastSeen: device.reads.lastSeen ?? null,
    motionDetected: false,
    rssi: device.reads.rssi ?? null,
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

/** Return whether inventory identifies a station that Home Assistant may represent. */
export function isInventoryStation(
  device: Pick<MegaInventoryDevice, "category" | "deviceType" | "model">,
): boolean {
  return isDiscoveredHomeBase(device)
    || (device.category === "eufy_security" && device.deviceType === 300 && device.model.startsWith("T8N00"));
}

/**
 * Apply fresh native T8N00 mode observations without enabling any security writes.
 * The provider owns the transport clock and monotonic fence. Generic HomeBase
 * fields, other models, stale deliveries and policy values posing as actual modes
 * cannot cross this read-only boundary. An unrecognized fresh change invalidates
 * the prior effective mode rather than keeping an obsolete reading.
 */
export function applyNvrModePush(station: HomeBaseState,
  identity: Pick<MegaInventoryDevice, "category" | "deviceType" | "model" | "serial">,
  event: MegaPushEvent, startedAt: number, previousSent: number | null, now: number): HomeBaseState | null {
  const change = event.nvrModeChange, sent = event.transportSentAtMilliseconds;
  if (identity.model !== "T8N00" || identity.deviceType !== 300 || identity.category !== "eufy_security"
    || identity.serial !== station.serial || event.stationSerial !== station.serial || event.cameraSerial !== station.serial
    || event.eventType !== 9 || !Number.isSafeInteger(startedAt) || !Number.isSafeInteger(now)
    || !Number.isSafeInteger(sent) || typeof sent !== "number" || sent < startedAt - 5000
    || sent < now - 120_000 || sent > now + 60_000 || sent < Date.UTC(2000, 0, 1)
    || sent > Date.UTC(9999, 11, 31) || previousSent !== null && sent <= previousSent) return null;
  if (!change || !validGuardMode(change.configured) || ![0, 1, 3, 4, 5, 63].includes(change.effective)
    || ![0, 1, 3, 4, 5, 63].includes(change.previous)
    || event.guardMode !== null && event.guardMode !== change.configured
    || event.effectiveMode !== null && event.effectiveMode !== change.effective) {
    return { ...station, effectiveMode: null, effectiveModeReportedAt: null };
  }
  return { ...station, stateReadSupported: true, guardMode: change.configured, effectiveMode: change.effective,
    effectiveModeReportedAt: new Date(sent).toISOString() };
}

/** Return whether inventory proves support for the wrapped guard-mode command. */
export function supportsHomeBaseGuardMode(
  device: Pick<MegaInventoryDevice, "category" | "deviceType" | "model" | "firmware">,
): boolean {
  if (isHomeBase3(device)) return true;
  if (!isDiscoveredHomeBase(device) || !device.firmware) return false;
  return compareFirmware(device.firmware, [2, 0, 7, 9]) >= 0;
}

/** Return whether a route has the proven level-two key exchange required by motion writes. */
export function supportsMotionDetectionControlRoute(
  route: { readonly homeBaseAttached: boolean } | null,
): boolean {
  return route?.homeBaseAttached === true;
}

/** Build inventory-owned station state without inferring an unverified command protocol. */
export function initialHomeBaseState(device: MegaInventoryDevice, dskReady: boolean): HomeBaseState {
  const controlsSupported = isHomeBase3(device);
  const homeBase2 = device.category === "eufy_security"
    && device.deviceType === 0
    && device.model.startsWith("T8010");
  const inventoryGuardMode = device.reads.guardMode ?? null;
  return {
    serial: device.serial,
    name: device.name,
    model: device.model,
    firmware: device.firmware,
    available: true,
    cameraRouteReady: Boolean(device.p2pDid && device.p2pConnection && dskReady),
    controlsSupported,
    guardModeControlSupported: supportsHomeBaseGuardMode(device),
    stateReadSupported: controlsSupported || inventoryGuardMode !== null,
    homeBaseSirenControlSupported: isDiscoveredHomeBase(device),
    connected: false,
    guardMode: inventoryGuardMode,
    guardModeNames: device.guardModeNames ?? {},
    effectiveMode: null,
    alarmActive: null,
    alarmVolume: null,
    promptVolume: null,
    alarmTone: null,
    storageSupported: controlsSupported ? ["emmc", "hdd"] : homeBase2 ? ["sd"] : [],
    storage: { sd: null, emmc: null, hdd: null },
  };
}

/**
 * Apply inventory-owned station readings without claiming a live PPCS read.
 *
 * RTC-only stations such as T8N00 cannot use the legacy station refresh, but
 * the account inventory can still report a newer guard mode. Preserve live
 * connection and control state while publishing only values owned by that
 * periodic inventory response.
 */
export function refreshInventoryStationState(
  existing: HomeBaseState,
  device: MegaInventoryDevice,
): HomeBaseState {
  return {
    ...existing,
    firmware: device.firmware ?? existing.firmware,
    guardMode: device.reads.guardMode ?? existing.guardMode,
    ...(existing.effectiveModeReportedAt && device.reads.guardMode !== undefined && device.reads.guardMode !== existing.guardMode
      ? { effectiveMode: null, effectiveModeReportedAt: null } : {}),
    guardModeNames: device.guardModeNames ?? existing.guardModeNames,
  };
}

/**
 * Apply one local station read to the published state.
 *
 * Some firmware, such as HomeBase 3 on recent releases, omits values from the
 * camera-info reply. A missing field means "not reported this time", not a
 * new value, so it must not erase a mode already known from the account
 * inventory or from a guard-mode notification.
 */
export function mergeHomeBaseState(existing: HomeBaseState, observed: HomeBasePpcsState): HomeBaseState {
  return {
    ...existing,
    firmware: observed.firmware ?? existing.firmware,
    stateReadSupported: true,
    connected: true,
    guardMode: observed.guardMode ?? existing.guardMode,
    effectiveMode: observed.effectiveMode ?? (observed.guardMode !== null && observed.guardMode !== existing.guardMode
      ? null
      : existing.effectiveMode),
    alarmVolume: observed.alarmVolume ?? existing.alarmVolume,
    promptVolume: observed.promptVolume ?? existing.promptVolume,
    alarmTone: observed.alarmTone ?? existing.alarmTone,
    storage: observed.storage ?? existing.storage,
  };
}

/** Describe mode availability in a raw local read, independently of preserved inventory values. */
export function homeBaseReadLogSummary(model: string, observed: HomeBasePpcsState): string {
  return `HomeBase state read ready: model=${model} guard_mode=${observed.guardMode === null ? "missing" : "present"} effective_mode=${observed.effectiveMode === null ? "missing" : "present"} alarm_volume=${observed.alarmVolumeObservation}`;
}

/** Format one bounded station-storage field inventory without exposing raw text values. */
export function homeBaseStorageLogSummary(
  model: string,
  diagnostic: HomeBaseStorageDiagnostic,
  normalized: HomeBaseState["storage"]["hdd"],
  medium: "sd" | "hdd" = "hdd",
): string {
  const fields = (values: readonly string[]): string => values.length > 0 ? values.join(",") : "none";
  return [
    `HomeBase storage observed: model=${model}`,
    `${medium}_present=${diagnostic.present}`,
    `calculated_total_bytes=${normalized?.totalBytes ?? "missing"}`,
    `calculated_free_bytes=${normalized?.freeBytes ?? "missing"}`,
    `${medium}_numeric=${fields(diagnostic.numericFields)}`,
    `${medium}_boolean=${fields(diagnostic.booleanFields)}`,
    `${medium}_text_lengths=${fields(diagnostic.textFieldLengths)}`,
    `${medium}_structured=${fields(diagnostic.structuredFields)}`,
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
    cameraSwitch1035: device.reads.cameraSwitch1035 ?? "missing",
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
export function isSupportedMegaCamera(device: Pick<MegaInventoryDevice, "category" | "deviceType"> & Partial<Pick<MegaInventoryDevice, "model">>): boolean {
  return isSupportedCameraType({ ...device, model: device.model ?? "" });
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

/**
 * Check implemented peer transport prerequisites without admitting the row as a camera.
 *
 * RTC-only stations can retain legacy-looking credentials in inventory. Those
 * values do not establish a usable PPCS route for attached media or controls.
 */
export function isPpcsRouteReady(
  device: MegaInventoryDevice,
  devicesBySerial: ReadonlyMap<string, MegaInventoryDevice>,
  dskPeerSerials: ReadonlySet<string>,
): boolean {
  const route = ppcsStreamRoute(device, devicesBySerial);
  const rtcStation = route?.peer.category === "eufy_security"
    && ((route.peer.deviceType === 27 && route.peer.model.startsWith("T9000"))
      || (route.peer.deviceType === 300 && route.peer.model.startsWith("T8N00")));
  return Boolean(
    !rtcStation && route?.peer.p2pDid
    && route.peer.p2pConnection
    && device.channel !== null
    && dskPeerSerials.has(route.peer.serial),
  );
}

/** Build a privacy-safe PPCS outcome summary without peer identities or packet data. */
export function ppcsStreamLogSummary(
  model: string,
  route: PpcsStreamRoute | null,
  stats: Pick<FirstPartyPpcsSession["stats"], "camId" | "dataDatagrams" | "frameHeaders" | "videoFrames"> & Partial<Pick<FirstPartyPpcsSession["stats"], "alternateLookupCandidates" | "batteryHistory" | "closeReason" | "commands" | "directLookupCandidates" | "duplicateDatagrams" | "foreignVideoFrames" | "frameShapes" | "incompleteAccessUnitBytes" | "incompleteAccessUnits" | "localLookupCandidates" | "mediaStartAttempts" | "mediaStartProtocols" | "mediaStopAttempts" | "mediaStopProtocol" | "parserBlocked" | "parserResyncs" | "pendingBytes" | "sequenceGaps" | "sequenceRestarts" | "sequenceChannels" | "staleDatagrams" | "types" | "videoCodec" | "videoNalTypes" | "videoOutputFrames" | "videoResults">>,
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
    `media_start_protocols=${stats.mediaStartProtocols?.join(",") || "none"}`,
    `media_stop_attempts=${stats.mediaStopAttempts ?? 0}`,
    `media_stop_protocol=${stats.mediaStopProtocol ?? "none"}`,
    `close_reason=${stats.closeReason ?? "unknown"}`,
    `battery_history=${stats.batteryHistory ?? "not-reported"}`,
    ...(stats.sequenceChannels === undefined ? [] : [`sequence_channels=${stats.sequenceChannels}`]),
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
    & Partial<Pick<MegaPushEvent, "detectionEvidence" | "personName" | "effectiveModeField">>,
  device: Pick<MegaInventoryDevice, "model" | "category" | "deviceType"> | null,
  stationPresent: boolean,
  stationManaged: boolean,
): string {
  const deviceKnown = device !== null;
  const cameraAccepted = device !== null && isSupportedMegaCamera(device);
  let handling = "unhandled";
  if (stationManaged && event.eventType === 9) handling = "station_guard";
  else if (stationManaged && event.eventType === 10 && event.alarmType !== null) handling = "station_alarm";
  else if (
    device !== null
    && (device.deviceType === 2 || device.deviceType === 126)
    && event.eventType === 3
  ) handling = "sensor_contact";
  else if (
    device !== null
    && (device.deviceType === 10 || device.deviceType === 127)
    && event.eventType === 14
  ) handling = "sensor_motion";
  else if (
    cameraAccepted
    && device !== null
    && isDoorbellDevice(device)
    && doorbellPushKind(event) !== null
  ) {
    const doorbellPush = doorbellPushKind(event);
    if (doorbellPush === "press") handling = "doorbell_press";
    else if (doorbellPush === "detection") handling = "doorbell_detection";
  }
  else if (cameraAccepted && isCameraDetection(event.eventType)) {
    handling = cameraDetectionKind(event.eventType) ?? "unhandled";
  }
  const model = device?.model === "T8N00" ? device.model : device?.model && /^T[0-9]{3,4}(?:[A-Z]{1,2}|-[A-Z]{1,2})?$/.test(device.model)
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
    ...(event.eventType === 9 ? [`effective_mode_field=${event.effectiveModeField ?? "none"}`] : []),
    `ai_evidence=${event.detectionEvidence?.join(",") || "none"}`,
  ].join(" ");
}

/** Distinguish a doorbell press from style-3 detection pushes that reuse event type 3103. */
export function doorbellPushKind(
  event: Pick<MegaPushEvent, "eventType" | "notificationStyle">
    & Partial<Pick<MegaPushEvent, "detectionEvidence" | "personName">>,
): "press" | "detection" | null {
  if (event.eventType !== 3103) return null;
  if (event.notificationStyle !== 3) return "press";
  const hasStructuredDetection = (event.detectionEvidence?.length ?? 0) > 0
    || (typeof event.personName === "string" && event.personName.trim().length > 0);
  return hasStructuredDetection ? "detection" : "press";
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
export function cameraDetectionKind(eventType: number | null): "motion" | "person" | "stranger" | "pet" | "vehicle" | "dog" | "crying" | "sound" | "packageDelivered" | "packageTaken" | "packageStranded" | null {
  if (eventType === 1 || eventType === 3101) return "motion";
  if (eventType === 3102 || eventType === 3111) return "person";
  if (eventType === 3112) return "stranger";
  if (eventType === 3104) return "crying";
  if (eventType === 3105) return "sound";
  if (eventType === 3106) return "pet";
  if (eventType === 3107) return "vehicle";
  if (eventType === 3108 || eventType === 3109 || eventType === 3110) return "dog";
  if (eventType === 3301) return "packageDelivered";
  if (eventType === 3302) return "packageTaken";
  if (eventType === 3304) return "packageStranded";
  return null;
}

/** Identify supported Mega doorbells that should expose a press sensor. */
export function isDoorbellDevice(device: Pick<MegaInventoryDevice, "deviceType" | "category">): boolean {
  return device.category === "eufy_security" && [5, 7, 91, 94, 95, 96, 203].includes(device.deviceType ?? -1);
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

/** Keep diagnostic counters independent of wire or account content. */
function nvrTrialCounters(session: NvrRtcSession): string {
  const counts = Object.entries(session.stats).map(([key, value]) => `${key}=${value}`).join(" ");
  const rejections = Object.entries(session.framingRejections).map(([key, value]) => `${key}:${value}`).join(",") || "none";
  return `${counts} framing_rejections=${rejections}`;
}

async function guardDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = (): void => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, milliseconds);
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new NvrGuardError("inventory")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
