/**
 * Exercises the existing authenticated catalogue-evidence HTTP contract.
 *
 * A loopback server owns synthetic inventory and exposes only the project
 * profile and reason. No vendor session or camera is used.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { CatalogueEvidence } from "../src/domain/types.js";
import { describeCameraCapabilities, resolveCameraEventProfile } from "../src/provider/device-capabilities-core.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";

test("catalogue evidence exports a small optional event profile without device identifiers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-catalogue-http-"));
  const state = new GatewayState();
  const lte = { serial: "private-fixture-serial", model: "T86P2", deviceType: 111, category: "eufy_security", paramTypes: [] };
  const legacy = { ...lte, serial: "private-legacy-serial", model: "T8420", deviceType: 3 };
  const options = { doorbellSupported: false, streamSupported: false, routeReady: false };
  const eventProfile = resolveCameraEventProfile(lte, false);
  assert.ok(eventProfile);
  state.updateCameraCapabilities([
    describeCameraCapabilities(lte, {
      ...options, eventProfile: Object.assign(eventProfile, { name: "private-fixture-name", peer: "192.0.2.10" }),
    }),
    describeCameraCapabilities(legacy, options),
  ]);
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "fixture-bearer" },
    state, new SnapshotStore(directory), {} as LiveStreamManager, {} as CameraProvider, null);
  try {
    await server.listen();
    const url = `http://127.0.0.1:${server.port}/api/diagnostics/catalogue-evidence`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { authorization: "Bearer fixture-bearer" } });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.doesNotMatch(text, /private-fixture|private-legacy|192\.0\.2\.10|fixture-bearer/);
    const evidence = JSON.parse(text) as CatalogueEvidence;
    assert.equal(evidence.schema, 1);
    const current = evidence.cameras.find(({ model }) => model === "T86P2");
    assert.equal(current?.acceptedAsCamera, true);
    assert.equal(current.peerRouteReady, false);
    assert.ok(current.capabilities.some(({ id }) => id === "motion"));
    assert.deepEqual(current.eventProfile, { profile: "motion-person-pet-vehicle-sound", reason: "matched" });
    assert.ok(!Object.hasOwn(evidence.cameras[1]!, "eventProfile"));
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
