/**
 * Defines the narrow adapter boundary between a camera provider and the
 * protocol-neutral gateway.
 *
 * Implementations own authentication, inventory, push decoding, image
 * retrieval, and stream startup. They report normalized facts through these
 * callbacks, while `GatewayState` and `GatewayServer` own presentation and
 * lifecycle policy. The simulated provider implements the same contract for
 * tests; the production provider is the only implementation allowed to know
 * Mega and PPCS details.
 */
import type { NvrLiveControl, NvrLiveControlResult } from "./nvr-live-controls.js";
import type { NvrPowerRequest, NvrPowerSummary } from "./nvr-power-trial.js";
import type { NvrGuardRequest, NvrGuardSummary } from "./nvr-guard-trial.js";
import type { T85V0StatusSummary } from "./t85v0-status.js";
import type { LocalMotionSummary } from "../stream/local-motion-trial.js";
import type { C31IndexSummary } from "../stream/c31-recording-index.js";
import type { CameraSettingChange } from "./camera-settings.js";
import type { E30LockSettingChange } from "../domain/types.js";
import type { NvrStateSummary } from "../stream/nvr-protocol.js";
import type { SmartLockState } from "../domain/types.js";
import type { ModelControlTrial, ModelControlTrialResult } from "./model-control-trials.js";
import type { CloudHistoryQuery, CloudHistoryRecord } from "../mega/cloud-history.js";
import type { CloudCalendarQuery, CloudCalendarResult } from "../mega/cloud-calendar.js";
import type { Readable } from "node:stream";
import type { StoredRecordingSummary } from "../stream/stored-recordings.js";

import type { CameraCapabilityManifest, CameraIdentity, CameraPresetPosition, DetectionKind, DeviceCapabilityManifest, EventReceiverState, HomeBaseState, InventoryDiagnostic, PushDiagnostic, SecuritySensorState, StreamDiagnostic, VideoCodec } from "../domain/types.js";

/** Callbacks through which a provider reports normalized observations. */
export interface ProviderEvents {

  /** Replace the separately owned lock inventory; optional for older/simulated adapters. */
  locks?(locks: readonly SmartLockState[]): void;
  camera(identity: CameraIdentity): void;
  station(state: HomeBaseState): void;
  sensor(state: SecuritySensorState): void;
  connection(state: "connected" | "disconnected" | "authentication-required" | "error", detail: string | null): void;
  motion(serial: string, detected: boolean): void;
  person(serial: string, detected: boolean, personName: string | null): void;
  detection(serial: string, kind: Exclude<DetectionKind, "motion" | "person" | "doorbell">, detected: boolean): void;
  doorbell(serial: string, pressed: boolean): void;
  sensorContact(serial: string, open: boolean): void;
  sensorMotion(serial: string, detected: boolean): void;

  /** Report one passive care-monitor notification without opening a media path. */
  sensorDetection(serial: string, kind: "crying" | "sound", detected: boolean): void;
  snapshot(serial: string, data: Buffer, contentType: string): void;
  pushDiagnostic(diagnostic: PushDiagnostic): void;
  eventReceiverState(state: EventReceiverState): void;
  eventDelivery(outcome: "parsed" | "empty" | "unparsed"): void;
  inventory(diagnostics: InventoryDiagnostic[]): void;
  cameraCapabilities(manifests: readonly CameraCapabilityManifest[]): void;
  deviceCapabilities(manifests: readonly DeviceCapabilityManifest[]): void;

  /** Attach video and optional verified AAC, owned and ended by the same session. */
  streamStarted(serial: string, video: Readable, codecHint: () => VideoCodec | null, audio?: Readable): void;
  streamStopped(serial: string): void;
}

/** Lifecycle and stream operations required by the gateway server. */
export interface CameraProvider {

  /** Read current NVR admission without opening media. Optional quality checks the exact profile. */
  nvrLiveSettingAdmitted?(serial: string, quality?: number): boolean;


