/**
 * Runs one consented camera-power test and restores its verified original value.
 * The provider owns the exclusive station lease and supplies an identity-checked
 * transport. This module owns phase budgets and never selects devices or logs
 * private context. A lost connection can prevent restoration, requiring the
 * observing operator's manual fallback.
 */
import { performance } from "node:perf_hooks";

/** Closed failure categories never carry a vendor message or private identity. */
export type NvrPowerStage = "admission" | "busy" | "inventory" | "identity" | "baseline" | "send" | "receipt"
  | "readback" | "restore" | "cleanup" | "cancelled" | "shutdown" | "timeout";

/**
 * Carries a fixed failure from the trial to the provider and authenticated API.
 * It owns no transport or recovery work and never retains vendor error text.
 * The observing operator uses manualRestoreRequired to decide whether the
 * recorded original still needs checking after the operation has ended.
 */
export class NvrPowerError extends Error {
  constructor(readonly stage: NvrPowerStage, readonly manualRestoreRequired = false) {
    super(stage); this.name = "NvrPowerError";
  }
}

/** Power is the reported privacy/power value, never inferred from video activity. */
export type NvrCameraPower = "on" | "off";

/** The operator records the original before consenting to both change and restore. */
export interface NvrPowerRequest {
  readonly originalPower: NvrCameraPower;
  readonly target: NvrCameraPower;
}

/** A completed software test still needs the operator to observe physical effects. */
export interface NvrPowerSummary {
  readonly outcome: "target_confirmed" | "no_change_confirmed" | "target_unconfirmed_restored";
  readonly restored: true;
  readonly physicalConfirmationRequired: true;
}

/**
 * Provider-owned operations on one ordered, authenticated station connection.
 * Every write checks binding synchronously and marks dispatch before its first
 * send. Cancellation retires a pending request without closing recovery's session.
 */
export interface NvrPowerTransport {

  /** Establish the fresh cloud binding, connection and correlated native identity. */
  prepare(signal: AbortSignal): Promise<void>;

  /** A recovery-only cloud failure may use the same connection and fresh native identity. */
  validate(recovery: boolean, signal: AbortSignal): Promise<void>;

  /** Return only a fresh query-segment-correlated power value, or unknown. */
  read(signal: AbortSignal): Promise<NvrCameraPower | null>;

  /** Send one absolute value, marking dispatch even if the first send throws. */
  write(value: NvrCameraPower, signal: AbortSignal, dispatched: () => void): Promise<void>;

  /** Retire callbacks and resources once, with the provider retaining its lease. */
  close(): Promise<void>;
}

