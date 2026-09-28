/**
 * Protects the cross-language T817L action contract.
 *
 * The gateway advertises only hardware-proven capabilities and owns every
 * protocol write. The Python integration consumes those exact fields and
 * endpoints as state-free buttons, so it never invents persistent readback.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryPath = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("gateway and Home Assistant share one T817L action contract", async () => {
  const server = await readFile(resolve(repositoryPath, "eufy_event_gateway/src/server.ts"), "utf8");
  const client = await readFile(resolve(repositoryPath, "custom_components/eufy_event_gateway/client.py"), "utf8");
  const button = await readFile(resolve(repositoryPath, "custom_components/eufy_event_gateway/button.py"), "utf8");
  const strings = JSON.parse(
    await readFile(resolve(repositoryPath, "custom_components/eufy_event_gateway/strings.json"), "utf8"),
  ) as { entity: { button: Record<string, unknown> } };

  assert.match(server, /segments\[3\] === "preset-position"/);
  assert.match(server, /segments\[3\] === "ai-tracking"/);
  assert.match(server, /segments\[3\] === "auto-cruise"/);
  assert.match(client, /\/api\/cameras\/\{serial\}\/preset-position/);
  assert.match(client, /\/api\/cameras\/\{serial\}\/ai-tracking/);
  assert.match(client, /\/api\/cameras\/\{serial\}\/auto-cruise/);
  assert.match(button, /presetPositionControlSupported/);
  assert.match(button, /aiTrackingControlSupported/);
  assert.match(button, /autoCruiseControlSupported/);
  for (const key of [
    "camera_preset",
    "camera_preset_default",
    "camera_ai_tracking_on",
    "camera_ai_tracking_off",
    "camera_auto_cruise_on",
    "camera_auto_cruise_off",
  ]) {
    assert.ok(strings.entity.button[key]);
  }
});
