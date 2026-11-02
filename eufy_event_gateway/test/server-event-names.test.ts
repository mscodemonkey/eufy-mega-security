/**
 * Checks manual history-name HTTP admission, privacy and disconnect cancellation.
 * Synthetic providers own all responses. These tests never contact Eufy devices.
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

test("manual name checks authenticate, validate before dispatch and expose only aggregate counts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "event-names-http-")), state = new GatewayState();
  state.registerCamera({ serial: "invented", name: "Invented", model: "T8210", stationSerial: "parent", streamSupported: false, doorbellSupported: true });
  let calls = 0;
  const summary = { scope: "one_history_page", records: 1, personCrops: 1, recordsWithFamiliarNames: 1, unresolvedPersonCrops: 0 };
  const provider = { diagnoseEventNames: async (_serial: string, date: string, cursor: string) => {
    calls++; assert.equal(date, "2026-10-31"); assert.equal(cursor, "0"); return { ...summary, privateName: "PRIVATE-CANARY" };
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "invented-secret" }, state,
    new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
  const headers = { authorization: "Bearer invented-secret", "content-type": "application/json" }, body = JSON.stringify({ date: "2026-10-31" });
  try {
    await server.listen(); const url = `http://127.0.0.1:${server.port}/api/cameras/invented/diagnostics/event-names`;
    assert.equal((await fetch(url, { method: "POST", body })).status, 401);
    for (const invalid of [{ date: "2026-02-30" }, { date: "2026-10-31", startId: "9007199254740992" },
      { date: "2026-10-31", startId: 2 }, { date: "2026-10-31", table: "other" }]) {
      assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify(invalid) })).status, 400);
    }
    assert.equal(calls, 0);
    const response = await fetch(url, { method: "POST", headers, body });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), summary); assert.equal(calls, 1);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
