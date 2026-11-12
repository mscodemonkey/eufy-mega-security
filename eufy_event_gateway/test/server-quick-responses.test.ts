/**
 * Exercises authenticated saved-reply HTTP requests against an inert provider.
 * The fixture owns its listener and storage. It can count dispatches but cannot
 * contact a doorbell or turn an HTTP response into physical playback evidence.
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

test("saved reply HTTP requires authentication, admission and exactly one valid ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quick-response-http-")), state = new GatewayState();
  for (const serial of ["enabled", "disabled"]) state.registerCamera({ serial, name: "Synthetic", model: "T8210",
    stationSerial: "station", streamSupported: true, doorbellSupported: true, experimentalQuickResponseSupported: serial === "enabled" });
  let reads = 0, writes = 0, fail = false;
  const provider = { async getQuickResponses() { reads++; return [{ id: 100, name: "Synthetic reply", custom: true }]; },
    async playQuickResponse(serial: string, id: number) { assert.equal(serial, "enabled"); assert.equal(id, 100); writes++; if (fail) throw Error("Unknown playback outcome"); },
  } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "synthetic-secret" }, state,
    new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.port}/api/cameras`;
    const headers = { authorization: "Bearer synthetic-secret", "content-type": "application/json" };
    assert.equal((await fetch(`${base}/enabled/quick-responses`)).status, 401);
    assert.equal((await fetch(`${base}/disabled/quick-responses`, { headers })).status, 409);
    assert.equal((await fetch(`${base}/missing/quick-responses`, { headers })).status, 404);
    assert.equal(reads, 0);
    assert.equal((await fetch(`${base}/enabled/quick-responses`, { headers })).status, 200); assert.equal(reads, 1);
    for (const body of [{ id: "100" }, { id: 4 }, { id: 100.1 }, { id: true }, { id: 100, repeat: 2 }, {}]) {
      assert.equal((await fetch(`${base}/enabled/quick-responses`, { method: "POST", headers, body: JSON.stringify(body) })).status, 400);
    }
    assert.equal(writes, 0);
    const post = () => fetch(`${base}/enabled/quick-responses`, { method: "POST", headers, body: '{"id":100}' });
    assert.equal((await post()).status, 200); assert.equal(writes, 1);
    fail = true; assert.equal((await post()).status, 500); assert.equal(writes, 2);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
