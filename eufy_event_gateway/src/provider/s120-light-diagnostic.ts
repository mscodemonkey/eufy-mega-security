/**
 * Carries fixed manual-light failure metadata from the provider to HTTP
 * logging. The trial owns device effects and cleanup. These observations never
 * establish illumination, reported switch state or permission to retry a write.
 */
import { controlReceiptSummary, type PpcsControlReceiptEvidence } from "../stream/ppcs-reply-evidence.js";

const stages = ["admission", "busy", "initial_inventory", "session_key", "session_connect",
  "session_inventory", "write_prepare", "write_receipt", "cleanup"] as const;

const busyReasons = ["local_motion", "trial", "recording", "station", "stream", "stream_start", "control"] as const;

/** Existing owner preventing another manual-light operation, never permission to evict it. */
export type ManualLightBusyReason = typeof busyReasons[number];

/** Last attempted boundary of one retired manual-light trial. */
export type S120LightFailureStage = typeof stages[number];

/**
 * One failed trial's structural observations, with no underlying error or keys.
 * The provider creates this only after the relevant boundary has been attempted.
 * HTTP keeps the existing unknown-state response and logs only the closed fields.
 */
export class S120LightTrialError extends Error {

  /**
   * @param writeAttempted The send boundary was reached, without proving bytes reached the camera.
   * @param acknowledgementReceived The model's command receipt was accepted, without proving illumination.
   * @param receipt Snapshot of the existing selected command wait, retained after cleanup.
   */
  constructor(readonly stage: S120LightFailureStage, readonly writeAttempted: boolean,
    readonly acknowledgementReceived: boolean, readonly cleanupFailed = false,
    readonly receipt?: PpcsControlReceiptEvidence, readonly busyReason?: ManualLightBusyReason) {
    super("Manual light test did not confirm the light state. Check the light and restore it before trying again.");
  }
}

/** Project only fixed stages and booleans, including for malformed provider errors. */
export function s120LightFailureDiagnostic(error: unknown): string {
  const known = error instanceof S120LightTrialError && stages.some(value => value === error.stage);
  const flag = (value: unknown): string => value === true ? "true" : value === false ? "false" : "unknown";
  return `stage=${known ? error.stage : "unknown"} write_attempted=${flag(known ? error.writeAttempted : null)}`
    + ` acknowledgement_received=${flag(known ? error.acknowledgementReceived : null)}`
    + ` cleanup_failed=${flag(known ? error.cleanupFailed : null)}`
    + controlReceiptSummary(known ? error.receipt : undefined)
    + (known && error.stage === "busy" && busyReasons.includes(error.busyReason as ManualLightBusyReason)
      ? ` busy_reason=${error.busyReason}` : "");
}
