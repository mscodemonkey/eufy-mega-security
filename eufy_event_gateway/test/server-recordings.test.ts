/**
 * Validates recording HTTP authentication, opaque references, preparation
 * de-duplication and seekable cached responses with a synthetic provider.
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

test("recordings require current eligibility and auth; prepared media supports seeking", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-recordings-http-"));
  const state = new GatewayState();
  const identity = { serial: "synthetic", name: "Synthetic", model: "T8171", stationSerial: "synthetic",
    streamSupported: false, doorbellSupported: false, storedRecordingsSupported: true };
  state.registerCamera(identity);
  const id = "a".repeat(64), data = Buffer.from("0123456789"), headers = { authorization: "Bearer synthetic-secret" };
  let downloads = 0, listings = 0;
  let release!: () => void;
  const provider = {
    listStoredRecordings: async () => { listings++; return [{ id, startTime: "2026-10-09T00:00:00Z", endTime: null }]; },
    downloadStoredRecording: async (_serial: string, value: string) => {
      downloads++; if (value !== id) return null;
      await new Promise<void>((resolve) => { release = resolve; }); return data;
    },
  } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "synthetic-secret" }, state,
    new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.port}/api/cameras/synthetic/recordings`;
    assert.equal((await fetch(`${base}?date=2026-10-09`)).status, 401);
    assert.equal((await fetch(`${base}?date=2026-02-30`, { headers })).status, 400);
    assert.equal(listings, 0);
    const listed = await (await fetch(`${base}?date=2026-10-09`, { headers })).json();
    assert.deepEqual(listed, { records: [{ id, startTime: "2026-10-09T00:00:00Z", endTime: null }] });
    assert.equal((await fetch(`${base}/bad/prepare`, { method: "POST", headers })).status, 404);
    assert.equal((await fetch(`${base}/${"b".repeat(64)}/prepare`, { method: "POST", headers })).status, 404);
    const first = fetch(`${base}/${id}/prepare`, { method: "POST", headers });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    const second = fetch(`${base}/${id}/prepare`, { method: "POST", headers });
    await new Promise((resolve) => setTimeout(resolve, 20)); release();
    assert.deepEqual((await Promise.all([first, second])).map((response) => response.status), [200, 200]);
    assert.equal(downloads, 2);
    assert.equal((await fetch(`${base}/${id}/prepare`, { method: "POST", headers })).status, 200);
    assert.equal(downloads, 2);
    const full = await fetch(`${base}/${id}/video`, { headers });
    assert.equal(full.headers.get("content-type"), "video/mp4"); assert.equal(await full.text(), "0123456789");
    const partial = await fetch(`${base}/${id}/video`, { headers: { ...headers, range: "bytes=3-5" } });
    assert.equal(partial.status, 206); assert.equal(partial.headers.get("content-range"), "bytes 3-5/10"); assert.equal(await partial.text(), "345");
    const head = await fetch(`${base}/${id}/video`, { method: "HEAD", headers });
    assert.equal(head.headers.get("content-length"), "10"); assert.equal(await head.text(), "");
    assert.equal((await fetch(`${base}/${id}/video`, { headers: { ...headers, range: "bytes=10-" } })).status, 416);
    state.registerCamera({ ...identity, storedRecordingsSupported: false });
    assert.equal((await fetch(`${base}/${id}/video`, { headers })).status, 501);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("disconnecting the only preparation waiter aborts the camera download", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-recordings-cancel-"));
  const state = new GatewayState();
  state.registerCamera({ serial: "synthetic", name: "Synthetic", model: "T8171", stationSerial: "synthetic",
    streamSupported: false, doorbellSupported: false, storedRecordingsSupported: true });
  let started!: () => void, cancelled!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const aborted = new Promise<void>((resolve) => { cancelled = resolve; });
  const provider = { listStoredRecordings: async () => [], downloadStoredRecording: async (_serial: string, _id: string, signal: AbortSignal) => {
    started();
    return await new Promise<Buffer>((_resolve, reject) => signal.addEventListener("abort", () => {
      cancelled(); reject(new Error("Download cancelled"));
    }, { once: true }));
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "synthetic-secret" }, state,
    new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
  try {
    await server.listen();
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${server.port}/api/cameras/synthetic/recordings/${"a".repeat(64)}/prepare`, {
      method: "POST", headers: { authorization: "Bearer synthetic-secret" }, signal: controller.signal,
    });
    await ready; controller.abort(); await assert.rejects(pending);
    await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error("Download was not cancelled")), 1_000))]);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
