/**
 * Verifies signed live transport routing and camera ownership over local HTTP.
 * Test-owned providers and sinks produce synthetic bytes without camera or
 * cloud access. Transport decoding is checked separately by the muxer tests.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { createStreamToken, GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";

test("live audio tokens remain limited to the requested camera's live endpoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-live-http-"));
  const state = new GatewayState();
  for (const [serial, audio] of [["audio", true], ["video", false]] as const) {
    state.registerCamera({ serial, name: "Synthetic", model: "T8171", stationSerial: serial,
      streamSupported: true, doorbellSupported: false, liveAudioSupported: audio });
  }
  let calls = 0;
  const streams = {
    async addTransportClient(serial: string, response: ServerResponse) {
      calls++;
      assert.equal(serial, "audio");
      response.writeHead(200, { "Content-Type": "video/mp2t" });
      response.end(Buffer.alloc(188, 0x47));
    },
  } as unknown as LiveStreamManager;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "synthetic-secret" },
    state, new SnapshotStore(directory), streams, {} as CameraProvider, null);
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: "Bearer synthetic-secret" };
    const token = await (await fetch(`${base}/api/cameras/audio/stream-token`, { method: "POST", headers })).json() as { path: string };
    assert.ok(token.path.startsWith("/api/cameras/audio/live.ts?access_token="));
    const allowed = await fetch(base + token.path);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("content-type"), "video/mp2t");
    await allowed.arrayBuffer();
    assert.equal((await fetch(`${base}/api/cameras/audio/live.ts`)).status, 401);
    assert.equal((await fetch(base + token.path.replace("/audio/", "/video/"))).status, 401);
    assert.equal((await fetch(base + token.path.replace("/live.ts", "/cloud-history"))).status, 401);
    assert.equal((await fetch(base + token.path, { method: "POST" })).status, 401);
    const expired = createStreamToken("audio", Math.floor(Date.now() / 1000) - 1, "synthetic-secret");
    assert.equal((await fetch(`${base}/api/cameras/audio/live.ts?access_token=${expired}`)).status, 401);
    assert.equal((await fetch(`${base}/api/cameras/video/live.ts`, { headers })).status, 409);
    const legacy = await (await fetch(`${base}/api/cameras/video/stream-token`, { method: "POST", headers })).json() as { path: string };
    assert.ok(legacy.path.startsWith("/api/cameras/video/live.h264?access_token="));
    assert.equal(calls, 1);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
