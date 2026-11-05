/**
 * Checks motion deadline responses through an authenticated ephemeral gateway.
 * Test providers own failure facts and never send camera or account requests.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import { CameraControlDeadlineError } from "../src/provider/camera-control-deadline.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";

for (const dispatched of [false, true]) {
  test(`motion deadline returns a fixed outcome, dispatched=${dispatched}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "motion-http-"));
    const state = new GatewayState();
    state.registerCamera({ serial: "synthetic", name: "Synthetic", model: "T8113-Z", stationSerial: "base",
      streamSupported: true, doorbellSupported: false });
    const error = new CameraControlDeadlineError(dispatched);
    const provider = { setCameraMotionDetection: async () => { throw error; } } as unknown as CameraProvider;
    const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "x".repeat(32) }, state,
      new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
    try {
      await server.listen();
      const response = await fetch(`http://127.0.0.1:${server.port}/api/cameras/synthetic/motion-detection`, {
        method: "POST", headers: { authorization: `Bearer ${"x".repeat(32)}`, "content-type": "application/json" },
        body: '{"enabled":false}',
      });
      assert.equal(response.status, dispatched ? 503 : 409);
      assert.deepEqual(await response.json(), { code: error.code, error: error.message });
      assert.ok(error.message.length <= 300);
    } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
