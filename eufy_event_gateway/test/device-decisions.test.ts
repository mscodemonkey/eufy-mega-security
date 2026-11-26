/**
 * Checks the public decision report against exact catalogue identities and
 * untrusted inventory. Fixtures own the state and never open camera sessions.
 */
import test from "node:test";
import { createHash } from "node:crypto";
import androidModels from "../src/diagnostics/android-models.json" with { type: "json" };
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
    ["T8030000PRIVATE", [], "1350 wrapper"], ["T8030001PRIVATE", [], "recorder-style start request"],
    ["T8030000PRIVATE", [{ param_type: 6271, param_value: 1 }], "direct 1700 wrapper"],
    ["T8170-PRIVATE", [], "direct 1700 wrapper"], ["unidentified", [], undefined],
  ] as const) {
    const [parsed] = parseMegaInventory({ devices: [{ ...camera, parent_sn: parent, params }] });
    assert.equal(parsed?.referenceStartRequest, expected);
  }
});

test("direct and HomeBase rules stay specific to each recovered handler", async () => {
  const { predictLiveRequest } = await import("../src/diagnostics/model-reference.js");
  for (const [handler, parent, expected] of [
    ["OpenLiveStreamParser", "T8111fixture", "basic live start"],
    ["OpenLiveStreamParser", "T8010fixture", "1350 wrapper"],
    ["OpenLiveStreamParser1700_V2", "T8030000fixture", "1700 wrapper"],
    ["OpenLiveStreamParser1350_V3 (v3)", "T8010fixture", "1350 wrapper with variant 5"],
    ["OpenLiveStreamParser1350_V3 (v6)", "unrecognized", "recorder-style start request"],
    ["OpenLiveStreamParser1350_V3 (v7)", "T8111fixture", "direct 1700 wrapper"],
    ["OpenLiveStreamParser1350_V3 (v7)", "T8010fixture", "1350 wrapper"],
    ["OpenLiveStreamParser1350_V3 (v7)", "T8030000fixture", undefined],
    ["OpenLiveStreamParser1350_V3 (v8)", "T8030000fixture", "1700 wrapper"],
    ["OpenLiveStreamParser1350_V3", "T8030001fixture", undefined],
    ["unreviewed", "T8010fixture", undefined],
  ] as const) {
    assert.equal(predictLiveRequest(handler, parent, "T8111fixture", false), expected);
  }
});

test("all 206 retained Android models resolve independently of numeric type and EMS admission", () => {
  const models = androidModels.map(row => row.model).sort();
  assert.equal(models.length, 206);
  assert.equal(new Set(models).size, 206);

  // Pin the exact model list qualified against the November 19 manifest.
  assert.equal(createHash("sha256").update(models.join("\n")).digest("hex"),
    "a5e51ef2e7f86354921bb396c0556353dcc307bf69d3bd8c64e1e96db239fa95");
  const state = new GatewayState();
  const reportFor = (model: string) => {
    state.updateInventoryDiagnostics([{ serial: "private-serial", name: "private-name", model, sources: ["mega"],
      upstreamIsCamera: false, acceptedAsCamera: false, megaDeviceType: null,
      category: null, cameraSwitch1035: "missing" }]);
    const report = deviceDecisions(state, "private-serial");
    assert.ok(report);
    return report;
  };
  for (const row of androidModels) {
    const report = reportFor(row.model);
    assert.equal(report.androidReference?.model, row.model);
    assert.equal(report.catalogue, "unresolved");
    assert.equal(report.streamAvailable, false);
    assert.deepEqual(report.operations, []);
    assert.ok(!JSON.stringify(report).includes("private-serial"));
  }
  const variant = reportFor("T8170E");
  assert.equal(variant.liveHandler, "OpenLiveStreamParser1350_V3 (v2)");
  assert.ok(variant.androidReference?.actions.includes("open_live_stream"));
  assert.ok(variant.androidReference?.resolvedOperations.includes("open_live_stream"));
  assert.ok(variant.referenceOperations.includes("Talkback"));
  const appliance = reportFor("T2070");
  assert.ok(appliance.androidReference?.actions.length);
  assert.equal(appliance.liveHandler, "unresolved");
  assert.equal(reportFor("T8170-FAKE").androidReference, null);
});

test("reference-only variants predict the traced request with no catalogue type", async () => {
  const { parseMegaInventory } = await import("../src/provider/inventory-normalization.js");
  for (const [model, expected] of [
    ["T8170E", "direct 1700 wrapper"], ["T8124R", "direct 1700 wrapper"], ["T8217", "recorder-style start request"],
    ["T8160C", "basic live start"], ["T8200X", "1700 wrapper"], ["T2070", undefined],
  ] as const) {
    const serial = model + "fixture";
    const [device] = parseMegaInventory({ devices: [{ device_sn: serial, device_model: model, parent_sn: serial, params: [] }] });
    assert.equal(device?.referenceStartRequest, expected, model);
  }
});

test("every model declaring live start has a traced source binding", async () => {
  const { androidModelReference } = await import("../src/diagnostics/model-reference.js");
  const declared = androidModels.filter(row => row.actions.includes("open_live_stream"));
  assert.equal(declared.length, 101);
  for (const { model } of declared) {
    const reference = androidModelReference(model);
    assert.ok(reference?.bindingRoot, model);
    assert.ok(reference.liveHandler, model);
    assert.ok(reference.resolvedOperations.includes("open_live_stream"), model);
  }

  // Exercise delegation, inheritance, factory registration and model-specific versions.
  for (const [model, handler] of [
    ["T8114", "OpenLiveStreamParser"],
    ["T8200", "OpenLiveStreamParser1350_V3 (v2)"],
    ["T8214C", "OpenLiveStreamParser1350_V3"],
    ["T8354", "OpenLiveStreamParser1700_V4"],
    ["T8416", "OpenLiveStreamParser1700_V4"],
    ["T8422", "OpenLiveStreamParser1700_V3"],
    ["T8532", "OpenLiveStreamParser1350_V3 (v6)"],
    ["T85M0", "OpenLiveStreamParser1350_V3"],
    ["T8600", "OpenLiveStreamParser1350_V3 (v7)"],
    ["T8L60", "OpenLiveStreamParser1350_V3 (v6)"],
  ] as const) {
    assert.equal(androidModelReference(model)?.liveHandler, handler, model);
  }
});
