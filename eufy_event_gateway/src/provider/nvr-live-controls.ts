/**
 * Defines closed experimental NVR profiles and public failures. The provider owns
 * observations and admission, while the session consumes these finite requests.
 */
import type { CameraStreamingQualityMode, NightVisionMode } from "../domain/types.js";

/** Fixed stages describe control progress without exposing a transport or vendor payload. */
export type NvrLiveControlStage = "admission" | "dispatch" | "source_lifetime" | "segment_budget" | "reply" | "receipt" | "request";

/**
 * Carries fixed operation failures to the gateway and HA. The catching boundary
 * owns presentation. Instances own no resources and never retain vendor causes.
 */
export class NvrLiveControlError extends Error {
  constructor(readonly code: "unavailable" | "busy" | "rate_limited" | "outcome_unknown" | "disabled", readonly stage: NvrLiveControlStage = "admission") {
    super(`NVR control ${code}`);
  }
}

/** A finite single-step request, with no continuous movement or arbitrary command. */
export type NvrLiveControl = { readonly kind: "pan"; readonly direction: "left" | "right" | "up" | "down" }
  | { readonly kind: "zoom"; readonly level: 1 | 2 | 3 };

/** An accepted request requires the operator to verify the physical result. */
export interface NvrLiveControlResult {
  readonly outcome: "request_accepted";
  readonly physicalConfirmationRequired: true;
}

/** Static opt-in profile, independent of hardware-confirmed capability claims. */
export interface NvrLiveProfile {
  readonly night: readonly NightVisionMode[];
  readonly quality: readonly CameraStreamingQualityMode[];
  readonly views: readonly string[];
  readonly defaultView: 0 | 1;
  readonly opticalZoom: boolean;
}

/** Match exact model/type pairs only. Telephoto is reporter-reported, not portal-source. */
export function nvrLiveProfile(model: string, type: number | null): NvrLiveProfile | null {
  if (model === "T8E00" && type === 301) return {
    night: [{ value: 0, name: "Standard" }, { value: 1, name: "Infrared" }, { value: 2, name: "Spotlight" }],
    quality: [{ value: 0, name: "Auto" }, { value: 1, name: "Low" }, { value: 3, name: "High" }],
    views: ["Fixed", "Movable"], defaultView: 1, opticalZoom: true,
  };
  if (model === "T8416" && type === 104) return {
    night: [{ value: 0, name: "Off" }, { value: 1, name: "Auto Infrared" }, { value: 3, name: "Infrared on" }],
    quality: [{ value: 0, name: "Auto" }, { value: 1, name: "Low" }, { value: 2, name: "Full HD (1080P)" }, { value: 3, name: "High" }, { value: 4, name: "Highest" }],
    views: ["Wide", "Telephoto"], defaultView: 0, opticalZoom: false,
  };
  return null;
}
