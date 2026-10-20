/**
 * Exercises authenticated closed NVR routes over loopback HTTP. Synthetic media
 * facts and provider methods own all effects, without any appliance connection.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { NvrLiveControlError } from "../src/provider/nvr-live-controls.js";
import { GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";

test("NVR routes reject unauthenticated, duplicate, unknown and conflicting inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nvr-live-http-")), state = new GatewayState();
  const identity = { serial: "synthetic", name: "Synthetic", model: "T8416", stationSerial: "synthetic-parent",
    streamSupported: true, doorbellSupported: false, nvrViewOptions: ["Wide", "Telephoto"], nvrSelectedView: 0 };
  state.registerCamera(identity);
  let calls = 0, active = false, limited = false, admitted = false;
  const provider = {
    nvrLiveSettingAdmitted: (_serial: string, quality?: number) => admitted && (quality === undefined || [0, 1, 2, 3, 4].includes(quality)),
    setCameraStreamingQuality: async () => { calls++; return identity; },
    setCameraNightVision: async () => { calls++; return identity; },
    setNvrView: async () => { calls++; return { ...identity, nvrSelectedView: 1 }; },
    performNvrLiveControl: async () => { calls++; if (limited) throw new NvrLiveControlError("rate_limited"); return { outcome: "request_accepted", physicalConfirmationRequired: true }; },
  } as unknown as CameraProvider;
  const streams = { hasActiveSession: () => active, hasActiveViewer: () => true, hasActiveRecording: () => false,
    withActiveViewer: async (_serial: string, operation: () => Promise<unknown>) => operation() } as unknown as LiveStreamManager;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "synthetic-secret" }, state, new SnapshotStore(directory), streams, provider, null);
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.port}/api/cameras`;
    const send = (path: string, body: string, authorised = true) => fetch(`${base}/${path}`, { method: "POST", headers: authorised ? { authorization: "Bearer synthetic-secret", "content-type": "application/json" } : {}, body });
    assert.equal((await send("synthetic/nvr-view", '{"view":1}', false)).status, 401);
    assert.equal((await send("missing/nvr-view", '{"view":1}')).status, 404);
    for (const body of ['{"view":0,"view":1}', '{"view":1,"extra":0}', '{"view":true}', '{"view":2}', '{"view":0,"\\u0076iew":1}']) assert.equal((await send("synthetic/nvr-view", body)).status, 400);
    for (const body of ['{"kind":"pan","direction":"left","extra":0}', '{"kind":"pan","direction":"left","direction":"right"}', '{"kind":"zoom","level":4}', '{"kind":"pan","direction":"held"}']) assert.equal((await send("synthetic/nvr-live-control", body)).status, 400);
    assert.equal(calls, 0);
    assert.equal((await send("synthetic/streaming-quality", '{"quality":1}', false)).status, 401);
    assert.equal((await send("synthetic/night-vision", '{"mode":1}', false)).status, 401);
    assert.equal((await send("synthetic/streaming-quality", '{"quality":1}')).status, 409);
    assert.equal((await send("synthetic/night-vision", '{"mode":1}')).status, 409);
    for (const mode of ["1", true, 1.5, null]) {
      assert.equal((await send("synthetic/night-vision", JSON.stringify({ mode }))).status, 400);
    }
    assert.equal(calls, 0); admitted = true;
    assert.equal((await send("synthetic/streaming-quality", '{"quality":4}')).status, 200);
    active = true; assert.equal((await send("synthetic/nvr-view", '{"view":1}')).status, 409);
    active = false; assert.equal((await send("synthetic/nvr-view", '{"view":1}')).status, 200);
    assert.equal((await send("synthetic/nvr-live-control", '{"kind":"pan","direction":"left"}')).status, 200);
    limited = true;
    const response = await send("synthetic/nvr-live-control", '{"kind":"pan","direction":"left"}');
    assert.equal(response.status, 409); assert.equal((await response.json()).code, "rate_limited");
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
