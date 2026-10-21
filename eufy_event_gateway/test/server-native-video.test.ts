/**
 * Verifies native URL authentication and strict profile admission over owned
 * local HTTP. The fake media boundary returns only synthetic fixture bytes.
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
import { createNativeStreamToken, createStreamToken, GatewayServer, validateNativeStreamToken, validateStreamToken } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager, ViewerProfile } from "../src/stream/live-stream-manager.js";

test("native token domains, strict expiry and unusual camera keys stay isolated", () => {
  assert.equal(createStreamToken("fixture", 1600, "fixture-only"), "1600.268sFIc_AXf_fbhb8MCVXQc4BPYG7GGW9XQ8sFDLpS8");
  for (const key of ["fixture", ".", '\",[', "%/!'()*"]) {
    const compatible = createStreamToken(key, 1600, "fixture-only");
    const native = createNativeStreamToken(key, 1600, "fixture-only");
    assert.ok(validateNativeStreamToken(key, native, "fixture-only", 1000));
    assert.ok(!validateNativeStreamToken(key, compatible, "fixture-only", 1000));
    assert.ok(!validateStreamToken(key, native, "fixture-only", 1000));
    assert.ok(!validateNativeStreamToken(key + "x", native, "fixture-only", 1000));
    assert.ok(!validateNativeStreamToken(key, native, "fixture-only", 1601));
    assert.ok(!validateNativeStreamToken(key, native, "other-fixture", 1000));
    assert.ok(!validateNativeStreamToken(key, native.replace("1600", "01600"), "fixture-only", 1000));
    assert.ok(!validateNativeStreamToken(key, createNativeStreamToken(key, 1661, "fixture-only"), "fixture-only", 1000));
  }
});

test("profile request grammar, precedence and signed native routing are checked independently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-profile-"));
  const state = new GatewayState();
  state.registerCamera({ serial: "fixture", name: "Synthetic", model: "T8171", stationSerial: "fixture",
    streamSupported: true, doorbellSupported: false, liveAudioSupported: false });
  state.registerCamera({ serial: "blocked", name: "Synthetic", model: "T8171", stationSerial: "blocked",
    streamSupported: false, doorbellSupported: false });
  const calls: ViewerProfile[] = [];
  const streams = { async addClient(_key: string, response: ServerResponse, profile: ViewerProfile) {
    calls.push(profile); response.writeHead(200, { "Content-Type": "video/h264" }); response.end("fixture");
  } } as unknown as LiveStreamManager;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "fixture-only" }, state,
    new SnapshotStore(directory), streams, {} as CameraProvider, null);
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: "Bearer fixture-only" };
    for (const body of ['[]', 'null', '1', '"native"', ' ', '{', '{"profile":null}', '{"profile":true}',
      '{"profile":{}}', '{"profile":"Native"}', '{"extra":"native"}', '{"profile":"native","profile":"compatible"}',
      '{"profile":"native","\\u0070rofile":"native"}', '{"profile":"native",}', '{"profile":"native","x":"x"}', " ".repeat(16_385)]) {
      const response = await fetch(`${base}/api/cameras/fixture/stream-token`, { method: "POST", headers, body });
      assert.equal(response.status, 400, body.slice(0, 80));
    }
    assert.equal((await fetch(`${base}/api/cameras/missing/stream-token`, { method: "POST", headers, body: "[]" })).status, 400);
    assert.equal((await fetch(`${base}/api/cameras/missing/stream-token`, { method: "POST", headers })).status, 404);
    assert.equal((await fetch(`${base}/api/cameras/blocked/stream-token`, { method: "POST", headers })).status, 409);
    assert.equal((await fetch(`${base}/api/cameras/fixture/stream-token`, { method: "POST", body: "[]" })).status, 401);
    const original = await (await fetch(`${base}/api/cameras/fixture/stream-token`, { method: "POST", headers })).json() as { path: string; expiresAt: number };
    assert.deepEqual(Object.keys(original), ["path", "expiresAt"]);
    const response = await fetch(`${base}/api/cameras/fixture/stream-token`, { method: "POST", headers, body: '{ "profile" : "native" }' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const native = await response.json() as { path: string; profile: string };
    assert.equal(native.profile, "native");
    assert.equal((await fetch(base + native.path)).status, 200);
    assert.equal((await fetch(base + native.path.replace("live-native.annexb", "live.h264"))).status, 401);
    assert.equal((await fetch(base + original.path.replace("live.h264", "live-native.annexb"))).status, 401);
    assert.equal((await fetch(base + native.path + "&access_token=duplicate")).status, 401);
    assert.equal((await fetch(`${base}/api/cameras/fixture/live-native.annexb`, { headers })).status, 200);
    assert.deepEqual(calls, ["native", "native"]);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