/** Injectable clock and delay allow offline tests without shortening production budgets. */
export interface NvrPowerRuntime {
  readonly now: () => number;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Change once, confirm reported power and restore under an independent budget.
 * Caller cancellation after dispatch starts recovery rather than closing it.
 * No target is replayed. A readable wrong restore or an undispatched recovery
 * write permits one retry within the same independent recovery budget.
 */
export async function runNvrPowerTrial(transport: NvrPowerTransport, request: NvrPowerRequest,
  caller: AbortSignal, runtime: NvrPowerRuntime = { now: () => performance.now(), sleep: wait }): Promise<NvrPowerSummary> {
  if (!["on", "off"].includes(request.originalPower) || !["on", "off"].includes(request.target)) throw new NvrPowerError("admission");
  const normal = new AbortController();
  let attempted = false, targetConfirmed = false, restored = false;
  let failure: NvrPowerError | null = null;
  const cancel = (): void => normal.abort(new NvrPowerError("cancelled"));
  caller.addEventListener("abort", cancel, { once: true });
  if (caller.aborted) cancel();
  const timer = setTimeout(() => normal.abort(new NvrPowerError("timeout")), 40_000);
  const targetStart = runtime.now();
  const mark = (): void => { attempted = true; };
  try {
    try {
      await owned(() => transport.prepare(normal.signal), normal.signal);
      if (await owned(() => transport.read(normal.signal), normal.signal) !== request.originalPower) throw new NvrPowerError("baseline");
      await owned(() => transport.validate(false, normal.signal), normal.signal);
      try { await owned(() => transport.write(request.target, normal.signal, mark), normal.signal); }
      catch (error) {
        if (!attempted) throw fixed(error, "send");
        failure = fixed(error, "receipt");
      }
      if (!normal.signal.aborted && attempted) {
        const settleEnd = Math.min(targetStart + 40_000, runtime.now() + 3_000);
        do {
          const value = await owned(() => transport.read(normal.signal), normal.signal);
          if (value === request.target) { targetConfirmed = true; break; }
          if (runtime.now() >= settleEnd) break;
          await runtime.sleep(500, normal.signal);
        } while (runtime.now() < settleEnd);
      }
      if (!targetConfirmed) failure ??= new NvrPowerError("readback");
    } catch (error) { failure = fixed(error, normal.signal.aborted ? "cancelled" : attempted ? "readback" : "identity"); }
    finally {
      clearTimeout(timer); caller.removeEventListener("abort", cancel);
      if (attempted) {
        const recovery = new AbortController();
        const recoveryTimer = setTimeout(() => recovery.abort(new NvrPowerError("restore", true)), 60_000);
        try {
          await owned(() => transport.validate(true, recovery.signal), recovery.signal);
          if (request.target === request.originalPower && targetConfirmed) {
            await runtime.sleep(1_000, recovery.signal);
            restored = await owned(() => transport.read(recovery.signal), recovery.signal) === request.originalPower;
          }
          for (let attempt = 0; !restored && attempt < 2; attempt++) {
            await owned(() => transport.validate(true, recovery.signal), recovery.signal);

            // A pending opposite target can invalidate an immediate original read.
            // Send the recorded original once before accepting restoration.
            let restoreDispatched = false;
            try {
              await owned(() => transport.write(request.originalPower, recovery.signal,
                () => { restoreDispatched = true; }), recovery.signal);
            } catch {
              recovery.signal.throwIfAborted();
            }
            if (!restoreDispatched) continue;
            let value = await owned(() => transport.read(recovery.signal), recovery.signal);
            if (value === request.originalPower) {
              await runtime.sleep(1_000, recovery.signal);
              value = await owned(() => transport.read(recovery.signal), recovery.signal);
              restored = value === request.originalPower;
            }
            if (value === null) break;
          }
          if (!restored) failure = new NvrPowerError("restore", true);
        } catch (error) { failure = new NvrPowerError(fixed(error, "restore").stage, true); }
        finally { clearTimeout(recoveryTimer); recovery.abort(); }
      }
    }
  } finally {
    clearTimeout(timer); caller.removeEventListener("abort", cancel); normal.abort();
    const cleanup = new AbortController();
    const cleanupTimer = setTimeout(() => cleanup.abort(new NvrPowerError("cleanup", attempted)), 5_000);
    try { await owned(() => transport.close(), cleanup.signal); }
    catch { if (attempted || !failure) failure = new NvrPowerError("cleanup", attempted && !restored); }
    finally { clearTimeout(cleanupTimer); cleanup.abort(); }
  }
  if (!attempted) throw failure ?? new NvrPowerError("send");
  if (!restored || failure?.stage === "cleanup") throw failure ?? new NvrPowerError("restore", true);
  return { outcome: targetConfirmed ? request.target === request.originalPower ? "no_change_confirmed" : "target_confirmed"
    : "target_unconfirmed_restored", restored: true, physicalConfirmationRequired: true };
}

function fixed(error: unknown, fallback: NvrPowerStage): NvrPowerError {
  return error instanceof NvrPowerError ? error : new NvrPowerError(fallback);
}

async function owned<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new NvrPowerError("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { const value = await Promise.race([operation(), cancelled]); signal.throwIfAborted(); return value; }
  finally { signal.removeEventListener("abort", abort); }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const done = (): void => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, milliseconds);
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason ?? new NvrPowerError("cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
