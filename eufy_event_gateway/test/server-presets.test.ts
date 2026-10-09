/**
 * Verifies preset authorization and decoded-source ownership at the HTTP boundary.
 * Synthetic providers and a lease stub isolate route policy from camera transport.
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

test("direct C31 preset movement retains a source without changing other model routes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-preset-http-"));
  const state = new GatewayState();
  for (const [serial, model, stationSerial] of [["direct", "T817L", "direct"], ["attached", "T817L", "station"], ["solo", "T8171", "solo"]]) {
    state.registerCamera({ serial: serial!, name: "Synthetic", model: model!, stationSerial: stationSerial!,
      streamSupported: true, doorbellSupported: false, presetPositionControlSupported: true });
  }
  let leased = false;
  let leases = 0;
  let moves = 0;
  let failMovement = false;
  let failStartup = false;
  const streams = { async withLiveSource<T>(serial: string, operation: () => Promise<T>): Promise<T> {
    assert.equal(serial, "direct");
    leases++;
    if (failStartup) throw new Error("source-unavailable");
    leased = true;
    try { return await operation(); } finally { leased = false; }
  } } as LiveStreamManager;
  const provider = { async selectCameraPresetPosition(serial: string, index: number) {
    assert.equal(index, 2);
    assert.equal(leased, serial === "direct");
    moves++;
    if (failMovement) throw new Error("movement-failed");
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "synthetic-secret" }, state,
    new SnapshotStore(directory), streams, provider, null);
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.port}/api/cameras`;
    const options = { method: "POST", headers: { authorization: "Bearer synthetic-secret", "content-type": "application/json" }, body: '{"index":2}' };
    assert.equal((await fetch(`${base}/direct/preset-position`, { ...options, headers: {} })).status, 401);
    assert.equal((await fetch(`${base}/missing/preset-position`, options)).status, 404);
    for (const index of [-1, 10, 1.5, "2", null]) {
      assert.equal((await fetch(`${base}/direct/preset-position`, { ...options, body: JSON.stringify({ index }) })).status, 400);
    }
    assert.equal(leases, 0);
    assert.equal(moves, 0);
    for (const serial of ["direct", "attached", "solo"]) {
      assert.equal((await fetch(`${base}/${serial}/preset-position`, options)).status, 200);
    }
    assert.equal(leases, 1);
    assert.equal(moves, 3);
    failMovement = true;
    assert.equal((await fetch(`${base}/direct/preset-position`, options)).status, 500);
    assert.equal(leased, false);
    failStartup = true;
    assert.equal((await fetch(`${base}/direct/preset-position`, options)).status, 500);
    assert.equal(moves, 4);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
