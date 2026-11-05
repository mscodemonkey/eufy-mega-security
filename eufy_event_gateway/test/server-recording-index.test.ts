/**
 * Checks authenticated index consent and cancellation using an ephemeral server.
 * Synthetic providers own summaries and never connect to a device or cloud.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { diagnosticsPage } from "../src/diagnostics/page.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";
import { C31IndexError } from "../src/stream/c31-recording-index.js";

const headers = { authorization: `Bearer ${"x".repeat(32)}`, "content-type": "application/json" };
const body = JSON.stringify({ consentReadRecordingIndex: true });
const summary = { outcome: "empty" as const, windowMatches: true, ownerMatches: true, valid: 0, invalid: 0, overlapping: 0 };

for (const enabled of [false, true]) test(`recording index HTTP admission and closed projection, enabled=${enabled}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "index-http-"));
  const state = new GatewayState(); state.registerCamera({ serial: "synthetic", name: "Synthetic", model: "T817L", stationSerial: "synthetic", streamSupported: false, doorbellSupported: false });
  let calls = 0;
  const provider = { readRecordingIndexTrial: async (serial: string, signal: AbortSignal) => {
    calls++; assert.equal(serial, "synthetic"); assert.equal(signal.aborted, false); return { ...summary, privateCanary: "PRIVATE-CANARY" };
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "x".repeat(32), experimentalModelControls: enabled },
    state, new SnapshotStore(directory), { hasActiveSession: () => false } as unknown as LiveStreamManager, provider, null);
  try {
    await server.listen(); const url = `http://127.0.0.1:${server.port}/api/cameras/synthetic/recording-index-trial`;
    assert.equal((await fetch(url, { method: "POST", body })).status, 401);
    if (!enabled) { assert.equal((await fetch(url, { method: "POST", headers, body })).status, 409); assert.equal(calls, 0); return; }
    for (const invalid of [{}, { consentReadRecordingIndex: false }, { consentReadRecordingIndex: true, begin: 1 }]) {
      assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify(invalid) })).status, 400);
    }
    assert.equal((await fetch(url.replace("synthetic/", "other/"), { method: "POST", headers, body })).status, 404);
    const response = await fetch(url, { method: "POST", headers, body });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), summary); assert.equal(calls, 1);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("index disconnect retains busy ownership until provider cleanup, then permits another call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "index-cancel-"));
  const state = new GatewayState(); state.registerCamera({ serial: "synthetic", name: "Synthetic", model: "T817L", stationSerial: "synthetic", streamSupported: false, doorbellSupported: false });
  let enter!: () => void, finish!: () => void, abort!: () => void, calls = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }), closed = new Promise<void>(resolve => { finish = resolve; });
  const aborted = new Promise<void>(resolve => { abort = resolve; });
  const provider = { readRecordingIndexTrial: async (_serial: string, signal: AbortSignal) => {
    calls++; if (calls === 1) { signal.addEventListener("abort", abort, { once: true }); enter(); await closed; throw new C31IndexError("cancelled"); } return summary;
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "x".repeat(32), experimentalModelControls: true },
    state, new SnapshotStore(directory), { hasActiveSession: () => false } as unknown as LiveStreamManager, provider, null);
  try {
    await server.listen(); const url = `http://127.0.0.1:${server.port}/api/cameras/synthetic/recording-index-trial`;
    const controller = new AbortController();
    const stopped = assert.rejects(fetch(url, { method: "POST", headers, body, signal: controller.signal }), /abort/i);
    await entered; controller.abort(); await aborted; await stopped;
    assert.equal((await fetch(url, { method: "POST", headers, body })).status, 409);
    finish(); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await fetch(url, { method: "POST", headers, body })).status, 200);
  } finally { finish(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("browser index consent is explicit and selection/page departure cancel the request", () => {
  const page = diagnosticsPage();
  assert.match(page, /id="index-consent" type="checkbox"/);
  assert.doesNotMatch(page, /id="index-consent"[^>]*checked/);
  assert.match(page, /pagehide', cancelIndex/); assert.match(page, /cancelIndex\(\); el\('index-consent'\).checked = false/);
  assert.match(page, /not confirmed its behaviour on hardware/); assert.match(page, /A timeout is inconclusive/);
});
