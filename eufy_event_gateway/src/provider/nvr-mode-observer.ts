/**
 * Keeps one opt-in read-only NVR connection alive without owning household state.
 * The provider supplies a verified target and fresh credentials for each attempt.
 * This owner serializes replacement and cleanup, bounds reconnect frequency and
 * retires its timers and invalidates callbacks before provider shutdown completes.
 */
import { NvrTrialError } from "../stream/nvr-protocol.js";
import type { NvrRtcSession } from "../stream/nvr-rtc-session.js";
import type { NvrEffectiveModeObservation } from "../stream/nvr-effective-mode.js";

/** Private target identity and factories must never be included in observer logs. */
export interface NvrModeObserverTarget {
  readonly key: string;
  readonly current: () => boolean;

  /** Construct an unstarted read-only session. Cancellation must also retire credential work. */
  readonly create: (signal: AbortSignal, current: () => boolean,
    report: (observation: NvrEffectiveModeObservation | null) => void) => Promise<NvrRtcSession>;

  /** Publish only source-owned observations. Retirement may clear its own reading after admission expires. */
  readonly report: (source: NvrRtcSession, observation: NvrEffectiveModeObservation | null) => void;
}

/** Public lifecycle labels contain no credentials, target identities or household modes. */
export type NvrModeObserverState = "idle" | "connecting" | "listening" | "retrying" | "blocked";

interface Attempt {
  readonly target: NvrModeObserverTarget;
  readonly controller: AbortController;
  flight: Promise<void>;
  session: NvrRtcSession | null;
  retiring: boolean;
  listeningAt: number | null;
  error: unknown;
}

/**
 * Owns at most one connection, credential flight and reconnect timer.
 * Stable target updates preserve the existing attempt and backoff. Loss clears
 * the session's observation through normal session close before another attempt.
 * Authentication rejection or failed cleanup blocks automatic reconnection.
 */
export class NvrModeObserver {
  #target: NvrModeObserverTarget | null = null;
  #attempt: Attempt | null = null;
  #transition: Promise<void> = Promise.resolve();
  #retry: NodeJS.Timeout | null = null;
  #failures = 0;
  #blocked = false;
  #cleanupFailed = false;

  constructor(private readonly state: (value: NvrModeObserverState, retryMilliseconds: number | null,
    blockedReason: "authorization" | "cleanup" | null) => void,
    private readonly now: () => number = () => performance.now()) {}

  /** Include credential setup and backoff in ownership so security trials can refuse overlap. */
  get active(): boolean { return this.#target !== null; }

  /** Confirm that no session or failed cleanup remains before an inactive provider restart. */
  get settled(): boolean { return this.#attempt === null && this.#retry === null && !this.#cleanupFailed; }

  /** Replace a changed verified binding without overlapping its predecessor's cleanup. */
  setTarget(target: NvrModeObserverTarget | null): void {
    if (target?.key === this.#target?.key) {
      const existing = this.#target;
      if (existing && !this.#attempt && !this.#retry && !this.#blocked) this.#enqueue(async () => { this.#begin(existing); });
      return;
    }
    this.#target = target;
    this.#failures = 0;
    this.#blocked = false;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    const previous = this.#attempt;
    if (previous) { previous.retiring = true; previous.controller.abort(); }
    this.#enqueue(async () => {
      if (previous) await this.#retire(previous);
      if (this.#target !== target) return;
      if (target) this.#begin(target); else this.#emit("idle");
    });
  }

  /** Cancel retry and setup, then wait for this owner's session to finish closing. */
  async close(): Promise<void> {
    this.setTarget(null);
    await this.#transition;
    if (this.#cleanupFailed) throw new NvrTrialError("stop");
  }

  #emit(state: NvrModeObserverState, retry: number | null = null, reason: "authorization" | "cleanup" | null = null): void {
    try { this.state(state, retry, reason); } catch { /* Presentation cannot retain a connection. */ }
  }

  #enqueue(work: () => Promise<void>): void {
    this.#transition = this.#transition.then(work).catch(() => {
      this.#cleanupFailed = true;
      this.#emit("blocked", null, "cleanup");
    });
  }

  #begin(target: NvrModeObserverTarget): void {
    if (this.#attempt || this.#cleanupFailed || this.#blocked || this.#target !== target) return;
    if (!target.current()) { this.#emit("idle"); return; }
    const attempt: Attempt = { target, controller: new AbortController(), session: null,
      flight: Promise.resolve(), retiring: false, listeningAt: null, error: null };
    this.#attempt = attempt;
    this.#emit("connecting");
    attempt.flight = this.#run(attempt).catch(error => { attempt.error = error; this.#lost(attempt); });
  }

  async #run(attempt: Attempt): Promise<void> {
    const signal = attempt.controller.signal;
    const current = (): boolean => this.#attempt === attempt && this.#target === attempt.target
      && !attempt.retiring && !signal.aborted && attempt.target.current();
    let created: NvrRtcSession | null = null;
    const report = (value: NvrEffectiveModeObservation | null): void => {
      if (created && (value === null || current())) attempt.target.report(created, value);
    };
    const creation = attempt.target.create(signal, current, report);
    void creation.then(session => {
      if (!current()) return session.close().catch(() => { this.#cleanupFailed = true; this.#emit("blocked", null, "cleanup"); });
    }).catch(() => {});
    let abort: (() => void) | undefined;
    try {
      created = await Promise.race([creation, new Promise<never>((_, reject) => {
        abort = () => reject(new NvrTrialError("cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]);
    } finally { if (abort) signal.removeEventListener("abort", abort); }
    attempt.session = created;
    if (!current()) { this.#lost(attempt); return; }
    created.output.on("error", error => { attempt.error = error; this.#lost(attempt); });
    created.output.once("end", () => this.#lost(attempt));
    created.output.once("close", () => this.#lost(attempt));
    created.output.resume();
    await created.observeEffectiveMode();
    if (!current()) { this.#lost(attempt); return; }
    attempt.listeningAt = this.now();
    this.#emit("listening");
  }

  #lost(attempt: Attempt): void {
    if (attempt.retiring || this.#attempt !== attempt) return;
    attempt.retiring = true;
    attempt.controller.abort();
    this.#enqueue(async () => {
      await this.#retire(attempt);
      if (this.#target !== attempt.target) return;
      if (attempt.error instanceof NvrTrialError && attempt.error.stage === "region_or_authorization_rejected") {
        this.#blocked = true; this.#emit("blocked", null, "authorization"); return;
      }
      if (!attempt.target.current()) { this.#emit("idle"); return; }
      const stable = attempt.listeningAt !== null && this.now() - attempt.listeningAt >= 60_000;
      this.#failures = stable ? 1 : Math.min(this.#failures + 1, 5);
      const delay = Math.min(30_000 * 2 ** (this.#failures - 1), 300_000);
      this.#emit("retrying", delay);
      this.#retry = setTimeout(() => {
        this.#retry = null;
        this.#begin(attempt.target);
      }, delay);
      this.#retry.unref();
    });
  }

  async #retire(attempt: Attempt): Promise<void> {
    attempt.retiring = true;
    attempt.controller.abort();
    await attempt.flight;
    await attempt.session?.close();
    if (this.#attempt === attempt) this.#attempt = null;
  }
}
