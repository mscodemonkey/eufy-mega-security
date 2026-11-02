/**
 * Checks authenticated single-click requests through the loopback HTTP boundary.
 * Fake provider calls own every action. No vendor service or camera is contacted.
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

test("direct camera movement rejects ambiguous input and withdraws admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "camera-pan-http-"));
  const state = new GatewayState();
  const identity = { serial: "synthetic", name: "Synthetic", model: "T814X", stationSerial: "synthetic",
    streamSupported: true, doorbellSupported: false, directionalPanControlSupported: true };
  state.registerCamera(identity);
  const calls: string[] = [];
  let fail = false;
  const provider = { panCamera: async (serial: string, direction: string) => {
    assert.equal(serial, "synthetic");
    calls.push(direction);
    if (fail) throw Error("Synthetic failed acknowledgement");
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "synthetic-secret" }, state,
    new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
  try {
    await server.listen();
    const send = (body: string, serial = "synthetic", authenticated = true) => fetch(
      `http://127.0.0.1:${server.port}/api/cameras/${serial}/pan`, {
        method: "POST", headers: authenticated ? { authorization: "Bearer synthetic-secret" } : {}, body,
      });
    assert.equal((await send('{"direction":"left"}', "synthetic", false)).status, 401);
    assert.equal((await send('{"direction":"left"}', "missing")).status, 404);
    for (const body of ['{}', '[]', '{"direction":"held"}', '{"direction":1}',
      '{"direction":"left","repeat":2}', '{"direction":"left","direction":"right"}',
      '{"direction":"left","\\u0064irection":"up"}']) {
      assert.equal((await send(body)).status, 400);
    }
    assert.deepEqual(calls, []);
    for (const direction of ["left", "right", "up", "down"]) {
      const response = await send(JSON.stringify({ direction }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { outcome: "acknowledged", physicalConfirmationRequired: true });
    }
    assert.deepEqual(calls, ["left", "right", "up", "down"]);
    fail = true;
    assert.equal((await send('{"direction":"left"}')).status, 500);
    assert.equal(calls.length, 5);
    state.registerCamera({ ...identity, directionalPanControlSupported: false });
    assert.equal((await send('{"direction":"left"}')).status, 409);
    assert.equal(calls.length, 5);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
