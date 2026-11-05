/**
 * Interprets reporter-qualified NVR effective-mode broadcasts without sending commands.
 * The RTC session owns authenticated transport, ordering and connection lifetime.
 * The provider consumes these observations and clears their state on session loss.
 */
import type { NvrApplicationFrame } from "./nvr-protocol.js";

/** Concrete modes already understood by the NVR state boundary. Policies remain unknown. */
export type NvrEffectiveMode = 0 | 1 | 3 | 4 | 5 | 63;

/** A recognized fresh broadcast with an unknown value invalidates the previous mode. */
export interface NvrEffectiveModeObservation {
  readonly mode: NvrEffectiveMode | null;
}

/**
 * Accept only station-wide unsolicited broadcasts on the observed notify channel.
 * Query errors, including the 132-byte -106 reply, cannot establish or erase state.
 * Schedule, Geofencing and unrecognized values are not concrete effective modes.
 */
export function nvrEffectiveModeBroadcast(frame: NvrApplicationFrame, transportChannel: number): NvrEffectiveModeObservation | null {
  if (frame.command !== 1151 || transportChannel !== 2 || frame.channel !== 255
    || frame.segment !== 0 || frame.stream !== 0 || frame.payload.length !== 8
    || frame.payload.readInt32LE(4) !== 0) return null;
  const value = frame.payload.readInt32LE(0);
  return { mode: [0, 1, 3, 4, 5, 63].includes(value) ? value as NvrEffectiveMode : null };
}
