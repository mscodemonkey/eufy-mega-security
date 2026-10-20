/**
 * Defines the gateway's protocol-neutral state and event contract.
 *
 * The provider converts untrusted Mega, Firebase, and PPCS observations into
 * these values. `GatewayState`, `GatewayServer`, and the Python Home Assistant
 * client consume them. No field in this file should require a caller to know
 * a Mega endpoint, packet header, encryption key, or Eufy-specific payload
 * shape; changing such a field means changing the public gateway API.
 */

/** Connection states reported by the provider and health endpoint. */
export type ConnectionState =
  | "starting"
  | "connected"
  | "disconnected"
  | "authentication-required"
  | "error";

/**
 * Push lifecycle without private data. `activation-unconfirmed` is retained for
 * v0.1.118 compatibility and is no longer emitted by the main receiver.
 */
export type EventReceiverState =
  | "starting"
  | "connected"
  | "activation-unconfirmed"
  | "disconnected"
  | "stopped"
  | "degraded";

/** Lifecycle states for a camera's shared media source. */
export type StreamState = "idle" | "starting" | "streaming" | "stopping" | "error";

/** Video codecs accepted by the gateway's stream and recording consumers. */
export type VideoCodec = "h264" | "h265";

/** Detection kinds exposed as independent transient camera states. */
export type DetectionKind =
  | "motion"
  | "person"
  | "stranger"
  | "pet"
  | "vehicle"
  | "dog"
  | "crying"
  | "sound"
  | "packageDelivered"
  | "packageTaken"
  | "packageStranded"
  | "doorbell";

/** One normalized camera detection emitted by the gateway. */
export interface Detection {
  readonly id: string;
  readonly kind: DetectionKind;
  readonly occurredAt: string;
  readonly personName: string | null;
  readonly recognized: boolean;
}

/** Metadata for the last retained image for a camera. */
export interface SnapshotInfo {
  readonly capturedAt: string;
  readonly contentType: string;
  readonly source: "event" | "live";
  readonly revision: number;
}

/** Cloud-reported audio configuration, not proof of physical recording or talkback. */
export interface CameraAudioSettings {
  readonly microphoneEnabled: boolean | null;
  readonly speakerEnabled: boolean | null;
  readonly recordingEnabled: boolean | null;
  readonly speakerVolume: number | null;
}

/** Inventory configuration only, not live image orientation, lamp output or sound events. */
export interface CameraReportedSettings {

  /** Exact standalone C31 pre-recording setting, not proof of a recording duration. */
  readonly preRecordingEnabled?: boolean | null;

  /** Model-limited ringtone and sound configuration, not live audio or detection results. */
  readonly ringtoneVolume?: number | null;
  readonly soundDetectionSensitivity?: number | null;
  readonly soundDetectionType?: number | null;

  /** Exact standalone C31 preferences, independent of detection or low-light results. */
  readonly soundRoundLookEnabled?: boolean | null;
  readonly enhanceLightingEnabled?: boolean | null;

  /** Exact C31 light setting and notification spacing, unrelated to recording intervals. */
  readonly lightBrightness?: number | null;
  readonly notificationIntervalMinutes?: number | null;

  /** Exact C31 publication and continuous recording switches, independent of active consumers. */
  readonly rtspPublicationEnabled?: boolean | null;
  readonly continuousRecordingEnabled?: boolean | null;

  /** Reported quality ranks. They do not assert an observed resolution or codec. */
  readonly streamingQualityTier?: number | null;
  readonly recordingQualityTier?: number | null;

  /** Reported solar contribution. Intensity is unitless, not a guessed percentage. */
  readonly solarIntensity?: number | null;
  readonly solarConnected24h?: boolean | null;

  /** Model-specific configuration reads, not lamp output or a delivered notification. */
  readonly notificationStyle?: number | null;
  readonly watermarkMode?: number | null;
  readonly antiTheftDetectionEnabled?: boolean | null;
  readonly spotlightEnabled?: boolean | null;
  readonly motionSensitivityRaw?: number | null;

  /** Reviewed least-to-most detection step, independent of legacy raw parameter mirrors. */
  readonly motionSensitivityStep?: number | null;
  readonly imageFlipped: boolean | null;
  readonly statusLedEnabled: boolean | null;
  readonly soundDetectionEnabled: boolean | null;

