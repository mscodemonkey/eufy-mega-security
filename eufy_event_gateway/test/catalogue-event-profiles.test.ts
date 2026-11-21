/**
 * Verifies exact event exposure and the catalogue CLI's reviewed binding rules.
 *
 * Runtime cases exercise the gateway capability selector. CLI cases own an
 * isolated temporary catalogue with synthetic records and no device access.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { cameraDetectionKinds } from "../src/provider/device-capabilities-core.js";

const profile = { id: "motion-person-pet-vehicle-sound", connection: "direct" };

test("only the exact direct LTE S330 selects the generated event profile", () => {
  const direct = { category: "eufy_security", model: "T86P2", deviceType: 111 };
  const expected = ["motion", "person", "pet", "vehicle", "sound"];
  assert.deepEqual(cameraDetectionKinds(direct, false), expected);
  assert.deepEqual(cameraDetectionKinds({ ...direct, model: "t86p2" }, false), expected);
  assert.equal(cameraDetectionKinds({ ...direct, model: "T86P2S" }, false), undefined);
  assert.equal(cameraDetectionKinds({ ...direct, model: "T86P2121" }, false), undefined);
  assert.equal(cameraDetectionKinds({ ...direct, deviceType: 112 }, false), undefined);
  assert.equal(cameraDetectionKinds({ ...direct, category: "eufy_care" }, false), undefined);
  for (const route of [true, null, undefined]) {
    assert.equal(cameraDetectionKinds(direct, route), undefined);
  }
});

function catalogueSandbox(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "catalogue-event-profile-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const gateway = join(root, "eufy_event_gateway");
  const devices = join(gateway, "device_catalogue", "devices");
  mkdirSync(devices, { recursive: true });
  mkdirSync(join(gateway, "scripts"));
  symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(gateway, "node_modules"), "dir");
  for (const script of ["device-catalogue.mjs", "new-device-catalogue.mjs"]) {
    copyFileSync(new URL(`../scripts/${script}`, import.meta.url), join(gateway, "scripts", script));
  }
  return {
    devices, gateway, root,
    run(args: string[]) {
      return spawnSync(process.execPath, args, { cwd: gateway, encoding: "utf8", timeout: 15_000 });
    },
  };
}

test("catalogue check rejects unqualified and duplicate profile bindings", (context) => {
  const { devices, run } = catalogueSandbox(context);
  const record = {
    schema: 1, id: "t9599", name: "Synthetic camera", category: "camera",
    integration: { status: "ready_to_test", handler: "camera", event_profile: profile },
    models: ["T9599"], device_type: 9599, capabilities: {},
  };
  const primary = join(devices, "t9599-camera.yaml");
  const check = (expected: RegExp) => {
    const result = run(["scripts/device-catalogue.mjs", "check"]);
    assert.equal(result.status, 1, result.error?.message ?? result.stderr);
    assert.match(result.stderr, expected);
  };

  for (const event_profile of [
    { ...profile, id: "unknown" },
    { ...profile, connection: "T8030" },
    { ...profile, model: "T9600" },
    null,
  ]) {
    writeFileSync(primary, stringify({ ...record, integration: { ...record.integration, event_profile } }));
    check(/t9599-camera.yaml: integration event_profile must name a known profile and the direct connection/);
  }

  writeFileSync(primary, stringify({ ...record, integration: { ...record.integration, status: "recognised" } }));
  check(/t9599-camera.yaml: integration event_profile requires an admitted camera/);

  writeFileSync(primary, stringify({ ...record, models: [] }));
  check(/t9599-camera.yaml: integration event_profile requires an admitted camera with a primary model/);

  writeFileSync(primary, stringify({ ...record, id: "t9599-camera" }));
  writeFileSync(join(devices, "t9599-duplicate.yaml"), stringify({ ...record, id: "t9599-duplicate", models: ["t9599"] }));
  check(/t9599-duplicate.yaml: duplicate event_profile identity also bound in t9599-camera.yaml/);
});

test("a clean catalogue copy can recognise a model and then reuse the existing direct event handler", (context) => {
  const sandbox = catalogueSandbox(context);
  const { devices, gateway, root, run } = sandbox;
  cpSync(new URL("../src", import.meta.url), join(gateway, "src"), { recursive: true });
  copyFileSync(new URL("../package.json", import.meta.url), join(gateway, "package.json"));
  mkdirSync(join(root, "docs"));
  const original = "t86p2-4g-lte-cam-s330.yaml";
  copyFileSync(new URL(`../device_catalogue/devices/${original}`, import.meta.url), join(devices, original));

  const succeed = (args: string[]) => {
    const result = run(args);
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout.trim();
  };
  const scaffold = succeed(["scripts/new-device-catalogue.mjs", "T9599", "Synthetic camera"]);
  assert.equal(scaffold, "device_catalogue/devices/t9599-synthetic-camera.yaml");
  const recordPath = join(gateway, scaffold);
  const record = parse(readFileSync(recordPath, "utf8"));
  assert.deepEqual(record.integration, { status: "recognised" });
  record.device_type = 9599;
  record.capabilities = { events: { motion: { connections: { direct: { status: "declared" } } } } };

  const verify = (assertions: string) => {
    writeFileSync(recordPath, stringify(record));
    succeed(["scripts/device-catalogue.mjs", "generate"]);
    succeed(["scripts/device-catalogue.mjs", "check"]);
    succeed(["--import", "tsx", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { cameraDetectionKinds, isSupportedCameraType, resolveCameraEventProfile }
        from "./src/provider/device-capabilities-core.ts";
      import { catalogueIntegrationStatus } from "./src/provider/camera-capability-core.ts";
      const original = { model: "T86P2", deviceType: 111, category: "eufy_security" };
      const candidate = { ...original, model: "T9599", deviceType: 9599 };
      const expected = ["motion", "person", "pet", "vehicle", "sound"];
      assert.deepEqual(cameraDetectionKinds(original, false), expected);
      ${assertions}
    `]);
  };

  verify(`
    assert.equal(catalogueIntegrationStatus(candidate.model, candidate.deviceType), "recognised");
    assert.equal(isSupportedCameraType(candidate), false);
    assert.equal(resolveCameraEventProfile(candidate, false), null);
    assert.equal(cameraDetectionKinds(candidate, false), undefined);
  `);

  record.integration = { status: "ready_to_test", handler: "camera", event_profile: profile };
  record.models.push("T9599S");
  record.alternate_device_types = [{ value: 9600, status: "reported" }];
  verify(`
    assert.equal(catalogueIntegrationStatus(candidate.model, candidate.deviceType), "ready_to_test");
    assert.equal(isSupportedCameraType(candidate), true);
    assert.deepEqual(cameraDetectionKinds(candidate, false), expected);
    assert.equal(resolveCameraEventProfile(candidate, false)?.reason, "matched");
    assert.equal(resolveCameraEventProfile(candidate, true)?.reason, "route_mismatch");
    assert.equal(resolveCameraEventProfile(candidate, undefined)?.reason, "route_unresolved");
    for (const route of [true, null, undefined]) {
      assert.equal(cameraDetectionKinds(candidate, route), undefined);
    }
    assert.equal(resolveCameraEventProfile({ ...candidate, model: "T9599S" }, false), null);
    assert.equal(resolveCameraEventProfile({ ...candidate, deviceType: 9600 }, false), null);
    assert.equal(resolveCameraEventProfile({ ...candidate, category: "eufy_care" }, false), null);
  `);

  const [result] = JSON.parse(succeed(["scripts/device-catalogue.mjs", "query", "T9599"]));
  assert.deepEqual(result.capabilities, {
    events: { motion: { connections: { direct: { status: "declared" } } } },
  });
});
