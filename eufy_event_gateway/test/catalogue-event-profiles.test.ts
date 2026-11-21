/**
 * Verifies exact event exposure and the catalogue CLI's reviewed binding rules.
 *
 * Runtime cases exercise the gateway capability selector. CLI cases own an
 * isolated temporary catalogue with synthetic records and no device access.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
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

test("catalogue check rejects unqualified and duplicate profile bindings", (context) => {
  const root = mkdtempSync(join(tmpdir(), "catalogue-event-profile-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const gateway = join(root, "eufy_event_gateway");
  const devices = join(gateway, "device_catalogue", "devices");
  mkdirSync(devices, { recursive: true });
  mkdirSync(join(gateway, "scripts"));
  symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(gateway, "node_modules"), "dir");
  const cli = join(gateway, "scripts", "device-catalogue.mjs");
  copyFileSync(new URL("../scripts/device-catalogue.mjs", import.meta.url), cli);

  const record = {
    schema: 1, id: "t9599", name: "Synthetic camera", category: "camera",
    integration: { status: "ready_to_test", handler: "camera", event_profile: profile },
    models: ["T9599"], device_type: 9599, capabilities: {},
  };
  const primary = join(devices, "t9599-camera.yaml");
  const check = (expected: RegExp) => {
    const result = spawnSync(process.execPath, [cli, "check"], { encoding: "utf8" });
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