  /** Reported doorbell chime settings, absent outside evidenced model families. */
  readonly homebaseChimeEnabled?: boolean | null;
  readonly mechanicalChimeEnabled?: boolean | null;
  readonly wideDynamicRangeEnabled?: boolean | null;
  readonly chimeVolume?: number | null;

  /** Doorbell quality rank, not resolution, decoded with its compression setting. */
  readonly doorbellVideoQuality?: number | null;
  readonly highCompressionEncoding?: boolean | null;

  /** Reported T8170 recording policy, not proof that a clip was recorded. */
  readonly workingMode?: string | null;
  readonly recordingDurationSeconds?: number | null;
  readonly recordingIntervalSeconds?: number | null;
  readonly recordingAutoStop?: boolean | null;
}

/** Complete state returned for one camera by the HTTP API. */
export interface CameraState {

  /** Optional device-owned secondary firmware and explicit update flag. */
  readonly firmwareSubVersion?: string | null;
  readonly firmwareUpdateAvailable?: boolean | null;

  /** Reported main firmware version, absent rather than inferred from the station. */
  readonly firmware: string | null;

  /** Device-reported hardware revision, when included in fresh inventory. */
  readonly hardwareVersion: string | null;

  /** Last validated inventory signal measurement, not a connection-health assertion. */
  readonly rssi: number | null;

  /** Validated inventory audio configuration, independent of control admission. */
  readonly audioSettings: CameraAudioSettings | null;

  /** Whether the owned route and known recording baseline admit the verified audio write. */
  readonly audioRecordingControlSupported?: boolean;

  /** Whether the owned ready route and known baseline admit native streaming-quality writes. */
  readonly streamingQualityControlSupported?: boolean;

  /** Known preferences with an exact owned and ready control route. */
  readonly preferenceControls?: readonly string[];

  /** Per-model bounds for admitted preferences, absent on older gateways. */
  /** Strict model-owned preference values, separate from generic camera interpretations. */
  readonly carePreferences?: Readonly<Record<string, number>>;

  readonly preferenceRanges?: Readonly<Record<string, { readonly minimum: number; readonly maximum: number }>>;

  /** An explicit empty set suppresses generic camera detections for a care adapter. */
  readonly supportedDetections?: readonly DetectionKind[];

  /** Separate care adapter retains the E21's existing notification entity IDs. */
  readonly careMonitor?: boolean;

  /** Exact-route admission for fresh-state-confirmed sensitivity and HomeBase chime writes. */
  readonly motionSensitivityControlSupported?: boolean;
  readonly motionSensitivitySteps?: number | null;
  readonly homebaseChimeControlSupported?: boolean;

  /** Model-specific streaming choices, used only when control admission is true. */
  readonly streamingQualityModes?: readonly CameraStreamingQualityMode[];

  /** Default-off exact-profile NVR controls, withdrawn when admission changes. */
  readonly nvrPanControlSupported?: boolean;
  readonly nvrOpticalZoomControlSupported?: boolean;
  readonly nvrViewOptions?: readonly string[];
  readonly nvrSelectedView?: number | null;


  /** Strictly validated camera-owned settings, with unknown values left absent. */
  readonly reportedSettings: CameraReportedSettings | null;
  readonly serial: string;
  readonly name: string;
  readonly model: string;
  readonly catalogueStatus: "supported" | "ready_to_test" | "recognised" | null;
  readonly stationSerial: string;
  readonly streamSupported: boolean;

  /** Whether the ready camera route supplies validated AAC for live MPEG-TS delivery. */
  readonly liveAudioSupported?: boolean;

  /** Exact route support for bounded speaker audio, independent of microphone streaming. */
  readonly talkbackSupported?: boolean;

