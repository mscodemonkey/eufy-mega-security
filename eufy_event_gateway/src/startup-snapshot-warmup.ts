/**
 * Coordinates retained-image capture for cameras that have no saved image.
 *
 * The composition root supplies camera discovery, snapshot state, and the live
 * capture operation. This coordinator waits until provider startup is complete,
 * captures one camera at a time to avoid a burst of battery-camera sessions,
 * and retries failed cameras on later inventory refreshes with a bounded budget.
 */

type SnapshotCapture = (serial: string) => Promise<unknown>;
type SnapshotLookup = (serial: string) => boolean;
type SnapshotFailureReporter = (error: unknown) => void;

/**
 * Runs first-image capture sequentially for newly discovered cameras.
 *
 * Candidates may be added before or after `start`. A candidate is checked
 * again immediately before capture so an intervening event snapshot avoids an
 * unnecessary live session. `stop` prevents queued work from opening another
 * camera while process shutdown is in progress.
 */
export class StartupSnapshotWarmup {
  readonly #scheduled = new Set<string>();
  readonly #attempted = new Map<string, { count: number; at: number }>();
  #queue: Promise<void> = Promise.resolve();
  #started = false;
  #stopped = false;

  /** Create a coordinator around snapshot state, capture, and safe reporting. */
  constructor(
    private readonly hasSnapshot: SnapshotLookup,
    private readonly capture: SnapshotCapture,
    private readonly reportFailure: SnapshotFailureReporter,
    private readonly now: () => number = Date.now,
  ) {}

  /** Add a camera that should receive an initial retained image. */
  enqueue(serial: string): void {
    const attempted = this.#attempted.get(serial);
    if (this.#stopped || this.#scheduled.has(serial) || this.hasSnapshot(serial)
      || attempted && (attempted.count >= 3 || this.now() - attempted.at < 120_000)) return;
    this.#scheduled.add(serial);
    if (this.#started) this.#append(serial);
  }

  /** Allow queued cameras to begin capturing after provider startup. */
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    for (const serial of this.#scheduled) this.#append(serial);
  }

  /** Prevent queued cameras from starting another live capture. */
  stop(): void {
    this.#stopped = true;
    this.#scheduled.clear();
  }

  /** Resolve after all work currently queued has completed. */
  async waitUntilIdle(): Promise<void> {
    await this.#queue;
  }

  #append(serial: string): void {
    this.#queue = this.#queue.then(async () => {
      try {
        if (this.#stopped || this.hasSnapshot(serial)) return;
        this.#attempted.set(serial, { count: (this.#attempted.get(serial)?.count ?? 0) + 1, at: this.now() });
        try {
          await this.capture(serial);
        } catch (error) {
          this.reportFailure(error);
        }
      } finally {
        this.#scheduled.delete(serial);
      }
    });
  }
}
