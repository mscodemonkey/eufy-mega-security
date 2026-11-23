/**
 * Retains a small structural receive timeline for an explicitly selected source.
 * The PPCS session owns its lifetime and clock. Private diagnostic capture
 * consumes copies without packet contents, addresses, account data or keys.
 */

/** Closed receive boundaries, independent of codec or physical camera success. */
export type PpcsReceiveKind = "arrival" | "ordered" | "gap" | "restart" | "resync" | "frame";

/** One source-local observation, never a packet or camera identifier. */
export interface PpcsReceiveObservation {
  readonly kind: PpcsReceiveKind;

  /** Increases within this source, allowing a consumer to detect lost ring entries. */
  readonly ordinal: number;

  /** Monotonic milliseconds since this timeline was created, not capture wall time. */
  readonly elapsedMs: number;
  readonly transportType: number;
  readonly bytes: number;
  readonly sequence?: number;

  /** Arrival source matches the selected peer, without retaining either address. */
  readonly samePeer?: boolean;
  readonly command?: number;
}

const KINDS: readonly PpcsReceiveKind[] = ["arrival", "ordered", "gap", "restart", "resync", "frame"];

/** Project only the closed structural fields before crossing diagnostic boundaries. */
export function projectPpcsReceiveObservation(value: unknown): PpcsReceiveObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const bounded = (key: string, maximum: number): boolean => typeof row[key] === "number"
    && Number.isSafeInteger(row[key]) && (row[key] as number) >= 0 && (row[key] as number) <= maximum;
  if (!KINDS.includes(row.kind as PpcsReceiveKind) || !bounded("ordinal", Number.MAX_SAFE_INTEGER)
    || row.ordinal === 0 || !bounded("elapsedMs", Number.MAX_SAFE_INTEGER)
    || !bounded("transportType", 255) || !bounded("bytes", 16 * 1024 * 1024)
    || row.sequence !== undefined && !bounded("sequence", 65535)
    || row.command !== undefined && !bounded("command", 65535)
    || row.samePeer !== undefined && typeof row.samePeer !== "boolean") return null;
  return { kind: row.kind as PpcsReceiveKind, ordinal: row.ordinal as number,
    elapsedMs: row.elapsedMs as number, transportType: row.transportType as number, bytes: row.bytes as number,
    ...(row.sequence === undefined ? {} : { sequence: row.sequence as number }),
    ...(row.command === undefined ? {} : { command: row.command as number }),
    ...(row.samePeer === undefined ? {} : { samePeer: row.samePeer as boolean }) };
}

/**
 * Owns at most 256 numeric observations for one source, with no I/O or timers.
 * The session freezes appends on close and keeps the last copy for its final
 * diagnostic. Disabled sources retain nothing. Ring loss remains visible in
 * ordinals rather than being interpreted as an absence of received traffic.
 */
export class PpcsReceiveTimeline {
  readonly #rows: PpcsReceiveObservation[] = [];
  readonly #started: number;
  #ordinal = 0;
  #closed = false;

  /** The owning session selects eligibility before any packet is handled. */
  constructor(private readonly enabled: boolean, private readonly now: () => number = () => performance.now()) {
    this.#started = now();
  }

  /** Append structural facts only, without affecting the receiver's decisions. */
  record(kind: PpcsReceiveKind, transportType: number, bytes: number,
    extra: Pick<PpcsReceiveObservation, "sequence" | "samePeer" | "command"> = {}): void {
    if (!this.enabled || this.#closed || this.#ordinal >= Number.MAX_SAFE_INTEGER) return;
    const row = projectPpcsReceiveObservation({ ...extra, kind, transportType, bytes,
      ordinal: this.#ordinal + 1, elapsedMs: Math.max(0, Math.round(this.now() - this.#started)) });
    if (!row) return;
    this.#ordinal++;
    if (this.#rows.length === 256) this.#rows.shift();
    this.#rows.push(row);
  }

  /** Return detached copies so a capture cannot mutate the session's ring. */
  snapshot(): readonly PpcsReceiveObservation[] { return this.#rows.map(row => ({ ...row })); }

  /** Freeze appends while preserving terminal evidence until the session is released. */
  close(): void { this.#closed = true; }
}
