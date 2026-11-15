/**
 * Retains an owned camera source for a manual light that needs live video.
 * The HTTP server owns this controller. The media manager owns source startup,
 * sharing and maximum lifetime, while the provider owns each confirmed write.
 */

/** Hold a shared decoded source until cancellation or its own retirement. */
export type HoldManualLightSource = (serial: string, signal: AbortSignal, ready: () => void) => Promise<void>;

interface LightHold {
  readonly controller: AbortController;
  readonly ready: Promise<void>;
  done: Promise<void>;
  ended: boolean;
  retained: boolean;
}

/**
 * Serializes each camera's light requests and owns only its media lease.
 * A confirmed on retains that lease until off, source retirement or shutdown.
 * Releasing it never closes another viewer or extends the source's time limit.
 */
export class ManualLightSource {
  readonly #holds = new Map<string, LightHold>();
  readonly #operations = new Map<string, Promise<unknown>>();
  #closed = false;

  /** The caller invalidates retained light state when its source expires. */
  constructor(private readonly hold: HoldManualLightSource, private readonly expired: (serial: string) => void) {}

  /** Wake once, submit one absolute operation and retain only a confirmed on. */
  run<T>(serial: string, enabled: boolean, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.#operations.get(serial) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      if (this.#closed || signal?.aborted) throw new Error("Manual light source closed or cancelled");
      const existing = this.#holds.get(serial);
      const source = existing ?? this.#create(serial);
      let submitted = false;
      const cancel = (): void => { if (!existing && !submitted) source.controller.abort(); };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        await source.ready;
        if (source.ended || this.#closed || signal?.aborted) throw new Error("Manual light source retired or cancelled");
        submitted = true;
        signal?.removeEventListener("abort", cancel);
        const result = await operation();
        if (source.ended || this.#closed) throw new Error("Manual light source retired during the command");
        source.retained = enabled;
        if (!enabled) await this.#release(source);
        return result;
      } catch (error) {
        if (!existing || submitted) {
          source.retained = false;
          await this.#release(source);
        }
        throw error;
      } finally { signal?.removeEventListener("abort", cancel); }
    });
    this.#operations.set(serial, current);
    void current.finally(() => {
      if (this.#operations.get(serial) === current) this.#operations.delete(serial);
    }).catch(() => undefined);
    return current;
  }

  /** Release owned leases and prevent queued requests from starting new media. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#holds.values()].map(source => this.#release(source)));
  }

  #create(serial: string): LightHold {
    let resolve!: () => void, reject!: (error: Error) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const source: LightHold = { controller: new AbortController(), ready, done: Promise.resolve(), ended: false, retained: false };
    this.#holds.set(serial, source);
    const retire = (error?: unknown): void => {
      source.ended = true;
      reject(error instanceof Error ? error : new Error("Manual light source retired before readiness"));
      if (this.#holds.get(serial) === source) this.#holds.delete(serial);
      if (source.retained) this.expired(serial);
    };
    source.done = Promise.resolve().then(() => this.hold(serial, source.controller.signal, resolve)).then(() => retire(), retire);
    void source.done.catch(() => undefined);
    return source;
  }

  async #release(source: LightHold): Promise<void> {
    source.controller.abort();
    await source.done;
  }
}
