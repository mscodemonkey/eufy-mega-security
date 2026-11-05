/**
 * Exercises raw-history privacy boundaries over a real local HTTP listener.
 * The test owns synthetic traffic and disposable storage, never Eufy accounts.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { RawHistory, setRawHistory, decodeRawSegment } from "../src/diagnostics/raw-history.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";

test("private raw export requires bearer auth and explicit consent and stays out of ordinary diagnostics", async t => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-raw-http-"));
  const history = new RawHistory({ directory: join(directory, "journal"), reserveBytes: 1 });
  await history.initialize(); setRawHistory(history);
  history.record({ boundary: "test", connection: "fixture", direction: "receive" }, Buffer.from("private-synthetic-payload"));
  await history.flush();
  const token = "synthetic-private-api-token-at-least-32";
  const config = { ...loadConfig({ EUFY_GATEWAY_API_TOKEN: token }), port: 0 };
  const snapshots = new SnapshotStore(directory); await snapshots.initialize();
  const server = new GatewayServer(config, new GatewayState(), snapshots, {} as LiveStreamManager, {} as CameraProvider, null, null);
  t.after(async () => { await server.close(); setRawHistory(undefined); await history.close(); await rm(directory, { recursive: true, force: true }); });
  await server.listen();
  const base = `http://127.0.0.1:${server.port}/api/diagnostics/`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  for (const path of ["raw-history", "raw-history/files", "raw-history/export"]) {
    const denied = await fetch(base + path + `?token=${token}`);
    assert.equal(denied.status, 401); assert.equal(denied.headers.get("cache-control"), "no-store");
  }
  assert.equal((await fetch(base + "raw-history/export", { headers })).status, 405);
  for (const body of [{ file: "key" }, { consentPrivateRaw: true, file: "../key" }, { consentPrivateRaw: true, file: "key", other: true }]) {
    assert.equal((await fetch(base + "raw-history/export", { method: "POST", headers, body: JSON.stringify(body) })).status, 400);
  }
  const inventory = await (await fetch(base + "raw-history/files", { headers })).json() as { files: { name: string }[] };
  assert.equal(inventory.files.length, 1); assert.ok(inventory.files.every(file => file.name !== "key"));
  async function download(file: string): Promise<Buffer> {
    const response = await fetch(base + "raw-history/export", { method: "POST", headers, body: JSON.stringify({ file, consentPrivateRaw: true }) });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    return Buffer.from(await response.arrayBuffer());
  }
  const key = await download("key"); assert.deepEqual(key, await readFile(join(directory, "journal/key")));
  const decoded = decodeRawSegment(await download(inventory.files[0]!.name), key);
  assert.equal(decoded.records.length, 1);
  const summary = await (await fetch(base + "summary", { headers })).text();
  assert.equal(summary.includes("private-synthetic-payload"), false); assert.equal(summary.includes(key.toString("hex")), false);
});
