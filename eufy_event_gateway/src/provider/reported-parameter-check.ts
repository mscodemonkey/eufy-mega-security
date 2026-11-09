/**
 * Projects the manual cloud parameter read into a closed diagnostic vocabulary.
 * This module owns no device state or network work. MegaClient and the HTTP
 * boundary consume its projections without enabling any normal controls.
 */

/** Fixed failures that may cross the diagnostic HTTP boundary without private data. */
export const parameterCheckStages = ["disabled", "unauthorized", "invalid_request", "unsupported", "owner_account_required", "owner_binding_unavailable", "busy", "inventory", "binding_changed", "request", "invalid_response", "timeout", "cancelled", "shutdown"] as const;

/** A diagnostic refusal, never an arbitrary transport or server message. */
export type ParameterCheckStage = typeof parameterCheckStages[number];

/**
 * Carries one fixed diagnostic failure. The operation owns this transient error,
 * and the server consumes only its stage rather than its stack or source error.
 */
export class ParameterCheckError extends Error {
  constructor(readonly stage: ParameterCheckStage) {
    super(`Reported parameter check ${stage}`);
  }
}

/** Exact profiles under investigation, without aliases or inferred device families. */
export type ParameterCheckModel = "T8410" | "T8417" | "T8030" | "T8910";

/** Cached value classes only. Time bands use the gateway receipt clock, never live-device freshness. */
export type ParameterObservation = "missing" | "zero" | "one" | "valid" | "invalid" | "conflicting" | "unset" | "recent" | "older" | "future";

/** Direction of a valid timestamp comparison, without exposing either instant. */
export type MotionTimeChange = "advanced" | "unchanged" | "regressed" | "unavailable";

/** Identifier-free result owned by one manual read, never merged into gateway state. */
export interface ParameterCheckSummary {
  readonly model: ParameterCheckModel;

  /** Present only for the separate, bounded T8910 device-list comparison. */
  readonly source?: "device_list";
  readonly change?: MotionTimeChange;
  readonly profile: "power_candidates" | "privacy_candidates" | "alarm_volume_candidate" | "motion_time_candidate";

  /** Selected parameter IDs and fixed classes, without raw values or event timestamps. */
  readonly observations: Readonly<Record<string, ParameterObservation>>;
}

const profiles = {
  T8410: { profile: "power_candidates", fields: [1035, 2001] },
  T8417: { profile: "privacy_candidates", fields: [1035, 2001, 6250, 6271] },
  T8030: { profile: "alarm_volume_candidate", fields: [1235] },
  T8910: { profile: "motion_time_candidate", fields: [1605] },
} as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalar(value: unknown): number | null {
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Coarsen the established seconds/milliseconds forms without publishing the cached instant. */
function motionTimeObservation(raw: number | null, receivedAtMilliseconds: number): ParameterObservation {
  if (raw === 0) return "unset";
  if (raw === null) return "invalid";
  const milliseconds = raw >= 946_684_800_000 ? raw : raw * 1_000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 946_684_800_000 || milliseconds >= 4_102_444_800_000) return "invalid";
  const age = receivedAtMilliseconds - milliseconds;
  return age < -2_000 ? "future" : age <= 60_000 ? "recent" : "older";
}

/**
 * Drop unselected fields and raw values from one bounded cloud response.
 *
 * @param receivedAtMilliseconds Gateway receipt clock used only to coarsen the T8910 cached timestamp.
 */
