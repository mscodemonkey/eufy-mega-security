/**
 * Observes an owned PPCS startup without consuming its buffered media.
 * The provider owns replacement and the overall deadline. This module owns
 * only temporary listeners and timers used to distinguish silence from sustained progress.
 */
import type { Readable } from "node:stream";

const STARTUP_VIDEO_UNITS = 10;
const STARTUP_STALL_MILLISECONDS = 3000;

/** Startup delivery and normalized-media facts consumed only by the owning provider. */
export interface OwnedStartupFacts {
  readonly camId: number;
  readonly mediaStartAcknowledged: number;
  readonly videoFrames: number;
  readonly videoOutputFrames: number;
  readonly commands: readonly number[];
  readonly closeReason: string;
}

/** Progress preserves the peer; silence or a stalled bootstrap permits owned replacement. */
export type OwnedStartupObservation = "progress" | "silent" | "stalled" | "unconfirmed";

/** Require delivery proof and absence of any application response beyond the key handshake. */
export function acknowledgedStartupIsSilent(facts: OwnedStartupFacts): boolean {
  return facts.closeReason === "open" && facts.camId > 0 && facts.mediaStartAcknowledged > 0
    && facts.videoFrames === 0 && facts.videoOutputFrames === 0
    && facts.commands.includes(1100) && facts.commands.every(command => command === 1100);
}

/**
 * Observe startup for a limited part of the caller's remaining deadline.
 * Media bytes stay buffered for the eventual viewer. Cancellation, logical
 * retirement and every settlement remove listeners and timers. Unknown delivery
 * and a slowly advancing stream retain the ordinary first-frame policy.
 * A short normalized bootstrap that stops for three seconds is distinct from
 * an application reply with no media and from an actively progressing stream.
 */
export function observeOwnedStartup(source: Readable, facts: OwnedStartupFacts,
  milliseconds: number, signal: AbortSignal): Promise<OwnedStartupObservation> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let outputUnits = facts.videoOutputFrames;
    let lastOutputAt = outputUnits > 0 ? performance.now() : null;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const finish = (value: OwnedStartupObservation | Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline); clearInterval(poll);
      source.off("end", ended); source.off("close", ended);
      signal.removeEventListener("abort", aborted);
      value instanceof Error ? reject(value) : resolve(value);
    };
    const aborted = (): void => finish(new Error("Camera startup observation cancelled"));
    const ended = (): void => finish(new Error("Camera session ended during startup observation"));
    const progress = (): void => {
      if (signal.aborted) { aborted(); return; }
      if (facts.closeReason !== "open" || source.destroyed || source.readableEnded) { ended(); return; }
      if (facts.videoOutputFrames > outputUnits) {
        outputUnits = facts.videoOutputFrames;
        lastOutputAt = performance.now();
      }
      if (outputUnits >= STARTUP_VIDEO_UNITS) finish("progress");
    };
    source.once("end", ended); source.once("close", ended);
    signal.addEventListener("abort", aborted, { once: true });
    deadline = setTimeout(() => {
      progress();
      if (finished) return;
      if (acknowledgedStartupIsSilent(facts)) { finish("silent"); return; }
      if (outputUnits > 0 && lastOutputAt !== null) {
        const stalled = performance.now() - lastOutputAt >= STARTUP_STALL_MILLISECONDS;
        if (!stalled) { finish("progress"); return; }
        if (facts.camId > 0 && facts.mediaStartAcknowledged > 0 && facts.commands.includes(1100)) {
          finish("stalled"); return;
        }
      }
      finish("unconfirmed");
    }, Math.max(0, milliseconds));
    poll = setInterval(progress, 50);
    deadline.unref?.(); poll.unref?.();
    progress();
  });
}