  /** Inject media facts without transferring ownership of sources or viewer leases. */
  setNvrLiveMediaChecks?(checks: { viewer: (serial: string) => boolean; active: (serial: string) => boolean; recording: (serial: string) => boolean }): void;

  /** Change the idle camera's next-stream view, with no device write. */
  setNvrView?(serial: string, view: number): Promise<CameraIdentity>;

  /** Submit one finite experimental movement, requiring physical confirmation. */
  performNvrLiveControl?(serial: string, request: NvrLiveControl, signal?: AbortSignal): Promise<NvrLiveControlResult>;


  /** Submit one reviewed absolute camera setting and return fresh confirmed state. */
  setCameraSetting?(serial: string, change: CameraSettingChange, signal?: AbortSignal): Promise<CameraIdentity>;

  /** Refresh one admitted experimental lock without actuating it. */
  refreshLock?(serial: string, signal?: AbortSignal): Promise<SmartLockState>;

  /** Submit one absolute lock state and return only fresh confirmed readback. */
  setLockState?(serial: string, locked: boolean, signal?: AbortSignal, onDispatch?: () => void): Promise<SmartLockState>;

  /** Write one closed E30 setting and return independently confirmed facts. */
  setLockSetting?(serial: string, change: E30LockSettingChange, signal?: AbortSignal, onDispatch?: () => void): Promise<SmartLockState>;

  /** Reserve one owner-account clip whose preparation never changes normal routing. */
  reserveGeneralRtcTrial?(serial: string, signal: AbortSignal): import("./general-rtc-trial.js").GeneralRtcTrialLease;

  /** Reserve one consented native doorbell clip without enabling normal streaming. */
  reserveDoorbellRtcTrial?(serial: string, signal: AbortSignal): () => Promise<void>;

  /** Reserve one explicit NVR video trial until its awaited cleanup completes. */
  reserveNvrLiveTrial?(serial: string, signal: AbortSignal): () => Promise<void>;

  /** Query one exact attached FamiLock without registering or operating a lock. */
  readT85V0StatusTrial?(serial: string, signal: AbortSignal): Promise<T85V0StatusSummary>;

  /** Passively observe one consented T8910 channel without publishing motion events. */
  readLocalMotionTrial?(serial: string, signal: AbortSignal): Promise<LocalMotionSummary>;

  /** Run one explicitly consented source-defined C31 index query, returning structural counts only. */
  readRecordingIndexTrial?(serial: string, signal: AbortSignal): Promise<C31IndexSummary>;

  /** Run one separately consented NVR camera-power test, retaining its lease through restoration. */
  testNvrCameraPower?(serial: string, request: NvrPowerRequest, signal: AbortSignal): Promise<NvrPowerSummary>;

  /** Run one consented Schedule-to-Home NVR test, retaining its lease through restoration. */
  testNvrGuardMode?(serial: string, request: NvrGuardRequest, signal: AbortSignal): Promise<NvrGuardSummary>;

  /** Query private NVR settings once, retiring the exclusive session before returning. */
  readNvrStateTrial?(serial: string, signal: AbortSignal): Promise<NvrStateSummary>;

  /** List default-off exact-model trials, independently of verified capabilities. */
  modelControlTrials?(serial: string): readonly ModelControlTrial["action"][];

  /** Submit one experimental command with fresh state confirmation for settings. */
  performModelControlTrial?(serial: string, request: ModelControlTrial, signal?: AbortSignal): Promise<ModelControlTrialResult>;

  /** Project active source counters synchronously, without opening a connection. */
  streamDiagnostic?(serial: string): StreamDiagnostic | null;

  /** Read local completed event clips without exposing card paths or recording keys. */
  listStoredRecordings?(serial: string, date: string, signal?: AbortSignal): Promise<readonly StoredRecordingSummary[]>;

  /** Retrieve a previously listed opaque ID; null means the reference expired or is unknown. */
  downloadStoredRecording?(serial: string, id: string, signal?: AbortSignal): Promise<Buffer | null>;
  /** Optional read-only cloud metadata, independent of local station storage. */
  cloudHistory?(serial: string, query: CloudHistoryQuery): Promise<readonly CloudHistoryRecord[]>;

