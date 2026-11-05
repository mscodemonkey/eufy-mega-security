/**
 * Checks authenticated guard consent and fixed summaries at an ephemeral HTTP
 * boundary. Synthetic providers own all outcomes, so no NVR or cloud changes.
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

const headers = { authorization: `Bearer ${"x".repeat(32)}`, "content-type": "application/json" };

test("NVR guard endpoint requires exact consent and returns only fixed fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nvr-guard-http-"));
  const state = new GatewayState();
  state.registerCamera({ serial: "synthetic", name: "Synthetic", model: "T8E00", stationSerial: "station",
    streamSupported: true, doorbellSupported: false });
  let calls = 0, fail = false;
  const provider = { testNvrGuardMode: async (serial: string, input: unknown, signal: AbortSignal) => {
    if (fail) throw Error("PRIVATE-CANARY");
    calls++; assert.equal(serial, "synthetic"); assert.deepEqual(input, { target: "home", timeZone: "UTC" }); assert.equal(signal.aborted, false);
    return { outcome: "home_confirmed" as const, restored: true as const, scheduleUnchanged: true as const,
      physicalConfirmationRequired: true as const, privateCanary: "PRIVATE-CANARY" };
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "x".repeat(32),
    experimentalNvrControls: true, experimentalModelControls: true, experimentalNvrLive: true }, state,
  new SnapshotStore(directory), { hasActiveSession: () => false } as unknown as LiveStreamManager, provider, null);
  try {
    await server.listen();
    const url = `http://127.0.0.1:${server.port}/api/cameras/synthetic/nvr-guard-trial`;
    const request = { method: "POST", headers, body: JSON.stringify({ consent: true, target: "home", timeZone: "UTC" }) };
    assert.equal((await fetch(url, { ...request, headers: {} })).status, 401);
    for (const body of [{}, { consent: false, target: "home" }, { consent: true, target: "away" },
      { consent: true, target: "home", timeZone: "PRIVATE-CANARY" },
      { consent: true, target: "home", timeZone: "UTC", extra: true }]) {
      assert.equal((await fetch(url, { ...request, body: JSON.stringify(body) })).status, 400);
    }
    assert.equal((await fetch(url, { ...request,
      body: '{"consent":true,"target":"home","timeZone":"UTC","timeZone":"UTC"}' })).status, 400);
    const response = await fetch(url, request);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { outcome: "home_confirmed", restored: true,
      scheduleUnchanged: true, physicalConfirmationRequired: true });
    assert.equal(calls, 1);
    assert.equal((await fetch(url + "?unexpected=1", request)).status, 400);
    assert.equal((await fetch(url, { ...request, headers: { ...headers, "content-type": "text/plain" } })).status, 415);
    fail = true;
    const failure = await fetch(url, request);
    assert.equal(failure.status, 409);
    assert.deepEqual(await failure.json(), { stage: "restore", manualRestoreRequired: true });
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Diagnostics warns that the whole NVR can arm during the guard trial", () => {
  const page = diagnosticsPage();
  assert.match(page, /id="nvr-guard-consent" type="checkbox"/);
  assert.doesNotMatch(page, /id="nvr-guard-consent"[^>]*checked/);
  assert.match(page, /temporarily changes the whole NVR to Home, which may arm cameras or alarms/);
  assert.match(page, /pagehide', \(\) => \{ cancelNvrGuard/);
  assert.match(page, /id="nvr-guard-timezone"[^>]*autocomplete="off"/);
  assert.doesNotMatch(page, /id="nvr-guard-timezone"[^>]*value=/);
  assert.match(page, /el\('nvr-guard-timezone'\).value = ''/);
  new Function(page.split("<script>")[1]!.split("</script>")[0]!);
});
