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
import type { Readable } from "node:stream";

import type { CameraCapabilityManifest, CameraIdentity, DetectionKind, DeviceCapabilityManifest, HomeBaseState, InventoryDiagnostic, PushDiagnostic, SecuritySensorState } from "../domain/types.js";

/** Callbacks through which a provider reports normalized observations. */
export interface ProviderEvents {
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
  snapshot(serial: string, data: Buffer, contentType: string): void;
  pushDiagnostic(diagnostic: PushDiagnostic): void;
  inventory(diagnostics: InventoryDiagnostic[]): void;
  cameraCapabilities(manifests: readonly CameraCapabilityManifest[]): void;
  deviceCapabilities(manifests: readonly DeviceCapabilityManifest[]): void;
  streamStarted(serial: string, video: Readable): void;
  streamStopped(serial: string): void;
}

/** Lifecycle and stream operations required by the gateway server. */
export interface CameraProvider {
  start(events: ProviderEvents): Promise<void>;
  startStream(serial: string): Promise<void>;
  stopStream(serial: string): Promise<void>;

  /** Write camera enablement and return only state confirmed by fresh readback. */
  setCameraEnabled(serial: string, enabled: boolean): Promise<CameraIdentity>;

  /** Write camera motion detection and return fresh inventory-backed state. */
  setCameraMotionDetection(serial: string, enabled: boolean): Promise<CameraIdentity>;
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