  /** Read unconfirmed calendar hints under fresh camera binding without media or key access. */
  cloudCalendar?(serial: string, query: CloudCalendarQuery, signal: AbortSignal): Promise<CloudCalendarResult>;

  /** Prepare one consented private cloud recording, without any camera or account writes. */
  cloudRecordingTrial?(serial: string, id: string, query: CloudHistoryQuery, signal: AbortSignal): Promise<Buffer>;
  start(events: ProviderEvents): Promise<void>;
  startStream(serial: string): Promise<void>;
  stopStream(serial: string): Promise<void>;

  /** Play bounded native AAC on the leased live source, stopping on cancellation or failure. */
  playCameraAudio?(serial: string, audio: Buffer, signal?: AbortSignal): Promise<void>;

  /** Write camera enablement and return only state confirmed by fresh readback. */
  setCameraEnabled(serial: string, enabled: boolean): Promise<CameraIdentity>;

  /** Write camera motion detection and return fresh inventory-backed state. */
  setCameraMotionDetection(serial: string, enabled: boolean): Promise<CameraIdentity>;

  /** Write one admitted model-specific preference and return fresh confirmed state. */
  setCameraPreference?(serial: string, name: string, value: number): Promise<CameraIdentity>;

  /** Write recorded audio separately from microphone enablement, returning fresh confirmed state. */
  setCameraAudioRecording?(serial: string, enabled: boolean): Promise<CameraIdentity>;

  /** Write a model-reported live quality preference and return fresh confirmed inventory. */
  setCameraStreamingQuality?(serial: string, quality: number, signal?: AbortSignal): Promise<CameraIdentity>;

  /** Refresh one direct camera's safe reads from its on-device parameter table. */
  refreshCameraCapabilities(serial: string): Promise<CameraIdentity>;

  /** Set one standalone camera guard mode and require fresh inventory readback. */
  setCameraGuardMode(serial: string, mode: number): Promise<CameraIdentity>;

  /** Write a reported night-vision mode and return fresh inventory-backed state. */
  setCameraNightVision(serial: string, mode: number, signal?: AbortSignal): Promise<CameraIdentity>;

  /** Send the camera family's momentary manual-light command. */
  setCameraLight(serial: string, enabled: boolean): Promise<void>;

  /** Trigger or stop the camera siren using its device-side duration. */
  setCameraSiren(serial: string, durationSeconds: number): Promise<void>;

  /** Query stored camera positions without returning names, images, or coordinates. */
  getCameraPresetPositions(serial: string): Promise<readonly CameraPresetPosition[]>;

  /** Move a camera once to an enabled stored position. */
  selectCameraPresetPosition(serial: string, index: number): Promise<void>;

  /** Send the camera's physically verified AI-tracking action. */
  setCameraAiTracking(serial: string, enabled: boolean): Promise<void>;

  /** Send the camera's physically verified automatic-cruise action. */
  setCameraAutoCruise(serial: string, enabled: boolean): Promise<void>;

  /** Trigger or stop a HomeBase siren using its station-side duration command. */
  setHomeBaseSiren(serial: string, durationSeconds: number): Promise<HomeBaseState>;
  refreshStation(serial: string): Promise<HomeBaseState>;
  setGuardMode(serial: string, mode: number): Promise<HomeBaseState>;
  setAlarmVolume(serial: string, value: number): Promise<HomeBaseState>;
  setPromptVolume(serial: string, value: number): Promise<HomeBaseState>;
  setAlarmTone(serial: string, value: number): Promise<HomeBaseState>;
  close(): Promise<void>;
}

/** Image challenge that the local authentication page can display. */
export interface CaptchaChallenge {
  readonly id: string;
  readonly image: string;
}

/** Optional authentication challenge operations exposed by a provider. */
export interface CaptchaProvider {
  getCaptchaChallenge(): CaptchaChallenge | null;
  isVerificationRequired(): boolean;
  submitCaptcha(answer: string): Promise<void>;
  submitVerification(code: string): Promise<void>;
}