  /** The direct route supports verified SD event retrieval; card presence is checked on access. */
  readonly storedRecordingsSupported?: boolean;
  readonly doorbellSupported: boolean;
  readonly enabled: boolean | null;
  readonly enableControlSupported: boolean;
  readonly motionDetectionEnabled: boolean | null;
  readonly motionDetectionControlSupported: boolean;
  readonly guardMode: number | null;
  readonly guardModeControlSupported: boolean;
  readonly guardModeRefreshSupported: boolean;
  readonly nightVisionMode: number | null;
  readonly nightVisionModes: readonly NightVisionMode[];
  readonly nightVisionControlSupported: boolean;
  readonly autoNightVisionEnabled: boolean | null;
  readonly autoNightVisionControlSupported: boolean;
  readonly cameraLightControlSupported: boolean;
  readonly timedLightControlSupported: boolean;
  readonly cameraSirenControlSupported: boolean;
  readonly presetPositionControlSupported: boolean;
  readonly aiTrackingControlSupported: boolean;

  /** Inventory-reported tracking preference, or null when the device supplies no verified value. */
  readonly aiTrackingEnabled?: boolean | null;
  readonly autoCruiseControlSupported: boolean;
  readonly motionDetected: boolean;
  readonly personDetected: boolean;
  readonly strangerDetected: boolean;
  readonly petDetected: boolean;
  readonly vehicleDetected: boolean;
  readonly dogDetected: boolean;
  readonly cryingDetected: boolean;
  readonly soundDetected: boolean;
  readonly packageDeliveredDetected: boolean;
  readonly packageTakenDetected: boolean;
  readonly packageStrandedDetected: boolean;
  readonly doorbellPressed: boolean;
  readonly battery: BatteryState | null;
  readonly lastDetection: Detection | null;
  readonly snapshot: SnapshotInfo | null;
  readonly eventImage: SnapshotInfo | null;
  readonly stream: {
    readonly state: StreamState;
    readonly viewers: number;
    readonly startedAt: string | null;
    readonly lastError: string | null;
  };
}

/** One camera-specific label for a raw night-vision mode value. */
export interface NightVisionMode {
  readonly value: number;
  readonly name: "Off" | "Colour" | "Infrared" | "Infrared on" | "Spotlight" | "Standard" | "Auto Infrared" | "Auto night vision";
}

/** One exact model's app-confirmed streaming quality, independent of recorded-video quality. */
export interface CameraStreamingQualityMode {
  readonly value: number;
  readonly name: "Auto" | "HD (720P)" | "Full HD (1080P)" | "2K" | "4K" | "Medium" | "High" | "Low" | "Highest";
}

/** Normalized battery reads exposed only when a device reports each field. */
export interface BatteryState {
  readonly supported: readonly ("level" | "backupLevel" | "charging" | "health" | "temperature" | "lastChargingDays")[];
  readonly level: number | null;
  readonly charging: boolean | null;
  readonly health: number | null;
  readonly temperature: number | null;
  readonly lastChargingDays: number | null;

  /** Separate AA backup percentage, absent unless this exact model reports it. */
  readonly backupLevel?: number | null;
}

/** Complete normalized state for one supported standalone security sensor. */
export interface SecuritySensorState {
  readonly serial: string;
  readonly name: string;
  readonly model: string;
  readonly deviceType: number;
  readonly available: boolean;
  readonly capabilities: readonly ("battery" | "contact" | "crying" | "lastSeen" | "motion" | "rssi" | "sound" | "pet" | "babyLeft" | "babyEntered" | "temperatureHigh" | "temperatureLow" | "careAreaLeft" | "careAreaEntered" | "babyActivity" | "roomTemperature" | "careDiagnostics")[];
  readonly batteryLevel: number | null;
  readonly contactOpen: boolean | null;
  readonly lastSeen: string | null;
  readonly motionDetected: boolean;

  /** A recent crying push was retained; false does not classify current audio. */
  readonly cryingDetected?: boolean;

  /** A recent sound push was retained; false does not classify current audio. */
  readonly soundDetected?: boolean;

  /** Independent recent E21 notifications, absent on other sensor families. */
  readonly petDetected?: boolean;
  readonly babyLeftDetected?: boolean;
  readonly babyEnteredDetected?: boolean;
  readonly temperatureHighDetected?: boolean;
  readonly temperatureLowDetected?: boolean;
  readonly careAreaLeftDetected?: boolean;
  readonly careAreaEnteredDetected?: boolean;
  readonly babyActivityDetected?: boolean;

