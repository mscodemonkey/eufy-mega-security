/**
 * Collects gateway-owned diagnostic evidence across every inventory family.
 * GatewayServer owns the single memory-only session and its subscriptions.
 * HTTP export consumes projected metadata and explicitly consented native media;
 * credentials, vendor payloads and arbitrary error/log text never enter here.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { GatewayState } from "../domain/gateway-state.js";
import type { GatewayEvent, StreamDiagnostic } from "../domain/types.js";
import { safeCameraModel } from "../domain/safe-camera-model.js";
import { getLogIdentity } from "../logging.js";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 20_000;
const RETENTION_MS = 10 * 60_000;

/** Validated capture selection. Media is optional and always requires consent. */
export interface BundleOptions {
  readonly target: string | null;
  readonly seconds: 30 | 60;
  readonly media: boolean;
}

/** One source-stage observation, before viewer conversion or container muxing. */
export interface DiagnosticMedia {
  readonly serial: string;
  readonly kind: "video" | "audio" | "snapshot" | "event-image";
  readonly codec: "h264" | "h265" | "unknown" | "aac" | "jpeg";
  readonly data: Buffer;
}

interface RecordEntry {
  readonly offsetMs: number;
  readonly event: string;
  readonly device?: string;
  readonly code?: string | number;
  readonly counters?: Readonly<Record<string, number>>;
}

interface MediaEntry {
  readonly offsetMs: number;
  readonly device: string;
  readonly kind: DiagnosticMedia["kind"];
  readonly codec: DiagnosticMedia["codec"];
  readonly data: Buffer;
}

/** Return local selectors for every discovered device, including unadmitted cameras. */
export function diagnosticTargets(state: GatewayState) {
  const devices = new Map<string, { serial: string; name: string; model: string; streamSupported: boolean }>();
  for (const device of [...state.listInventoryDiagnostics(), ...state.listStations(), ...state.listSensors(), ...state.listCameras()]) {
    devices.set(device.serial, { serial: device.serial, name: device.name, model: safeCameraModel(device.model),
      streamSupported: "streamSupported" in device && device.streamSupported === true });
  }
  return [...devices.values()];
}

/**
 * Owns one capture's buffers, pseudonyms, timing and expiry.
 * Capturing observes existing work and never starts transport or writes device
 * settings. Stop preserves evidence until expiry; clear erases all media buffers.
 * The owner must call clear on shutdown and unsubscribe its event listeners.
 */
export class BundleCapture {
  readonly #started: number;
  readonly #ids = new Map<string, string>();
  readonly #selected = new Set<string>();
  readonly #records: RecordEntry[] = [];
  readonly #media: MediaEntry[] = [];
  readonly #timer: NodeJS.Timeout;
  readonly #expiry: NodeJS.Timeout;
  #bytes = 0;
  #dropped = 0;
  #state: "active" | "stopped" | "duration_limit" | "size_limit" | "record_limit" | "cleared" | "expired" = "active";

  /** Freeze device selection and begin timers, without opening any device connection. */
  constructor(readonly options: BundleOptions, private readonly now: () => number = () => performance.now()) {
    this.#started = now();
    this.#timer = setTimeout(() => this.stop("duration_limit"), options.seconds * 1000);
    this.#expiry = setTimeout(() => this.clear("expired"), RETENTION_MS);
    this.#timer.unref();
    this.#expiry.unref();
  }

