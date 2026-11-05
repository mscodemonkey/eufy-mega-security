/**
 * Consumes cloud motion timestamps without replaying cached sensor activity.
 * The provider owns identity matching and one clock per binding. Each clock
 * owns its monotonic baseline and bounded quarantine until that binding ends.
 */

/** Whether a fresh cloud advance should publish motion or only confirm a recent push. */
export type InventoryMotionOutcome = "none" | "push-confirmed" | "cloud-motion";

/** Evaluate one advance against an explicit receipt clock, without retaining state. */
export function inventoryMotionOutcome(previous: number | undefined, current: number | undefined,
  pushPending: boolean, receivedAtMilliseconds = Date.now()): InventoryMotionOutcome {
  if (current === undefined || !Number.isFinite(current) || !Number.isFinite(receivedAtMilliseconds)
    || receivedAtMilliseconds < 0) return "none";
  const milliseconds = Math.round(current * 1_000), age = receivedAtMilliseconds - milliseconds;
  if (!Number.isSafeInteger(milliseconds) || age < -2_000 || age > 60_000) return "none";
  if (previous === undefined) return pushPending ? "push-confirmed" : "none";
  if (!Number.isFinite(previous) || milliseconds <= Math.round(previous * 1_000)) return "none";
  return pushPending ? "push-confirmed" : "cloud-motion";
}

/**
 * Owns the baseline for one sensor binding. Missing, repeated and rolled-back
 * values never move it backward. Future readings are quarantined so they cannot
 * become new events when wall time catches up. Reset by replacing this instance.
 */
export class InventoryMotionClock {
  #baseline: number | undefined;
  readonly #future = new Set<number>();
  #overflow = false;

  constructor(initialSeconds?: number, receivedAtMilliseconds = Date.now()) {
    this.observe(initialSeconds, false, receivedAtMilliseconds);
  }

  /** The last consumed non-future instant, including stale advances, in epoch seconds. */
  get baselineSeconds(): number | undefined {
    return this.#baseline === undefined ? undefined : this.#baseline / 1_000;
  }

  /** Consume one reading, publishing only a fresh advance after the initial baseline. */
  observe(seconds: number | undefined, pushPending: boolean, receivedAtMilliseconds = Date.now()): InventoryMotionOutcome {
    if (seconds === undefined || !Number.isFinite(seconds) || !Number.isFinite(receivedAtMilliseconds)
      || receivedAtMilliseconds < 0) return "none";
    const milliseconds = Math.round(seconds * 1_000);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 946_684_800_000 || this.#overflow) return "none";
    for (const timestamp of this.#future) if (timestamp < receivedAtMilliseconds - 60_000) this.#future.delete(timestamp);
    if (this.#future.has(milliseconds)) return "none";
    if (milliseconds > receivedAtMilliseconds + 2_000) {
      if (this.#future.size >= 32) this.#overflow = true;
      else this.#future.add(milliseconds);
      return "none";
    }
    const previous = this.#baseline;
    if (previous === undefined) { this.#baseline = milliseconds; return "none"; }
    if (milliseconds <= previous) return "none";
    this.#baseline = milliseconds;
    return inventoryMotionOutcome(previous / 1_000, milliseconds / 1_000, pushPending, receivedAtMilliseconds);
  }
}
