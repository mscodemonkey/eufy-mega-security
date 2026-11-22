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

/** Decode one reported quality record without selecting a preference bank. */
function qualityRecord(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length > 4096) return undefined;
  try { return JSON.parse(value); }
  catch {
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return undefined;
    try { return JSON.parse(Buffer.from(value, "base64").toString("utf8")); }
    catch { return undefined; }
  }
}

/**
 * Read the S340 view mode independently of the reported quality preference.
 * Both the separate mode parameter and the quality record's explicit cur_mode
 * report 0 for single view and 12 for dual view. Missing values are never
 * inferred from available banks. Duplicate or conflicting reports stay unknown.
 */
export function readS340LiveViewMode(params: readonly InventoryParameter[]): 0 | 12 | undefined {
  const modes = params.filter(row => row.param_type === 6243);
  if (modes.length > 1) return undefined;
  const nativeMode = (value: unknown): 0 | 12 | undefined => value === 0 || value === "0" ? 0
    : value === 12 || value === "12" ? 12 : undefined;
  const separate = nativeMode(modes[0]?.param_value);
  if (modes.length === 1 && separate === undefined) return undefined;
  const qualities = params.filter(row => row.param_type === 2730);
  const record = qualities.length === 1 ? qualityRecord(qualities[0]!.param_value) : undefined;
  if (record !== null && typeof record === "object" && !Array.isArray(record) && Object.hasOwn(record, "cur_mode")) {
    const embedded = nativeMode((record as Record<string, unknown>).cur_mode);
    return embedded !== undefined && (separate === undefined || separate === embedded) ? embedded : undefined;
  }
  return separate;
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
  let value = qualityRecord(qualities[0]!.param_value);
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
