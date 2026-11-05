/**
 * Exercise authenticated speaker upload admission with synthetic audio.
 * The provider owns native transmission and hardware audibility validation.
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

test("speaker uploads validate before acquiring media and reject concurrent playback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-speaker-http-"));
  const state = new GatewayState();
  const identity = { serial: "synthetic", stationSerial: "synthetic", name: "Synthetic", model: "T817L", streamSupported: true, doorbellSupported: false, talkbackSupported: true };
  state.registerCamera(identity);
  const audio = Buffer.from([0xff, 0xf1, 0x60, 0x40, 0x01, 0x1f, 0xfc, 0]);
  let leases = 0, plays = 0;
  let finish!: () => void;
  const provider = { playCameraAudio: async (_serial: string, bytes: Buffer, signal: AbortSignal) => {
    plays++; assert.deepEqual(bytes, audio); assert.equal(signal.aborted, false);
    await new Promise<void>((resolve) => { finish = resolve; });
  } } as unknown as CameraProvider;
  const streams = { withLiveSource: async (_serial: string, action: () => Promise<void>) => { leases++; await action(); } } as unknown as LiveStreamManager;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "synthetic-secret" }, state, new SnapshotStore(directory), streams, provider, null);
  const headers = { authorization: "Bearer synthetic-secret", "content-type": "audio/aac" };
  try {
    await server.listen();
    const url = `http://127.0.0.1:${server.port}/api/cameras/synthetic/speaker-audio`;
    const post = (body: Buffer, extra = headers) => fetch(url, { method: "POST", headers: extra, body: new Uint8Array(body) });
    assert.equal((await post(audio, { ...headers, authorization: "Bearer wrong" })).status, 401);
    assert.equal((await post(Buffer.alloc(320_001))).status, 400);
    assert.equal((await post(Buffer.from("invalid"))).status, 400);
    assert.equal(leases, 0);
    state.registerCamera({ ...identity, talkbackSupported: false });
    assert.equal((await post(audio)).status, 409);
    state.registerCamera(identity);
    const pending = post(audio);
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await post(audio)).status, 409);
    finish(); assert.equal((await pending).status, 200);
    assert.equal(leases, 1); assert.equal(plays, 1);
  } finally { finish?.(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
