/**
 * Verifies the read-only history route over an ephemeral authenticated server.
 * Synthetic providers own all records. No camera sockets or cloud calls occur.
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

test("requires bearer authentication and validates history bounds before contacting the provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-history-http-"));
  let calls = 0;
  const provider = { cloudHistory: async (serial: string, query: unknown) => {
    calls++;
    assert.equal(serial, "synthetic");
    assert.deepEqual(query, { startTime: 100, endTime: 200, timezoneOffset: 0, cursor: 0, count: 100 });
    return [];
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "synthetic-secret" }, new GatewayState(), new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.port}/api/cameras/synthetic/cloud-history`;
    const headers = { authorization: "Bearer synthetic-secret" };
    assert.equal((await fetch(`${base}?start=100&end=200`)).status, 401);
    assert.equal((await fetch(base, { headers })).status, 400);
    assert.equal((await fetch(`${base}?start=100&end=99`, { headers })).status, 400);
    assert.equal((await fetch(`${base}?start=100&end=200&count=1001`, { headers })).status, 400);
    assert.equal(calls, 0);
    const response = await fetch(`${base}?start=100&end=200`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { records: [], mediaPlaybackAvailable: false });
    assert.equal(calls, 1);
    assert.equal((await fetch(base, { method: "DELETE", headers })).status, 404);
    assert.equal(calls, 1);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
