/** Verify private-preview HTTP consent and admission with an ephemeral synthetic server. */
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

for (const mode of ["success", "disabled", "busy"]) test(`continuous HTTP consent and admission: ${mode}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "c31-preview-")), state = new GatewayState();
  state.registerCamera({ serial: "synthetic", name: "Synthetic", model: "T817L", stationSerial: "synthetic", streamSupported: false, doorbellSupported: false });
  const beginTime = Math.floor(Date.now() / 1000) - 100, headers = { authorization: `Bearer ${"x".repeat(32)}`, "content-type": "application/json" };
  let calls = 0;
  const provider = { readC31ContinuousTrial: async (serial: string, begin: number, signal: AbortSignal) => {
    calls++; assert.equal(serial, "synthetic"); assert.equal(begin, beginTime); assert.equal(signal.aborted, false); return Buffer.from("synthetic-media");
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "x".repeat(32), experimentalModelControls: mode !== "disabled" }, state,
    new SnapshotStore(directory), { hasActiveSession: () => mode === "busy" } as unknown as LiveStreamManager, provider, null);
  try {
    await server.listen(); const url = `http://127.0.0.1:${server.port}/api/cameras/synthetic/continuous-recording-trial`, body = JSON.stringify({ consentPrivateMedia: true, beginTime });
    assert.equal((await fetch(url, { method: "POST", body })).status, 401);
    if (mode === "disabled") { assert.equal((await fetch(url, { method: "POST", headers, body })).status, 409); assert.equal(calls, 0); return; }
    for (const invalid of [{ beginTime }, { consentPrivateMedia: false, beginTime }, { consentPrivateMedia: true, beginTime, path: "private" }]) assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify(invalid) })).status, 400);
    assert.equal(calls, 0);
    const response = await fetch(url, { method: "POST", headers, body });
    if (mode === "busy") { assert.equal(response.status, 409); assert.equal(calls, 0); return; }
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(await response.text(), "synthetic-media"); assert.equal(calls, 1);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
