/**
 * Implements the gateway's in-memory camera state machine.
 *
 * `EufyProvider` reports normalized facts here; this class owns the current
 * connection state, camera registry, detection hold timers, retained snapshot
 * metadata, and stream lifecycle counters. `GatewayServer` reads snapshots and
 * forwards emitted events over SSE. It deliberately owns no Eufy credentials
 * and performs no network or media-protocol work, so state policy can be
 * tested without a real camera or cloud account.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import type {
  CameraIdentity,
  CameraState,
  ConnectionState,
  Detection,
  GatewayEvent,
  HomeBaseState,
  SnapshotInfo,
  StreamState,
  PushDiagnostic,
  InventoryDiagnostic,
  CameraCapabilityManifest,
  DeviceCapabilityManifest,
  DetectionKind,
  SecuritySensorState,
} from "./types.js";

/** Mutable internal representation; callers receive immutable snapshots. */
interface MutableCameraState {
  identity: CameraIdentity;
  motionDetected: boolean;
  personDetected: boolean;
  strangerDetected: boolean;
  petDetected: boolean;
  vehicleDetected: boolean;
  dogDetected: boolean;
  cryingDetected: boolean;
  soundDetected: boolean;
  packageStrandedDetected: boolean;
  doorbellPressed: boolean;
  lastDetection: Detection | null;
  snapshot: SnapshotInfo | null;
  streamState: StreamState;
  streamViewers: number;
  streamStartedAt: string | null;
  streamLastError: string | null;
}

/**
 * In-memory source of truth for camera state and lifecycle events.
 *
 * The class owns no network resources. Callers register identities, report
 * provider observations, and subscribe to the `event` EventEmitter channel.
 * Detection flags are cleared after the configured hold period unless a newer
 * provider notification refreshes them.
 */
export class GatewayState extends EventEmitter {
  readonly #cameras = new Map<string, MutableCameraState>();
  readonly #stations = new Map<string, HomeBaseState>();
  readonly #sensors = new Map<string, SecuritySensorState>();
  readonly #pushDiagnostics: PushDiagnostic[] = [];
  readonly #motionClearTimers = new Map<string, NodeJS.Timeout>();
  readonly #personClearTimers = new Map<string, NodeJS.Timeout>();
  readonly #doorbellClearTimers = new Map<string, NodeJS.Timeout>();
  readonly #detectionClearTimers = new Map<string, NodeJS.Timeout>();
  readonly #sensorMotionClearTimers = new Map<string, NodeJS.Timeout>();
  #inventoryDiagnostics: InventoryDiagnostic[] = [];
  #cameraCapabilities: CameraCapabilityManifest[] = [];
  #deviceCapabilities: DeviceCapabilityManifest[] = [];
  #connectionState: ConnectionState = "starting";
  #connectionDetail: string | null = null;

  /** Create state with a short hold period for transient detection flags. */
  constructor(private readonly detectionHoldMilliseconds = 10_000) {
    super();
  }

