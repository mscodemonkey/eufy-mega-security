/**
 * Protects generation-specific HomeBase storage entity discovery.
 *
 * The gateway names the media supported by each station model. Home Assistant
 * must consume that list instead of exposing HomeBase 3 media on HomeBase 2.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryPath = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("Home Assistant creates only the storage media advertised by the gateway", async () => {
  const provider = await readFile(
    resolve(repositoryPath, "eufy_event_gateway/src/provider/eufy-provider.ts"),
    "utf8",
  );
  const sensor = await readFile(
    resolve(repositoryPath, "custom_components/eufy_event_gateway/sensor.py"),
    "utf8",
  );

  assert.match(provider, /controlsSupported \? \["emmc", "hdd"\] : homeBase2 \? \["sd"\] : \[\]/);
  assert.match(sensor, /station\.get\("storageSupported"\)/);
  assert.match(sensor, /\{"sd": "SD card", "emmc": "eMMC", "hdd": "HDD"\}/);
});
