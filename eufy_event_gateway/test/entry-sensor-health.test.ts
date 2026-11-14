/**
 * Checks entry-sensor health from raw inventory through the published sensor DTO.
 * Invented parameter rows own all fixtures. No HomeBase, sensor or account is
 * contacted. Tests keep unknown, wrong-family and conflicting readings explicit.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { entrySensorHealth } from "../src/provider/entry-sensor-health.js";
import { parseMegaInventory, publishHomeBaseChildSensorObservation } from "../src/provider/eufy-provider.js";
import { describeDeviceCapabilities } from "../src/provider/device-capabilities-core.js";
import type { SecuritySensorState } from "../src/domain/types.js";

const param = (id: number, value: unknown) => ({ param_type: id, param_value: value });

/** Project the actual inventory adapter without starting its account lifecycle. */
function project(params: unknown[], model = "T8900", deviceType = 2): SecuritySensorState | null {
  const device = parseMegaInventory({ devices: [{ device_sn: "invented-sensor", device_model: model,
    device_type: deviceType, category: "eufy_security", main_sw_version: "1.2.3", params }] })[0]!;
  let sensor: SecuritySensorState | null = null;
  publishHomeBaseChildSensorObservation(device, { sensor: value => { sensor = value; } });
  return sensor;
}

test("only explicit known status and low-power values become sensor health", () => {
  for (let status = 0; status <= 5; status++) {
    assert.deepEqual(entrySensorHealth([param(1131, String(status)), param(1552, "0")], "T8900", 2),
      { entrySensorConnected: status === 1, entrySensorBatteryLow: false });
  }
  assert.deepEqual(entrySensorHealth([param(1552, 1)], "T8900", 2), { entrySensorBatteryLow: true });
  for (const value of [undefined, null, true, false, "", "true", "01", "1.0", "unknown", [], {}, -1, 6, 1.5]) {
    assert.deepEqual(entrySensorHealth([param(1131, value), param(1552, value)], "T8900", 2), {});
  }
  assert.deepEqual(entrySensorHealth([param(1552, 2)], "T8900", 2), {});
});

test("missing fields, another family's battery bit and duplicates never invent health", () => {
  for (const rows of [[], [param(1601, "1")], [param(1131, 1), param(1131, 1)],
    [param(1552, 0), { param_type: "1552", param_value: 1 }]]) {
    assert.deepEqual(entrySensorHealth(rows, "T8900", 2), {});
  }
  assert.deepEqual(entrySensorHealth(null, "T8900", 2), {});
  for (const [model, type] of [["T8910", 10], ["T8900", 10], ["T89000D1", 2]] as const) {
    assert.deepEqual(entrySensorHealth([param(1131, 1), param(1552, 0)], model, type), {});
  }
});

test("inventory publishes current accessory firmware and separately advertised health", () => {
  const connected = project([param(1131, "1"), param(1550, "0"), param(1601, "1")])!;
  assert.equal(connected.connected, true);
  assert.equal(connected.firmware, "1.2.3");
  assert.equal(connected.contactOpen, false);
  assert.equal(connected.capabilities.includes("connected"), true);
  assert.equal(connected.capabilities.includes("batteryLow"), false);
  assert.equal(connected.batteryLow, undefined);
  const unknown = project([param(1131, "broken"), param(1552, null)])!;
  assert.equal(unknown.connected, null); assert.equal(unknown.batteryLow, null);
  assert.equal(project([param(1131, "0"), param(1552, "1")])!.batteryLow, true);
  assert.equal(project([param(1131, "1")], "T8910", 10)!.connected, undefined);
});

test("capability manifests map health only on the same qualified model and type", () => {
  const options = { homeBaseSupported: false, homeBaseGuardModeSupported: false, homeBaseRouteReady: false,
    doorbellSupported: false, cameraStreamSupported: false };
  const device = { serial: "invented-sensor", model: "T8900", category: "eufy_security", deviceType: 2,
    paramTypes: [1131, 1552] };
  const manifest = describeDeviceCapabilities(device, options).find(row => row.family === "sensor")!;
  assert.equal(manifest.supported, true); assert.equal(manifest.unmappedParamCount, 0);
  assert.equal(manifest.matrix.find(row => row.id === "sensor.connected")!.offerable, true);
  assert.equal(manifest.matrix.find(row => row.id === "sensor.battery_low")!.offerable, true);
  const other = describeDeviceCapabilities({ ...device, model: "T8910", deviceType: 10 }, options)
    .find(row => row.family === "sensor")!;
  assert.equal(other.matrix.some(row => row.id === "sensor.connected" || row.id === "sensor.battery_low"), false);
});
