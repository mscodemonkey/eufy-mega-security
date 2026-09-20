/**
 * Provides a deterministic implementation of the provider boundary.
 *
 * The simulated provider owns no cloud credentials and performs no Eufy
 * network calls. It creates a known camera, emits repeatable JPEG/H.264 test
 * bytes, and can trigger detection events through the development endpoint.
 * This keeps HTTP, SSE, snapshot, and Home Assistant integration work
 * reproducible when Mega is unavailable or a physical camera is asleep.
 */
import { Readable } from "node:stream";

import type { CameraIdentity, HomeBaseState } from "../domain/types.js";
import { describeCameraCapabilities, describeDeviceCapabilities } from "./device-capabilities-core.js";
import type { CameraProvider, ProviderEvents } from "./provider.js";


const stationSerial = "SIMULATED-HOMEBASE-3";

function simulatedStation(overrides: Partial<HomeBaseState> = {}): HomeBaseState {
  return {
    serial: stationSerial,
    name: "Simulated HomeBase 3",
    model: "T8030",
    firmware: "3.8.6.0",
    available: true,
    cameraRouteReady: true,
    controlsSupported: true,
    connected: true,
    guardMode: 63,
    effectiveMode: 63,
    alarmActive: false,
    alarmVolume: 20,
    promptVolume: 12,
    alarmTone: 1,
    storage: {
      emmc: { status: "healthy", totalBytes: 16_000_000_000, freeBytes: 12_000_000_000 },
      hdd: null,
    },
    ...overrides,
  };
}

/**
 * Supplies deterministic camera observations for tests and local API checks.
 * It follows the same callback contract as EufyProvider, so the server and
 * state layers can be exercised without changing their production code.
 */
export class SimulatedProvider implements CameraProvider {
  static readonly serial = "SIMULATED-CAMERA-1";
  #events: ProviderEvents | null = null;
  #station = simulatedStation();

