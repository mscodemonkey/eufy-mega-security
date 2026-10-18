/**
 * Runs the consented T8N00 Schedule-to-Home diagnostic and restores Schedule.
 * The provider owns private inventory state, the exclusive station lease, and
 * the authenticated transport. This module owns bounded change and recovery
 * policy and never exposes the recorded schedule or device identity.
 */
import { performance } from "node:perf_hooks";
import { nvrGuardSchedule, nvrGuardTimeZone, type NvrGuardEffective } from "./nvr-guard-schedule.js";

/** Fixed failure categories safe for the authenticated diagnostics boundary. */
export type NvrGuardStage = "admission" | "busy" | "inventory" | "identity" | "baseline" | "send" | "receipt"
  | "readback" | "restore" | "cleanup" | "cancelled" | "shutdown" | "timeout";

/**
 * Carries a fixed failure without vendor text or private state. The operator
 * uses manualRestoreRequired to decide whether Schedule needs checking in Eufy.
 */
export class NvrGuardError extends Error {
  constructor(readonly stage: NvrGuardStage, readonly manualRestoreRequired = false) {
    super(stage); this.name = "NvrGuardError";
  }
}

/** The only admitted temporary transition is Schedule to Home. */
export interface NvrGuardRequest {
  readonly target: "home";

  /** Operator-confirmed NVR timezone, never inferred from the gateway clock. */
  readonly timeZone: string;
}

/** A software-confirmed restore still requires observation on the real NVR. */
export interface NvrGuardSummary {
  readonly outcome: "home_confirmed" | "home_unconfirmed_restored";
  readonly restored: true;
  readonly scheduleUnchanged: true;
  readonly physicalConfirmationRequired: true;
}

/** Private inventory projection retained only for the duration of one trial. */
export interface NvrGuardState {
  readonly mode: number | null;
  readonly schedule: string | null;
}

/** Provider-owned operations on one ordered, authenticated station connection. */
export interface NvrGuardTransport {

  /** Establish fresh cloud binding, connection, and correlated native identity. */
  prepare(signal: AbortSignal): Promise<void>;

  /** Revalidate cloud and native identity before a write or recovery step. */
  validate(recovery: boolean, signal: AbortSignal): Promise<void>;

  /** Return only freshly queried cloud guard state and the private schedule bytes. */
  read(signal: AbortSignal): Promise<NvrGuardState>;

  /** Send one closed absolute mode, marking dispatch before the first packet. */
  write(mode: 1 | 2, signal: AbortSignal, dispatched: () => void): Promise<void>;

  /** Confirm the station's effective mode with a fresh correlated query. */
  effective(expected: NvrGuardEffective, signal: AbortSignal): Promise<void>;

  /** Retire callbacks and resources once while the provider retains its lease. */
  close(): Promise<void>;
}

/** Injectable clock and delay allow complete offline recovery tests. */
export interface NvrGuardRuntime {
  readonly now: () => number;