export function projectReportedParameters(model: ParameterCheckModel, value: unknown, receivedAtMilliseconds = Date.now()): ParameterCheckSummary {
  if (model === "T8910" && (!Number.isFinite(receivedAtMilliseconds) || receivedAtMilliseconds < 0)) throw new ParameterCheckError("invalid_response");
  if (!record(value) || !Array.isArray(value.params) || value.params.length > 4096) throw new ParameterCheckError("invalid_response");
  const selected = profiles[model];
  const observations: Record<string, ParameterObservation> = Object.fromEntries(selected.fields.map(id => [id, "missing"]));
  const seen = new Set<number>();
  for (const row of value.params) {
    if (!record(row)) continue;
    const id = scalar(row.param_type);
    if (id === null || !Object.hasOwn(observations, id)) continue;
    if (model === "T8030" && ["channel", "dev_type"].some(key => Object.hasOwn(row, key) && scalar(row[key]) !== 255)) continue;
    if (seen.has(id)) { observations[id] = "conflicting"; continue; }
    seen.add(id);
    const raw = scalar(row.param_value);
    observations[id] = model === "T8910" ? motionTimeObservation(raw, receivedAtMilliseconds) : model === "T8030" ? (raw !== null && raw >= 1 && raw <= 26 ? "valid" : "invalid")
      : raw === 0 ? "zero" : raw === 1 ? "one" : "invalid";
  }
  return { model, profile: selected.profile, observations };
}

/**
 * Compare two selected-device parameter tables without retaining either value.
 * Only valid, non-future timestamps qualify. An unchanged or absent value over
 * this short window does not establish that the backend never updates it.
 */
export function projectDeviceListMotion(before: unknown, after: unknown, receivedAtMilliseconds = Date.now()): ParameterCheckSummary {
  const first = projectReportedParameters("T8910", before, receivedAtMilliseconds);
  const second = projectReportedParameters("T8910", after, receivedAtMilliseconds);
  const instant = (table: unknown, summary: ParameterCheckSummary): number | null => {
    if (!["recent", "older"].includes(summary.observations["1605"]!)) return null;
    const rows = (table as { params: Record<string, unknown>[] }).params;
    const raw = scalar(rows.find(row => record(row) && scalar(row.param_type) === 1605)?.param_value);
    return raw === null ? null : raw >= 946_684_800_000 ? raw : raw * 1_000;
  };
  const initial = instant(before, first), latest = instant(after, second);
  const change: MotionTimeChange = initial === null || latest === null ? "unavailable"
    : latest > initial ? "advanced" : latest < initial ? "regressed" : "unchanged";
  return { ...second, source: "device_list", change };
}

/** Validate the provider DTO again before returning it to a browser or logger. */
export function validateParameterSummary(value: unknown): ParameterCheckSummary {
  if (!record(value) || Object.keys(value).sort().join() !== (value.source === "device_list"
    ? "change,model,observations,profile,source" : "model,observations,profile")
    || typeof value.model !== "string" || !Object.hasOwn(profiles, value.model)) throw new ParameterCheckError("invalid_response");
  const model = value.model as ParameterCheckModel, selected = profiles[model];
  if (value.source === "device_list" && (model !== "T8910"
    || typeof value.change !== "string" || !["advanced", "unchanged", "regressed", "unavailable"].includes(value.change))) throw new ParameterCheckError("invalid_response");
  if (value.profile !== selected.profile || !record(value.observations)
    || Object.keys(value.observations).sort().join() !== selected.fields.map(String).sort().join()) throw new ParameterCheckError("invalid_response");
  const observations: Record<string, ParameterObservation> = {};
  for (const id of selected.fields) {
    const observation = value.observations[id];
    const allowed = model === "T8910" ? ["missing", "unset", "recent", "older", "future", "invalid", "conflicting"] : model === "T8030" ? ["missing", "valid", "invalid", "conflicting"] : ["missing", "zero", "one", "invalid", "conflicting"];
    if (typeof observation !== "string" || !allowed.includes(observation)) throw new ParameterCheckError("invalid_response");
    observations[id] = observation as ParameterObservation;
  }
  return { model, profile: selected.profile, observations,
    ...(value.source === "device_list" ? { source: "device_list" as const, change: value.change as MotionTimeChange } : {}) };
}

/** Format only fixed metadata, masking binary candidates so logs cannot disclose privacy state. */
export function parameterCheckLog(value: unknown): string {
  const result = validateParameterSummary(value);
  return `model=${result.model} outcome=read${result.source ? ` source=${result.source} change=${result.change}` : ""} ${Object.entries(result.observations).map(([id, shape]) => `${id}=${shape === "zero" || shape === "one" ? "valid" : shape}`).join(" ")}`;
}
