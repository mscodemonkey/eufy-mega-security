/**
 * Protects the standalone-camera alarm contract across gateway and Home Assistant.
 *
 * The gateway owns protocol validation and confirmed readback. The Python
 * integration creates an alarm panel only from that explicit capability and
 * must not advertise a nonexistent Home Assistant disarm feature flag.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryPath = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("gateway and Home Assistant share the confirmed standalone alarm contract", async () => {
  const server = await readFile(resolve(repositoryPath, "eufy_event_gateway/src/server.ts"), "utf8");
  const client = await readFile(resolve(repositoryPath, "custom_components/eufy_event_gateway/client.py"), "utf8");
  const alarm = await readFile(
    resolve(repositoryPath, "custom_components/eufy_event_gateway/alarm_control_panel.py"),
    "utf8",
  );
  const integration = await readFile(
    resolve(repositoryPath, "custom_components/eufy_event_gateway/__init__.py"),
    "utf8",
  );
  const strings = JSON.parse(
    await readFile(resolve(repositoryPath, "custom_components/eufy_event_gateway/strings.json"), "utf8"),
  ) as { entity: { alarm_control_panel: Record<string, unknown> } };

  assert.match(server, /segments\[3\] === "guard-mode"/);
  assert.match(server, /provider\.setCameraGuardMode\(serial, requiredInteger\(body\.mode\)\)/);
  assert.match(client, /\/api\/cameras\/\{serial\}\/guard-mode/);
  assert.match(client, /\/api\/cameras\/\{serial\}\/refresh-capabilities/);
  assert.match(alarm, /camera\.get\("guardModeControlSupported"\) is True/);
  assert.match(integration, /camera\.get\("guardModeRefreshSupported"\) is True/);
  assert.match(integration, /asyncio\.timeout\(_CAPABILITY_REFRESH_TIMEOUT_SECONDS\)/);
  assert.match(integration, /except \(GatewayClientError, TimeoutError\)/);
  assert.match(integration, /coordinator\.async_set_camera\(camera\)/);
  assert.doesNotMatch(alarm, /AlarmControlPanelEntityFeature\.DISARM/);
  assert.ok(strings.entity.alarm_control_panel.eufy_standalone_camera_alarm);
});
