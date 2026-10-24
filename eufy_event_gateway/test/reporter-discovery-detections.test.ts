/**
 * Exercises reporter-confirmed identities through the real offline provider.
 *
 * Fixtures own cloud rows, keys and timers. No vendor connection, camera stream
 * or security write is executed. Hardware media remains a reporter check.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider, isPpcsStreamSupported, parseMegaInventory } from "../src/provider/eufy-provider.js";
import { describeCameraCapabilities, directCameraDetectionKinds, isSupportedCameraType } from "../src/provider/device-capabilities-core.js";
import { GENERATED_CATALOGUE_DEVICES } from "../src/provider/devices/generated-catalogue.js";
import type { CameraIdentity } from "../src/domain/types.js";
import type { ProviderEvents } from "../src/provider/provider.js";

const profiles = [
  { serial: "flood", model: "T8420", deviceType: 3, kinds: ["motion"] },
  { serial: "bell", model: "T8224", deviceType: 96, kinds: ["motion", "person"] },
  { serial: "e2k", model: "T8422", deviceType: 37, kinds: ["motion", "person"] },
  { serial: "c220", model: "T8W11C", deviceType: 10008, kinds: ["motion", "person"] },
  { serial: "lte", model: "T86P2", deviceType: 111, kinds: ["motion", "person", "pet", "vehicle", "sound"] },
] as const;

test("exact direct profiles agree with declared events without sharing mutable lists", () => {
  for (const { model, deviceType, kinds } of profiles) {
    const device = { model, deviceType, category: "eufy_security" };
    const actual = directCameraDetectionKinds(device, false)!;
    assert.deepEqual(actual, kinds);
    assert.deepEqual(directCameraDetectionKinds({ ...device, model: model.toLowerCase() }, false), kinds);
    assert.notEqual(directCameraDetectionKinds(device, false), actual);
    const entry = GENERATED_CATALOGUE_DEVICES.find(row => row.models.includes(model) && row.deviceType === deviceType)!;
    assert.equal(entry.handler, "camera");
    const files: Record<string, string> = {
      T8420: "t8420-floodlight-cam-1080p.yaml",
      T8224: "t8224-video-doorbell-c30.yaml",
      T8422: "t8422-floodlight-cam-e-2k.yaml",
      T8W11C: "t8w11c-indoor-cam-c220-original.yaml",
      T86P2: "t86p2-4g-lte-cam-s330.yaml",
    };
    const catalogue = parse(readFileSync(new URL(`../device_catalogue/devices/${files[model]}`, import.meta.url), "utf8")) as { capabilities: { events: Record<string, unknown> } };
    const events = Object.keys(catalogue.capabilities.events);
    assert.deepEqual(events.filter(kind => kind !== "doorbell_press").sort(), [...kinds].sort());
    for (const attached of [true, null, undefined]) assert.equal(directCameraDetectionKinds(device, attached), undefined);
    for (const patch of [{ category: "other" }, { model: model + "S" }, { deviceType: 999 }]) {
      assert.equal(directCameraDetectionKinds({ ...device, ...patch }, false), undefined);
    }
  }
  assert.equal(directCameraDetectionKinds({ model: "T8224", deviceType: 95, category: "eufy_security" }, false), undefined);
});

test("T8422 admission retains category, exact-model and live route guards", () => {
  const base = { category: "eufy_security", model: "T8422", deviceType: 37 };
  assert.equal(isSupportedCameraType(base), true);
  assert.equal(isSupportedCameraType({ ...base, model: "t8422" }), true);
  for (const model of ["T8422S", "T8422-Z", "", "T8420", "T8224", "T9999"]) {
    assert.equal(isSupportedCameraType({ ...base, model }), false);
  }
  assert.equal(isSupportedCameraType({ ...base, category: "other" }), false);
  assert.equal(isSupportedCameraType({ ...base, deviceType: 999 }), false);
  assert.equal(isSupportedCameraType({ ...base, model: "T8224", deviceType: 95 }), false);
  assert.equal(isSupportedCameraType({ ...base, model: "T8223", deviceType: 95 }), true);
  const manifest = describeCameraCapabilities({ ...base, serial: "cam", paramTypes: [] }, { doorbellSupported: false, streamSupported: true });
  assert.equal(manifest.acceptedAsCamera, true);
  assert.equal(manifest.capabilities.some(row => row.id === "liveVideo"), true);
  for (const patch of [{}, { parent_sn: "absent" }, { p2p_did: "" }, { p2p_conn: "" }]) {
    const [device] = parseMegaInventory({ devices: [{ device_sn: "cam", device_model: "T8422", device_type: 37,
      category: "eufy_security", device_channel: 0, p2p_did: "did", p2p_conn: "connection", ...patch }] });
    const devices = new Map([[device!.serial, device!]]);
    assert.equal(isPpcsStreamSupported(device!, devices, new Set(["cam"])), Object.keys(patch).length === 0);
    assert.equal(isPpcsStreamSupported(device!, devices, new Set()), false);
  }
});

test("C220 original admission is exact and keeps the existing v2 path", () => {
  const base = { category: "eufy_security", model: "T8W11C", deviceType: 10008 };
  assert.equal(isSupportedCameraType(base), true);
  assert.equal(isSupportedCameraType({ ...base, model: "t8w11c" }), true);
  for (const model of ["T8W11", "T8W11C-Z", "T8W11CS", " T8W11C", "T8W11C ", "T9999"]) {
    assert.equal(isSupportedCameraType({ ...base, model }), false);
  }
  assert.equal(isSupportedCameraType({ ...base, category: "other" }), false);
  assert.equal(isSupportedCameraType({ ...base, deviceType: 999 }), false);
  assert.equal(isSupportedCameraType({ ...base, deviceType: 10010 }), true);
  assert.equal(isSupportedCameraType({ ...base, model: "T8W11", deviceType: 10010 }), true);
});

test("provider publishes exact profiles and refuses aliases or incomplete live routes", async context => {
  const directory = await mkdtemp(join(tmpdir(), "reporter-profiles-"));
  const identities = new Map<string, CameraIdentity>();
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(globalThis, "setInterval", (() => ({ unref() {} })) as unknown as typeof setInterval);
  context.mock.method(globalThis, "clearInterval", (() => {}) as typeof clearInterval);
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
  const rejected = [
    { serial: "wrong37", model: "T8422S", deviceType: 37 },
    { serial: "wrong111", model: "T86P2S", deviceType: 111 },
    { serial: "wrong10008", model: "T8W11", deviceType: 10008 },
  ];
  const incomplete = [
    { serial: "no-did", p2p_did: "" },
    { serial: "no-connection", p2p_conn: "" },
    { serial: "no-key" },
    { serial: "orphan", parent_sn: "missing-parent" },
  ];
  const devices = [...profiles, ...rejected, ...incomplete.map(row => ({ model: "T8W11C", deviceType: 10008, ...row }))].map(row => ({
    device_sn: row.serial, device_model: row.model, device_type: row.deviceType, category: "eufy_security",
    device_channel: 0, p2p_did: "p2p_did" in row ? row.p2p_did : "did",
    p2p_conn: "p2p_conn" in row ? row.p2p_conn : "connection",
    parent_sn: "parent_sn" in row ? row.parent_sn : "", member: { admin_user_id: "owner" }, params: [],
  }));
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => Object.fromEntries(devices.filter(row => row.device_sn !== "no-key").map(row => [row.device_sn, { key: "fixture", expiresAt: null }])));
  const events = new Proxy({}, { get: (_target, key) => key === "camera"
    ? (identity: CameraIdentity) => identities.set(identity.serial, identity) : () => {} }) as ProviderEvents;
  const provider = new EufyProvider({ username: "fixture", password: "fixture", country: "AU", persistentDirectory: directory, maxStreamSeconds: 120 });
  try {
    await provider.start(events);
    for (const row of profiles) {
      assert.deepEqual(identities.get(row.serial)?.supportedDetections, row.kinds);
      assert.equal(identities.get(row.serial)?.streamSupported, true);
      assert.equal(identities.get(row.serial)?.enableControlSupported, false);
      assert.equal(identities.get(row.serial)?.motionDetectionControlSupported, false);
    }
    for (const row of incomplete) {
      assert.equal(identities.has(row.serial), true);
      assert.equal(identities.get(row.serial)?.streamSupported, false);
    }
    for (const row of rejected) {
      assert.equal(identities.has(row.serial), false);
      await assert.rejects(provider.startStream(row.serial), /camera|support/i);
      await assert.rejects(async () => provider.setCameraEnabled(row.serial, true), /camera|support/i);
    }
    assert.equal(network.mock.callCount(), 0);
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
