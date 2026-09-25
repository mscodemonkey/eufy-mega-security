/**
 * Protects the cross-language timed camera-light contract.
 *
 * The TypeScript gateway advertises the capability and owns the command. The
 * Python integration consumes that exact field and endpoint to create two
 * state-free actions without importing Home Assistant into this test process.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryPath = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("gateway and Home Assistant share one timed light contract", async () => {
  const server = await readFile(resolve(repositoryPath, "eufy_event_gateway/src/server.ts"), "utf8");
  const client = await readFile(resolve(repositoryPath, "custom_components/eufy_event_gateway/client.py"), "utf8");
  const button = await readFile(resolve(repositoryPath, "custom_components/eufy_event_gateway/button.py"), "utf8");
  const strings = JSON.parse(
    await readFile(resolve(repositoryPath, "custom_components/eufy_event_gateway/strings.json"), "utf8"),
  ) as { entity: { button: Record<string, unknown> } };

  assert.match(server, /segments\[3\] === "light"/);
  assert.match(server, /provider\.setCameraLight\(serial, requiredBoolean\(body\.enabled\)\)/);
  assert.match(client, /\/api\/cameras\/\{serial\}\/light/);
  assert.match(button, /timedLightControlSupported/);
  assert.ok(strings.entity.button.camera_light_on);
  assert.ok(strings.entity.button.camera_light_off);
});
