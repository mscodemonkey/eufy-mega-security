/**
 * Records content-free viewer milestones on one monotonic clock.
 * LiveStreamManager owns one timeline per source attempt and supplies byte and
 * random-access observations. Logging consumes relative times only. These
 * observations cannot establish decoding or a displayed Home Assistant picture.
 */

/** Times relative to one HTTP request. Warm milestones are zero with explicit warm flags. */
export interface ViewerStartupMilestones {
  readonly sourceFirstByteMilliseconds: number | null;
  readonly sourceRandomAccessMilliseconds: number | null;
  readonly conversionStartMilliseconds: number | null;
  readonly conversionFirstOutputMilliseconds: number | null;
  readonly viewerRandomAccessMilliseconds: number | null;
  readonly conversionAttempt: number;
  readonly warmSource: boolean;
  readonly warmViewer: boolean;
}

/** Owns one source attempt's milestones and replaces conversion milestones on each retry. */
export class ViewerStartupTimeline {
  #sourceByte: number | null = null;
  #sourceReady: number | null = null;
  #conversionStart: number | null = null;
  #conversionOutput: number | null = null;
  #conversionReady: number | null = null;
  #conversionAttempt = 0;

  /** Keep viewer timing separate from the manager's injected recovery/lease clock. */
  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Observe nonempty source bytes, without claiming that they contain a playable picture. */
  sourceByte(): void { this.#sourceByte ??= this.now(); }

  /** Observe a source header set and retained random-access group. */
  sourceRandomAccess(): void { this.#sourceReady ??= this.now(); }

  /** Begin a new conversion attempt without carrying its predecessor's output milestones. */
  conversionStarted(): void {
    this.#conversionAttempt++;
    this.#conversionStart = this.now();
    this.#conversionOutput = null;
    this.#conversionReady = null;
  }

  /** Observe nonempty converter output, which may contain headers only. */
  conversionOutput(): void { this.#conversionOutput ??= this.now(); }

  /** Observe converted headers and a retained random-access group, separately from first output. */
  conversionRandomAccess(): void { this.#conversionReady ??= this.now(); }

  /** Project only relative timings from this attempt. No source identities or media enter the result. */
  snapshot(requestedAt: number, converted: boolean): ViewerStartupMilestones {
    const relative = (at: number | null): number | null => at === null ? null : Math.round(Math.max(0, at - requestedAt));
    const viewer = converted ? this.#conversionReady : this.#sourceReady;
    return {
      sourceFirstByteMilliseconds: relative(this.#sourceByte),
      sourceRandomAccessMilliseconds: relative(this.#sourceReady),
      conversionStartMilliseconds: converted ? relative(this.#conversionStart) : null,
      conversionFirstOutputMilliseconds: converted ? relative(this.#conversionOutput) : null,
      viewerRandomAccessMilliseconds: relative(viewer),
      conversionAttempt: converted ? this.#conversionAttempt : 0,
      warmSource: this.#sourceReady !== null && this.#sourceReady < requestedAt,
      warmViewer: viewer !== null && viewer < requestedAt,
    };
  }
}