  /** Strict reported room state, separate from any battery measurement. */
  readonly careSettings?: import("../provider/e21-profile.js").E21CareSettings;
  readonly rssi: number | null;
}

/** One physical storage device reported by a HomeBase. */
export interface HomeBaseStorageState {
  readonly status: string | null;
  readonly totalBytes: number | null;
  readonly freeBytes: number | null;
}

/** Complete normalized state for one discovered station. */
export interface HomeBaseState {
  readonly serial: string;
  readonly name: string;
  readonly model: string;
  readonly firmware: string | null;
  readonly available: boolean;

  /** Whether a child-camera PPCS route has all inventoried prerequisites. */
  readonly cameraRouteReady: boolean;

  /** Whether the model may receive the managed station control set. */
  readonly controlsSupported: boolean;

  /** Whether the station may receive confirmed guard-mode writes. */
  readonly guardModeControlSupported: boolean;

  /** Whether this station has an established read-only state source. */
  readonly stateReadSupported: boolean;
  readonly homeBaseSirenControlSupported: boolean;
  readonly connected: boolean;
  readonly guardMode: number | null;

  /** Account-defined labels for explicitly reported custom modes 3 to 5. */
  readonly guardModeNames: Readonly<Record<number, string>>;
  readonly effectiveMode: number | null;

  /** Last fresh NVR push observation. Its absence must not be treated as a live readback. */
  readonly effectiveModeReportedAt?: string | null;
  readonly alarmActive: boolean | null;
  readonly alarmVolume: number | null;
  readonly promptVolume: number | null;
  readonly alarmTone: number | null;

  /** Storage media whose local read protocol is known for this station model. */
  readonly storageSupported: readonly ("sd" | "emmc" | "hdd")[];
  readonly storage: {
    readonly sd: HomeBaseStorageState | null;
    readonly emmc: HomeBaseStorageState | null;
    readonly hdd: HomeBaseStorageState | null;
  };
}

/** Allowlisted lock state; private identities, raw enums and MQTT material never cross this boundary. */
export const SMART_LOCK_STATE_TTL_MS = 360_000;

/** Public settings facts with independent device and cloud observation ages. */
export interface SmartLockSettings {
  readonly volume: 0 | 1 | 2 | 3 | null;
  readonly autoLock: boolean | null;

  /** Device-reported timer, independent of whether automatic locking is enabled. */
  readonly autoLockDelaySeconds: number | null;
  readonly notifications: boolean | null;
  readonly lockedNotifications: boolean | null;
  readonly unlockedNotifications: boolean | null;
  readonly observedAt: string | null;
  readonly notificationsObservedAt: string | null;
}

/** Closed user controls admit reviewed timer choices, excluding schedules and mute writes. */
export type E30LockSettingChange = { readonly setting: "volume"; readonly value: 1 | 2 | 3 }
  | { readonly setting: "autoLockDelaySeconds"; readonly value: 30 | 60 | 90 | 120 | 150 | 180 | 300 }
  | { readonly setting: "autoLock" | "notifications" | "lockedNotifications" | "unlockedNotifications"; readonly value: boolean };

/** Validate untrusted settings bodies before provider authority or network work is used. */
export function isE30LockSettingChange(value: unknown): value is E30LockSettingChange {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || !Object.hasOwn(row, "setting") || !Object.hasOwn(row, "value")) return false;
  return row.setting === "volume" ? Number.isInteger(row.value) && [1, 2, 3].includes(row.value as number)
    : row.setting === "autoLockDelaySeconds" ? Number.isInteger(row.value) && [30, 60, 90, 120, 150, 180, 300].includes(row.value as number)
    : ["autoLock", "notifications", "lockedNotifications", "unlockedNotifications"].includes(row.setting as string) && typeof row.value === "boolean";
}

