/**
 * Owns the experimental S100 pulse lifecycle without sockets or device state.
 * The provider supplies an exclusive prepared transport and cancellation signal.
 * Completion reports acknowledgement only, never audible hardware behaviour.
 */

import { setTimeout as delay } from "node:timers/promises";

/** Closed failure stages safe for HTTP responses and aggregate diagnostics. */
export type S100SirenFailureStage = "start" | "primary_stop" | "secondary_stop" | "ownership"
  | "session_key" | "session_connect" | "session_prepare"
  | "session_identity" | "session_gateway" | "session_cipher" | "session_counter";

/** Carries only fixed stage names, excluding transport errors and private inputs. */
export class S100SirenTrialError extends Error {

  /** Failure order preserves an ambiguous start before any cleanup failures. */
  readonly stages: readonly S100SirenFailureStage[];

  /** Select the no-command wording only for the connection-check boundary. */
  constructor(stages: readonly S100SirenFailureStage[], connectionOnly = false) {
    super(connectionOnly ? `S100 connection check failed: ${stages.join(", ")}. No siren command was sent.`
      : `S100 siren trial failed: ${stages.join(", ")}. Check the camera in the Eufy app before retrying`);
    this.stages = [...stages];
  }
}

/** Prepared transport owns counter reservation, start-attempt tracking and deduplicated stops. */
export interface S100SirenTrialTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Run one five-second sound-only pulse or explicit stop. Cancellation shortens
 * the pulse. Ownership is checked during the wait, while cleanup always targets
 * the original transport even if ownership changes. Every attempted start gets
 * a stop attempt, including ambiguous starts. Preflight belongs to the caller.
 */
export async function runS100SirenTrial(
  transport: S100SirenTrialTransport, enabled: boolean, signal: AbortSignal, checkOwnership: () => void,
): Promise<{ readonly outcome: "acknowledged"; readonly physicalConfirmationRequired: true; readonly stoppedEarly: boolean }> {
  checkOwnership();
  if (!enabled) {
    await transport.stop();
    checkOwnership();
    return { outcome: "acknowledged", physicalConfirmationRequired: true, stoppedEarly: false };
  }
  const failures: S100SirenFailureStage[] = [];
  let stoppedEarly = false, started = false;
  try {
    await transport.start();
    started = true;
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline && !signal.aborted) {
      checkOwnership();
      try { await delay(Math.min(100, deadline - performance.now()), undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; }
    }
    stoppedEarly = signal.aborted;
    checkOwnership();
  } catch (error) {
    failures.push(...(error instanceof S100SirenTrialError ? error.stages : [started ? "ownership" as const : "start" as const]));
  }
  try { await transport.stop(); }
  catch (error) { failures.push(...(error instanceof S100SirenTrialError ? error.stages : ["primary_stop", "secondary_stop"] as const)); }
  if (failures.length) throw new S100SirenTrialError(failures);
  return { outcome: "acknowledged", physicalConfirmationRequired: true, stoppedEarly };
}
