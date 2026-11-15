/**
 * Owns the attached T8171's live-session quality request and correlated reply.
 * The PPCS session supplies decrypted notifications and retires this state
 * on close. Provider and HA consumers must not treat it as a saved preference.
 */
import type { ModelControlRoute } from "./model-control-trials.js";

/** Native live choices, independent of recording quality and delivered dimensions. */
export const T8171_SESSION_QUALITY_MODES = [
  { value: 0, name: "Auto" }, { value: 1, name: "HD (720P)" },
  { value: 2, name: "Full HD (1080P)" }, { value: 3, name: "2K" },
] as const;

/** Admit only the observed HomeBase 3 attached model and child-channel range. */
export function isT8171SessionQualityRoute(route: ModelControlRoute): boolean {
  return route.model === "T8171" && route.deviceType === 88 && route.homeBaseAttached
    && !route.selfPeer && route.peerModel === "T8030" && route.peerDeviceType === 18
    && Number.isInteger(route.channel) && route.channel !== null && route.channel >= 0 && route.channel <= 31;
}

/** Build the observed live-view request without modifying recording or lens mode. */
export function t8171SessionQualityValue(channel: number, quality: number, account: string, transaction: string): string {
  if (!Number.isInteger(channel) || channel < 0 || channel > 31 || !Number.isInteger(quality)
    || quality < 0 || quality > 3 || !account || !/^\d{13}$/.test(transaction)) {
    throw new Error("Attached live quality unavailable");
  }
  return JSON.stringify({ account_id: account, cmd: 2730, mChannel: channel, mValue3: 0,
    payload: { quality, mode: 0, primary_view: 0, channel, transaction } });
}

/**
 * Owns one in-flight quality change and its session-lifetime accepted value.
 * Only the owning PPCS session may pass qualified encrypted replies. A timeout,
 * cancellation or close clears the value because dispatch may have succeeded.
 * This is reply evidence, never independent persistent-setting readback.
 */
export class T8171SessionQuality {
  #value: number | null = null;
  #closed = false;
  #lastTransaction = 0;
  #pending: { channel: number; quality: number; transaction: string; resolve: () => void; reject: (error: Error) => void;
    timer: NodeJS.Timeout; abort: () => void; signal: AbortSignal } | null = null;

  /** Accepted value for this connection only, absent after failure or retirement. */
  get value(): number | null { return this.#value; }

  /** Reject overlapping requests rather than replacing their correlation identity. */
  get busy(): boolean { return this.#pending !== null; }

  /**
   * Dispatch once and wait for the exact correlated quality echo.
   * The caller supplies the already-owned channel and must check route and media
   * readiness before entering. Cancellation never retries or closes live view.
   */
  async change(channel: number, quality: number, account: string, signal: AbortSignal,
    send: (value: string) => void, timeoutMilliseconds = 10_000): Promise<void> {
    if (this.#closed || this.#pending || signal.aborted) throw new Error("Live quality session unavailable or busy");
    const transaction = `${Math.max(Date.now(), this.#lastTransaction + 1)}`;
    const value = t8171SessionQualityValue(channel, quality, account, transaction);
    this.#lastTransaction = Number(transaction);
    this.#value = null;
    await new Promise<void>((resolve, reject) => {
      const fail = (): void => this.#finish(new Error("Live quality was not confirmed for this stream"));
      const timer = setTimeout(fail, timeoutMilliseconds);
      this.#pending = { channel, quality, transaction, resolve, reject, timer, abort: fail, signal };
      signal.addEventListener("abort", fail, { once: true });
      try { send(value); } catch { fail(); }
    });
  }

  /** Accept only the expected child, fixed live mode, quality and transaction. */
  accept(value: Record<string, unknown>, channel: number): boolean {
    const pending = this.#pending;
    const body = value.payload;
    if (!pending || pending.channel !== channel || value.cmd !== 2730 || value.mChannel !== channel || value.mValue3 !== 0
      || !body || typeof body !== "object" || Array.isArray(body)) return false;
    const payload = body as Record<string, unknown>;
    if (payload.channel !== channel || payload.mode !== 0 || payload.primary_view !== 0
      || payload.quality !== pending.quality || payload.transaction !== pending.transaction) return false;
    this.#value = pending.quality;
    this.#finish();
    return true;
  }

  /** Permanently retire this connection's requests and accepted value. */
  close(): void {
    this.#closed = true;
    this.#finish(new Error("Live quality session closed"));
    this.#value = null;
  }

  #finish(error?: Error): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    clearTimeout(pending.timer);
    pending.signal.removeEventListener("abort", pending.abort);
    if (error) { this.#value = null; pending.reject(error); }
    else pending.resolve();
  }
}
