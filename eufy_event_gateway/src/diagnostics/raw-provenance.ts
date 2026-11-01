/**
 * Fingerprints the gateway code tree and dependency lock for retained evidence.
 * The composition root reads only its installed code directory before recording
 * starts. Runtime data, credentials and journal files live outside that tree.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** Bind a recording session to installed code bytes and locked dependencies. */
export async function rawBuildFingerprint(root = new URL("../", import.meta.url)): Promise<string> {
  const hash = createHash("sha256");
  const directory = fileURLToPath(root);
  async function visit(relative: string): Promise<void> {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Cannot qualify linked gateway code");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(?:js|ts)$/.test(entry.name)) {
        hash.update(path); hash.update("\0"); hash.update(await readFile(join(directory, path))); hash.update("\0");
      }
    }
  }
  await visit("");
  hash.update(await readFile(new URL("../package-lock.json", root)));
  return hash.digest("hex");
}
