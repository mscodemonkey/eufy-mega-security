/**
 * Owns durable last-good snapshot storage for the gateway.
 *
 * The provider supplies verified image bytes and the HTTP server reads them
 * for Home Assistant. This store maps camera serials to hashed filenames,
 * keeps separate still and event-image indexes, serializes concurrent writes,
 * and uses temporary files plus rename for crash-safe replacement. It
 * intentionally stores no
 * Eufy credentials or raw event metadata; a restart should recover media, not
 * recreate a cloud session from this directory.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SnapshotInfo } from "../domain/types.js";
import { repairRetainedEventImage } from "../mega/image.js";

/** One JSON index entry linking a camera serial to image metadata. */
interface SnapshotRecord {
  readonly serial: string;
  readonly info: SnapshotInfo;
}

/**
 * Last-good still and event-image store with atomic index updates.
 *
 * `write` returns only after both the image and index have been replaced. The
 * internal promise queue preserves that ordering when several push events
 * arrive together.
 */
export class SnapshotStore {
  readonly #directory: string;
  readonly #records = new Map<string, SnapshotInfo>();
  readonly #eventRecords = new Map<string, SnapshotInfo>();
  #writeQueue: Promise<void> = Promise.resolve();

  /** Create a store rooted beneath the gateway's private data directory. */
  constructor(dataDirectory: string) {
    this.#directory = join(dataDirectory, "snapshots");
  }

  /** Load the index, ignoring a first-run missing file. */
  async initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await this.#loadIndex("index.json", this.#records);
    await this.#loadIndex("event-index.json", this.#eventRecords);
    await this.#repairEventHeaders();
    await this.#migrateRetainedEventImages();
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

  /** Return metadata for the latest event image without reading its bytes. */
  getEventInfo(serial: string): SnapshotInfo | null {
    return this.#eventRecords.get(serial) ?? null;
  }

  /** Read the latest event image and its metadata, or return null if absent. */
  async readEvent(serial: string): Promise<{ data: Buffer; info: SnapshotInfo } | null> {
    const info = this.#eventRecords.get(serial);
    if (!info) return null;
    try {
      return { data: await readFile(this.#eventImagePath(serial)), info };
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

  /**
   * Retain every event image separately and preserve an existing live still.
   *
   * The event image always advances its own revision. The main snapshot is
   * also updated until a live frame exists, preserving the original camera
   * entity behaviour without allowing a later event to replace that frame.
   */
  async writeEvent(
    serial: string,
    data: Buffer,
    contentType: string,
    capturedAt = new Date(),
  ): Promise<{ eventImage: SnapshotInfo; snapshot: SnapshotInfo | null }> {
    const operation = this.#writeQueue.then(async () => {
      if (data.length === 0) throw new Error("Refusing to replace a snapshot with an empty image");
      const previousEvent = this.#eventRecords.get(serial);
      const eventImage: SnapshotInfo = {
        capturedAt: capturedAt.toISOString(),
        contentType,
        source: "event",
        revision: (previousEvent?.revision ?? 0) + 1,
      };
      await atomicWrite(this.#eventImagePath(serial), data);
      this.#eventRecords.set(serial, eventImage);
      await this.#writeEventIndex();

      const previous = this.#records.get(serial);
      if (previous?.source === "live") return { eventImage, snapshot: null };
      const snapshot: SnapshotInfo = {
        capturedAt: capturedAt.toISOString(),
        contentType,
        source: "event",
        revision: (previous?.revision ?? 0) + 1,
      };
      await atomicWrite(this.#imagePath(serial), data);
      this.#records.set(serial, snapshot);
      await this.#writeIndex();
      return { eventImage, snapshot };
    });
    this.#writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #writeIndex(): Promise<void> {
    const records = [...this.#records.entries()].map(([serial, info]) => ({ serial, info }));
    await atomicWrite(join(this.#directory, "index.json"), Buffer.from(`${JSON.stringify(records, null, 2)}\n`));
  }

  async #writeEventIndex(): Promise<void> {
    const records = [...this.#eventRecords.entries()].map(([serial, info]) => ({ serial, info }));
    await atomicWrite(join(this.#directory, "event-index.json"), Buffer.from(`${JSON.stringify(records, null, 2)}\n`));
  }

  async #loadIndex(filename: string, destination: Map<string, SnapshotInfo>): Promise<void> {
    try {
      const records = JSON.parse(await readFile(join(this.#directory, filename), "utf8")) as SnapshotRecord[];
      for (const record of records) {
        const path = filename === "event-index.json" ? this.#eventImagePath(record.serial) : this.#imagePath(record.serial);
        try {
          if ((await stat(path)).size > 0) destination.set(record.serial, record.info);
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  async #migrateRetainedEventImages(): Promise<void> {
    let changed = false;
    for (const [serial, info] of this.#records) {
      if (info.source !== "event" || this.#eventRecords.has(serial)) continue;
      try {
        await atomicWrite(this.#eventImagePath(serial), await readFile(this.#imagePath(serial)));
      } catch (error) {
        if (isMissingFile(error)) continue;
        throw error;
      }
      this.#eventRecords.set(serial, info);
      changed = true;
    }
    if (changed) await this.#writeEventIndex();
  }

  async #repairEventHeaders(): Promise<void> {
    for (const [records, event] of [[this.#records, false], [this.#eventRecords, true]] as const) {
      let changed = false;
      for (const [serial, info] of records) {
        if (info.source !== "event") continue;
        const path = event ? this.#eventImagePath(serial) : this.#imagePath(serial);
        try {
          const previous = await readFile(path);
          const recovered = repairRetainedEventImage(previous);
          if (recovered === previous) continue;
          await atomicWrite(path, recovered);
          records.set(serial, { ...info, revision: info.revision + 1 });
          changed = true;
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
      }
      if (changed) await (event ? this.#writeEventIndex() : this.#writeIndex());
    }
  }

  #imagePath(serial: string): string {
    const safeName = createHash("sha256").update(serial).digest("hex");
    return join(this.#directory, `${safeName}.image`);
  }

  #eventImagePath(serial: string): string {
    const safeName = createHash("sha256").update(serial).digest("hex");
    return join(this.#directory, `${safeName}.event-image`);
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
