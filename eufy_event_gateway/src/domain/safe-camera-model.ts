/**
 * Validates model labels before diagnostic boundaries expose inventory text.
 * It owns no state; HTTP summaries and private event captures share this rule.
 */

/** Return a model-shaped label, replacing arbitrary inventory text with unknown. */
export function safeCameraModel(value: string): string {
  return /^T[0-9A-Z-]{3,12}$/.test(value) ? value : "unknown";
}
