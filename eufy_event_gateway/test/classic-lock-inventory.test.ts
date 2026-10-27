/**
 * Protects the opt-in inventory-only lock profile with synthetic cloud rows.
 * Tests own all identities and timestamps. No socket, credential or actuator
 * is available to this projector or to its authenticated API consumers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { MegaDevice } from "../src/mega/types.js";
import { classicLockInventory } from "../src/provider/classic-lock-inventory.js";
import { maskSmartLockState } from "../src/domain/types.js";

const now = 1_800_000_000_000;
const base: MegaDevice = { device_sn: "fixture", device_model: "T8520", device_type: 51, category: "eufy_security",
  device_name: "Synthetic lock", params: [{ param_type: 6000, param_value: "4" }, { param_type: 6001, param_value: "80" }] };

for (const model of ["T8520", "T8520J11", "T8520S"]) {
  test(`read-only lock profile admits exact direct ${model} without motor authority`, () => {
    const [state] = classicLockInventory([{ ...base, device_model: model }], true, now);
    assert.equal(state?.model, model); assert.equal(state?.readOnly, true); assert.equal(state?.observationSource, "cloud_inventory");
    assert.equal(state?.state, "locked"); assert.equal(state?.batteryPercent, 80); assert.equal(state?.available, true);
    assert.equal(state?.stateObservedAt, new Date(now).toISOString());
    assert.equal(state?.settings, undefined);
    assert.equal(maskSmartLockState(state!, now + 360_001).available, false);
  });
}

test("default-off, unproven identity, duplicate identities and invalid clock refuse admission", () => {
  assert.deepEqual(classicLockInventory([base], false, now), []);
  assert.equal(classicLockInventory([null, false, 7, "invalid", [], base] as unknown as MegaDevice[], true, now).length, 1);
  for (const change of [{ device_model: "T8520P" }, { device_model: "T8520N" }, { device_model: "t8520" }, { device_type: 53 },
    { device_type: "51" }, { category: "eufy_home" }, { parent_sn: "station" }, { station_sn: "station" }, { device_sn: "" }]) {
    assert.deepEqual(classicLockInventory([{ ...base, ...change } as MegaDevice], true, now), []);
  }
  assert.deepEqual(classicLockInventory([base, { ...base, device_model: "T8520S" }], true, now), []);
  for (const stamp of [NaN, Infinity, -1, 8_640_000_000_000_001]) assert.deepEqual(classicLockInventory([base], true, stamp), []);
});

test("only settled status values are named and malformed battery never borrows another field", () => {
  for (const value of ["1", "2", "5", "6", "7", "", "04", " 4", "locked", "false"]) {
    const [state] = classicLockInventory([{ ...base, params: [{ param_type: 6000, param_value: value }] }], true, now);
    assert.equal(state?.state, "unknown"); assert.equal(state?.batteryPercent, null);
  }
  assert.equal(classicLockInventory([{ ...base, params: [{ param_type: 6000, param_value: "3" }] }], true, now)[0]?.state, "unlocked");
  const invalid = classicLockInventory([{ ...base, params: [{ param_type: 6001, param_value: "101" }, { param_type: 1101, param_value: "80" }] }], true, now)[0]!;
  assert.equal(invalid.batteryPercent, null);
  assert.equal(classicLockInventory([{ ...base, params: [{ param_type: 1101, param_value: "0" }] }], true, now)[0]?.batteryPercent, 0);
});

test("duplicate numeric/string candidates stay unknown and raw fields never leave the projection", () => {
  const rows = [{ ...base, member: { admin_user_id: "SENTINEL_PRIVATE" }, private: "SENTINEL_PRIVATE", params: [
    { param_type: 6000, param_value: "3" }, { param_type: "6000", param_value: "3" }, { param_type: 6000, param_value: "3" },
    { param_type: 6001, param_value: "20" }, { param_type: 6001, param_value: "20" },
    { param_type: 9999, param_value: "SENTINEL_PRIVATE" },
  ] } as unknown as MegaDevice];
  const [state] = classicLockInventory(rows, true, now);
  assert.equal(state?.state, "unknown"); assert.equal(state?.batteryPercent, null);
  assert.doesNotMatch(JSON.stringify(state), /SENTINEL|admin_user|member|9999/);
});
