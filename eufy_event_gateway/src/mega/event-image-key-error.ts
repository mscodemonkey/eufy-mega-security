/**
 * Carries content-free picture-key refusal reasons from the account client to
 * provider diagnostics. Each failed lookup owns one error. No key, selector,
 * owner identity or server response belongs in this boundary.
 */

/** Distinguishes local admission from unavailable account metadata without exposing its contents. */
export type EventImageKeyReason = "unauthenticated" | "invalid_selector" | "owner_missing" |
  "owner_mismatch" | "key_list_missing" | "key_list_invalid" | "key_missing" |
  "key_ambiguous" | "key_material_unavailable";

/**
 * Reports one refused picture-key lookup while retaining the established error
 * message for callers. The provider may publish only the fixed reason, never
 * the account data that caused it. This error owns no key bytes or retry state.
 */
export class EventImageKeyUnavailableError extends Error {

  /** Construct an allowlisted diagnostic, with no underlying response or cause. */
  constructor(readonly reason: EventImageKeyReason) {
    super("Event picture key unavailable");
  }
}
