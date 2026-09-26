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

/** Complete state returned for one camera by the HTTP API. */
export interface CameraState {
  readonly serial: string;
  readonly name: string;
  readonly model: string;
  readonly catalogueStatus: "supported" | "ready_to_test" | "recognised" | null;
  readonly stationSerial: string;
  readonly streamSupported: boolean;
  readonly doorbellSupported: boolean;
  readonly enabled: boolean | null;
  readonly enableControlSupported: boolean;
  readonly motionDetectionEnabled: boolean | null;
  readonly motionDetectionControlSupported: boolean;
  readonly nightVisionMode: number | null;
  readonly nightVisionModes: readonly NightVisionMode[];
  readonly nightVisionControlSupported: boolean;
  readonly autoNightVisionEnabled: boolean | null;
  readonly autoNightVisionControlSupported: boolean;
  readonly timedLightControlSupported: boolean;
  readonly cameraSirenControlSupported: boolean;
  readonly motionDetected: boolean;
  readonly personDetected: boolean;
  readonly strangerDetected: boolean;
  readonly petDetected: boolean;
  readonly vehicleDetected: boolean;
  readonly dogDetected: boolean;
  readonly cryingDetected: boolean;
  readonly soundDetected: boolean;
  readonly packageStrandedDetected: boolean;
  readonly doorbellPressed: boolean;
  readonly battery: BatteryState | null;
  readonly lastDetection: Detection | null;
  readonly snapshot: SnapshotInfo | null;
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
  readonly name: "Off" | "Colour" | "Infrared" | "Spotlight";
}

/** Normalized battery reads exposed only when a device reports each field. */
export interface BatteryState {
  readonly supported: readonly ("level" | "charging" | "health" | "temperature" | "lastChargingDays")[];
  readonly level: number | null;
  readonly charging: boolean | null;
  readonly health: number | null;
  readonly temperature: number | null;
  readonly lastChargingDays: number | null;
}

/** Complete normalized state for one supported standalone security sensor. */
export interface SecuritySensorState {
  readonly serial: string;
  readonly name: string;
  readonly model: string;
  readonly deviceType: number;
  readonly available: boolean;
  readonly capabilities: readonly ("battery" | "contact" | "lastSeen" | "motion")[];
  readonly batteryLevel: number | null;
  readonly contactOpen: boolean | null;
  readonly lastSeen: string | null;
  readonly motionDetected: boolean;
}

/** One physical storage device reported by a HomeBase 3. */
export interface HomeBaseStorageState {
  readonly status: string | null;
  readonly totalBytes: number | null;
  readonly freeBytes: number | null;
}

/** Complete normalized state for one discovered HomeBase. */
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

  /** Whether the local state path is enabled for this station model. */
  readonly stateReadSupported: boolean;
  readonly homeBaseSirenControlSupported: boolean;
  readonly connected: boolean;
  readonly guardMode: number | null;
  readonly effectiveMode: number | null;
  readonly alarmActive: boolean | null;
  readonly alarmVolume: number | null;
  readonly promptVolume: number | null;
  readonly alarmTone: number | null;
  readonly storage: {
    readonly emmc: HomeBaseStorageState | null;
    readonly hdd: HomeBaseStorageState | null;
  };
}

/** Events sent over the gateway SSE endpoint. */
export type GatewayEvent =
  | { readonly type: "camera-updated"; readonly camera: CameraState }
  | { readonly type: "sensor-updated"; readonly sensor: SecuritySensorState }
  | { readonly type: "sensors-updated"; readonly sensors: readonly SecuritySensorState[] }
  | { readonly type: "station-updated"; readonly station: HomeBaseState }
  | { readonly type: "stations-updated"; readonly stations: readonly HomeBaseState[] }
  | { readonly type: "detection"; readonly cameraSerial: string; readonly detection: Detection }
  | { readonly type: "snapshot-updated"; readonly cameraSerial: string; readonly snapshot: SnapshotInfo }
  | { readonly type: "connection-updated"; readonly state: ConnectionState; readonly detail: string | null };

/** Stable camera metadata discovered from Mega inventory. */
export interface CameraIdentity {
  readonly serial: string;
  readonly name: string;
  readonly model: string;
  readonly catalogueStatus?: "supported" | "ready_to_test" | "recognised" | null;
  readonly stationSerial: string;
  readonly streamSupported: boolean;
  readonly doorbellSupported: boolean;
  readonly enabled?: boolean | null;
  readonly enableControlSupported?: boolean;
  readonly motionDetectionEnabled?: boolean | null;
  readonly motionDetectionControlSupported?: boolean;
  readonly nightVisionMode?: number | null;
  readonly nightVisionModes?: readonly NightVisionMode[];
  readonly nightVisionControlSupported?: boolean;
  readonly autoNightVisionEnabled?: boolean | null;
  readonly autoNightVisionControlSupported?: boolean;
  readonly timedLightControlSupported?: boolean;
  readonly cameraSirenControlSupported?: boolean;
  readonly battery?: BatteryState | null;
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
  readonly reason: "supported-camera-type" | "catalogued-camera-type" | "non-security-category" | "unrecognized-camera-type";
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
  readonly receiverState: "starting" | "connected" | "disconnected" | "stopped";
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
