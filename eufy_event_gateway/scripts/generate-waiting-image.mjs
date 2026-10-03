/**
 * Writes the gateway's neutral waiting image into the HA offline fallback asset.
 * The gateway owns its generated pixels. This build helper owns only the shared
 * integration asset, consumed when neither an HTTP image nor a cached image exists.
 */
import { readFile, writeFile } from "node:fs/promises";
import { waitingImage } from "../src/mega/waiting-image.ts";

const asset = new URL("../../custom_components/eufy_event_gateway/waiting-image.jpg", import.meta.url);
const expected = waitingImage();
if (process.argv.includes("--check")) {
  if (!(await readFile(asset)).equals(expected)) {
    throw new Error("The HA waiting image differs from the gateway asset. Regenerate it before committing.");
  }
} else {
  await writeFile(asset, expected);
}
