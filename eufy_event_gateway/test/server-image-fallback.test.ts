/**
 * Exercise retained-picture fallback through the actual authenticated HTTP API.
 * Tests own temporary storage and an ephemeral listener. No provider or live
 * stream operation is permitted while requesting a missing or retained image.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decode } from "jpeg-js";

import { loadConfig } from "../src/config.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import { waitingImage } from "../src/mega/waiting-image.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";

test("never returns an empty image for a known camera and never wakes it on reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-image-http-"));
  const snapshots = new SnapshotStore(directory);
  await snapshots.initialize();
  const state = new GatewayState();
  state.registerCamera({ serial: "synthetic", name: "Synthetic", model: "T8142", stationSerial: "", streamSupported: false, doorbellSupported: false });
  const forbidden = new Proxy({}, { get: () => assert.fail("An image read must not open a camera") });
  const server = new GatewayServer({ ...loadConfig({}), port: 0 }, state, snapshots, forbidden as LiveStreamManager, forbidden as CameraProvider, null);
  try {
    await server.listen();
    const read = async (kind: string): Promise<Buffer> => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/cameras/synthetic/${kind}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/jpeg");
      return Buffer.from(await response.arrayBuffer());
    };
    const placeholder = await read("snapshot");
    assert.deepEqual(placeholder, waitingImage());
    assert.equal(decode(placeholder).width, 320);
    assert.deepEqual(await read("event-image"), placeholder);
    const retained = Buffer.concat([placeholder.subarray(0, 2), Buffer.from([0xff, 0xfe, 0, 6]), Buffer.from("test"), placeholder.subarray(2)]);
    await snapshots.write("synthetic", retained, "image/jpeg", "live");
    assert.deepEqual(await read("snapshot"), retained);
    assert.deepEqual(await read("event-image"), retained);
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/cameras/missing/snapshot`)).status, 404);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