  /** Wall clock for schedule evaluation, separate from monotonic budgets. */
  readonly wallNow?: () => number;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Change Schedule to Home once, then restore Schedule under an independent
 * budget. A retry is allowed only after fresh readback does not prove the
 * original mode and byte-identical schedule. Cancellation after dispatch
 * starts recovery instead of abandoning the station in the temporary mode.
 */
export async function runNvrGuardTrial(transport: NvrGuardTransport, request: NvrGuardRequest,
  caller: AbortSignal, runtime: NvrGuardRuntime = { now: () => performance.now(), sleep: wait }): Promise<NvrGuardSummary> {
  if (request.target !== "home") throw new NvrGuardError("admission");
  const zone = nvrGuardTimeZone(request.timeZone);
  const wallNow = runtime.wallNow ?? Date.now;
  const normal = new AbortController();
  let attempted = false, targetConfirmed = false, restored = false, originalSchedule: string | null = null;
  let expected: Exclude<NvrGuardEffective, 1> | undefined;
  let failure: NvrGuardError | null = null;
  const cancel = (): void => normal.abort(new NvrGuardError("cancelled"));
  caller.addEventListener("abort", cancel, { once: true });
  if (caller.aborted) cancel();
  const timer = setTimeout(() => normal.abort(new NvrGuardError("timeout")), 40_000);
  try {
    try {
      await owned(() => transport.prepare(normal.signal), normal.signal);
      const baseline = await owned(() => transport.read(normal.signal), normal.signal);
      if (baseline.mode !== 2 || typeof baseline.schedule !== "string") throw new NvrGuardError("baseline");
      originalSchedule = baseline.schedule;
      expected = nvrGuardSchedule(originalSchedule, zone, wallNow());
      await owned(() => transport.effective(expected!, normal.signal), normal.signal);
      await owned(() => transport.validate(false, normal.signal), normal.signal);
      let receipt = false;
      try {
        await owned(() => transport.write(1, normal.signal, () => { attempted = true; }), normal.signal);
        receipt = true;
      } catch (error) {
        if (!attempted) throw fixed(error, "send");
        failure = fixed(error, "receipt");
      }
      const targetEnd = runtime.now() + 15_000;
      while (attempted && !normal.signal.aborted && runtime.now() < targetEnd) {
        try {
          const state = await owned(() => transport.read(normal.signal), normal.signal);
          if (state.schedule !== originalSchedule) throw new NvrGuardError("baseline");
          await owned(() => transport.effective(1, normal.signal), normal.signal);
          if (state.mode === 1 && receipt) { targetConfirmed = true; break; }
          if (!receipt) break;
        } catch (error) {
          const reason = fixed(error, "readback");
          if (reason.stage === "identity" || reason.stage === "shutdown" || reason.stage === "baseline") throw reason;
        }
        await runtime.sleep(1_000, normal.signal);
      }
    } catch (error) { failure = fixed(error, normal.signal.aborted ? "cancelled" : attempted ? "readback" : "identity"); }
    finally {
      clearTimeout(timer); caller.removeEventListener("abort", cancel);
      if (attempted && originalSchedule !== null && expected !== undefined) {
        const recovery = new AbortController();
        const recoveryTimer = setTimeout(() => recovery.abort(new NvrGuardError("restore", true)), 120_000);
        const end = runtime.now() + 120_000;
        let writes = 0, lastDispatch = -Infinity, firstPairAt: number | null = null;
        try {
          while (!restored && runtime.now() < end) {
            try {
              await owned(() => transport.validate(true, recovery.signal), recovery.signal);
              if (writes === 0 || writes < 2 && lastDispatch === -Infinity) {
                writes++;
                try {
                  await owned(() => transport.write(2, recovery.signal, () => { lastDispatch = runtime.now(); }), recovery.signal);
                } catch (error) {
                  const reason = fixed(error, "receipt");
                  if (["identity", "shutdown", "admission"].includes(reason.stage)) throw reason;
                }
              }
              const state = await owned(() => transport.read(recovery.signal), recovery.signal);
              if (state.schedule !== originalSchedule) throw new NvrGuardError("baseline", true);
              const scheduled = nvrGuardSchedule(originalSchedule, zone, wallNow(), true);
              if (scheduled !== expected) throw new NvrGuardError("baseline", true);
              if (state.mode === 2) {
                await owned(() => transport.effective(scheduled, recovery.signal), recovery.signal);
                if (firstPairAt !== null && runtime.now() - firstPairAt >= 1_000) { restored = true; break; }
                firstPairAt = runtime.now();
              } else {
                firstPairAt = null;
                if (writes < 2 && state.mode === 1 && runtime.now() - lastDispatch >= 15_000) {
                  await owned(() => transport.validate(true, recovery.signal), recovery.signal);
                  writes++;
                  try {
                    await owned(() => transport.write(2, recovery.signal, () => { lastDispatch = runtime.now(); }), recovery.signal);
                  } catch (error) {
                    const reason = fixed(error, "receipt");
                    if (["identity", "shutdown", "admission"].includes(reason.stage)) throw reason;
                  }
                }
              }
            } catch (error) {
              firstPairAt = null;
              const reason = fixed(error, "readback");
              if (["identity", "shutdown", "admission", "baseline"].includes(reason.stage)) throw reason;
            }
            await runtime.sleep(2_000, recovery.signal);
          }
          if (!restored) failure = new NvrGuardError("restore", true);
        } catch (error) { failure = new NvrGuardError(fixed(error, "restore").stage, true); }
        finally { clearTimeout(recoveryTimer); recovery.abort(); }
      }
    }
  } finally {
    clearTimeout(timer); caller.removeEventListener("abort", cancel); normal.abort();
    const cleanup = new AbortController();
    const cleanupTimer = setTimeout(() => cleanup.abort(new NvrGuardError("cleanup", attempted && !restored)), 5_000);
    try { await owned(() => transport.close(), cleanup.signal); }
    catch { failure = new NvrGuardError("cleanup", attempted && !restored); }
    finally { clearTimeout(cleanupTimer); cleanup.abort(); }
  }
  if (!attempted) throw failure ?? new NvrGuardError("send");
  if (!restored || failure?.stage === "cleanup") throw failure ?? new NvrGuardError("restore", true);
  return { outcome: targetConfirmed ? "home_confirmed" : "home_unconfirmed_restored", restored: true,
    scheduleUnchanged: true, physicalConfirmationRequired: true };
}

function fixed(error: unknown, fallback: NvrGuardStage): NvrGuardError {
  return error instanceof NvrGuardError ? error : new NvrGuardError(fallback);
}

async function owned<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new NvrGuardError("cancelled"));
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
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason ?? new NvrGuardError("cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
