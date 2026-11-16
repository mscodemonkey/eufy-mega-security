/**
 * Qualifies the derived pane HTTP boundary with synthetic provider admission.
 * The loopback server owns tokens and retained images. No camera starts, account
 * changes, recording or vendor request is permitted by these fixtures.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { decode } from "jpeg-js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { createStreamToken, GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";

test("main-lens tokens and stills require admission without opening the combined source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shared-lens-http-")), state = new GatewayState();
  state.registerCamera({ serial: "test", name: "Synthetic", model: "T8214", stationSerial: "station", streamSupported: true, doorbellSupported: false });
  state.registerCamera({ serial: "other", name: "Synthetic", model: "T8416", stationSerial: "station", streamSupported: true, doorbellSupported: false });
  let admitted = true, calls = 0;
  const streams = { addMainLensClient: async (serial: string, response: import("node:http").ServerResponse) => {
    calls++; assert.equal(serial, "test"); response.writeHead(200); response.end("main");
  } } as unknown as LiveStreamManager;
  const provider = { mainLensViewAdmitted: (serial: string) => admitted && serial === "test" } as unknown as CameraProvider;
  const snapshots = new SnapshotStore(directory);
  await snapshots.initialize();
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "fixture" }, state, snapshots, streams, provider, null);
  try {
    await server.listen(); const base = `http://127.0.0.1:${server.port}/api/cameras`;
    const headers = { authorization: "Bearer fixture", "content-type": "application/json" };
    const token = async (body: string, serial = "test") => await fetch(`${base}/${serial}/stream-token`, { method: "POST", headers, body });
    for (const body of ['{"lens":"other"}', '{"lens":"main","profile":"native"}', '{"lens":"movable","audio":"on"}',
      '{"lens":"fixed","lens":"movable"}', '{"lens":"fixed","command":"write"}']) assert.equal((await token(body)).status, 400);
    assert.equal((await token('{"lens":"main"}', "other")).status, 409); assert.equal(calls, 0);
    for (const lens of ["main"]) {
      const response = await token(JSON.stringify({ lens, profile: "compatible", audio: "off" }));
      assert.equal(response.headers.get("cache-control"), "no-store");
      const result = await response.json(); assert.equal(result.lens, lens);
      const url = new URL(result.path, base);
      assert.equal(url.pathname, `/api/cameras/test/live-${lens}.h264`);
      assert.equal((await fetch(`${base}/test/live-${lens}.h264`)).status, 401);
      assert.equal(await (await fetch(url)).text(), lens);
      url.pathname = `/api/cameras/other/live-${lens}.h264`;
      assert.equal((await fetch(url)).status, 401);
    }
    assert.equal(calls, 1);
    const jpeg = (height: number) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      `color=red:size=1600x${height},drawbox=x=0:y=${height / 2}:w=iw:h=${height / 2}:color=blue:t=fill`,
      "-frames:v", "1", "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1"]);
    await snapshots.write("test", jpeg(2200), "image/jpeg", "live");
    for (const lens of ["main"]) {
      const imageResponse = await fetch(`${base}/test/snapshot-${lens}`, { headers });
      assert.equal(imageResponse.status, 200);
      const image = decode(Buffer.from(await imageResponse.arrayBuffer()));
      assert.deepEqual([image.width, image.height], [1600, 1100]);
      const pixel = (550 * 1600 + 800) * 4;
      assert.ok(image.data[pixel + 0]! > 200);
    }
    await snapshots.write("test", jpeg(1100), "image/jpeg", "live");
    const wrongImage = await fetch(`${base}/test/snapshot-main`, { headers });
    assert.equal(wrongImage.headers.get("x-eufy-image-source"), "waiting");
    assert.equal(calls, 1, "retained pane reads never open a camera");
    admitted = false;
    assert.equal((await token('{"lens":"main"}')).status, 409);
    const signed = createStreamToken("test", Math.floor(Date.now() / 1000) + 60, "fixture");
    assert.equal((await fetch(`${base}/test/live-main.h264?access_token=${signed}`)).status, 409);
    assert.equal((await fetch(`${base}/test/snapshot-main`, { headers })).status, 409);
    assert.equal(calls, 1);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
