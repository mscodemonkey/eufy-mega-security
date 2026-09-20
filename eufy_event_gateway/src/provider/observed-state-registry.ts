/**
 * Reconciles field-level device observations from cloud inventory, push, and
 * PPCS reads. The provider owns the registry lifecycle and supplies its
 * output to gateway state without persisting private upstream payloads.
 */

/** Observation source ordering used when timestamps are equal. */
export type ObservationSource = "inventory" | "push" | "ppcs";

/** One source-tagged value retained for a device field. */
export interface ObservedValue<T> {
  readonly value: T;
  readonly source: ObservationSource;
  readonly observedAt: number;
}

const SOURCE_PRIORITY: Record<ObservationSource, number> = {
  inventory: 1,
  push: 2,
  ppcs: 3,
};

/**
 * Keep the freshest non-missing value for each device field.
 *
 * `undefined` is treated as absent, never as a value that clears a newer
 * observation. Equal timestamps use the more authoritative source.
 */
export class ObservedStateRegistry<TField extends string> {
  readonly #values = new Map<string, Map<TField, ObservedValue<unknown>>>();

  /** Record one observation unless an equal or newer value already won. */
  set<T>(
    serial: string,
    field: TField,
    value: T | undefined,
    source: ObservationSource,
    observedAt: number,
  ): void {
    if (value === undefined) return;
    const fields = this.#values.get(serial) ?? new Map<TField, ObservedValue<unknown>>();
    const existing = fields.get(field);
    if (existing && (existing.observedAt > observedAt ||
      existing.observedAt === observedAt && SOURCE_PRIORITY[existing.source] >= SOURCE_PRIORITY[source])) return;
    fields.set(field, { value, source, observedAt });
    this.#values.set(serial, fields);
  }

  /** Return a source-tagged value, or `undefined` when no observation exists. */
  get<T>(serial: string, field: TField): ObservedValue<T> | undefined {
    return this.#values.get(serial)?.get(field) as ObservedValue<T> | undefined;
  }

  /** Return the current plain values for a device without inventing unknowns. */
  snapshot(serial: string): Partial<Record<TField, unknown>> {
    return Object.fromEntries(
      [...(this.#values.get(serial) ?? [])].map(([field, observation]) => [field, observation.value]),
    ) as Partial<Record<TField, unknown>>;
  }
}
