/**
 * Retains prepared recording bytes only in bounded, expiring gateway memory.
 * GatewayServer owns this cache and clears it at shutdown. HTTP and HA proxy
 * consumers borrow immutable MP4 buffers; no camera path or key is stored here.
 */

/** A process-local recording cache capped by both byte count and item count. */
export class RecordingCache {
  readonly #items = new Map<string, { data: Buffer; expiresAt: number }>();
  #bytes = 0;

  /** Allow a clock override for expiry tests without affecting runtime ownership. */
  constructor(private readonly now: () => number = Date.now) {}

  /** Retain a verified clip for ten minutes, evicting older clips before exceeding 64 MiB. */
  put(key: string, data: Buffer): void {
    if (!data.length || data.length > 32 * 1024 * 1024) throw new Error("Recording exceeds the cache limit");
    this.#delete(key);
    this.#items.set(key, { data, expiresAt: this.now() + 10 * 60_000 });
    this.#bytes += data.length;
    while (this.#bytes > 64 * 1024 * 1024 || this.#items.size > 4) this.#delete(this.#items.keys().next().value!);
  }

  /** Return prepared bytes without renewing their access lifetime. */
  get(key: string): Buffer | null {
    const item = this.#items.get(key);
    if (!item) return null;
    if (item.expiresAt <= this.now()) { this.#delete(key); return null; }
    return item.data;
  }

  /** Release all prepared video when the owning server shuts down. */
  clear(): void { this.#items.clear(); this.#bytes = 0; }

  #delete(key: string): void {
    const item = this.#items.get(key);
    if (item) this.#bytes -= item.data.length;
    this.#items.delete(key);
  }
}

/** Parse one RFC byte range, returning null for invalid or unsatisfiable requests. */
export function recordingByteRange(value: string, size: number): { start: number; end: number } | null {
  if (value.length > 64 || !/^bytes=\d*-\d*$/.test(value) || size <= 0) return null;
  const [left, right] = value.slice(6).split("-");
  if (!left && !right) return null;
  if (!left) {
    const suffix = Number(right);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(left), end = right ? Number(right) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}
