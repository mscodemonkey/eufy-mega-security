/**
 * Owns the in-memory epoch, cooldown and active-time budget for manual video
 * sign-in preparation. The provider owns all authentication and cleanup I/O.
 * HTTP and Diagnostics consume only the provider's fixed public state.
 */
import { GeneralRtcPreparationError, type GeneralRtcPreparationState } from "./provider.js";

/**
 * One preparation lifetime per provider process, with no persisted account data.
 * Challenge input pauses the active deadline. Failure remains gated until the
 * provider process is replaced, while retirement invalidates every late result.
 */
export class GeneralRtcPreparation {
  #state: GeneralRtcPreparationState = "idle";
  #epoch = 0;
  #owner: number | null = null;
  #cooldownUntil = 0;
  #remaining = 180_000;
  #activeStarted = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  /** The deadline callback retires provider I/O. The injected clock is monotonic and test-owned when supplied. */
  constructor(private readonly onDeadline: (epoch: number) => void, private readonly now: () => number = () => performance.now()) {}

  /** Refuse new effects while signing in, waiting for challenge input, or latched after failure. */
  get gated(): boolean {
    return this.#state === "signing-in" || this.#state === "authentication-required" || this.#state === "failed";
  }

  /** Report identity readiness from the current binding, never from a previously successful flight. */
  status(identityBound: boolean): GeneralRtcPreparationState {
    if (this.gated) return this.#state;
    if (identityBound) return "ready";
    return this.#state === "identity-unavailable" && this.now() < this.#cooldownUntil ? "identity-unavailable" : "idle";
  }

  /** Reserve the epoch synchronously before the provider performs its first asynchronous effect. */
  begin(): number {
    if (this.gated) throw new GeneralRtcPreparationError("preparing");
    if (this.now() < this.#cooldownUntil) throw new GeneralRtcPreparationError("cooldown");
    this.#owner = ++this.#epoch;
    this.#cooldownUntil = this.now() + 600_000;
    this.#remaining = 180_000;
    this.#state = "signing-in";
    this.#arm(this.#owner);
    return this.#owner;
  }

  /** Check ownership after each provider await, including after shutdown or a deadline. */
  owns(epoch: number): boolean {
    return this.#owner === epoch && this.#epoch === epoch;
  }

  /** Stop consuming the active budget while the existing authentication page waits for input. */
  challenge(epoch: number): void {
    if (!this.owns(epoch)) return;
    this.#pause();
    this.#state = "authentication-required";
  }

  /** Resume the same epoch and remaining budget for an explicit challenge submission. */
  resume(epoch: number): void {
    if (!this.owns(epoch) || this.#state !== "authentication-required") throw new GeneralRtcPreparationError("preparing");
    this.#state = "signing-in";
    this.#arm(epoch);
  }

  /** Finish only the owning flight, releasing its gate without claiming physical camera support. */
  complete(epoch: number, identityBound: boolean): boolean {
    if (!this.owns(epoch)) return false;
    this.#pause();
    this.#owner = null;
    this.#state = identityBound ? "ready" : "identity-unavailable";
    return true;
  }

  /** Latch failure so no new device operation or reauthentication runs before process restart. */
  fail(epoch: number): boolean {
    if (!this.owns(epoch)) return false;
    this.#pause();
    this.#owner = null;
    this.#state = "failed";
    return true;
  }

  /** Retire the active epoch synchronously on close while preserving a failure latch and cooldown. */
  retire(): void {
    this.#pause();
    ++this.#epoch;
    this.#owner = null;
    if (this.#state !== "failed") this.#state = "idle";
  }

  #pause(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
      this.#remaining = Math.max(0, this.#remaining - Math.max(0, this.now() - this.#activeStarted));
    }
  }

  #arm(epoch: number): void {
    this.#activeStarted = this.now();
    this.#timer = setTimeout(() => {
      if (!this.owns(epoch)) return;
      try { this.onDeadline(epoch); } catch {}
      finally { this.fail(epoch); }
    }, this.#remaining);
    this.#timer.unref();
  }
}
