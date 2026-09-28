/**
 * Protects the cross-language T817L action contract.
 *
 * The gateway advertises hardware-proven preset discovery and movement while
 * keeping tracking and cruise hidden until local acknowledgement or readback
 * exists. The Python integration consumes only the resulting preset contract.
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
  assert.match(client, /\/api\/cameras\/\{serial\}\/preset-position/);
  assert.match(button, /presetPositionControlSupported/);
  assert.doesNotMatch(server, /segments\[3\] === "ai-tracking"/);
  assert.doesNotMatch(server, /segments\[3\] === "auto-cruise"/);
  assert.doesNotMatch(button, /aiTrackingControlSupported|autoCruiseControlSupported/);
  for (const key of ["camera_preset", "camera_preset_default"]) {
    assert.ok(strings.entity.button[key]);
  }
  for (const key of [
    "camera_ai_tracking_on",
    "camera_ai_tracking_off",
    "camera_auto_cruise_on",
    "camera_auto_cruise_off",
  ]) {
    assert.equal(strings.entity.button[key], undefined);
  }
});
