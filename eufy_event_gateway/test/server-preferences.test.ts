/**
 * Exercises authenticated preference writes and failure-state preservation over HTTP.
 * Synthetic providers own confirmation; no physical camera or cloud is contacted.
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

test("preference writes validate input and preserve reported state when confirmation fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-preferences-http-"));
  const state = new GatewayState();
  const identity = { serial: "synthetic", name: "Synthetic", model: "T817L", stationSerial: "synthetic",
    streamSupported: false, doorbellSupported: false, preferenceControls: ["microphone"],
    audioSettings: { recordingEnabled: true, microphoneEnabled: true, speakerEnabled: true, speakerVolume: 50 } };
  state.registerCamera(identity);
  let calls = 0;
  let fail = true;
  const provider = { setCameraPreference: async (serial: string, name: string, value: number) => {
    calls++;
    assert.equal(serial, "synthetic");
    assert.equal(name, "microphone");
    assert.equal(value, 0);
    if (fail) throw new Error("Write not confirmed by fresh readback");
    return { ...identity, audioSettings: { ...identity.audioSettings, microphoneEnabled: false } };
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "synthetic-secret" }, state,
    new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.port}/api/cameras`;
    const options = { method: "POST", headers: { authorization: "Bearer synthetic-secret", "content-type": "application/json" }, body: '{"preference":"microphone","value":0}' };
    assert.equal((await fetch(`${base}/synthetic/preferences`, { ...options, headers: {} })).status, 401);
    assert.equal((await fetch(`${base}/missing/preferences`, options)).status, 404);
    assert.equal((await fetch(`${base}/synthetic/preferences`, { ...options, body: '{"preference":"microphone","value":2}' })).status, 400);
    for (const body of [{ preference: "continuous", value: 1 }, { preference: "watermark", value: true }, { preference: "speakerVolume", value: 101 }]) {
      assert.equal((await fetch(`${base}/synthetic/preferences`, { ...options, body: JSON.stringify(body) })).status, 400);
    }
    assert.equal(calls, 0);
    assert.equal((await fetch(`${base}/synthetic/preferences`, options)).status, 500);
    assert.equal(state.getCamera("synthetic").audioSettings?.microphoneEnabled, true);
    fail = false;
    assert.equal((await fetch(`${base}/synthetic/preferences`, options)).status, 200);
    assert.equal(state.getCamera("synthetic").audioSettings?.microphoneEnabled, false);
    assert.equal(state.getCamera("synthetic").audioSettings?.recordingEnabled, true);
    assert.equal(calls, 2);
    delete provider.setCameraPreference;
    assert.equal((await fetch(`${base}/synthetic/preferences`, options)).status, 409);
    assert.equal(calls, 2);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
