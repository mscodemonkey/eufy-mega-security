/**
 * Qualifies the attached S340 live-quality preference independently of recording
 * quality and lens selection. The provider owns fresh inventory and exclusive
 * sessions; the settings and HA boundaries consume these restricted values.
 */
import type { ModelControlRoute } from "./model-control-trials.js";

/** Quality of the active view mode, taken from one complete parameter snapshot. */
export interface S340LiveQualityRead {

  /** Native preference code, not a measured video resolution. */
  readonly quality: number;

  /** Native mode selects the preference bank this reading belongs to. */
  readonly videoMode: 0 | 12;
}

/** Offer native live-quality choices without promising delivered frame dimensions. */
export const S340_LIVE_QUALITY_MODES = [
  { value: 0, name: "Auto" }, { value: 1, name: "HD (720P)" },
  { value: 2, name: "Full HD (1080P)" }, { value: 3, name: "3K" },
] as const;

/** Require the exact attached S340 identity, HomeBase generation and reported mode. */
export function isS340LiveQualityRoute(route: ModelControlRoute): boolean {
  return route.model === "T8170" && route.deviceType === 48 && route.homeBaseAttached
    && !route.selfPeer && route.peerModel === "T8030" && route.peerDeviceType === 18
    && Number.isInteger(route.channel) && route.channel !== null && route.channel >= 0 && route.channel <= 31
    && (route.liveQualityVideoMode === 0 || route.liveQualityVideoMode === 12);
}

type InventoryParameter = { readonly param_type: number; readonly param_value: unknown };

/** Closed, content-free explanation of the exact view-mode parameter admission. */
export type S340LiveModeEvidence = "missing" | "duplicate" | "single" | "dual"
  | "invalid_number" | "invalid_string" | "invalid_shape";

/** Classify one inventory snapshot without retaining arbitrary values or inferring a mode. */
export function readS340LiveModeEvidence(params: readonly InventoryParameter[]): S340LiveModeEvidence {
  const modes = params.filter(row => row.param_type === 6243);
  if (modes.length === 0) return "missing";
  if (modes.length > 1) return "duplicate";
  const value = modes[0]!.param_value;
  if (value === 0 || value === "0") return "single";
  if (value === 12 || value === "12") return "dual";
  return typeof value === "number" ? "invalid_number" : typeof value === "string" ? "invalid_string" : "invalid_shape";
}

/**
 * Read the S340 view mode independently of the reported quality preference.
 * The model reports 0 for single view and 12 for dual view. Duplicate rows
 * leave the mode unknown, even if their values agree.
 */
export function readS340LiveViewMode(params: readonly InventoryParameter[]): 0 | 12 | undefined {
  const evidence = readS340LiveModeEvidence(params);
  return evidence === "single" ? 0 : evidence === "dual" ? 12 : undefined;
}

/**
 * Read the active preference bank, refusing missing, duplicate or malformed
 * evidence. A legacy scalar is accepted only for single view.
 */
export function readS340LiveQuality(params: readonly InventoryParameter[]): S340LiveQualityRead | undefined {
  const videoMode = readS340LiveViewMode(params);
  if (videoMode === undefined) return undefined;
  const qualities = params.filter(row => row.param_type === 2730);
  if (qualities.length !== 1) return undefined;
  let value = qualities[0]!.param_value;
  if (typeof value === "string") {
    if (value.length > 4096) return undefined;
    try { value = JSON.parse(value); }
    catch {
      if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value as string)) return undefined;
      try { value = JSON.parse(Buffer.from(value as string, "base64").toString("utf8")); }
      catch { return undefined; }
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const mode = (value as Record<string, unknown>)[videoMode === 12 ? "mode_1" : "mode_0"];
    value = mode !== null && typeof mode === "object" && !Array.isArray(mode)
      ? (mode as Record<string, unknown>).quality : undefined;
  } else if (videoMode === 12) {
    return undefined;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3
    ? { quality: value, videoMode } : undefined;
}

/** Build one absolute live-quality request without writing recording quality or lens mode. */
export function s340LiveQualityValue(route: ModelControlRoute, quality: number, accountId: string): string {
  if (!isS340LiveQualityRoute(route) || !Number.isInteger(quality) || quality < 0 || quality > 3 || !accountId) {
    throw new Error("S340 live quality unavailable");
  }
  return JSON.stringify({ account_id: accountId, cmd: 2730, mChannel: route.channel, mValue3: 0,
    payload: { quality, mode: route.liveQualityVideoMode, primary_view: 0, channel: route.channel } });
}
