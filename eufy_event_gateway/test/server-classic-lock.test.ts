/**
 * Exercises lock visibility and command refusal through real local HTTP/SSE.
 * The fixture owns synthetic cached facts and a provider with no motor. It
 * proves that enabling observations cannot inherit E30 command authority.
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
import { classicLockInventory } from "../src/provider/classic-lock-inventory.js";
import type { SmartLockState } from "../src/domain/types.js";

for (const read of [false, true]) for (const motor of [false, true]) {
  test(`classic lock HTTP and SSE visibility read=${read}, motor=${motor}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "classic-http-"));
    const state = new GatewayState();
    const classic = classicLockInventory([{ device_sn: "classic", device_model: "T8520", device_type: 51, category: "eufy_security",
      params: [{ param_type: 6000, param_value: "4" }] }], true, Date.now())[0]!;
    const e30: SmartLockState = { serial: "e30", name: "Fixture", model: "T85F1", state: "locked", available: true, batteryPercent: 70, stateObservedAt: new Date().toISOString() };
    state.replaceLocks([classic, e30]);
    let calls = 0;
    const provider = { setLockState: async () => { calls++; return classic; }, refreshLock: async () => { calls++; return classic; }, setLockSetting: async () => { calls++; return classic; } } as unknown as CameraProvider;
    const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "fixture", experimentalModelControls: read, experimentalE30Locks: motor },
      state, new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
    const controller = new AbortController();
    try {
      await server.listen(); const root = `http://127.0.0.1:${server.port}`;
      const headers = { authorization: "Bearer fixture", "content-type": "application/json" };
      assert.equal((await fetch(root + "/api/locks")).status, 401);
      const expected = [...(read ? ["classic"] : []), ...(motor ? ["e30"] : [])].sort();
      const body = await (await fetch(root + "/api/locks", { headers })).json() as { locks: SmartLockState[] };
      assert.deepEqual(body.locks.map(lock => lock.serial).sort(), expected);
      for (const [endpoint, value] of [["state", { locked: true }], ["settings", { setting: "autoLock", value: true }], ["refresh", {}]] as const) {
        const response = await fetch(root + `/api/locks/classic/${endpoint}`, { method: "POST", headers, body: JSON.stringify(value) });
        assert.equal(response.status, 409);
        const failure = await response.json() as { code: string };
        assert.equal(failure.code, motor ? "read_only" : "disabled");
      }
      assert.equal(calls, 0);
      const events = await fetch(root + "/api/events", { headers, signal: controller.signal });
      const reader = events.body!.getReader(), decoder = new TextDecoder();
      const first = decoder.decode((await reader.read()).value);
      const ready = JSON.parse(first.split("data: ")[1]!.split("\n")[0]!) as { locks: SmartLockState[] };
      assert.deepEqual(ready.locks.map(lock => lock.serial).sort(), expected);
      state.replaceLocks([classic, e30]);
      const next = decoder.decode((await reader.read()).value);
      const replacement = JSON.parse(next.split("data: ")[1]!.split("\n")[0]!) as { locks: SmartLockState[] };
      assert.deepEqual(replacement.locks.map(lock => lock.serial).sort(), expected);
      controller.abort(); await reader.cancel().catch(() => undefined);
    } finally { controller.abort(); await server.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
