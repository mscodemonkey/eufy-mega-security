/**
 * Bounds one confirmed camera operation, including its queue and readback waits.
 * The provider owns device admission, writes and reservations. This scope owns
 * cancellation and closes registered resources before releasing timed-out work.
 */

/** Distinguish a provably unsent operation from a write needing independent readback. */
export class CameraControlDeadlineError extends Error {
  readonly code: "not_started" | "outcome_unknown";

  /** Use fixed messages so protocol errors and private identities cannot escape. */
  constructor(dispatched: boolean) {
    super(dispatched
      ? "Motion control outcome is unknown. Check the camera state before retrying."
      : "Motion control did not start. No change was sent.");
    this.code = dispatched ? "outcome_unknown" : "not_started";
  }
}

/** Provider-facing operation effects; every phase must use the same scope. */
export interface CameraControlScope {
  readonly signal: AbortSignal;

  /** Invoke a phase only while live, and stop awaiting it when this scope retires. */
  wait<T>(operation: () => Promise<T>): Promise<T>;

  /** Register synchronous retirement of an owned resource and return its deregistration. */
  onAbort(cleanup: () => void): () => void;

  /** Mark the first setting datagram so expiry cannot be reported as a known no-op. */
  dispatched(): void;
}

/** Internal timer injection for deterministic tests, never a gateway configuration option. */
export interface CameraControlTiming {
  readonly milliseconds: number;
  schedule(callback: () => void, milliseconds: number): () => void;
}

const timing: CameraControlTiming = {
  milliseconds: 90_000,
  schedule: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/**
 * Run one operation with a total 90-second budget, including queue waiting.
 * Read-only losing work may settle later, but cannot resume a cancelled caller.
 * Registered owned sessions close synchronously before any abort rejection.
 */
export async function withCameraControlDeadline<T>(
  operation: (scope: CameraControlScope) => Promise<T>,
  parent?: AbortSignal,
  clock: CameraControlTiming = timing,
): Promise<T> {
  if (!Number.isSafeInteger(clock.milliseconds) || clock.milliseconds < 1 || clock.milliseconds > 90_000) {
    throw new RangeError("Invalid camera control deadline");
  }
  const controller = new AbortController();
  const cleanups = new Set<() => void>();
  let dispatched = false;
  const abort = (): void => {
    if (controller.signal.aborted) return;
    for (const cleanup of cleanups) {
      try { cleanup(); }
      catch {

        // Retirement must still cancel the remaining resources and waiters.
      }
    }
    controller.abort(new CameraControlDeadlineError(dispatched));
  };
  const scope: CameraControlScope = {
    signal: controller.signal,
    dispatched: () => { dispatched = true; },
    onAbort: cleanup => {
      if (controller.signal.aborted) cleanup();
      else cleanups.add(cleanup);
      return () => { cleanups.delete(cleanup); };
    },
    wait: async <V>(thunk: () => Promise<V>): Promise<V> => {
      controller.signal.throwIfAborted();
      let rejectAbort!: (reason: unknown) => void;
      const cancelled = new Promise<V>((_resolve, reject) => { rejectAbort = reject; });
      const reject = (): void => rejectAbort(controller.signal.reason);
      controller.signal.addEventListener("abort", reject, { once: true });
      try {
        controller.signal.throwIfAborted();
        const pending = Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return thunk();
        });

        // Read-only losing work may reject after retirement, with no active caller.
        void pending.catch(() => undefined);
        return await Promise.race([pending, cancelled]);
      } finally { controller.signal.removeEventListener("abort", reject); }
    },
  };
  const cancelTimer = clock.schedule(abort, clock.milliseconds);
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  try { return await scope.wait(() => operation(scope)); }
  finally {
    cancelTimer();
    parent?.removeEventListener("abort", abort);
    cleanups.clear();
  }
}
