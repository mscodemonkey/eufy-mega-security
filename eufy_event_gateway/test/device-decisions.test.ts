/**
 * Checks the public decision report against exact catalogue identities and
 * untrusted inventory. Fixtures own the state and never open camera sessions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { GatewayState } from "../src/domain/gateway-state.js";
import { deviceDecisions } from "../src/diagnostics/device-decisions.js";
import { sensorInventory } from "../src/provider/sensor-inventory.js";
import { GENERATED_CATALOGUE_DEVICES } from "../src/provider/devices/generated-catalogue.js";

test("9240 preserves missing and malformed evidence and retains only numeric sensor descriptors", () => {
  const row = (param_value: unknown) => ({ param_type: 9240, param_value });
  assert.equal(sensorInventory([]).status, "missing");
  assert.equal(sensorInventory([row("[]")]).status, "empty");
  assert.equal(sensorInventory([row("garbage")]).status, "invalid");
  assert.equal(sensorInventory([row([]), row([])]).status, "duplicate");
  assert.deepEqual(sensorInventory([row('[{"type":1,"id":2,"name":"PRIVATE"}]')]),
    { status: "reported", sensors: [{ type: 1, id: 2 }] });
});

test("every typed catalogue entry gets a local privacy-safe report, even with no player binding", () => {
  const state = new GatewayState();
  for (const row of GENERATED_CATALOGUE_DEVICES) {
    const model = row.models[0]!;
    state.updateInventoryDiagnostics([{ serial: "PRIVATE-serial", name: "PRIVATE-location", model, sources: ["mega"],
      upstreamIsCamera: false, acceptedAsCamera: false, megaDeviceType: row.deviceType,
      category: null, cameraSwitch1035: "missing" }]);
    const report = deviceDecisions(state, "PRIVATE-serial");
    assert.ok(report);
    assert.equal(report.streamAvailable, false);
    assert.ok(!JSON.stringify(report).includes("PRIVATE"));
    if (model === "T8170" && row.deviceType === 48) assert.equal(report.liveHandler, "OpenLiveStreamParser1350_V3 (v2)");
  }
  assert.equal(deviceDecisions(state, "other"), null);
});

test("S340 reference distinguishes HB3 variants and outdoor selection without retaining identifiers", async () => {
  const { parseMegaInventory } = await import("../src/provider/inventory-normalization.js");
  const camera = { device_sn: "T8170-PRIVATE", device_model: "T8170", device_type: 48, params: [] };
  for (const [parent, params, expected] of [
    ["T8030000PRIVATE", [], "station 1350 wrapper"], ["T8030001PRIVATE", [], "recorder-style start request"],
    ["T8030000PRIVATE", [{ param_type: 6271, param_value: 1 }], "direct 1700 wrapper"],
    ["T8170-PRIVATE", [], "direct 1700 wrapper"], ["unidentified", [], undefined],
  ] as const) {
    const [parsed] = parseMegaInventory({ devices: [{ ...camera, parent_sn: parent, params }] });
    assert.equal(parsed?.s340StartRequest, expected);
  }
});
