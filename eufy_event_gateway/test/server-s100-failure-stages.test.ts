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


import { S100SirenTrialError, type S100SirenFailureStage } from "../src/provider/s100-siren-trial.js";

test("S100 failure responses rebuild fixed messages and closed stages with no private error text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "s100-errors-")), state = new GatewayState();
  state.registerCamera({ serial: "fixture", name: "Synthetic", model: "T84A1", stationSerial: "fixture", streamSupported: false, doorbellSupported: false });
  let failure: unknown;
  const provider = { modelControlTrials: () => ["sirenConnection", "siren"], performModelControlTrial: async () => { throw failure; } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "fixture", experimentalModelControls: true },
    state, new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
  try {
    await server.listen(); const url = `http://127.0.0.1:${server.port}/api/cameras/fixture/model-control-trial`;
    const options = { method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" }, body: '{"action":"sirenConnection","enabled":false}' };
    for (const stage of ["gateway_decrypt", "cipher_lookup_error", "cipher_missing_key", "cipher_unwrap_failed", "session_prepare", "session_gateway", "session_cipher"] as const) {
      for (const connectionOnly of [true, false]) {
        failure = new S100SirenTrialError(["session_cipher", stage], connectionOnly);
        (failure as Error).message = "private-serial-owner-key";
        const response = await fetch(url, options); assert.equal(response.status, 409); assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(await response.json(), { error: new S100SirenTrialError(["session_cipher", stage], connectionOnly).message, stages: ["session_cipher", stage] });
      }
    }
    failure = new S100SirenTrialError(["private-serial-owner-key" as S100SirenFailureStage], true);
    const response = await fetch(url, options);
    assert.deepEqual(await response.json(), { error: new S100SirenTrialError(["session_prepare"], true).message, stages: ["session_prepare"] });
    failure = new Error("Ordinary fixed failure"); assert.equal((await fetch(url, options)).status, 500);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
