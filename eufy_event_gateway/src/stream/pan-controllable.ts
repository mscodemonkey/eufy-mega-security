/** Device controllers own pan/tilt protocols; PPCS owns their connection and packet delivery. */
export type PanDirection = "left" | "right" | "up" | "down";

export type PanEncryption = "level2-json" | "standalone-json";

/** Device requirements; the provider owns scheduling, authorization and connections. */
export interface PanExecutionPolicy {
  readonly connection: "homebase-viewer-or-isolated" | "isolated";
  readonly scheduling: "exclusive" | "queued";
  readonly refreshInventory: boolean;
  readonly encryption: PanEncryption;
}

export interface PanControlTransport {
  isConnected(): boolean;
  /** Dispatch once, checking ownership immediately before send; receipt completion belongs to the controller. */
  sendJson(command: number, value: string, channel: number, current: () => void): Promise<void>;
  /** Decode a command receipt without exposing the session's encryption keys. */
  decodeResult(header: Buffer, payload: Buffer, command: number, channel: number): number | null;
}

/** Shared command lifecycle; subclasses supply their command value and receipt interpretation. */
export abstract class PanControllable {
  #closed = false;
  #busy = false;
  #sent = false;
  #pending: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly model: string, protected readonly transport: PanControlTransport, protected readonly channel: number) {}

  protected abstract commandValue(direction: PanDirection): string;
  protected abstract movementResult(header: Buffer, payload: Buffer, type: number): number | null;

  async pan(direction: PanDirection, current: () => void): Promise<void> {
    if (!["left", "right", "up", "down"].includes(direction)) throw new Error(`${this.model} pan control unavailable`);
    if (this.#closed || this.#busy || !this.transport.isConnected()) throw new Error(`${this.model} pan control unavailable`);
    this.#busy = true;
    const receipt = new Promise<void>((resolve, reject) => {
      this.#pending = { resolve, reject, timer: setTimeout(() => this.#finish(new Error(`${this.model} movement acknowledgement timed out`)), 10_000) };
    });
    // Key negotiation can outlive the receipt deadline or session.
    void receipt.catch(() => undefined);
    try {
      await this.transport.sendJson(1700, this.commandValue(direction), this.channel, () => {
        current();
        if (this.#closed || !this.#pending) throw new Error(`${this.model} control session retired`);
        this.#sent = true;
      });
      await receipt;
      current();
    } finally {
      this.#finish(new Error(`${this.model} control session retired`));
      this.#busy = false;
      this.#sent = false;
    }
  }

  handleFrame(header: Buffer, payload: Buffer, type: number): boolean {
    if (!this.#isAwaitingMovementReceipt()) return false;
    const result = this.movementResult(header, payload, type);
    if (result === null) return false;
    this.#finish(result === 0 ? undefined : new Error(`${this.model} movement rejected (${result})`));
    return true;
  }

  #isAwaitingMovementReceipt(): boolean {
    return !this.#closed && this.#pending !== null && this.#sent;
  }

  close(): void {
    this.#closed = true;
    this.#finish(new Error(`${this.model} control session retired`));
  }

  #finish(error?: Error): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    clearTimeout(pending.timer);
    error ? pending.reject(error) : pending.resolve();
  }
}
