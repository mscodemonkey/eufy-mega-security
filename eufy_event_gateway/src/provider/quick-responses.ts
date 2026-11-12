/**
 * Defines the opt-in attached-doorbell saved-reply contract. The provider owns
 * authenticated device bindings and sessions; HTTP and HA consume only reply
 * IDs and labels. Recording URLs, file paths and audio never cross this boundary.
 */
import type { ModelControlRoute } from "./model-control-trials.js";

/** Fixed failure categories for list discovery, containing no saved reply or account data. */
export type QuickResponseListFailure = "protection_unavailable" | "response_timeout" | "session_closed" | "invalid_list";

/**
 * Carries one list-read boundary from the owned session to the provider log.
 * The session owns cleanup. This error authorizes neither playback nor a retry,
 * and never retains underlying errors, private response values or audio paths.
 */
export class QuickResponseListError extends Error {
  constructor(readonly reason: QuickResponseListFailure) {
    super(`Saved reply list unavailable: ${reason}`);
  }
}

/** One currently selectable reply, with no claim of speaker playback state. */
export interface DoorbellQuickResponse {
  readonly id: number;
  readonly name: string;
  readonly custom: boolean;
}

/** Admit only the two reviewed doorbell handlers through HomeBase 3. */
export function isQuickResponseRoute(route: ModelControlRoute): boolean {
  return ((route.model === "T8210" && route.deviceType === 7)
    || (route.model === "T8214" && route.deviceType === 94))
    && route.homeBaseAttached && !route.selfPeer && route.peerModel === "T8030"
    && route.peerDeviceType === 18 && Number.isInteger(route.channel)
    && route.channel !== null && route.channel >= 0 && route.channel <= 254;
}

/** Reject implicit conversion and IDs outside the app's preset/custom slots. */
export function validQuickResponseId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && [1, 2, 3, 100, 101, 102].includes(value);
}

/** Parse a complete custom list; malformed replies fail rather than hiding saved audio. */
export function parseQuickResponseList(payload: Record<string, unknown>): readonly DoorbellQuickResponse[] {
  if (!Array.isArray(payload.voice_list) || payload.voice_list.length > 3) throw new QuickResponseListError("invalid_list");
  const result: DoorbellQuickResponse[] = [
    { id: 1, name: "Excuse me, can I help you", custom: false },
    { id: 2, name: "Please leave it at the door", custom: false },
    { id: 3, name: "We will be right there", custom: false },
  ];
  for (const value of payload.voice_list) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new QuickResponseListError("invalid_list");
    const row = value as Record<string, unknown>;
    if (!validQuickResponseId(row.voice_id) || row.voice_id < 100 || result.some(item => item.id === row.voice_id)
      || typeof row.voice_name !== "string" || !row.voice_name.trim() || row.voice_name.length > 80
      || /[\u0000-\u001f\u007f]/u.test(row.voice_name)) throw new QuickResponseListError("invalid_list");
    result.push({ id: row.voice_id, name: row.voice_name, custom: true });
  }
  return result;
}
