/**
 * Checks authenticated FamiLock status consent and cancellation using an ephemeral server.
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
import { T85V0StatusError } from "../src/provider/t85v0-status.js";

const headers = { authorization: `Bearer ${"x".repeat(32)}`, "content-type": "application/json" };
const body = JSON.stringify({ consent: true });
const summary = { reportedState: "locked" as const, batteryPercent: 77, physicalConfirmationRequired: true as const };

for (const enabled of [false, true]) test(`FamiLock status HTTP admission and closed projection, enabled=${enabled}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "index-http-"));
  const state = new GatewayState(); state.registerSensor({ serial: "synthetic", name: "Synthetic", model: "T8910", deviceType: 10, available: true, capabilities: ["motion"], batteryLevel: null, contactOpen: null, lastSeen: null, motionDetected: false, rssi: null });
  let calls = 0;
  const provider = { readT85V0StatusTrial: async (serial: string, signal: AbortSignal) => {
    calls++; assert.equal(serial, "synthetic"); assert.equal(signal.aborted, false); return { ...summary, privateCanary: "PRIVATE-CANARY" };
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "x".repeat(32), experimentalModelControls: enabled },
    state, new SnapshotStore(directory), { hasActiveSession: () => false } as unknown as LiveStreamManager, provider, null);
  try {
    await server.listen(); const url = `http://127.0.0.1:${server.port}/api/locks/synthetic/status-trial`;
    assert.equal((await fetch(url, { method: "POST", body })).status, 401);
    if (!enabled) { assert.equal((await fetch(url, { method: "POST", headers, body })).status, 409); assert.equal(calls, 0); return; }
    for (const invalid of [{}, { consent: false }, { consent: true, begin: 1 }]) {
      assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify(invalid) })).status, 400);
    }
    assert.equal((await fetch(url.replace("synthetic/", "other/"), { method: "POST", headers, body })).status, 409);
    assert.equal((await fetch(url + "?duration=1", { method: "POST", headers, body })).status, 400);
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers, "content-type": "text/plain" }, body })).status, 415);
    assert.equal((await fetch(url, {method:"POST",headers,body:JSON.stringify({consent:true,extra:"x".repeat(16_384)})})).status,400);
    assert.equal((await fetch(url,{method:"POST",headers,body:"[]"})).status,400);
    const response = await fetch(url, { method: "POST", headers, body });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), summary); assert.equal(calls, 2);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("FamiLock status disconnect retains busy ownership until provider cleanup, then permits another call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "index-cancel-"));
  const state = new GatewayState(); state.registerSensor({ serial: "synthetic", name: "Synthetic", model: "T8910", deviceType: 10, available: true, capabilities: ["motion"], batteryLevel: null, contactOpen: null, lastSeen: null, motionDetected: false, rssi: null });
  let enter!: () => void, finish!: () => void, abort!: () => void, calls = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }), closed = new Promise<void>(resolve => { finish = resolve; });
  const aborted = new Promise<void>(resolve => { abort = resolve; });
  const provider = { readT85V0StatusTrial: async (_serial: string, signal: AbortSignal) => {
    calls++; if (calls === 1) { signal.addEventListener("abort", abort, { once: true }); enter(); await closed; throw new T85V0StatusError("cancelled"); } return summary;
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "x".repeat(32), experimentalModelControls: true },
    state, new SnapshotStore(directory), { hasActiveSession: () => false } as unknown as LiveStreamManager, provider, null);
  try {
    await server.listen(); const url = `http://127.0.0.1:${server.port}/api/locks/synthetic/status-trial`;
    const controller = new AbortController();
    const stopped = assert.rejects(fetch(url, { method: "POST", headers, body, signal: controller.signal }), /abort/i);
    await entered; controller.abort(); await aborted; await stopped;
    assert.equal((await fetch(url, { method: "POST", headers, body })).status, 409);
    finish(); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await fetch(url, { method: "POST", headers, body })).status, 200);
  } finally { finish(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("FamiLock browser consent is unchecked and cancels on selection or departure", () => {
  const page = diagnosticsPage();
  assert.match(page, /id="lock-status-consent" type="checkbox"/);
  assert.doesNotMatch(page, /id="lock-status-consent"[^>]*checked/);
  assert.match(page, /pagehide', cancelLockStatus/);
  assert.match(page, /change', cancelLockStatus/);
  assert.match(page, /without operating the lock/);
});
