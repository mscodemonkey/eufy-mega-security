/**
 * Maintains the static Android model lookup used by local inventory diagnostics.
 * The retained model library owns its declarations. EMS runtime admission and
 * the separately traced start-request predictions use independent evidence.
 */
import androidModels from "./android-models.json" with { type: "json" };

const referenceByModel = new Map(androidModels.map(row => [row.model, row]));

/** Find declarations and resolved parser operations for the exact reference model. */
export function androidModelReference(model: string) {
  return referenceByModel.get(model);
}

const operationLabels = [
  ["detection_sensitivity", "Detection sensitivity"], ["open_event_stream", "Event playback"],
  ["live_streaming_resolution", "Live quality"], ["motion_detection_status", "Motion detection"],
  ["nightvision_type", "Night vision"], ["arming_selected_mode", "Security mode"],
  ["speaker_volume", "Speaker volume"], ["spotlight_switch", "Spotlight"],
  ["get_storage_info", "Storage status"], ["start_intercom", "Talkback"],
  ["device_thumbnail_path", "Thumbnail"],
] as const;

/** Name common resolved operations for the compact web summary. */
export function referenceOperations(identifiers: readonly string[]): string[] {
  return operationLabels.filter(([id]) => identifiers.includes(id)).map(([, label]) => label);
}

/** Accept a bounded numeric firmware version for prediction and diagnostic export. */
export function referenceFirmware(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{1,6}(?:\.\d{1,6}){1,4}$/.test(value) ? value : undefined;
}

/**
 * Predict the outer request family for traced direct, HB2 and standard HB3 paths.
 * The caller supplies a reviewed exact-model binding. Other station variants
 * remain unresolved unless the binding itself makes the choice unconditionally.
 */
export function predictLiveRequest(handler: string | undefined, parent: string, serial: string, outdoor: boolean | undefined, parentFirmware?: string): string | undefined {
  if (!handler) return undefined;
  if (handler === "OpenLiveStreamParser1350_V3 (v6)") return "recorder-style start request";
  if (!parent) return undefined;
  if (handler === "OpenLiveStreamParser1700_V4") return parent === serial ? "direct 1700 wrapper" : "1350 wrapper";
  if (outdoor === undefined) return undefined;
  const hb2 = parent.startsWith("T8010");
  const hb3 = parent.startsWith("T8030") && parent.length >= 8 && parent[7] !== "1";
  const direct = outdoor || (parent === serial && !/^T(?:80|90|8N|7000)/.test(parent));
  if (!direct && !hb2 && !hb3) return undefined;
  if (handler === "OpenLiveStreamParser") return direct ? "basic live start" : "1350 wrapper";
  if (handler === "OpenLiveStreamParser1700_V2" || handler === "OpenLiveStreamParser1700_V3") return "1700 wrapper";
  if (handler === "OpenLiveStreamParser1700_V5") return "1350 wrapper";
  if (handler === "OpenLiveStreamParser1350_V3 (v4)") return "basic live start";
  if (handler === "OpenLiveStreamParser1350_V3 (v3)") return "1350 wrapper with variant 5";
  if (handler === "OpenLiveStreamParser1350_V3 (v7)") {
    if (direct) return "direct 1700 wrapper";
    if (hb2) return "1350 wrapper";
    const firmware = referenceFirmware(parentFirmware);
    if (!hb3 || !firmware) return undefined;

    // The Android comparator treats missing version components as zero.
    const components = firmware.split(".").map(Number);
    const threshold = [4, 2, 0, 0];
    const difference = components.findIndex((value, index) => value !== (threshold[index] ?? 0));
    return difference >= 0 && components[difference]! > (threshold[difference] ?? 0)
      ? "recorder-style start request" : "1700 wrapper";
  }
  if (handler === "OpenLiveStreamParser1350_V3 (v8)" && (direct || hb3)) return "1700 wrapper";
  if (["OpenLiveStreamParser1350_V3", "OpenLiveStreamParser1350_V3 (v1)", "OpenLiveStreamParser1350_V3 (v2)", "OpenLiveStreamParser1350_V3 (v8)"].includes(handler)) return direct ? "direct 1700 wrapper" : "1350 wrapper";
  return undefined;
}