  /** Add a camera or refresh its discovered metadata and return its state. */
  registerCamera(identity: CameraIdentity): CameraState {
    const existing = this.#cameras.get(identity.serial);
    if (existing) {
      existing.identity = identity;
    } else {
      this.#cameras.set(identity.serial, {
        identity,
        motionDetected: false,
        personDetected: false,
        strangerDetected: false,
        petDetected: false,
        vehicleDetected: false,
        dogDetected: false,
        cryingDetected: false,
        soundDetected: false,
        packageStrandedDetected: false,
        doorbellPressed: false,
        lastDetection: null,
        snapshot: null,
        streamState: "idle",
        streamViewers: 0,
        streamStartedAt: null,
        streamLastError: null,
      });
    }
    return this.#emitCamera(identity.serial);
  }

  /** Add or replace one complete HomeBase state observation. */
  registerStation(station: HomeBaseState): HomeBaseState {
    const snapshot = structuredClone(station);
    this.#stations.set(station.serial, snapshot);
    this.emit("event", { type: "station-updated", station: snapshot } satisfies GatewayEvent);
    return structuredClone(snapshot);
  }

  /** Add or replace one standalone security-sensor observation. */
  registerSensor(sensor: SecuritySensorState): SecuritySensorState {
    const existing = this.#sensors.get(sensor.serial);
    const snapshot = structuredClone({
      ...sensor,
      motionDetected: existing?.motionDetected ?? sensor.motionDetected,
    });
    this.#sensors.set(sensor.serial, snapshot);
    this.emit("event", { type: "sensor-updated", sensor: snapshot } satisfies GatewayEvent);
    return structuredClone(snapshot);
  }

  /** Return immutable snapshots for every supported standalone sensor. */
  listSensors(): SecuritySensorState[] {
    return [...this.#sensors.values()].map((sensor) => structuredClone(sensor));
  }

  /** Check standalone sensor existence without throwing. */
  hasSensor(serial: string): boolean {
    return this.#sensors.has(serial);
  }

  /** Apply a settled contact state delivered by cloud inventory or push. */
  updateSensorContact(serial: string, open: boolean): void {
    const sensor = this.#sensors.get(serial);
    if (!sensor || !sensor.capabilities.includes("contact")) return;
    this.registerSensor({ ...sensor, contactOpen: open });
  }

  /** Hold a standalone PIR event long enough for Home Assistant to observe it. */
  recordSensorMotion(serial: string, detected: boolean): void {
    const sensor = this.#sensors.get(serial);
    if (!sensor || !sensor.capabilities.includes("motion")) return;
    const existing = this.#sensorMotionClearTimers.get(serial);
    if (existing) clearTimeout(existing);
    this.#sensorMotionClearTimers.delete(serial);
    this.#sensors.set(serial, { ...sensor, motionDetected: detected });
    this.emit("event", { type: "sensor-updated", sensor: this.#sensors.get(serial)! } satisfies GatewayEvent);
    if (!detected) return;
    const timer = setTimeout(() => {
      this.#sensorMotionClearTimers.delete(serial);
      this.recordSensorMotion(serial, false);
    }, this.detectionHoldMilliseconds);
    timer.unref();
    this.#sensorMotionClearTimers.set(serial, timer);
  }

  /** Return immutable snapshots for every known HomeBase. */
  listStations(): HomeBaseState[] {
    return [...this.#stations.values()].map((station) => structuredClone(station));
  }

  /** Return one HomeBase or throw when its serial is not known. */
  getStation(serial: string): HomeBaseState {
    const station = this.#stations.get(serial);
    if (!station) throw new Error(`Unknown HomeBase: ${serial}`);
    return structuredClone(station);
  }

  /** Check HomeBase existence without throwing. */
  hasStation(serial: string): boolean {
    return this.#stations.has(serial);
  }

  /** Restore persisted image metadata without emitting a detection event. */
  restoreSnapshot(serial: string, snapshot: SnapshotInfo): void {
    const camera = this.#requireCamera(serial);
    camera.snapshot = snapshot;
    this.#emitCamera(serial);
  }

  /** Record motion and hold the visible flag long enough for HA to observe it. */
  recordMotion(serial: string, detected: boolean, occurredAt = new Date()): void {
    const camera = this.#requireCamera(serial);
    camera.motionDetected = detected;
    this.#scheduleDetectionClear(this.#motionClearTimers, serial, detected, () => this.recordMotion(serial, false));
    if (detected) {
      const detection: Detection = {
        id: randomUUID(),
        kind: "motion",
        occurredAt: occurredAt.toISOString(),
        personName: null,
        recognized: false,
      };
      if (!isRecentPersonDetection(camera.lastDetection, occurredAt)) camera.lastDetection = detection;
      this.emit("event", { type: "detection", cameraSerial: serial, detection } satisfies GatewayEvent);
    }
    this.#emitCamera(serial);
  }

  /** Record person recognition, which takes precedence over same-moment motion. */
  recordPerson(serial: string, detected: boolean, personName: string | null, occurredAt = new Date()): void {
    const camera = this.#requireCamera(serial);
    camera.personDetected = detected;
    this.#scheduleDetectionClear(this.#personClearTimers, serial, detected, () => this.recordPerson(serial, false, null));
    if (detected) {
      const normalizedName = normalizePersonName(personName);
      const detection: Detection = {
        id: randomUUID(),
        kind: "person",
        occurredAt: occurredAt.toISOString(),
        personName: normalizedName,
        recognized: normalizedName !== null,
      };
      camera.lastDetection = detection;
      this.emit("event", { type: "detection", cameraSerial: serial, detection } satisfies GatewayEvent);
    }
    this.#emitCamera(serial);
  }

  /** Record a non-person AI or audio detection without collapsing its meaning into motion. */
  recordDetection(
    serial: string,
    kind: Exclude<DetectionKind, "motion" | "person" | "doorbell">,
    detected: boolean,
    occurredAt = new Date(),
  ): void {
    const camera = this.#requireCamera(serial);
    const field = `${kind}Detected` as keyof Pick<MutableCameraState, "strangerDetected" | "petDetected" | "vehicleDetected" | "dogDetected" | "cryingDetected" | "soundDetected" | "packageStrandedDetected">;
    camera[field] = detected;
    const timerKey = `${serial}:${kind}`;
    const previous = this.#detectionClearTimers.get(timerKey);
    if (previous) clearTimeout(previous);
    this.#detectionClearTimers.delete(timerKey);
    if (detected) {
      const detection: Detection = {
        id: randomUUID(), kind, occurredAt: occurredAt.toISOString(), personName: null, recognized: false,
      };
      camera.lastDetection = detection;
      this.emit("event", { type: "detection", cameraSerial: serial, detection } satisfies GatewayEvent);
      const timer = setTimeout(() => {
        this.#detectionClearTimers.delete(timerKey);
        this.recordDetection(serial, kind, false);
      }, this.detectionHoldMilliseconds);
      timer.unref();
      this.#detectionClearTimers.set(timerKey, timer);
    }
    this.#emitCamera(serial);
  }

  /** Record a transient doorbell press for a camera that supports doorbells. */
  recordDoorbell(serial: string, pressed: boolean, occurredAt = new Date()): void {
    const camera = this.#requireCamera(serial);
    if (!camera.identity.doorbellSupported) return;
    camera.doorbellPressed = pressed;
    this.#scheduleDetectionClear(this.#doorbellClearTimers, serial, pressed, () => this.recordDoorbell(serial, false));
    if (pressed) {
      const detection: Detection = {
        id: randomUUID(),
        kind: "doorbell",
        occurredAt: occurredAt.toISOString(),
        personName: null,
        recognized: false,
      };
      camera.lastDetection = detection;
      this.emit("event", { type: "detection", cameraSerial: serial, detection } satisfies GatewayEvent);
    }
    this.#emitCamera(serial);
  }

  /** Publish new retained-image metadata and notify SSE subscribers. */
  updateSnapshot(serial: string, snapshot: SnapshotInfo): void {
    const camera = this.#requireCamera(serial);
    camera.snapshot = snapshot;
    this.emit("event", { type: "snapshot-updated", cameraSerial: serial, snapshot } satisfies GatewayEvent);
    this.#emitCamera(serial);
  }

  /** Update shared stream lifecycle and viewer count for one camera. */
  updateStream(serial: string, state: StreamState, viewers: number, error: string | null = null): void {
    const camera = this.#requireCamera(serial);
    camera.streamState = state;
    camera.streamViewers = viewers;
    camera.streamLastError = error;
    if (state === "streaming" && camera.streamStartedAt === null) {
      camera.streamStartedAt = new Date().toISOString();
    } else if (state === "idle" || state === "error") {
      camera.streamStartedAt = null;
    }
    this.#emitCamera(serial);
  }

  /** Publish provider connectivity and an optional safe diagnostic message. */
  updateConnection(state: ConnectionState, detail: string | null = null): void {
    this.#connectionState = state;
    this.#connectionDetail = detail;
    this.emit("event", { type: "connection-updated", state, detail } satisfies GatewayEvent);
  }

  /** Return the latest provider connection state for health and UI pages. */
  getConnection(): { state: ConnectionState; detail: string | null } {
    return { state: this.#connectionState, detail: this.#connectionDetail };
  }

  /** Keep a bounded diagnostic history without retaining raw push payloads. */
  recordPushDiagnostic(diagnostic: PushDiagnostic): void {
    this.#pushDiagnostics.push(diagnostic);
    if (this.#pushDiagnostics.length > 50) this.#pushDiagnostics.shift();
  }

  /** Return a copy of the bounded push diagnostic history. */
  listPushDiagnostics(): PushDiagnostic[] {
    return [...this.#pushDiagnostics];
  }

  /** Replace the current inventory explanation after provider discovery. */
  updateInventoryDiagnostics(diagnostics: InventoryDiagnostic[]): void {
    this.#inventoryDiagnostics = [...diagnostics];
  }

  /** Return a copy of the latest inventory diagnostics. */
  listInventoryDiagnostics(): InventoryDiagnostic[] {
    return [...this.#inventoryDiagnostics];
  }

  /** Replace per-device camera shapes after one complete Mega inventory read. */
  updateCameraCapabilities(manifests: readonly CameraCapabilityManifest[]): void {
    this.#cameraCapabilities = manifests.map((manifest) => structuredClone(manifest));
  }

  /** Return checked camera support shapes without querying a device. */
  listCameraCapabilities(): CameraCapabilityManifest[] {
    return this.#cameraCapabilities.map((manifest) => structuredClone(manifest));
  }

  /** Replace baseline product-family decisions after one complete inventory read. */
  updateDeviceCapabilities(manifests: readonly DeviceCapabilityManifest[]): void {
    this.#deviceCapabilities = manifests.map((manifest) => structuredClone(manifest));
  }

  /** Return independent copies of non-camera family decisions. */
  listDeviceCapabilities(): DeviceCapabilityManifest[] {
    return this.#deviceCapabilities.map((manifest) => structuredClone(manifest));
  }

  /** Return immutable snapshots for every known camera. */
  listCameras(): CameraState[] {
    return [...this.#cameras.keys()].map((serial) => this.getCamera(serial));
  }

  /** Return one camera or throw when the serial is not known. */
  getCamera(serial: string): CameraState {
    const camera = this.#requireCamera(serial);
    return {
      serial: camera.identity.serial,
      name: camera.identity.name,
      model: camera.identity.model,
      stationSerial: camera.identity.stationSerial,
      streamSupported: camera.identity.streamSupported,
      doorbellSupported: camera.identity.doorbellSupported,
      enabled: camera.identity.enabled ?? null,
      enableControlSupported: camera.identity.enableControlSupported ?? false,
      motionDetectionEnabled: camera.identity.motionDetectionEnabled ?? null,
      motionDetectionControlSupported: camera.identity.motionDetectionControlSupported ?? false,
      motionDetected: camera.motionDetected,
      personDetected: camera.personDetected,
      strangerDetected: camera.strangerDetected,
      petDetected: camera.petDetected,
      vehicleDetected: camera.vehicleDetected,
      dogDetected: camera.dogDetected,
      cryingDetected: camera.cryingDetected,
      soundDetected: camera.soundDetected,
      packageStrandedDetected: camera.packageStrandedDetected,
      doorbellPressed: camera.doorbellPressed,
      battery: camera.identity.battery ?? null,
      lastDetection: camera.lastDetection,
      snapshot: camera.snapshot,
      stream: {
        state: camera.streamState,
        viewers: camera.streamViewers,
        startedAt: camera.streamStartedAt,
        lastError: camera.streamLastError,
      },
    };
  }

  /** Check camera existence without throwing. */
  hasCamera(serial: string): boolean {
    return this.#cameras.has(serial);
  }

  /** Cancel pending detection timers during process shutdown. */
  close(): void {
    for (const timer of this.#motionClearTimers.values()) clearTimeout(timer);
    for (const timer of this.#personClearTimers.values()) clearTimeout(timer);
    for (const timer of this.#doorbellClearTimers.values()) clearTimeout(timer);
    for (const timer of this.#detectionClearTimers.values()) clearTimeout(timer);
    for (const timer of this.#sensorMotionClearTimers.values()) clearTimeout(timer);
    this.#motionClearTimers.clear();
    this.#personClearTimers.clear();
    this.#doorbellClearTimers.clear();
    this.#detectionClearTimers.clear();
    this.#sensorMotionClearTimers.clear();
  }

  #scheduleDetectionClear(
    timers: Map<string, NodeJS.Timeout>,
    serial: string,
    detected: boolean,
    clear: () => void,
  ): void {
    const existing = timers.get(serial);
    if (existing) clearTimeout(existing);
    timers.delete(serial);
    if (!detected) return;

    const timer = setTimeout(() => {
      timers.delete(serial);
      clear();
    }, this.detectionHoldMilliseconds);
    timer.unref();
    timers.set(serial, timer);
  }

  #requireCamera(serial: string): MutableCameraState {
    const camera = this.#cameras.get(serial);
    if (!camera) throw new Error(`Unknown camera: ${serial}`);
    return camera;
  }

  #emitCamera(serial: string): CameraState {
    const camera = this.getCamera(serial);
    this.emit("event", { type: "camera-updated", camera } satisfies GatewayEvent);
    return camera;
  }
}

function isRecentPersonDetection(detection: Detection | null, occurredAt: Date): boolean {
  if (detection?.kind !== "person") return false;
  const ageMilliseconds = occurredAt.getTime() - new Date(detection.occurredAt).getTime();
  return ageMilliseconds >= 0 && ageMilliseconds <= 10_000;
}

/** Convert Eufy's placeholder person labels into a nullable name. */
export function normalizePersonName(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate || /^(unknown|unknown person|no person)$/i.test(candidate)) return null;
  return candidate;
}
