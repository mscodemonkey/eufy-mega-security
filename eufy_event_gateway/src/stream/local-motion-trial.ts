/**
 * Counts fresh local motion candidates for a single consented passive session.
 * The provider owns identity, transport and cleanup. This collector owns only
 * per-watch timestamp deduplication and never publishes Home Assistant events.
 */
import type { SensorMotionObservation } from "./sensor-status-notification.js";

/** Public failure vocabulary, excluding underlying transport or account details. */
export type LocalMotionStage = "admission" | "busy" | "cancelled" | "timeout" | "session";

/** A fixed diagnostic failure whose text is safe for the local API and logs. */
export class LocalMotionError extends Error {
  constructor(readonly stage: LocalMotionStage) { super(`Local motion test failed: ${stage}`); }
}

/** Counts only, with no device identities or source timestamps. */
export interface LocalMotionSummary {
  readonly outcome: "observed" | "inconclusive";
  readonly candidates: number;
}

/**
 * Deduplicate one selected channel after session readiness. Closing invalidates
 * future callbacks, while the provider must discard results after failed checks.
 */
export class LocalMotionCollector {
  #latest = 0;
  #count = 0;
  #closed = false;

  constructor(private readonly channel: number, private readonly startedAt: number) {}

  /** Ignore stale, future, repeated, foreign-channel and pre-watch observations. */
  observe(observation: SensorMotionObservation, receivedAt: number): void {
    const timestamp = observation.triggeredAt;
    if (this.#closed || observation.channel !== this.channel || !Number.isSafeInteger(timestamp)
      || !Number.isSafeInteger(receivedAt) || timestamp <= this.startedAt || timestamp <= this.#latest
      || receivedAt - timestamp > 60_000 || timestamp - receivedAt > 2_000) return;
    this.#latest = timestamp;
    this.#count = Math.min(16, this.#count + 1);
  }

  /** Stop counting and return the closed public projection. */
  finish(): LocalMotionSummary {
    this.#closed = true;
    return { outcome: this.#count ? "observed" : "inconclusive", candidates: this.#count };
  }
}
