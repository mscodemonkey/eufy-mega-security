/**
 * Checks the separate T85V0 AA reading through inventory and provider state.
 * Synthetic cloud rows own every input. No device, key or hardware claim is used.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeInventoryReads, EufyProvider } from "../src/provider/eufy-provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { ProviderEvents } from "../src/provider/provider.js";

for (const value of [1, "57", 100]) test(`T85V0 keeps backup percentage ${value} separate from primary battery`, () => {
  const reads = safeInventoryReads([{ param_type: 1101, param_value: 93 }, { param_type: 6485, param_value: value }], 203, "T85V0");
  assert.equal(reads.batteryLevel, 93); assert.equal(reads.backupBatteryLevel, Number(value));
});

test("T85V0 unavailable, malformed and ambiguous AA values cannot become a percentage", () => {
  for (const value of [undefined, null, false, true, "", " ", 0, "0", 255, "255", -1, 101, 1.5, "1.5", "5e1", {}, [], NaN]) {
    assert.equal(safeInventoryReads([{ param_type: 6485, param_value: value }], 203, "T85V0").backupBatteryLevel, undefined);
  }
  assert.equal(safeInventoryReads([{ param_type: 1101, param_value: 90 }], 203, "T85V0").backupBatteryLevel, undefined);
  assert.equal(safeInventoryReads([{ param_type: 6485, param_value: 60 }, { param_type: "6485", param_value: 70 }], 203, "T85V0").backupBatteryLevel, undefined);
  for (const [type, model] of [[203, "T85V0C"], [202, "T85V0"], [203, "T85M0"], [48, "T8170"]] as const) {
    assert.equal(safeInventoryReads([{ param_type: 6485, param_value: 60 }], type, model).backupBatteryLevel, undefined);
  }
});

for (const main of [false, true]) test(`provider publishes a reported AA field with primary present=${main}`, async context => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-aa-test-"));
  context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ device_sn: "synthetic-lock", device_model: "T85V0", device_type: 203,
    category: "eufy_security", parent_sn: "synthetic-parent", device_channel: 0,
    params: [...(main ? [{ param_type: 1101, param_value: "93" }] : []), { param_type: 6485, param_value: "57" }] }] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
  const state = new GatewayState();
  const events = new Proxy({ camera: (value: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(value) },
    { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: directory, maxStreamSeconds: 120 });
  try {
    await provider.start(events);
    const battery = state.getCamera("synthetic-lock").battery!;
    assert.ok(battery.supported.includes("backupLevel"));
    assert.equal(battery.backupLevel, 57); assert.equal(battery.level, main ? 93 : null);
    assert.equal(battery.supported.includes("level"), main);
  } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
