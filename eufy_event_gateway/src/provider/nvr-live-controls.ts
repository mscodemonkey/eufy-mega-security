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

  /** The only view that accepts pan and zoom, or null when every view does. */
  readonly movementView: 0 | 1 | null;

  /** The camera confirms a pan with its receipt alone and sends no PTZ data reply. */
  readonly panReceiptOnly: boolean;

  /** AI tracking is written on the PTZ transport and read back from the channel row. */
  readonly aiTracking: boolean;
}

/**
 * Match exact model/type pairs only. T8416 offers no view choice: its second NVR source showed the
 * same wide picture on hardware, and zoom reaches the telephoto. Its quality names follow the eufy app.
 */
export function nvrLiveProfile(model: string, type: number | null): NvrLiveProfile | null {
  if (model === "T8E00" && type === 301) return {
    night: [{ value: 0, name: "Standard" }, { value: 1, name: "Infrared" }, { value: 2, name: "Spotlight" }],
    quality: [{ value: 0, name: "Auto" }, { value: 1, name: "Low" }, { value: 3, name: "High" }],
    views: ["Fixed", "Movable"], defaultView: 1, opticalZoom: true, movementView: 1, panReceiptOnly: false, aiTracking: false,
  };
  if (model === "T8416" && type === 104) return {
    night: [{ value: 0, name: "Off" }, { value: 1, name: "Auto Infrared" }, { value: 3, name: "Infrared on" }],
    quality: [{ value: 0, name: "Auto" }, { value: 1, name: "HD (720P)" }, { value: 2, name: "Full HD (1080P)" }, { value: 3, name: "2K" }, { value: 4, name: "Ultra 4K" }],
    views: [], defaultView: 0, opticalZoom: true, movementView: null, panReceiptOnly: true, aiTracking: true,
  };
  return null;
}