  async start(events: ProviderEvents): Promise<void> {
    this.#events = events;
    events.camera({
      serial: SimulatedProvider.serial,
      name: "Simulated driveway",
      model: "T8142-compatible simulator",
      stationSerial: "SIMULATED-HOMEBASE-3",
      streamSupported: true,
      doorbellSupported: false,
      enabled: true,
      enableControlSupported: true,
      motionDetectionEnabled: true,
      motionDetectionControlSupported: true,
      battery: {
        supported: ["level", "charging", "health", "temperature", "lastChargingDays"],
        level: 82,
        charging: false,
        health: 96,
        temperature: 24,
        lastChargingDays: 12,
      },
    });
    events.sensor({
      serial: "SIMULATED-ENTRY-SENSOR-1",
      name: "Simulated side gate",
      model: "T8900-compatible simulator",
      deviceType: 2,
      available: true,
      capabilities: ["battery", "contact", "lastSeen"],
      batteryLevel: 74,
      contactOpen: false,
      lastSeen: new Date().toISOString(),
      motionDetected: false,
    });
    events.station(this.#station);
    events.inventory([{
      serial: SimulatedProvider.serial,
      name: "Simulated driveway",
      model: "T8142-compatible simulator",
      sources: ["simulated"],
      upstreamIsCamera: true,
      acceptedAsCamera: true,
      megaDeviceType: 8,
      category: "eufy_security",
    }]);
    events.cameraCapabilities([describeCameraCapabilities({
      serial: SimulatedProvider.serial,
      model: "T8142-compatible simulator",
      category: "eufy_security",
      deviceType: 8,
      paramTypes: [1101, 6043, 6044],
    }, { doorbellSupported: false, streamSupported: true, routeReady: true, homeBaseAttached: true })]);
    events.deviceCapabilities(describeDeviceCapabilities({
      serial: stationSerial,
      model: "T8030",
      category: "eufy_security",
      deviceType: 18,
      paramTypes: [],
    }, { homeBaseSupported: true, homeBaseRouteReady: true, doorbellSupported: false, cameraStreamSupported: false }));
    events.connection("connected", "simulated provider");
  }

  async startStream(serial: string): Promise<void> {
    this.#assertSerial(serial);
    this.#events?.streamStarted(serial, Readable.from([]));
  }

  async stopStream(serial: string): Promise<void> {
    this.#assertSerial(serial);
    this.#events?.streamStopped(serial);
  }

  /** Apply deterministic enablement state for HTTP and Home Assistant tests. */
  async setCameraEnabled(serial: string, enabled: boolean): Promise<CameraIdentity> {
    this.#assertSerial(serial);
    const identity = {
      serial: SimulatedProvider.serial,
      name: "Simulated driveway",
      model: "T8142-compatible simulator",
      stationSerial: stationSerial,
      streamSupported: true,
      doorbellSupported: false,
      enabled,
      enableControlSupported: true,
      battery: {
        supported: ["level", "charging", "health", "temperature", "lastChargingDays"] as const,
        level: 82,
        charging: false,
        health: 96,
        temperature: 24,
        lastChargingDays: 12,
      },
    };
    this.#events?.camera(identity);
    return identity;
  }

  /** Apply deterministic motion-detection state for API and HA tests. */
  async setCameraMotionDetection(serial: string, enabled: boolean): Promise<CameraIdentity> {
    this.#assertSerial(serial);
    const identity = {
      serial: SimulatedProvider.serial,
      name: "Simulated driveway",
      model: "T8142-compatible simulator",
      stationSerial: stationSerial,
      streamSupported: true,
      doorbellSupported: false,
      enabled: true,
      enableControlSupported: true,
      motionDetectionEnabled: enabled,
      motionDetectionControlSupported: true,
    };
    this.#events?.camera(identity);
    return identity;
  }

  async refreshStation(serial: string): Promise<HomeBaseState> {
    this.#assertStation(serial);
    return structuredClone(this.#station);
  }

  async setGuardMode(serial: string, mode: number): Promise<HomeBaseState> {
    this.#assertStation(serial);
    this.#station = { ...this.#station, guardMode: mode, effectiveMode: mode };
    this.#events?.station(this.#station);
    return structuredClone(this.#station);
  }

  async setAlarmVolume(serial: string, value: number): Promise<HomeBaseState> {
    return this.#updateStation(serial, { alarmVolume: value });
  }

  async setPromptVolume(serial: string, value: number): Promise<HomeBaseState> {
    return this.#updateStation(serial, { promptVolume: value });
  }

  async setAlarmTone(serial: string, value: number): Promise<HomeBaseState> {
    return this.#updateStation(serial, { alarmTone: value });
  }

  async close(): Promise<void> {
    this.#events?.connection("disconnected", "simulated provider stopped");
    this.#events = null;
  }

  detectMotion(personName: string | null = null): void {
    const events = this.#events;
    if (!events) return;
    events.pushDiagnostic({
      receivedAt: new Date().toISOString(),
      cameraSerial: SimulatedProvider.serial,
      cameraName: "Simulated driveway",
      type: 1,
      eventType: personName === null ? 1 : 2,
      messageType: 3,
      notificationStyle: 1,
      personName,
      hasPersonName: personName !== null,
      hasPictureUrl: true,
      hasFilePath: false,
      hasFetchId: personName !== null,
      hasSenseId: false,
    });
    events.motion(SimulatedProvider.serial, true);
    if (personName !== null) events.person(SimulatedProvider.serial, true, personName);
  }

  #assertSerial(serial: string): void {
    if (serial !== SimulatedProvider.serial) throw new Error(`Unknown simulated camera: ${serial}`);
  }

  #assertStation(serial: string): void {
    if (serial !== stationSerial) throw new Error(`Unknown simulated HomeBase: ${serial}`);
  }

  #updateStation(serial: string, values: Partial<HomeBaseState>): HomeBaseState {
    this.#assertStation(serial);
    this.#station = { ...this.#station, ...values };
    this.#events?.station(this.#station);
    return structuredClone(this.#station);
  }
}