  /** Include a device in this session without exporting its original identifier. */
  select(serial: string): void { this.#selected.add(serial); this.#id(serial); }

  /** Test the frozen selection; stations include their inventoried child cameras. */
  includes(serial: string): boolean { return this.options.target === null || this.#selected.has(serial); }

  /** Return a strict metadata projection, also used by Home Assistant's diagnostics download. */
  summary(state: GatewayState) {
    const cameras = state.listCameras();
    const stations = state.listStations();
    const sensors = state.listSensors();
    const inventory = state.listInventoryDiagnostics();
    const manifests = [...state.listCameraCapabilities(), ...state.listDeviceCapabilities()];
    const targets = diagnosticTargets(state).filter((row) => this.includes(row.serial));
    const devices = targets.map((row) => {
      const camera = cameras.find((item) => item.serial === row.serial);
      const station = stations.find((item) => item.serial === row.serial);
      const sensor = sensors.find((item) => item.serial === row.serial);
      const raw = inventory.find((item) => item.serial === row.serial);
      const manifest = manifests.find((item) => item.serial === row.serial);
      const type = raw?.megaDeviceType ?? sensor?.deviceType;
      const parent = camera?.stationSerial && camera.stationSerial !== row.serial ? camera.stationSerial : null;
      return {
        id: this.#id(row.serial), model: row.model,
        family: camera ? "camera" : station ? "station" : sensor ? "sensor" : "inventory",
        deviceType: Number.isSafeInteger(type) && type! >= 0 && type! <= 65535 ? type : null,
        parent: parent ? this.#id(parent) : null,
        topology: parent ? "attached" : "direct",
        firmware: firmware(camera?.firmware ?? station?.firmware),
        streamSupported: camera?.streamSupported ?? false,
        liveAudioSupported: camera?.liveAudioSupported ?? false,
        stateReadSupported: station?.stateReadSupported ?? false,
        controlsSupported: station?.controlsSupported ?? false,
        acceptedAsCamera: raw?.acceptedAsCamera ?? !!camera,
        streamState: camera?.stream.state ?? null,
        controls: camera ? {
          enable: camera.enableControlSupported, motion: camera.motionDetectionControlSupported,
          guardMode: camera.guardModeControlSupported, nightVision: camera.nightVisionControlSupported,
          autoNightVision: camera.autoNightVisionControlSupported, light: camera.cameraLightControlSupported,
          siren: camera.cameraSirenControlSupported, presets: camera.presetPositionControlSupported,
          aiTracking: camera.aiTrackingControlSupported, autoCruise: camera.autoCruiseControlSupported,
          talkback: camera.talkbackSupported ?? false, storedRecordings: camera.storedRecordingsSupported ?? false,
        } : null,
        capabilities: (manifest?.matrix ?? []).slice(0, 256).map((item) => ({
          id: /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(item.id) ? item.id : "unknown",
          implemented: item.gatewaySupport === "implemented", offerable: item.offerable === true,
          reportedParamIds: item.reportedParamIds.filter((id) => Number.isSafeInteger(id) && id >= 0 && id <= 65535).slice(0, 128),
        })),
        available: station?.available ?? sensor?.available ?? null,
      };
    });
    const delivery = state.eventDeliveryDiagnostic();
    return {
      schema: 1, version: getLogIdentity().version,
      connection: state.getConnection().state, devices,
      eventDelivery: { receiverState: delivery.receiverState, connectionCount: delivery.connectionCount,
        disconnectionCount: delivery.disconnectionCount, deliveryCount: delivery.deliveryCount,
        parsedCount: delivery.parsedCount, emptyCount: delivery.emptyCount, unparsedCount: delivery.unparsedCount },
    };
  }

  /** Observe normalized lifecycle events without names, detection identities or detail text. */
  event(event: GatewayEvent): void {
    if (event.type === "lock" || event.type === "locks") return;
    if (event.type === "camera-updated") this.record(event.type, event.camera.serial, event.camera.stream.state);
    else if (event.type === "sensor-updated") this.record(event.type, event.sensor.serial);
    else if (event.type === "station-updated") this.record(event.type, event.station.serial);
    else if (event.type === "sensors-updated") { for (const sensor of event.sensors) this.record("sensor-updated", sensor.serial); }
    else if (event.type === "stations-updated") { for (const station of event.stations) this.record("station-updated", station.serial); }
    else if (event.type === "connection-updated") this.record(event.type, undefined, event.state);
    else this.record(event.type, event.cameraSerial, event.type === "detection" ? event.detection.kind : undefined);
  }

  /** Retain closed event codes and relative timing; arbitrary messages are not accepted. */
  record(event: string, serial?: string, code?: string | number): void {
    if (!this.#accepting() || (serial !== undefined && !this.includes(serial))) return;
    if (this.#records.length + this.#media.length >= MAX_RECORDS) { this.#dropped++; this.stop("record_limit"); return; }
    this.#records.push({ offsetMs: this.#elapsed(), event,
      ...(serial !== undefined ? { device: this.#id(serial) } : {}), ...(code !== undefined ? { code } : {}) });
  }

  /** Retain only allowlisted numeric source counters, never arbitrary transport fields. */
  transport(serial: string, diagnostic: StreamDiagnostic): void {
    if (!this.#accepting() || !this.includes(serial)) return;
    if (this.#records.length + this.#media.length >= MAX_RECORDS) { this.stop("record_limit"); return; }
    const counters: Record<string, number> = {};
    for (const key of ["dataDatagrams", "frameHeaders", "videoFrames", "videoOutputFrames", "sequenceGaps",
      "sequenceRestarts", "duplicateDatagrams", "staleDatagrams", "parserResyncs", "pendingBytes",
      "incompleteAccessUnits", "incompleteAccessUnitBytes"] as const) {
      const value = diagnostic.counters[key];
      if (Number.isSafeInteger(value) && value >= 0) counters[key] = value;
    }
    this.#records.push({ offsetMs: this.#elapsed(), event: "source-transport", device: this.#id(serial),
      code: diagnostic.stage === "lookup" || diagnostic.stage === "first-frame" ? diagnostic.stage : "media", counters });
  }

  /** Copy native media only during a consented session, before viewer conversion. */
  media(sample: DiagnosticMedia): void {
    if (!this.options.media || !this.#accepting() || !this.includes(sample.serial) || !sample.data.length) return;
    if (this.#bytes + sample.data.length > MAX_BYTES) { this.#dropped++; this.stop("size_limit"); return; }
    if (this.#records.length + this.#media.length >= MAX_RECORDS) { this.#dropped++; this.stop("record_limit"); return; }
    this.#media.push({ offsetMs: this.#elapsed(), device: this.#id(sample.serial), kind: sample.kind,
      codec: sample.codec, data: Buffer.from(sample.data) });
    this.#bytes += sample.data.length;
  }

  /** Stop acquisition while retaining a retryable download until expiry. */
  stop(reason: "stopped" | "duration_limit" | "size_limit" | "record_limit" = "stopped"): void {
    clearTimeout(this.#timer);
    if (this.#state === "active") this.#state = reason;
  }

  /** Release and overwrite media buffers, making export unavailable immediately. */
  clear(reason: "cleared" | "expired" = "cleared"): void {
    clearTimeout(this.#timer);
    clearTimeout(this.#expiry);
    for (const sample of this.#media) sample.data.fill(0);
    this.#media.length = 0;
    this.#records.length = 0;
    this.#ids.clear();
    this.#selected.clear();
    this.#bytes = 0;
    this.#state = reason;
  }

  /** Return counts and limits without private bytes or original device identities. */
  status() {
    this.#expire();
    return { state: this.#state, media: this.options.media, seconds: this.options.seconds,
      elapsedMs: this.#elapsed(), records: this.#records.length, mediaChunks: this.#media.length,
      mediaBytes: this.#bytes, dropped: this.#dropped,
      limits: { mediaBytes: MAX_BYTES, records: MAX_RECORDS, retentionSeconds: RETENTION_MS / 1000 } };
  }

  /** Stop and build a gzip archive with checksums; no disk or network writes occur. */
  archive(state: GatewayState): Buffer | null {
    this.#expire();
    if (this.#state === "cleared" || this.#state === "expired") return null;
    this.stop();
    return gzipSync(JSON.stringify({ schema: "eufy-diagnostics-1", summary: this.summary(state),
      capture: this.status(), stages: { lifecycle: true, logEventCodes: true, nativeMedia: this.options.media,
        mediaSource: "provider-before-viewer-conversion", rawPackets: false, vendorPayloads: false,
        nvrRtc: false, securitySettingsChanged: false },
      records: this.#records, media: this.#media.map((sample) => ({
        offsetMs: sample.offsetMs, device: sample.device, kind: sample.kind, codec: sample.codec,
        bytes: sample.data.length, sha256: createHash("sha256").update(sample.data).digest("hex"),
        base64: sample.data.toString("base64"),
      })) }));
  }

  #id(serial: string): string {
    let id = this.#ids.get(serial);
    if (!id) { id = `device-${this.#ids.size + 1}`; this.#ids.set(serial, id); }
    return id;
  }

  #elapsed(): number { return Math.max(0, Math.round(this.now() - this.#started)); }

  #expire(): void {
    if (this.#state === "cleared" || this.#state === "expired") return;
    if (this.#elapsed() >= RETENTION_MS) this.clear("expired");
    else if (this.#elapsed() >= this.options.seconds * 1000) this.stop("duration_limit");
  }

  #accepting(): boolean { this.#expire(); return this.#state === "active"; }
}

function firmware(value: string | null | undefined): string | null {
  return value && /^\d{1,5}(?:\.\d{1,5}){1,5}(?:-[A-Za-z]{1,12}\d{0,4})?$/.test(value) ? value : null;
}
