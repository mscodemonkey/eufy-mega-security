/**
 * Locks down inventory value and merge semantics across the provider extraction.
 *
 * The fixtures own their raw rows and compare the normalized values consumed by
 * the provider. They create no sessions or Home Assistant state.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as provider from "../src/provider/eufy-provider.js";
import {
  inventoryBindingChanged, mergeInventoryMetadata, parseMegaInventory, safeInventoryReads,
} from "../src/provider/inventory-normalization.js";

const e30 = { device_model: "T8171", device_type: 88, category: "eufy_security" };
const params = [
  { param_type: 1011, param_value: 1 },
  { param_type: 6040, param_value: 0 },
  { param_type: 1101, param_value: 0 },
  { param_type: 2111, param_value: 0 },
];
const unknownFields = {
  parentSerial: "", deviceType: null, category: null, channel: null, p2pDid: null,
  p2pConnection: null, localAddress: null, cipherId: null, adminUserId: null,
  userName: null, firmware: null, hardwareVersion: null, firmwareSubVersion: null,
  firmwareUpdateAvailable: null, paramTypes: [], reads: {},
};
const cameraFields = {
  ...unknownFields, name: "T8171", model: "T8171", deviceType: 88,
  category: "eufy_security", paramTypes: [1011, 1101, 2111, 6040],
};

test("preserves the provider entry points and normalizes partial and route-specific rows", () => {
  assert.equal(provider.parseMegaInventory, parseMegaInventory);
  assert.equal(provider.mergeInventoryMetadata, mergeInventoryMetadata);
  assert.equal(provider.safeInventoryReads, safeInventoryReads);

  assert.deepEqual(parseMegaInventory(null), []);
  assert.deepEqual(parseMegaInventory({ devices: {} }), []);
  assert.deepEqual(parseMegaInventory({ devices: [
    null,
    { device_sn: "partial", main_sw_version: "1.2.3" },
    { device_sn: "direct", ...e30, device_channel: 0, charging_days: 0, params },
    { device_sn: "hub", device_model: "T8030", device_type: 18, category: "eufy_security", member: { admin_user_id: "fixture-owner" } },
    { device_sn: "child", ...e30, parent_sn: "hub", device_channel: 1, params },
  ] }), [
    { ...unknownFields, serial: "partial", name: "Unknown Eufy device", model: "Unknown Eufy device", firmware: "1.2.3" },
    { ...cameraFields, serial: "direct", channel: 0,
      reads: { motionDetectionEnabled: false, batteryLevel: 0, batteryCharging: false, lastChargingDays: 0 } },
    { ...unknownFields, serial: "hub", name: "T8030", model: "T8030", deviceType: 18,
      category: "eufy_security", adminUserId: "fixture-owner" },
    { ...cameraFields, serial: "child", parentSerial: "hub", channel: 1, adminUserId: "fixture-owner",
      reads: { t8171OutdoorMode: false, motionDetectionEnabled: true, batteryLevel: 0, batteryCharging: false } },
  ]);
});

test("retains the backup battery value only for an exact lock with unambiguous input", () => {
  const backup = { param_type: 6485, param_value: 37 };
  assert.deepEqual(safeInventoryReads([backup], 203, "T85V0", true), { backupBatteryLevel: 37 });
  assert.deepEqual(safeInventoryReads([backup], 203, "T85V0S", true), {});
  assert.deepEqual(safeInventoryReads([backup, backup], 203, "T85V0", true), {});
  assert.deepEqual(safeInventoryReads({ 6485: 37 }), {});
});

test("reconciles optional charging history only within the existing binding", () => {
  const base = { device_sn: "camera", ...e30, device_channel: 0 };
  const [existing] = parseMegaInventory({ devices: [{ ...base, charging_days: 0, params: [{ param_type: 6040, param_value: 1 }] }] });
  const [fresh] = parseMegaInventory({ devices: [{ ...base, params }] });
  const [partial] = parseMegaInventory({ devices: [{ device_sn: "camera", main_sw_version: "3.4.5", needUpdate: false }] });
  assert.ok(existing && fresh && partial);
  assert.equal(inventoryBindingChanged(existing, fresh), false);
  assert.deepEqual(mergeInventoryMetadata(existing, fresh, true), {
    ...fresh, reads: { motionDetectionEnabled: false, batteryLevel: 0, batteryCharging: false, lastChargingDays: 0 },
  });
  assert.deepEqual(mergeInventoryMetadata(existing, fresh), fresh);
  assert.deepEqual(mergeInventoryMetadata(existing, partial, true), {
    ...existing, firmware: "3.4.5", firmwareUpdateAvailable: false,
  });

  for (const changed of [{ ...fresh, channel: 1 }, { ...fresh, parentSerial: "other-hub" }]) {
    assert.equal(inventoryBindingChanged(existing, changed), true);
    assert.deepEqual(mergeInventoryMetadata(existing, changed, true), changed);
  }
  assert.throws(() => mergeInventoryMetadata(existing, { ...fresh, serial: "other" }), /ownership changed/);
});
