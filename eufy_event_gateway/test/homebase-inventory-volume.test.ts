/**
 * Checks cached HB3 volume admission and its separation from local readback.
 * Synthetic inventory owns the inputs. No account, device or network is used,
 * and a displayed inventory reading must never confirm a volume command.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { homeBaseInventoryAlarmVolume } from "../src/provider/homebase-inventory-volume.js";
import { confirmStationWrite, initialHomeBaseState, mergeHomeBaseState, parseMegaInventory, refreshInventoryStationState } from "../src/provider/eufy-provider.js";
import type { HomeBasePpcsState } from "../src/stream/homebase-ppcs.js";

const params = (value: unknown) => [{ param_type: 1235, param_value: value }];
const device = (value: unknown) => parseMegaInventory({ devices: [{ device_sn: "station", device_model: "T8030", device_type: 18,
  category: "eufy_security", params: value }] })[0]!;
const local = (volume: number | null): HomeBasePpcsState => ({ firmware: null, guardMode: null, effectiveMode: null,
  alarmVolume: volume, alarmVolumeObservation: volume === null ? "missing" : "valid", promptVolume: null, alarmTone: null,
  storage: null, storageDiagnostic: null, childParams: [] });

test("HB3 inventory volume admits only one exact station value", () => {
  for (const value of [1, "1", 26, "26"]) assert.equal(homeBaseInventoryAlarmVolume(params(value), "T8030", 18), Number(value));
  for (const value of [0, 27, -1, 1.5, true, null, {}, "", "01", "1e1", " 10", "NaN", Infinity]) {
    assert.equal(homeBaseInventoryAlarmVolume(params(value), "T8030", 18), undefined);
  }
  for (const [model, type] of [["T8030X", 18], ["T8010", 0], ["T8030", 0], ["T8171", 88]] as const) {
    assert.equal(homeBaseInventoryAlarmVolume(params(18), model, type), undefined);
  }
  assert.equal(homeBaseInventoryAlarmVolume([...params(18), ...params(18)], "T8030", 18), undefined);
  assert.equal(homeBaseInventoryAlarmVolume([...params(18), ...params(19)], "T8030", 18), undefined);
  assert.equal(homeBaseInventoryAlarmVolume([{ ...params(18)[0], dev_type: 1 }], "T8030", 18), undefined);
  assert.equal(homeBaseInventoryAlarmVolume([{ ...params(18)[0], channel: 255, dev_type: 1 }], "T8030", 18), undefined);
  assert.equal(homeBaseInventoryAlarmVolume([{ ...params(18)[0], dev_type: "255" }], "T8030", 18), 18);
  assert.equal(homeBaseInventoryAlarmVolume([{ ...params(9)[0], dev_type: 1 }, ...params(18)], "T8030", 18), 18);
});

test("inventory fills missing volume without inventing connection or siren state", () => {
  const station = initialHomeBaseState(device(params("18")), false);
  assert.equal(station.alarmVolume, 18);
  assert.equal(station.alarmVolumeSource, "inventory");
  assert.equal(station.connected, false);
  assert.equal(station.alarmActive, null);
  assert.equal(mergeHomeBaseState(station, local(null)).alarmVolume, 18);
});

test("inventory updates its own reading without replacing confirmed local volume", async () => {
  const station = initialHomeBaseState(device(params(18)), false);
  const refreshed = refreshInventoryStationState(station, device(params(19)));
  assert.equal(refreshed.alarmVolume, 19);
  assert.equal(refreshed.alarmVolumeSource, "inventory");
  assert.equal(refreshInventoryStationState(refreshed, device([])).alarmVolume, 19);
  const observed = mergeHomeBaseState(refreshed, local(20));
  assert.equal(observed.alarmVolumeSource, "local");
  assert.equal(refreshInventoryStationState(observed, device(params(18))).alarmVolume, 20);
  assert.equal(mergeHomeBaseState(observed, local(null)).alarmVolumeSource, "local");
  await assert.rejects(confirmStationWrite("alarmVolume", 19, async () => undefined, async () => local(null)), /did not confirm alarmVolume/);
});
