/**
 * Private encrypted receive/send history owned by one gateway process. Transport
 * boundaries submit copies before parsing. A bounded asynchronous writer owns
 * rotation and retention, never blocking or failing the neighbouring protocol.
 * These files and their local key must never enter ordinary diagnostic bundles.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, lstat, chmod, unlink, statfs, rename, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

/** Limits include ciphertext overhead. The reserve protects the host's other data. */
export interface RawHistoryOptions {
  directory: string;
  buildFingerprint?: string;
  maximumBytes?: number;
  maximumAgeMs?: number;
  segmentBytes?: number;
  queueBytes?: number;
  reserveBytes?: number;
}

/** Metadata is private too. Connection IDs associate observations, not causal proof. */
export interface RawObservation {
  boundary: string;
  connection: string;
  direction: "receive" | "send" | "state" | "decode" | "encode";
  metadata?: unknown;
}

/**
 * Owns the encryption key, queue and segment handles until close. Callers own
 * network activity. Each record authenticates its own bytes, so a crash can lose
 * the last incomplete record without making older records undecryptable.
 */
export class RawHistory {
  readonly session = randomUUID();
  private key = Buffer.alloc(0);
  private file: FileHandle | undefined;
  private fileBytes = 0;
  private fileName: string | undefined;
  private fileTime = 0;
  private checkpoint = false;
  private readonly queue: Buffer[] = [];
  private queuedBytes = 0;
  private writer: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private sequence = 0;
  private accepted = 0;
  private written = 0;
  private dropped = 0;
  private ioErrors = 0;
  private retryAt = 0;
  private evictedFiles = 0;
  private evictedBytes = 0;
  private lastWrite: number | null = null;
  private readonly maximumBytes: number;
  private readonly maximumAgeMs: number;
  private readonly segmentBytes: number;
  private readonly queueLimit: number;
  private readonly reserveBytes: number;

  constructor(private readonly options: RawHistoryOptions) {
    this.maximumBytes = options.maximumBytes ?? 1024 ** 3;
    this.maximumAgeMs = options.maximumAgeMs ?? 24 * 60 * 60 * 1000;
    this.segmentBytes = options.segmentBytes ?? 8 * 1024 ** 2;
    this.queueLimit = options.queueBytes ?? 8 * 1024 ** 2;
    this.reserveBytes = options.reserveBytes ?? 256 * 1024 ** 2;
    for (const value of [this.maximumBytes, this.maximumAgeMs, this.segmentBytes, this.queueLimit, this.reserveBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid raw history limit");
    }
    if (this.segmentBytes > this.maximumBytes) throw new Error("Raw history segment exceeds retention");
  }

  /** Refuse unsafe storage rather than weakening permissions or writing plaintext. */
  async initialize(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.options.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe raw history directory");
    await chmod(this.options.directory, 0o700);
    const keyPath = join(this.options.directory, "key");
    let handle: FileHandle;
    try {
      handle = await open(keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o077) !== 0) throw new Error("Unsafe raw history key");
      this.key = await handle.readFile();
    } finally { await handle.close(); }
    try { await this.maintain(); } catch (error) { this.key.fill(0); throw error; }
    this.timer = setInterval(() => { void this.flush(); }, 5000);
    this.timer.unref();
  }

  /** Copy bytes now. Queue pressure or invalid metadata loses diagnostics, never traffic. */
  record(observation: RawObservation, bytes: Uint8Array = Buffer.alloc(0)): void {
    if (this.closed || this.key.length !== 32) return;
    const sequence = ++this.sequence;
    if (Date.now() < this.retryAt) { this.dropped++; return; }
    if (bytes.byteLength > 4 * 1024 ** 2 || this.queuedBytes + bytes.byteLength * 1.4 + 1024 > this.queueLimit) {
      this.dropped++; return;
    }
    try {
      const record = Buffer.from(JSON.stringify({ format: 1, build: this.options.buildFingerprint ?? "unqualified", session: this.session, sequence,
        realtimeMs: Date.now(), monotonicNs: process.hrtime.bigint().toString(), ...observation,
        bytes: Buffer.from(bytes).toString("base64") }));
      if (record.length > this.queueLimit || this.queuedBytes + record.length > this.queueLimit) {
        record.fill(0); this.dropped++; return;
      }
      this.queue.push(record); this.queuedBytes += record.length; this.accepted++;
      this.startWriter();
    } catch { this.dropped++; }
  }