/** Copy cached facts and independently expire physical, device-settings and notification groups. */
export function maskSmartLockState(state: SmartLockState, now = Date.now()): SmartLockState {
  const fresh = (stamp: string | null): boolean => {
    if (!stamp) return false;
    const age = now - Date.parse(stamp);
    return Number.isFinite(age) && age >= 0 && age <= SMART_LOCK_STATE_TTL_MS;
  };
  const settings = state.settings ? { ...state.settings,
    ...(!fresh(state.settings.observedAt) ? { volume: null, autoLock: null, autoLockDelaySeconds: null, observedAt: null } : {}),
    ...(!fresh(state.settings.notificationsObservedAt) ? { notifications: null, lockedNotifications: null, unlockedNotifications: null, notificationsObservedAt: null } : {}) } : undefined;
  return { ...state, ...(settings ? { settings } : {}),
    ...(!fresh(state.stateObservedAt) ? { state: "unknown" as const, available: false, batteryPercent: null } : {}) };
}

/** Only normalized observations cross from the lock provider into the authenticated local API. */
export interface SmartLockState {
  readonly serial: string;
  readonly name: string;
  readonly model: "T85F1";
  readonly state: "locked" | "unlocked" | "unknown";
  readonly available: boolean;
  readonly batteryPercent: number | null;
  readonly stateObservedAt: string | null;
  readonly settings?: SmartLockSettings;
}

/** Normalized state notifications consumed by the authenticated SSE connection. */
export type GatewayEvent =
  | { readonly type: "lock"; readonly lock: SmartLockState }
  | { readonly type: "locks"; readonly locks: readonly SmartLockState[] }
  | { readonly type: "camera-updated"; readonly camera: CameraState }
  | { readonly type: "sensor-updated"; readonly sensor: SecuritySensorState }
  | { readonly type: "sensors-updated"; readonly sensors: readonly SecuritySensorState[] }
  | { readonly type: "station-updated"; readonly station: HomeBaseState }
  | { readonly type: "stations-updated"; readonly stations: readonly HomeBaseState[] }
  | { readonly type: "detection"; readonly cameraSerial: string; readonly detection: Detection }
  | { readonly type: "snapshot-updated"; readonly cameraSerial: string; readonly snapshot: SnapshotInfo }
  | { readonly type: "event-image-updated"; readonly cameraSerial: string; readonly eventImage: SnapshotInfo }
  | { readonly type: "connection-updated"; readonly state: ConnectionState; readonly detail: string | null };

/** Stable camera metadata discovered from Mega inventory. */
export interface CameraIdentity {

  /** Camera-owned firmware metadata. Unknown update status never becomes false. */
  readonly firmwareSubVersion?: string | null;
  readonly firmwareUpdateAvailable?: boolean | null;

  /** Device-reported main firmware, not the parent station's version. */
  readonly firmware?: string | null;

  /** Hardware revision from the camera record, never inferred from its model. */
  readonly hardwareVersion?: string | null;

  /** Optional reported signal strength in dBm. */
  readonly rssi?: number | null;

  /** Cloud configuration only. A missing setting never implies it is disabled. */
  readonly audioSettings?: CameraAudioSettings | null;

  /** Optional provider admission for the independently confirmed recorded-audio write. */
  readonly audioRecordingControlSupported?: boolean;

  /** Optional admission for fresh-state-confirmed streaming-quality writes. */
  readonly streamingQualityControlSupported?: boolean;

  /** Known preferences with an exact owned and ready control route. */
  readonly preferenceControls?: readonly string[];

  /** Per-model bounds for admitted preferences, absent on older gateways. */
  /** Strict model-owned preference values, separate from generic camera interpretations. */
  readonly carePreferences?: Readonly<Record<string, number>>;

  readonly preferenceRanges?: Readonly<Record<string, { readonly minimum: number; readonly maximum: number }>>;

  /** An explicit empty set suppresses generic camera detections for a care adapter. */
  readonly supportedDetections?: readonly DetectionKind[];

  /** Separate care adapter retains the E21's existing notification entity IDs. */
  readonly careMonitor?: boolean;

  /** Exact-route admission for fresh-state-confirmed sensitivity and HomeBase chime writes. */
  readonly motionSensitivityControlSupported?: boolean;
  readonly motionSensitivitySteps?: number | null;
  readonly homebaseChimeControlSupported?: boolean;

  /** Native choices for this model, separate from recorded-video resolution. */
  readonly streamingQualityModes?: readonly CameraStreamingQualityMode[];

