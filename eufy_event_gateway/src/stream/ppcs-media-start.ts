/**
 * Repairs lost live-start datagrams without constructing another camera command.
 * Each PPCS session owns one tracker and its fixed peer/socket sender. The
 * session validates ACKs and channel-specific media before retiring entries.
 * Ciphertext is held only in memory until receipt, expiry, stop or close.
 */

/** Clock and repeating timer borrowed by the tracker for deterministic lifetime tests. */
export interface PpcsMediaStartScheduler {
  now(): number;
  repeat(callback: () => void, milliseconds: number): () => void;
}

const scheduler: PpcsMediaStartScheduler = {
  now: () => Date.now(),
  repeat: (callback, milliseconds) => {
    const timer = setInterval(callback, milliseconds);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

interface PendingStart {
  readonly sequence: number;
  readonly packet: Buffer;
  readonly deadline: number;
}

/**
 * Own the current live start and, during a key upgrade, one displaced start.
 * Retries preserve the complete packet and its original sequence. The owning
 * session must close this tracker before stopping media or closing its socket.
 * Receipt counters describe transport only, never successful video playback.
 */
export class PpcsMediaStart {
  #current: PendingStart | null = null;
  #displaced: PendingStart | null = null;
  #cancelTimer: (() => void) | null = null;
  #closed = false;

  /** Counts are retained after close for the session's privacy-safe summary. */
  readonly stats = { acknowledged: 0, retransmitted: 0, expired: 0 };

  /** Borrow a sender pinned to the session's adopted socket and selected endpoint. */
  constructor(
    private readonly transmit: (packet: Buffer) => void,
    private readonly clock: PpcsMediaStartScheduler = scheduler,
  ) {}

  /** Defer heartbeat-driven starts while either original datagram still needs repair. */
  get pending(): boolean { return this.#current !== null || this.#displaced !== null; }

  /**
   * Send one new start, retaining one replaced start during a key upgrade.
   * A third simultaneous start is refused instead of dropping a sequence hole.
   */
  start(sequence: number, packet: Buffer): boolean {
    if (this.#closed || this.#current && this.#displaced) return false;
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > 65535 || packet.length > 65539) {
      throw new RangeError("Invalid PPCS media-start datagram");
    }
    if (this.#current) this.#displaced = this.#current;
    const entry = { sequence, packet: Buffer.from(packet), deadline: this.clock.now() + 3000 };
    this.#current = entry;
    this.#cancelTimer ??= this.clock.repeat(() => this.#retry(), 150);
    this.transmit(entry.packet);
    return true;
  }

  /** Retire only an outstanding exact sequence; duplicate ACKs have no effect. */
  acknowledge(sequence: number): void {
    if (this.#current?.sequence === sequence) { this.#current = null; this.stats.acknowledged++; }
    else if (this.#displaced?.sequence === sequence) { this.#displaced = null; this.stats.acknowledged++; }
    this.#retireTimer();
  }

  /** A validated frame for this camera proves receipt even when its ACK was lost. */
  mediaReceived(): void {
    this.#current = null;
    this.#displaced = null;
    this.#retireTimer();
  }

  /** Cancel the current start before an explicit stop while preserving displaced repair. */
  stop(): void { this.#current = null; this.#retireTimer(); }

  /** Retire all repair work permanently before the owning socket is stopped. */
  close(): void { this.#closed = true; this.mediaReceived(); }

  #retry(): void {
    if (this.#closed) return;
    for (const key of ["#displaced", "#current"] as const) {
      const entry = key === "#current" ? this.#current : this.#displaced;
      if (!entry) continue;
      if (this.clock.now() >= entry.deadline) {
        if (key === "#current") this.#current = null;
        else this.#displaced = null;
        this.stats.expired++;
      } else {
        this.stats.retransmitted++;
        this.transmit(entry.packet);
      }
    }
    this.#retireTimer();
  }

  #retireTimer(): void {
    if (this.pending) return;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
  }
}