  /** Counts contain no endpoints, payloads or device identities. */
  status(): object {
    return { format: 1, build: this.options.buildFingerprint ?? "unqualified", session: this.session, active: !this.closed && this.key.length === 32,
      accepted: this.accepted, written: this.written, dropped: this.dropped, ioErrors: this.ioErrors,
      queuedBytes: this.queuedBytes, evictedFiles: this.evictedFiles, evictedBytes: this.evictedBytes,
      lastWrite: this.lastWrite, maximumBytes: this.maximumBytes, maximumAgeMs: this.maximumAgeMs,
      coverage: "instrumented_application_boundaries_only", encryption: "AES-256-GCM-per-record" };
  }

  /** Drain accepted entries and persist aggregate status without publishing raw files. */
  async flush(): Promise<void> {
    this.checkpoint = true;
    this.startWriter();
    while (this.writer) await this.writer;
  }

  /** List ciphertext segments for an explicit private snapshot, never the key. */
  async files(): Promise<{ name: string; bytes: number }[]> {
    const result: { name: string; bytes: number }[] = [];
    for (const name of await readdir(this.options.directory)) {
      if (!/^\d+-[a-f0-9-]+\.raw$/.test(name)) continue;
      try {
        const stat = await lstat(join(this.options.directory, name));
        if (stat.isFile() && !stat.isSymbolicLink()) result.push({ name, bytes: stat.size });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Read only a named journal file after the caller checks private-raw consent.
   * The local key is deliberately available only through this explicit private
   * export. A fixed stat-sized prefix prevents a growing active file from making
   * the download unbounded. Its final record may be incomplete.
   */
  async privateFile(name: string): Promise<Buffer> {
    if (name !== "key" && !/^\d+-[a-f0-9-]+\.raw$/.test(name)) throw new Error("Invalid raw history file");
    const handle = await open(join(this.options.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.segmentBytes || name === "key" && stat.size !== 32) throw new Error("Invalid raw history file");
      const result = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < result.length) {
        const read = await handle.read(result, offset, result.length - offset, offset);
        if (!read.bytesRead) throw new Error("Raw history file changed");
        offset += read.bytesRead;
      }
      return result;
    } finally { await handle.close(); }
  }

  /** Stop admission, drain and close storage. Protocol owners must stop first. */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.flush();
    await this.file?.close(); this.file = undefined; this.key.fill(0);
  }

  private startWriter(): void {
    if (this.writer) return;
    this.writer = this.drain().finally(() => { this.writer = undefined; if (this.queue.length || this.checkpoint) this.startWriter(); });
  }

  private async drain(): Promise<void> {
    while (this.queue.length || this.checkpoint) {
      if (!this.queue.length) {
        this.checkpoint = false;
        try {
          await this.file?.sync();
          if (this.file && Date.now() - this.fileTime > this.maximumAgeMs) {
            await this.file.close(); this.file = undefined; this.fileName = undefined;
          }
          await this.maintain();
        } catch { this.ioErrors++; }
        continue;
      }
      const record = this.queue.shift()!;
      try {
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
        cipher.setAAD(Buffer.from("EMS-RAW-1"));
        const encrypted = Buffer.concat([cipher.update(record), cipher.final()]);
        const size = Buffer.alloc(4); size.writeUInt32BE(12 + 16 + encrypted.length);
        const frame = Buffer.concat([size, nonce, cipher.getAuthTag(), encrypted]);
        if (frame.length > this.segmentBytes) throw new Error("Raw history frame exceeds segment");
        if (!this.file || this.fileBytes + frame.length > this.segmentBytes) {
          await this.file?.sync(); await this.file?.close(); this.file = undefined; this.fileName = undefined;
          await this.maintain(this.segmentBytes);
          const disk = await statfs(this.options.directory);
          if (disk.bavail * disk.bsize < this.reserveBytes + this.segmentBytes) throw new Error("Raw history reserve");
          this.fileTime = Date.now();
          this.fileName = `${this.fileTime}-${randomUUID()}.raw`;
          this.file = await open(join(this.options.directory, this.fileName), "wx", 0o600);
          this.fileBytes = 0;
        }
        let offset = 0;
        while (offset < frame.length) {
          const result = await this.file.write(frame, offset, frame.length - offset);
          if (!result.bytesWritten) throw new Error("Raw history short write");
          offset += result.bytesWritten;
        }
        this.fileBytes += frame.length; this.written++; this.lastWrite = Date.now();
      } catch {
        this.ioErrors++; this.dropped++; this.retryAt = Date.now() + 5000;
        await this.file?.close().catch(() => undefined); this.file = undefined;
      } finally { this.queuedBytes -= record.length; record.fill(0); }
    }
  }

  private async maintain(required = 0): Promise<void> {
    const entries = [];
    for (const name of await readdir(this.options.directory)) {
      if (!/^\d+-[a-f0-9-]+\.raw$/.test(name)) continue;
      const stat = await lstat(join(this.options.directory, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe raw history segment");
      entries.push({ name, size: stat.size, time: Number(name.split("-")[0]) });
    }
    entries.sort((a, b) => a.time - b.time);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (Date.now() - entry.time <= this.maximumAgeMs && total + required <= this.maximumBytes) break;
      if (entry.name === this.fileName) continue;
      await unlink(join(this.options.directory, entry.name));
      total -= entry.size; this.evictedFiles++; this.evictedBytes += entry.size;
    }
    const pending = join(this.options.directory, "status.pending");
    const handle = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(this.status())); } finally { await handle.close(); }
    await rename(pending, join(this.options.directory, "status.json"));
  }
}