  /** Default-off exact-profile NVR controls, withdrawn when admission changes. */
  readonly nvrPanControlSupported?: boolean;
  readonly nvrOpticalZoomControlSupported?: boolean;
  readonly nvrViewOptions?: readonly string[];
  readonly nvrSelectedView?: number | null;


  /** Optional read-only configuration projection from fresh device inventory. */
  readonly reportedSettings?: CameraReportedSettings | null;
  readonly serial: string;
  readonly name: string;
  readonly model: string;
  readonly catalogueStatus?: "supported" | "ready_to_test" | "recognised" | null;
  readonly stationSerial: string;
  readonly streamSupported: boolean;

  /** Whether provider startup may open this stream to seed a retained snapshot. */
  readonly startupSnapshotSupported?: boolean;

  /** The provider owns validated SD event retrieval on this route, not card formatting or deletion. */
  readonly storedRecordingsSupported?: boolean;

  /** Optional provider admission for live AAC, independent of reported microphone settings. */
  readonly liveAudioSupported?: boolean;

  /** Exact route support for bounded speaker audio, independent of microphone streaming. */
  readonly talkbackSupported?: boolean;
  readonly doorbellSupported: boolean;
  readonly enabled?: boolean | null;
  readonly enableControlSupported?: boolean;
  readonly motionDetectionEnabled?: boolean | null;
  readonly motionDetectionControlSupported?: boolean;
  readonly guardMode?: number | null;
  readonly guardModeControlSupported?: boolean;
  readonly guardModeRefreshSupported?: boolean;
  readonly nightVisionMode?: number | null;
  readonly nightVisionModes?: readonly NightVisionMode[];
  readonly nightVisionControlSupported?: boolean;
  readonly autoNightVisionEnabled?: boolean | null;
  readonly autoNightVisionControlSupported?: boolean;
  readonly cameraLightControlSupported?: boolean;
  readonly timedLightControlSupported?: boolean;
  readonly cameraSirenControlSupported?: boolean;
  readonly presetPositionControlSupported?: boolean;
  readonly aiTrackingControlSupported?: boolean;

  /** Model-qualified tracking state; null means the camera has not reported a valid enable bit. */
  readonly aiTrackingEnabled?: boolean | null;
  readonly autoCruiseControlSupported?: boolean;
  readonly battery?: BatteryState | null;
}

/** Privacy-safe stored PTZ slot returned by a camera's live preset query. */
export interface CameraPresetPosition {
  readonly index: number;
  readonly enabled: boolean;
  readonly isDefault: boolean;
}

/** A previously known camera feature found in one device's discovery evidence. */
export interface CameraCapability {
  readonly id: "motion" | "person" | "doorbellPress" | "retainedImage" | "liveVideo" | "batteryLevel" | "batteryCharging" | "batteryHealth" | "batteryTemperature";
  readonly kind: "event" | "image" | "stream" | "measurement" | "state";
  readonly unit: "%" | "°C" | null;
  readonly evidence: "gateway" | "inventory-param" | "ppcs-route";
}

/** One core feature evaluated against a discovered device's reported evidence. */
export interface CapabilityMatrixRow {
  readonly id: string;
  readonly family: string;
  readonly kind: "read" | "event" | "action" | "media";
  readonly reportedParamIds: readonly number[];
  readonly deviceEvidence: "reported-param" | "gateway-baseline" | "ready-route" | "requires-live-proof" | "topology-mismatch" | "suppressed-sentinel" | "not-reported";
  readonly gatewaySupport: "implemented" | "reference-only";
  readonly offerable: boolean;
  readonly note: string | null;
}

/** Shape-only camera support decision, without a current value or write path. */
export interface CameraCapabilityManifest {
  readonly serial: string;
  readonly model: string;
  readonly deviceType: number | null;
  readonly acceptedAsCamera: boolean;
  readonly reviewCandidate: boolean;
  /** Peer transport prerequisites, independent of camera-type admission. */
  readonly peerRouteReady: boolean;
  readonly reason: "exact-e21-profile" | "supported-camera-type" | "catalogued-camera-type" | "non-security-category" | "unrecognized-camera-type";
  readonly capabilities: readonly CameraCapability[];
  readonly matrix: readonly CapabilityMatrixRow[];
  readonly unmappedParamIds: readonly number[];
  readonly unmappedParamCount: number;
}

