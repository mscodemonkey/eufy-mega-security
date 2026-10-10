/**
 * Defines the exact standalone C31 preference contract shared by HTTP and PPCS.
 * The provider owns route admission and fresh readback. This module owns only
 * reviewed command IDs, numeric validation and normalized inventory selection.
 */

/** Native C31 preference names accepted at the authenticated control boundary. */
export const c31PreferenceNames = ["microphone", "speaker", "speakerVolume", "imageFlipped", "watermark", "preRecording", "soundDetection"] as const;

/** A reviewed native preference, independent of support on any particular route. */
export type C31Preference = typeof c31PreferenceNames[number];

/** Reject unknown names and out-of-range values before a camera session is opened. */
export function validateC31Preference(name: unknown, value: unknown): C31Preference {
  if (typeof name !== "string" || !c31PreferenceNames.includes(name as C31Preference)) throw new SyntaxError("Unknown camera preference");
  const maximum = name === "speakerVolume" ? 100 : name === "watermark" ? 2 : 1;
  if (typeof value !== "number" || !Number.isInteger(value) || value < (name === "speakerVolume" ? 1 : 0) || value > maximum) throw new SyntaxError("Invalid camera preference value");
  return name as C31Preference;
}

/** Map a reviewed preference to the single inventory field invalidated after a write. */
export function c31PreferenceReadField(name: C31Preference) {
  const fields = { microphone: "microphoneEnabled", speaker: "speakerEnabled", speakerVolume: "speakerVolume", imageFlipped: "imageFlipped", watermark: "watermarkMode", preRecording: "preRecordingEnabled", soundDetection: "soundDetectionEnabled" } as const;
  return fields[name];
}

/** Select a validated reported baseline, leaving missing or malformed values unknown. */
export function c31PreferenceValue(reads: object, name: C31Preference): number | undefined {
  const value: unknown = (reads as Record<string, unknown>)[c31PreferenceReadField(name)];
  if (typeof value === "boolean" && !["speakerVolume", "watermark"].includes(name)) return value ? 1 : 0;
  try { validateC31Preference(name, value); return value as number; } catch { return undefined; }
}
