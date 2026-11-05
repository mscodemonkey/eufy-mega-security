/**
 * Verifies the opt-in cloud preview API and browser ownership with synthetic
 * providers and an ephemeral HTTP server. The provider owns checked MP4 bytes.
 * No vendor account, recording, hardware or browser profile is contacted.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { loadConfig } from "../src/config.js";
import { diagnosticsPage } from "../src/diagnostics/page.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";

const headers = { authorization: `Bearer ${"x".repeat(32)}`, "content-type": "application/json" };
const body = JSON.stringify({ consentPrivateMedia: true, recordId: "record", startTime: 90, endTime: 130, timezoneOffset: 0 });

for (const enabled of [false, true]) test(`cloud recording flag=${enabled} requires authentication, consent and valid selection`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-preview-http-"));
  const state = new GatewayState(); state.registerCamera({ serial: "synthetic", name: "Synthetic", model: "T8113-Z", stationSerial: "station", streamSupported: false, doorbellSupported: false });
  let calls = 0;
  const provider = { cloudRecordingTrial: async (serial: string, id: string, query: unknown, signal: AbortSignal) => {
    calls++; assert.equal(serial, "synthetic"); assert.equal(id, "record"); assert.equal(signal.aborted, false);
    assert.deepEqual(query, { startTime: 90, endTime: 130, timezoneOffset: 0, count: 1000 }); return Buffer.from("checked-private-media");
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "x".repeat(32), experimentalCloudRecordings: enabled },
    state, new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
  try {
    await server.listen(); const url = `http://127.0.0.1:${server.port}/api/cameras/synthetic/cloud-recording-trial`;
    assert.equal((await fetch(url, { method: "POST", body })).status, 401);
    if (!enabled) { assert.equal((await fetch(url, { method: "POST", body, headers })).status, 409); assert.equal(calls, 0); return; }
    for (const invalid of [{}, { consentPrivateMedia: false }, { ...JSON.parse(body), account: "other" },
      { ...JSON.parse(body), startTime: 150 }, { ...JSON.parse(body), recordId: "" }]) {
      assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify(invalid) })).status, 400);
    }
    assert.equal(calls, 0);
    const result = await fetch(url, { method: "POST", body, headers });
    assert.equal(result.status, 200); assert.equal(result.headers.get("content-type"), "video/mp4");
    assert.equal(result.headers.get("cache-control"), "no-store"); assert.equal(await result.text(), "checked-private-media");
    assert.equal(calls, 1);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("cloud preview disconnect cancels and retains the expensive slot until cleanup settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-preview-cancel-"));
  const state = new GatewayState(); state.registerCamera({ serial: "synthetic", name: "Synthetic", model: "T8113-Z", stationSerial: "station", streamSupported: false, doorbellSupported: false });
  let enter!: () => void, finish!: () => void, cancelled!: () => void, calls = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const closing = new Promise<void>(resolve => { finish = resolve; });
  const aborted = new Promise<void>(resolve => { cancelled = resolve; });
  const media = Buffer.from("checked-private-media");
  const provider = { cloudRecordingTrial: async (_serial: string, _id: string, _query: unknown, signal: AbortSignal) => {
    calls++; if (calls === 1) { signal.addEventListener("abort", cancelled, { once: true }); enter(); await closing; return media; }
    return Buffer.from("checked-private-media");
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "x".repeat(32), experimentalCloudRecordings: true },
    state, new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
  try {
    await server.listen(); const url = `http://127.0.0.1:${server.port}/api/cameras/synthetic/cloud-recording-trial`;
    const controller = new AbortController();
    const stopped = assert.rejects(fetch(url, { method: "POST", headers, body, signal: controller.signal }), /abort/i);
    await entered; controller.abort(); await aborted; await stopped;
    assert.equal((await fetch(url, { method: "POST", headers, body })).status, 409);
    finish(); await new Promise(resolve => setImmediate(resolve));
    assert.ok(media.every(byte => byte === 0));
    assert.equal((await fetch(url, { method: "POST", headers, body })).status, 200);
  } finally { finish(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("cloud preview browser selection owns consent, cancellation and object URLs", async () => {
  const page = diagnosticsPage(), script = page.match(/<script>([\s\S]*)<\/script>/i)?.[1]; assert.ok(script);
  const nodes = new Map<string, { value: string; checked: boolean; disabled: boolean; hidden: boolean; textContent: string;
    onclick?: () => Promise<void>; handlers: Map<string, () => void>; addEventListener: (event: string, callback: () => void) => void;
    replaceChildren: (...values: unknown[]) => void; add: (value: unknown) => void; removeAttribute: (name: string) => void }>();
  const node = (id: string) => {
    if (!nodes.has(id)) {
      const handlers = new Map<string, () => void>();
      nodes.set(id, { value: "", checked: false, disabled: false, hidden: false, textContent: "", handlers,
        addEventListener: (event, callback) => { handlers.set(event, callback); }, replaceChildren: () => {}, add: () => {}, removeAttribute: () => {} });
    }
    return nodes.get(id)!;
  };
  const urls: string[] = [], revoked: string[] = [];
  let late = false, finish!: (response: Response) => void, entered!: () => void, pendingSignal: AbortSignal | null = null;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  new Script(script).runInNewContext({ document: { getElementById: node }, window: { addEventListener: () => {} }, location: { protocol: "https:" },
    Option: class { constructor(readonly text: string, readonly value: string) {} }, Date, AbortController, URLSearchParams,
    URL: { revokeObjectURL: (url: string) => { revoked.push(url); }, createObjectURL: () => "blob:private" },
    setInterval, clearInterval,
    fetch: async (url: string, options: RequestInit) => {
      urls.push(url);
      if (url.endsWith("cloud-recording-trial")) {
        if (late) { pendingSignal = options.signal!; entered(); return pending; }
        return new Response("checked-private-media");
      }
      return new Response(JSON.stringify({ records: [{ id: "record", startTime: 100, hasCloudMedia: true }] }));
    } });
  node("device").value = "synthetic"; node("cloud-date").value = "2026-10-16";
  await node("cloud-list").onclick!(); assert.equal(urls.length, 1); assert.match(urls[0]!, /cloud-history\?/);
  node("cloud-record").value = "record"; node("cloud-consent").checked = true;
  await node("cloud-test").onclick!(); assert.equal(node("cloud-video").hidden, false);
  node("cloud-record").handlers.get("change")!(); assert.equal(node("cloud-consent").checked, false);
  assert.deepEqual(revoked, ["blob:private"]); assert.equal(node("cloud-video").hidden, true);
  node("cloud-consent").checked = true; late = true;
  const stale = node("cloud-test").onclick!(); await waiting;
  node("device").handlers.get("change")!(); assert.equal(node("cloud-status").textContent, "No cloud recording selected.");
  assert.equal((pendingSignal as AbortSignal | null)?.aborted, true);
  finish(new Response("late-private-media")); await stale;
  assert.equal(node("cloud-video").hidden, true); assert.deepEqual(revoked, ["blob:private"]);
});
