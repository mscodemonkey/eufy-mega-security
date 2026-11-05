/**
 * Classifies repeated Eufy push deliveries without storing private payloads.
 *
 * The provider owns one instance for its connection lifetime. It suppresses
 * repeated entity pulses while still accepting a thumbnail that arrives on a
 * later delivery of the same event.
 */

/** Describes which effects remain useful for one observed push delivery. */
export interface PushDeliveryDecision {
  readonly handleState: boolean;
  readonly retainPicture: boolean;
}

/**
 * Remembers recent event identities and whether their thumbnail was observed.
 *
 * Entries expire after the configured window so the cache stays bounded by
 * recent push traffic. Messages without an event identity cannot be safely
 * deduplicated and retain their original behavior.
 */
export class PushEventDeduplicator {
  readonly #recent = new Map<string, { readonly observedAt: number; readonly pictureSeen: boolean }>();

  /** Create a cache whose entries expire after `windowMilliseconds`. */
  constructor(private readonly windowMilliseconds = 60_000) {}

  /** Classify state and picture work for one normalized push delivery. */
  observe(cameraSerial: string, eventId: string | null, eventType: number | null, hasPicture: boolean, now = Date.now()): PushDeliveryDecision {
    if (!eventId) return { handleState: true, retainPicture: hasPicture };
    for (const [key, observation] of this.#recent) {
      if (now - observation.observedAt > this.windowMilliseconds) this.#recent.delete(key);
    }
    const key = `${cameraSerial}:${eventId}:${eventType}`;
    const previous = this.#recent.get(key);
    this.#recent.set(key, { observedAt: now, pictureSeen: hasPicture || previous?.pictureSeen === true });
    return {
      handleState: previous === undefined,
      retainPicture: hasPicture && previous?.pictureSeen !== true,
    };
  }
}
