/**
 * Defines reviewed sensitivity and chime settings for exact camera routes.
 * The provider owns leases, network reads and state publication. This module
 * owns native mappings and the single-write confirmation lifecycle consumed
 * by HTTP, PPCS and the Home Assistant settings boundary.
 */
import type { ModelControlRoute } from "./model-control-trials.js";

/** Closed absolute requests never carry arbitrary native command identifiers. */
export type CameraSettingChange =
  | { readonly setting: "motionSensitivity"; readonly value: number }
  | { readonly setting: "homebaseChime"; readonly value: boolean };

/** Native parameter and encoding selected only for a reviewed model and topology. */
export interface CameraSettingProfile {
  readonly readParam: number;
  readonly command: number;
  readonly form: "binary" | "payload" | "control";

  /** Least-sensitive first; absent for the boolean chime control. */
  readonly ladder?: readonly number[];
}

const INVERTED_2C = [192, 118, 72, 46, 30, 20, 14] as const;

/**
 * Carries a privacy-safe failure category for one settings operation.
 * The provider owns dispatch state; HTTP and HA consume this request-lifetime
 * error without retaining vendor exceptions, payloads or credential material.
 */
export class CameraSettingError extends Error {
  constructor(readonly code: "unavailable" | "busy" | "outcome_unknown") {
    super(code === "busy" ? "Wait for other camera operations to finish"
      : code === "outcome_unknown" ? "Setting outcome is unknown; check the Eufy app before retrying"
      : "Camera setting unavailable");
  }
}

/** Reject malformed bodies before provider authority or network work is used; JSON duplicate keys are last-wins. */
export function parseCameraSettingChange(value: unknown): CameraSettingChange {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new SyntaxError("Invalid camera setting");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || !Object.hasOwn(row, "setting") || !Object.hasOwn(row, "value")) throw new SyntaxError("Invalid camera setting");
  if (row.setting === "homebaseChime" && typeof row.value === "boolean") return { setting: row.setting, value: row.value };
  if (row.setting === "motionSensitivity" && typeof row.value === "number" && Number.isInteger(row.value) && row.value >= 1 && row.value <= 7) {
    return { setting: row.setting, value: row.value };
  }
  throw new SyntaxError("Invalid camera setting");
}

function nativeProfile(model: string, type: number | null, standalone: boolean, setting: CameraSettingChange["setting"]): CameraSettingProfile | null {
  if (setting === "homebaseChime") return !standalone && model === "T8210" && type === 7 ? { readParam: 1702, command: 1702, form: "binary" } : null;
  if (standalone) return model === "T817L" && type === 10031 ? { readParam: 6041, command: 1700, form: "control", ladder: [1, 2, 3] } : null;
  if (model === "T8113-Z" && type === 8) return { readParam: 1210, command: 1210, form: "binary", ladder: INVERTED_2C };
  if (model === "T8160-C" && type === 19) return { readParam: 1210, command: 1210, form: "binary", ladder: [1, 2, 3, 4, 5, 6, 7] };
  if (model === "T8210" && type === 7) return { readParam: 1276, command: 1350, form: "payload", ladder: [1, 2, 3, 4, 5] };
  if (model === "T8171" && type === 88) return { readParam: 1276, command: 1350, form: "payload", ladder: [1, 2, 3, 4, 5, 6, 7] };
  return null;
}

/** Admit tested transport families, excluding standalone SoloCam and nearby model variants. */
export function cameraSettingProfile(route: ModelControlRoute, setting: CameraSettingChange["setting"]): CameraSettingProfile | null {
  if (!Number.isInteger(route.channel) || route.channel! < 0 || route.channel! > 255) return null;
  if (route.homeBaseAttached ? route.selfPeer || route.peerModel !== "T8030" : !route.selfPeer || route.channel !== 0) return null;
  return nativeProfile(route.model, route.deviceType, !route.homeBaseAttached, setting);
}

/** Read only a parameter present exactly once in this observation, never a mirrored value or default. */
export function readCameraSetting(
  params: readonly { readonly param_type: number; readonly param_value: unknown }[],
  model: string, type: number | null, standalone: boolean, setting: CameraSettingChange["setting"],
): number | boolean | undefined {
  const profile = nativeProfile(model, type, standalone, setting);
  if (!profile) return undefined;
  const rows = params.filter(row => row.param_type === profile.readParam);
  if (rows.length !== 1) return undefined;
  const raw = rows[0]!.param_value;
  const value = typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
  if (setting === "homebaseChime") return value === 0 || value === 1 ? value === 1 : undefined;
  const index = profile.ladder!.indexOf(value);
  return index >= 0 ? index + 1 : undefined;
}

/** Convert one validated HA step to native bytes, rejecting profile-specific excess values. */
export function cameraSettingWireValue(profile: CameraSettingProfile, change: CameraSettingChange): number {
  parseCameraSettingChange(change);
  if (change.setting === "homebaseChime") {
    if (profile.readParam !== 1702 || profile.ladder) throw new CameraSettingError("unavailable");
    return change.value ? 1 : 0;
  }
  const value = profile.ladder?.[change.value - 1];
  if (value === undefined) throw new SyntaxError("Unsupported sensitivity step for this model");
  return value;
}

/** Injected operation boundaries keep readback/no-replay tests independent of real devices. */
export interface ConfirmedCameraSettingOperation {

  /** Require presence in this specific fresh observation, returning undefined for omission. */
  readonly read: () => Promise<number | boolean | undefined>;

  /** Call onDispatch immediately before the single native send, after final ownership checks. */
  readonly write: (onDispatch: () => void) => Promise<void>;
  readonly check: () => void;
  readonly invalidate: () => void;
  readonly signal?: AbortSignal;

  /** Absolute epoch-millisecond deadline; HA allows a longer HTTP timeout. */
  readonly deadline: number;
  readonly wait?: () => Promise<void>;
}

/** Submit once from a fresh baseline, retaining confirmed state on every clean rejection. */
export async function runConfirmedCameraSetting(operation: ConfirmedCameraSettingOperation, expected: number | boolean): Promise<void> {
  let dispatched = false;
  const check = (): void => {
    operation.check();
    if (Date.now() >= operation.deadline || (!dispatched && operation.signal?.aborted)) throw new CameraSettingError("unavailable");
  };
  const bounded = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CameraSettingError("unavailable")), Math.max(1, operation.deadline - Date.now()));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  try {
    check(); const baseline = await bounded(operation.read()); check();
    if (baseline === undefined) throw new CameraSettingError("unavailable");
    if (baseline === expected) return;
    await bounded(operation.write(() => { check(); if (operation.deadline - Date.now() < 20_000) throw new CameraSettingError("unavailable"); dispatched = true; }));
    check();
    if (!dispatched) throw new CameraSettingError("unavailable");
    for (let attempt = 0; attempt < 12; attempt++) {
      if (attempt) await bounded(operation.wait?.() ?? new Promise(resolve => setTimeout(resolve, 2_000)));
      check(); const value = await bounded(operation.read()); check();
      if (value === expected) return;
    }
    throw new CameraSettingError("outcome_unknown");
  } catch (error) {
    if (dispatched) { operation.invalidate(); throw new CameraSettingError("outcome_unknown"); }
    throw error instanceof SyntaxError || error instanceof CameraSettingError ? error : new CameraSettingError("unavailable");
  }
}
