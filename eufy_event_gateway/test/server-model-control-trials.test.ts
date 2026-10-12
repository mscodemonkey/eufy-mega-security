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
import { runS100SirenTrial } from "../src/provider/s100-siren-trial.js";
import { diagnosticsPage } from "../src/diagnostics/page.js";

for (const enabled of [false, true]) {
  test(`model control HTTP opt-in=${enabled} authenticates, validates and never updates state optimistically`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "eufy-trials-http-"));
    const state = new GatewayState();
    state.registerCamera({ serial: "synthetic", name: "Synthetic", model: "T8423", stationSerial: "synthetic",
      streamSupported: false, doorbellSupported: false, motionDetectionEnabled: true });
    let writes = 0, fail = false;
    const provider = { modelControlTrials: () => ["motion", "ptz"], performModelControlTrial: async () => {
      writes++;
      if (fail) throw Error("Trial not confirmed");
      return { outcome: "acknowledged", physicalConfirmationRequired: true };
    } } as unknown as CameraProvider;
    const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "synthetic-secret", experimentalModelControls: enabled },
      state, new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
    try {
      await server.listen();
      const base = `http://127.0.0.1:${server.port}/api/cameras`;
      const options = { method: "POST", headers: { authorization: "Bearer synthetic-secret", "content-type": "application/json" }, body: '{"action":"motion","enabled":false}' };
      assert.equal((await fetch(`${base}/synthetic/model-control-trial`, { ...options, headers: {} })).status, 401);
      if (!enabled) {
        assert.equal((await fetch(`${base}/synthetic/model-control-trial`, options)).status, 409);
        assert.equal(writes, 0);
        return;
      }
      assert.equal((await fetch(`${base}/missing/model-control-trial`, options)).status, 404);
      for (const body of [{ action: "motion", enabled: 1 }, { action: "ptz", direction: "diagonal" }, { action: "motion", enabled: true, command: 6040 }]) {
        assert.equal((await fetch(`${base}/synthetic/model-control-trial`, { ...options, body: JSON.stringify(body) })).status, 400);
      }
      assert.equal((await fetch(`${base}/synthetic/model-control-trial`, { ...options, body: '{"action":"spotlight","enabled":true}' })).status, 409);
      assert.equal(writes, 0);
      const actions = await fetch(`${base}/synthetic/model-control-trial`, { headers: options.headers });
      assert.equal(actions.headers.get("cache-control"), "no-store");
      assert.deepEqual((await actions.json()).actions, ["motion", "ptz"]);
      assert.deepEqual(await (await fetch(`${base}/synthetic/model-control-trial`, options)).json(), { outcome: "acknowledged", physicalConfirmationRequired: true });
      assert.equal(state.getCamera("synthetic").motionDetectionEnabled, true);
      fail = true;
      assert.equal((await fetch(`${base}/synthetic/model-control-trial`, options)).status, 500);
      assert.equal(state.getCamera("synthetic").motionDetectionEnabled, true);
      assert.equal(writes, 2);
    } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test("trial form is opt-in, explicit, single-submit and syntactically valid", () => {
  const page = diagnosticsPage();
  assert.match(page, /trial-consent/);
  assert.match(page, /Stop live view first/);
  assert.match(page, /trial-send'\).disabled = true/);
  assert.match(page, /model-control-trial/);
  assert.match(page, /Five-second sound test/);
  assert.match(page, /Stop siren/);
  assert.match(page, /device enforcement is unverified/);
  new Function(page.split("<script>")[1]!.split("</script>")[0]!);
});


test("S100 HTTP client disconnect leaves provider-owned stop cleanup running", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-s100-http-"));
  const state = new GatewayState();
  state.registerCamera({ serial: "test", name: "Synthetic", model: "T84A1", stationSerial: "test", streamSupported: false, doorbellSupported: false });
  const pulse = new AbortController(), client = new AbortController();
  let started!: () => void, completed!: () => void, stops = 0;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const finished = new Promise<void>(resolve => { completed = resolve; });
  const provider = { modelControlTrials: () => ["siren"], performModelControlTrial: async () => {
    try {
      return await runS100SirenTrial({ start: async () => { started(); }, stop: async () => { stops++; } }, true, pulse.signal, () => {});
    } finally { completed(); }
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "fixture", experimentalModelControls: true },
    state, new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
  try {
    await server.listen();
    const url = `http://127.0.0.1:${server.port}/api/cameras/test/model-control-trial`;
    const headers = { authorization: "Bearer fixture", "content-type": "application/json" };
    assert.equal((await fetch(url, { method: "POST", headers, body: '{"action":"siren","enabled":true,"duration":900}' })).status, 400);
    const request = fetch(url, { method: "POST", headers, body: '{"action":"siren","enabled":true}', signal: client.signal });
    await entered;
    client.abort(); await assert.rejects(request, /abort/i);
    assert.equal(stops, 0);
    pulse.abort(); await finished;
    assert.equal(stops, 1);
  } finally { pulse.abort(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
