/**
 * Owns durable last-good snapshot storage for the gateway.
 *
 * The provider supplies verified image bytes and the HTTP server reads them
 * for Home Assistant. This store maps camera serials to hashed filenames,
 * keeps a small JSON index, serializes concurrent writes, and uses temporary
 * files plus rename for crash-safe replacement. It intentionally stores no
 * Eufy credentials or raw event metadata; a restart should recover media, not
 * recreate a cloud session from this directory.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SnapshotInfo } from "../domain/types.js";

/** One JSON index entry linking a camera serial to image metadata. */
interface SnapshotRecord {
  readonly serial: string;
  readonly info: SnapshotInfo;
}

/**
 * Last-good image store with atomic index updates.
 *
 * `write` returns only after both the image and index have been replaced. The
 * internal promise queue preserves that ordering when several push events
 * arrive together.
 */
export class SnapshotStore {
  readonly #directory: string;
  readonly #records = new Map<string, SnapshotInfo>();
  #writeQueue: Promise<void> = Promise.resolve();

  /** Create a store rooted beneath the gateway's private data directory. */
  constructor(dataDirectory: string) {
    this.#directory = join(dataDirectory, "snapshots");
  }

  /** Load the index, ignoring a first-run missing file. */
  async initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    try {
      const records = JSON.parse(await readFile(join(this.#directory, "index.json"), "utf8")) as SnapshotRecord[];
      for (const record of records) this.#records.set(record.serial, record.info);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  /** Return metadata for the retained image without reading its bytes. */
  getInfo(serial: string): SnapshotInfo | null {
    return this.#records.get(serial) ?? null;
  }

  /** Read one retained image and its metadata, or return null if absent. */
  async read(serial: string): Promise<{ data: Buffer; info: SnapshotInfo } | null> {
    const info = this.#records.get(serial);
    if (!info) return null;
    try {
      return { data: await readFile(this.#imagePath(serial)), info };
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  /** Atomically replace a camera image and advance its revision number. */
  async write(
    serial: string,
    data: Buffer,
    contentType: string,
    source: SnapshotInfo["source"],
    capturedAt = new Date(),
  ): Promise<SnapshotInfo> {
    const operation = this.#writeQueue.then(async () => {
      if (data.length === 0) throw new Error("Refusing to replace a snapshot with an empty image");
      const previous = this.#records.get(serial);
      const info: SnapshotInfo = {
        capturedAt: capturedAt.toISOString(),
        contentType,
        source,
        revision: (previous?.revision ?? 0) + 1,
      };
      await atomicWrite(this.#imagePath(serial), data);
      this.#records.set(serial, info);
      await this.#writeIndex();
      return info;
    });
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /** Retain an event image only while no live frame has become the last-good still. */
  async writeEvent(
    serial: string,
    data: Buffer,
    contentType: string,
    capturedAt = new Date(),
  ): Promise<SnapshotInfo | null> {
    const operation = this.#writeQueue.then(async () => {
      if (data.length === 0) throw new Error("Refusing to replace a snapshot with an empty image");
      const previous = this.#records.get(serial);
      if (previous?.source === "live") return null;
      const info: SnapshotInfo = {
        capturedAt: capturedAt.toISOString(),
        contentType,
        source: "event",
        revision: (previous?.revision ?? 0) + 1,
      };
      await atomicWrite(this.#imagePath(serial), data);
      this.#records.set(serial, info);
      await this.#writeIndex();
      return info;
    });
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #writeIndex(): Promise<void> {
    const records = [...this.#records.entries()].map(([serial, info]) => ({ serial, info }));
    await atomicWrite(join(this.#directory, "index.json"), Buffer.from(`${JSON.stringify(records, null, 2)}\n`));
  }

  #imagePath(serial: string): string {
    const safeName = createHash("sha256").update(serial).digest("hex");
    return join(this.#directory, `${safeName}.image`);
  }
}

async function atomicWrite(path: string, data: Buffer): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, data, { mode: 0o600 });
  await rename(temporaryPath, path);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
