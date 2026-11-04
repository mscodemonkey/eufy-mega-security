/**
 * Carries a qualified PPCS frame clock beside unchanged live-video bytes.
 * The first-party session owns each epoch. Weak references retain no media or
 * session after downstream stream consumers release their original buffers.
 */

/** A clock admitted only by the exact S340/type 88, HB3/channel 1 media route. */
export interface QualifiedLiveFrameClock {

  /** Unsigned millisecond word from the qualified camera's complete access-unit header. */
  readonly timestampMilliseconds: number;

  /** Opaque owning-session identity, preventing queued data from spanning source replacements. */
  readonly epoch: symbol;

  /** The owning session observed a keyframe with a different positive frame size. */
  readonly encoderFormatChanged?: boolean;
}

const sources = new WeakSet<object>();
const clocks = new WeakMap<Buffer, QualifiedLiveFrameClock>();

/**
 * Associate a complete normalized unit with its session-owned source clock.
 *
 * @param encoderFormatChanged True only when the owning PPCS session observes
 * a keyframe whose positive dimensions differ from the preceding frame.
 */
export function markS340LiveFrameClock(data: Buffer, timestampMilliseconds: number, epoch: symbol, encoderFormatChanged = false): void {
  if (!Number.isInteger(timestampMilliseconds) || timestampMilliseconds < 0 || timestampMilliseconds > 0xffff_ffff) {
    throw new Error("Invalid qualified live frame clock");
  }
  clocks.set(data, Object.freeze({ timestampMilliseconds, epoch, ...(encoderFormatChanged ? { encoderFormatChanged: true } : {}) }));
}

/** Read qualified timing without changing bytes or inferring clocks for other sources. */
export function qualifiedLiveFrameClock(data: Buffer): QualifiedLiveFrameClock | undefined {
  return clocks.get(data);
}

/** Admit only a source whose owning PPCS session has produced qualified H.264. */
export function markS340LiveSource(source: object): void {
  sources.add(source);
}

/** Check source ownership before an experimental viewer buffers bootstrap bytes. */
export function qualifiedS340LiveSource(source: object | null | undefined): boolean {
  return source !== null && source !== undefined && sources.has(source);
}