/** Mega-side baseline decision for a sensor, HomeBase, or doorbell. */
export interface DeviceCapabilityManifest {
  readonly serial: string;
  readonly model: string;
  readonly deviceType: number | null;
  readonly family: "sensor" | "homebase" | "doorbell";
  /** Recognition identifies the product family; support means gateway/HA admission. */
  readonly recognized: boolean;
  readonly supported: boolean;
  /** Core rows only; local research notes are never loaded into this matrix. */
  readonly matrix: readonly CapabilityMatrixRow[];
  readonly unmappedParamCount: number;
}

/** Stable metadata for a HomeBase discovered through Mega inventory. */
export interface HomeBaseIdentity {
  readonly serial: string;
  readonly name: string;
  readonly model: string;
  readonly firmware: string | null;
}

/** Safe, field-level evidence about a push message, with payloads omitted. */
export interface PushDiagnostic {
  readonly receivedAt: string;
  readonly cameraSerial: string;
  readonly cameraName: string | null;
  readonly type: number | null;
  readonly eventType: number | null;
  readonly messageType: number | null;
  readonly notificationStyle: number | null;
  readonly personName: string | null;
  readonly hasPersonName: boolean;
  readonly hasPictureUrl: boolean;
  readonly hasFilePath: boolean;
  readonly hasFetchId: boolean;
  readonly hasSenseId: boolean;
}

/** Aggregate push transport health without device identities or payload data. */
export interface EventDeliveryDiagnostic {
  readonly receiverState: EventReceiverState;
  readonly connectionCount: number;
  readonly disconnectionCount: number;
  readonly deliveryCount: number;
  readonly parsedCount: number;
  readonly emptyCount: number;
  readonly unparsedCount: number;
  readonly lastDeliveryAge: "none" | "under_one_minute" | "one_to_five_minutes" | "five_to_thirty_minutes" | "over_thirty_minutes";
}

/** Explains why an upstream device was accepted or rejected as a camera. */
export interface InventoryDiagnostic {
  readonly serial: string;
  readonly name: string;
  readonly model: string;
  readonly sources: readonly ("mega" | "simulated")[];
  readonly upstreamIsCamera: boolean;
  readonly acceptedAsCamera: boolean;
  readonly megaDeviceType: number | null;
  readonly category: string | null;

  /** Privacy-safe shape of camera power parameter 1035, without its raw payload. */
  readonly cameraSwitch1035: "zero" | "one" | "other_number" | "boolean" | "text" | "structured" | "other" | "missing";
}

/** Privacy-safe evidence that can be attached to a device support report. */
export interface CatalogueEvidence {
  readonly schema: 1;
  readonly inventory: readonly Omit<InventoryDiagnostic, "serial" | "name">[];
  readonly cameras: readonly Omit<CameraCapabilityManifest, "serial">[];
  readonly devices: readonly Omit<DeviceCapabilityManifest, "serial">[];
  readonly events: readonly CatalogueEventEvidence[];
}

/** One push result linked to catalogue identity without local device labels. */
export interface CatalogueEventEvidence {
  readonly observedOn: string;
  readonly model: string;
  readonly deviceType: number | null;
  readonly type: number | null;
  readonly eventType: number | null;
  readonly messageType: number | null;
  readonly notificationStyle: number | null;
  readonly hasPersonName: boolean;
  readonly hasPictureUrl: boolean;
  readonly hasFilePath: boolean;
  readonly hasFetchId: boolean;
  readonly hasSenseId: boolean;
}

/** Numeric source-transport evidence without peer addresses, keys or payload bytes. */
export interface StreamDiagnostic {
  readonly stage: "lookup" | "first-frame" | "media";
  readonly counters: Readonly<Record<"dataDatagrams" | "frameHeaders" | "videoFrames" | "videoOutputFrames"
    | "sequenceGaps" | "sequenceRestarts" | "duplicateDatagrams" | "staleDatagrams"
    | "parserResyncs" | "pendingBytes" | "incompleteAccessUnits" | "incompleteAccessUnitBytes", number>>;
}
