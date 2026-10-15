/**
 * Checks authenticated consent and decoded private clips on the doorbell trial API.
 * Tests own temporary stores, local HTTP servers and generated media. Provider
 * leases are synthetic, so these checks do not establish camera compatibility.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { loadConfig } from "../src/config.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";
import { diagnosticsPage } from "../src/diagnostics/page.js";
import { validateStoredMedia } from "../src/stream/stored-recordings.js";

for (const enabled of [false, true]) test(`doorbell opt-in=${enabled} protects consent and validates returned media`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "doorbell-http-"));
  const state = new GatewayState();
  state.registerCamera({ serial: "synthetic", name: "Synthetic", model: "T8224", stationSerial: "synthetic", streamSupported: false, doorbellSupported: true });
  let acquired = 0, released = 0, busy = false;
  const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=32x32:rate=10", "-t", "0.2",
    "-c:v", "libx264", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"]);
  assert.equal(generated.status, 0);
  let media = generated.stdout;
  const provider = { reserveDoorbellRtcTrial: () => { acquired++; return async () => { released++; }; } } as unknown as CameraProvider;
  const streams = { hasActiveSession: () => busy, recordClip: async (_camera: string, seconds: number, timeout: number, diagnostic: boolean) => {
    assert.equal(seconds, 10); assert.equal(timeout, 75_000); assert.equal(diagnostic, true); return media;
  } } as unknown as LiveStreamManager;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "x".repeat(32), experimentalDoorbellRtc: enabled },
    state, new SnapshotStore(directory), streams, provider, null);
  try {
    await server.listen();
    const url = `http://127.0.0.1:${server.port}/api/cameras/synthetic/doorbell-video-trial`;
    const options = { method: "POST", headers: { authorization: `Bearer ${"x".repeat(32)}`, "content-type": "application/json" }, body: '{"consentPrivateMedia":true}' };
    assert.equal((await fetch(url, { ...options, headers: {} })).status, 401);
    if (!enabled) { assert.equal((await fetch(url, options)).status, 409); assert.equal(acquired, 0); return; }
    for (const body of ['{}', '{"consentPrivateMedia":false}', '{"consentPrivateMedia":true,"command":1}']) {
      assert.equal((await fetch(url, { ...options, body })).status, 400);
    }
    assert.equal(acquired, 0);
    busy = true; assert.equal((await fetch(url, options)).status, 409); assert.equal(acquired, 0); busy = false;
    const response = await fetch(url, options);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), media);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(released, 1);
    await assert.rejects(validateStoredMedia(media, undefined, 1), /did not fully decode/);
    media = Buffer.from("invalid-private-video");
    const invalid = await fetch(url, options); assert.equal(invalid.status, 409);
    const failure = await invalid.json() as { stage: string; error: string };
    assert.equal(failure.stage, "video"); assert.equal(failure.error.includes("invalid-private"), false);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(acquired, 2); assert.equal(released, 2);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("doorbell Diagnostics keeps private consent, cancellation and page-exit cleanup", () => {
  const page = diagnosticsPage();
  assert.match(page, /doorbell-consent/); assert.match(page, /doorbell-video-trial/);
  assert.match(page, /if\(doorbellJob\) doorbellJob\.abort\(\)/);
  assert.match(page, /URL\.revokeObjectURL\(doorbellClip\)/);
  const script = page.match(/<script>([\s\S]*)<\/script>/i)?.[1]; assert.ok(script);
  new Script(script);
});
