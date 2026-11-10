/**
 * Defines content-free failures for camera-owned setting reads.
 * PPCS sessions own response observations. Trial runners and provider logging
 * consume only these fixed reasons, never transport errors or response values.
 */

/** Distinguish an absent reply, unusable reply and absent required setting. */
export type CameraInfoFailureReason =
  | "no_reply" | "not_decoded" | "invalid_json" | "invalid_schema"
  | "setting_missing" | "unavailable"
  | "protection_mismatch" | "authentication_failed";

const reasons = new Set<string>([
  "no_reply", "not_decoded", "invalid_json", "invalid_schema", "setting_missing", "unavailable", "protection_mismatch", "authentication_failed",
]);

/**
 * Carries one failed read across the session/trial boundary without private data.
 * The read owner creates it after retiring that read. It grants no retry or write
 * authority, and diagnostic consumers must still validate its reason.
 */
export class CameraInfoReadError extends Error {

  /** Fixed failure category, independent of an underlying exception's message. */
  readonly reason: CameraInfoFailureReason;

  /** Construct only fixed text, including when called with an invalid runtime value. */
  constructor(reason: CameraInfoFailureReason) {
    const safe = reasons.has(reason) ? reason : "unavailable";
    super(safe === "setting_missing"
      ? "Trial requires a fresh reported original setting (reason=setting_missing)"
      : `Camera-info read failed: reason=${safe}`);
    this.name = "CameraInfoReadError";
    this.reason = safe;
  }
}

/** Recheck the closed vocabulary before a failure crosses a public log boundary. */
export function cameraInfoFailureReason(error: unknown): CameraInfoFailureReason {
  return error instanceof CameraInfoReadError && reasons.has(error.reason) ? error.reason : "unavailable";
}

/** Classify only observations made since the current query was submitted. */
export function cameraInfoTimeoutReason(
  received: boolean, decoded: boolean, parseStage: string,
): CameraInfoFailureReason {
  if (!received) return "no_reply";
  if (!decoded) return "not_decoded";
  if (parseStage === "invalid_json" || parseStage === "invalid_schema") return parseStage;
  return "unavailable";
}
