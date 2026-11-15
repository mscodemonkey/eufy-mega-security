/**
 * Checks that only the admitted 2C HTTP light path owns a media lease.
 * Test servers use synthetic inventory and transport, retaining no credentials
 * or device I/O. Provider confirmation remains independent of lease startup.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import { CameraSettingError } from "../src/provider/camera-settings.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";

for (const mode of ["ready", "unready", "disabled", "other-model", "expired", "unknown"] as const) {
  test(`HTTP manual light source ownership: ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "manual-light-http-"));
    const state = new GatewayState();
    state.registerCamera({ serial: "camera", name: "Synthetic", model: mode === "other-model" ? "T8426" : "T8113-Z",
      deviceType: mode === "other-model" ? 10032 : 8, stationSerial: "base", streamSupported: true, doorbellSupported: false,
      manualFloodlightControlSupported: mode !== "disabled" && mode !== "unknown",
      manualFloodlightControlReason: mode === "disabled" ? "trial_disabled" : mode === "unknown" ? "state_unavailable" : "ready",
      reportedSettings: { imageFlipped: null, statusLedEnabled: null, soundDetectionEnabled: null, manualFloodlightEnabled: mode === "unknown" ? null : false } });
    let held = false, leases = 0, writes = 0, invalidated = 0;
    let retire!: () => void;
    const streams = { async holdManualLightSource(_serial: string, signal: AbortSignal, ready: () => void) {
      leases++;
      if (mode === "unready") throw new Error("source not ready");
      held = true;
      await new Promise<void>(resolve => { retire = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); ready(); });
      held = false;
    } } as unknown as LiveStreamManager;
    const provider = { async setCameraSetting(_serial: string, change: { value: boolean }) {
      if (mode === "disabled") throw new CameraSettingError("unavailable");
      assert.equal(held, mode !== "other-model"); writes++;
      return { ...state.getCamera("camera"), reportedSettings: { ...state.getCamera("camera").reportedSettings!, manualFloodlightEnabled: change.value } };
    }, retireManualLightState() {
      invalidated++;
      state.registerCamera({ ...state.getCamera("camera"), reportedSettings: { ...state.getCamera("camera").reportedSettings!, manualFloodlightEnabled: null } });
    } } as unknown as CameraProvider;
    const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "synthetic-secret" }, state,
      new SnapshotStore(directory), streams, provider, null);
    try {
      await server.listen();
      const url = `http://127.0.0.1:${server.port}/api/cameras/camera/settings`;
      const options = { method: "POST", headers: { authorization: "Bearer synthetic-secret", "content-type": "application/json" } };
      assert.equal((await fetch(url, { ...options, headers: { "content-type": "application/json" }, body: '{"setting":"manualFloodlight","value":true}' })).status, 401);
      assert.equal(leases, 0); assert.equal(writes, 0);
      const on = await fetch(url, { ...options, body: '{"setting":"manualFloodlight","value":true}' });
      if (mode === "unready" || mode === "disabled") {
        assert.equal(on.status, 409); assert.equal(writes, 0); assert.equal(held, false);
      } else {
        assert.equal(on.status, 200); assert.equal(writes, 1);
        if (mode === "expired") {
          retire(); await new Promise(resolve => setImmediate(resolve));
          assert.equal(invalidated, 1); assert.equal(state.getCamera("camera").reportedSettings?.manualFloodlightEnabled, null);
        } else {
          assert.equal(held, mode !== "other-model");
          const off = await fetch(url, { ...options, body: '{"setting":"manualFloodlight","value":false}' });
          assert.equal(off.status, 200); assert.equal(writes, 2); assert.equal(held, false); assert.equal(invalidated, 0);
          assert.equal(leases, mode === "other-model" ? 0 : 1);
        }
      }
    } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
