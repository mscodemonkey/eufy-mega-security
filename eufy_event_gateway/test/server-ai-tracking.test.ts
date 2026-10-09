/**
 * Exercises tracking authorization, input validation and failed-confirmation state over HTTP.
 * Synthetic providers own reported preferences. These cases do not contact camera hardware.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";

test("tracking writes reject invalid requests and preserve state when confirmation fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-tracking-http-"));
  const state = new GatewayState();
  const identity = { serial: "synthetic", name: "Synthetic", model: "T8171", stationSerial: "synthetic",
    streamSupported: false, doorbellSupported: false, aiTrackingControlSupported: true, aiTrackingEnabled: true };
  state.registerCamera(identity);
  let calls = 0;
  let fail = true;
  const provider = { setCameraAiTracking: async (serial: string, enabled: boolean) => {
    calls++;
    assert.equal(serial, "synthetic");
    assert.equal(enabled, false);
    if (fail) throw new Error("Tracking write not confirmed by fresh inventory");
    state.registerCamera({ ...identity, aiTrackingEnabled: false });
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "synthetic-secret" }, state,
    new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.port}/api/cameras`;
    const options = { method: "POST", headers: { authorization: "Bearer synthetic-secret", "content-type": "application/json" }, body: '{"enabled":false}' };
    assert.equal((await fetch(`${base}/synthetic/ai-tracking`, { ...options, headers: {} })).status, 401);
    assert.equal((await fetch(`${base}/missing/ai-tracking`, options)).status, 404);
    for (const enabled of [0, 1, "false", null]) {
      assert.equal((await fetch(`${base}/synthetic/ai-tracking`, { ...options, body: JSON.stringify({ enabled }) })).status, 400);
    }
    assert.equal(calls, 0);
    assert.equal((await fetch(`${base}/synthetic/ai-tracking`, options)).status, 500);
    assert.equal(state.getCamera("synthetic").aiTrackingEnabled, true);
    fail = false;
    assert.equal((await fetch(`${base}/synthetic/ai-tracking`, options)).status, 200);
    assert.equal(state.getCamera("synthetic").aiTrackingEnabled, false);
    assert.equal(calls, 2);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
