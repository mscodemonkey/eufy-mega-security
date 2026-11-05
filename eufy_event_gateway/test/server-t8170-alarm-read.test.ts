/**
 * Verifies the experimental HTTP boundary without a cloud account or camera.
 * The server owns authentication and admission, and the synthetic provider owns results.
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


const unavailable = { outcome: "unavailable", frames: 0, parseStage: "none", keyReady: false };

test("T8170 HTTP closes result shapes and masks arbitrary private errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alarm-http-")), state = new GatewayState();
  state.registerCamera({ serial: "fixture", name: "Synthetic", model: "T8170", stationSerial: "fixture", streamSupported: false, doorbellSupported: false });
  const before = state.getCamera("fixture");
  let value: unknown = { outcome: "decoded", parameterCount: 2, guardMode: 63 }, fail = false;
  const provider = { modelControlTrials: () => ["alarmState"], performModelControlTrial: async () => {
    if(fail) throw Error("private-serial-owner-key"); return value;
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "fixture", experimentalModelControls: true },
    state, new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
  try {
    await server.listen(); const url = `http://127.0.0.1:${server.port}/api/cameras/fixture/model-control-trial`;
    const options = { method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" }, body: '{"action":"alarmState","enabled":false}' };
    const response = await fetch(url, options); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), value);
    for(const malformed of [{ outcome: "decoded", parameterCount: 2, private: "private-serial-owner-key" },
      { outcome: "decoded", parameterCount: -1 }, { outcome: "decoded", parameterCount: 1, guardMode: 7 },
      { outcome: "unavailable", frames: 0, parseStage: {}, keyReady: false }]) {
      value = malformed; assert.deepEqual(await (await fetch(url, options)).json(), unavailable);
    }
    fail = true; const failure = await fetch(url, options); assert.equal(failure.status, 409); assert.deepEqual(await failure.json(), unavailable);
    assert.equal((await fetch(url, { ...options, headers: {} })).status, 401);
    assert.equal((await fetch(url, { ...options, body: '{"action":"alarmState","enabled":true}' })).status, 400);
    assert.deepEqual(state.getCamera("fixture"), before);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
