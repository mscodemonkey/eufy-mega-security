/**
 * Projects the manual cloud parameter read into a closed diagnostic vocabulary.
 * This module owns no device state or network work. MegaClient and the HTTP
 * boundary consume its projections without enabling any normal controls.
 */

/** Fixed failures that may cross the diagnostic HTTP boundary without private data. */
export const parameterCheckStages = ["disabled", "unauthorized", "invalid_request", "unsupported", "owner_account_required", "busy", "inventory", "binding_changed", "request", "invalid_response", "timeout", "cancelled", "shutdown"] as const;

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
export type ParameterCheckModel = "T8410" | "T8417" | "T8030";

/** Value shape only. Zero and one are cached candidates, never physical-state claims. */
export type ParameterObservation = "missing" | "zero" | "one" | "valid" | "invalid" | "conflicting";

/** Identifier-free result owned by one manual read, never merged into gateway state. */
export interface ParameterCheckSummary {
  readonly model: ParameterCheckModel;
  readonly profile: "power_candidates" | "privacy_candidates" | "alarm_volume_candidate";
  readonly observations: Readonly<Record<string, ParameterObservation>>;
}

const profiles = {
  T8410: { profile: "power_candidates", fields: [1035, 2001] },
  T8417: { profile: "privacy_candidates", fields: [1035, 2001, 6250, 6271] },
  T8030: { profile: "alarm_volume_candidate", fields: [1235] },
} as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalar(value: unknown): number | null {
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Drop all unselected fields, timestamps and raw values from a bounded cloud response. */
export function projectReportedParameters(model: ParameterCheckModel, value: unknown): ParameterCheckSummary {
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
    observations[id] = model === "T8030" ? (raw !== null && raw >= 1 && raw <= 26 ? "valid" : "invalid")
      : raw === 0 ? "zero" : raw === 1 ? "one" : "invalid";
  }
  return { model, profile: selected.profile, observations };
}

/** Validate the provider DTO again before returning it to a browser or logger. */
export function validateParameterSummary(value: unknown): ParameterCheckSummary {
  if (!record(value) || Object.keys(value).sort().join() !== "model,observations,profile"
    || typeof value.model !== "string" || !Object.hasOwn(profiles, value.model)) throw new ParameterCheckError("invalid_response");
  const model = value.model as ParameterCheckModel, selected = profiles[model];
  if (value.profile !== selected.profile || !record(value.observations)
    || Object.keys(value.observations).sort().join() !== selected.fields.map(String).sort().join()) throw new ParameterCheckError("invalid_response");
  const observations: Record<string, ParameterObservation> = {};
  for (const id of selected.fields) {
    const observation = value.observations[id];
    const allowed = model === "T8030" ? ["missing", "valid", "invalid", "conflicting"] : ["missing", "zero", "one", "invalid", "conflicting"];
    if (typeof observation !== "string" || !allowed.includes(observation)) throw new ParameterCheckError("invalid_response");
    observations[id] = observation as ParameterObservation;
  }
  return { model, profile: selected.profile, observations };
}

/** Format only fixed metadata, masking binary candidates so logs cannot disclose privacy state. */
export function parameterCheckLog(value: unknown): string {
  const result = validateParameterSummary(value);
  return `model=${result.model} outcome=read ${Object.entries(result.observations).map(([id, shape]) => `${id}=${shape === "zero" || shape === "one" ? "valid" : shape}`).join(" ")}`;
}