/** Decrypt one segment offline. An incomplete crash tail is explicitly reported. */
export function decodeRawSegment(bytes: Buffer, key: Buffer): { records: unknown[]; incompleteTail: boolean } {
  const records: unknown[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 4) return { records, incompleteTail: true };
    const size = bytes.readUInt32BE(offset);
    if (size < 28 || size > 16 * 1024 ** 2) throw new Error("Invalid raw history frame");
    if (bytes.length - offset - 4 < size) return { records, incompleteTail: true };
    const frame = bytes.subarray(offset + 4, offset + 4 + size);
    const decipher = createDecipheriv("aes-256-gcm", key, frame.subarray(0, 12));
    decipher.setAAD(Buffer.from("EMS-RAW-1")); decipher.setAuthTag(frame.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(frame.subarray(28)), decipher.final()]);
    try { records.push(JSON.parse(plaintext.toString("utf8"))); } finally { plaintext.fill(0); }
    offset += 4 + size;
  }
  return { records, incompleteTail: false };
}

let current: RawHistory | undefined;
let startupFailed = false;

/** The composition root owns installation and shutdown. Tests can clear this sink. */
export function setRawHistory(history: RawHistory | undefined, failed = false): void { current = history; startupFailed = failed; }

/** A disabled recorder is inert. The sink never propagates diagnostics failures. */
export function recordRaw(observation: RawObservation, bytes?: Uint8Array): void { current?.record(observation, bytes); }

/** Whether the process composition root has installed the private recorder. */
export function rawHistoryEnabled(): boolean { return current !== undefined; }

/** Aggregate health for the authenticated diagnostics page, with no raw export. */
export function rawHistoryStatus(): object { return current?.status() ?? { active: false, startupFailed }; }

/** Fixed private inventory for an authenticated operator snapshot. */
export async function rawHistoryFiles(): Promise<{ name: string; bytes: number }[]> { return current?.files() ?? []; }

/** Export a fixed journal file only after the HTTP boundary validates consent. */
export async function rawHistoryPrivateFile(name: string): Promise<Buffer | undefined> { return current?.privateFile(name); }
