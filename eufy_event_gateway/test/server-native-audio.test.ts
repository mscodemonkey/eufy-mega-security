/**
 * Verifies the native transport route: a native token names it only for a
 * camera with live audio, it passes the native profile and view mark to the
 * stream manager, and it refuses compatible tokens and silent cameras.
 * The fake media boundary returns only synthetic fixture bytes.
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
import { GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import { liveAudioStartWaitMilliseconds, type LiveStreamManager, type ViewerProfile } from "../src/stream/live-stream-manager.js";

test("native tokens name the MPEG-TS route only for cameras with live audio", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-audio-"));
  const state = new GatewayState();
  for (const [serial, audio] of [["audio", true], ["video", false]] as const) {
    state.registerCamera({ serial, name: "Synthetic", model: "T8416", stationSerial: "nvr",
      streamSupported: true, doorbellSupported: false, liveAudioSupported: audio });
  }
  const transport: { serial: string; profile: ViewerProfile; view: string | undefined }[] = [];
  const plain: ViewerProfile[] = [];
  const streams = {
    async addTransportClient(serial: string, response: ServerResponse, profile: ViewerProfile, view?: string) {
      transport.push({ serial, profile, view });
      response.writeHead(200, { "Content-Type": "video/mp2t" });
      response.end(Buffer.alloc(188, 0x47));
    },
    async addClient(_serial: string, response: ServerResponse, profile: ViewerProfile) {
      plain.push(profile);
      response.writeHead(200, { "Content-Type": "video/h265" });
      response.end("fixture");
    },
  } as unknown as LiveStreamManager;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "fixture-only" }, state,
    new SnapshotStore(directory), streams, {} as CameraProvider, null);
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: "Bearer fixture-only" };
    const token = async (serial: string, native: boolean): Promise<string> => ((await (await fetch(`${base}/api/cameras/${serial}/stream-token`,
      { method: "POST", headers, ...(native ? { body: '{"profile":"native"}' } : {}) })).json()) as { path: string }).path;

    const nativeAudio = await token("audio", true);
    assert.ok(nativeAudio.startsWith("/api/cameras/audio/live-native.ts?access_token=native."));
    assert.ok((await token("video", true)).startsWith("/api/cameras/video/live-native.annexb?access_token=native."));
    const compatibleAudio = await token("audio", false);
    assert.ok(compatibleAudio.startsWith("/api/cameras/audio/live.ts?access_token="));

    const viewed = await fetch(`${base}${nativeAudio}&view=fixture-view-mark-0001`);
    assert.equal(viewed.status, 200);
    assert.equal(viewed.headers.get("content-type"), "video/mp2t");
    await viewed.arrayBuffer();
    assert.deepEqual(transport, [{ serial: "audio", profile: "native", view: "fixture-view-mark-0001" }]);

    // The same native token also opens the camera's raw route, as before; a compatible token opens neither.
    assert.equal((await fetch(base + nativeAudio.replace("live-native.ts", "live-native.annexb"))).status, 200);
    assert.equal((await fetch(base + compatibleAudio.replace("live.ts", "live-native.ts"))).status, 401);
    assert.equal((await fetch(base + nativeAudio.replace("/audio/", "/video/"))).status, 401);
    assert.equal((await fetch(`${base}/api/cameras/audio/live-native.ts`)).status, 401);
    assert.equal((await fetch(`${base}/api/cameras/video/live-native.ts`, { headers })).status, 409);
    assert.deepEqual(plain, ["native"]);
    assert.equal(transport.length, 1);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("transport viewers hold video for audio only as long as the route needs", () => {
  assert.equal(liveAudioStartWaitMilliseconds({ model: "T8171", serial: "camera", stationSerial: "homebase" }), 12_000);
  assert.equal(liveAudioStartWaitMilliseconds({ model: "T8171", serial: "camera", stationSerial: "camera" }), 2_000);
  assert.equal(liveAudioStartWaitMilliseconds({ model: "T8416", serial: "camera", stationSerial: "nvr" }), 2_000);
});
