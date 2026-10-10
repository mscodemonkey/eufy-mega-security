/**
 * Verifies sensitive evidence routes over real ephemeral HTTP listeners.
 * Tests own synthetic capture sessions and never contact camera/cloud services.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { EventImageCapture } from "../src/diagnostics/event-image-capture.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { createStreamToken, GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";

test("private export requires bearer auth, supports retry and clear, and never changes retained images", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-evidence-http-"));
  const capture = new EventImageCapture();
  const token = "synthetic-private-api-token-at-least-32";
  const config = { ...loadConfig({ EUFY_GATEWAY_API_TOKEN: token, EUFY_GATEWAY_CAPTURE_FAILED_EVENT_IMAGES: "true" }), port: 0 };
  const snapshots = new SnapshotStore(directory);
  await snapshots.initialize();
  await snapshots.writeEvent("fixture", Buffer.from("retained"), "image/jpeg");
  const server = new GatewayServer(config, new GatewayState(), snapshots, {} as LiveStreamManager, {} as CameraProvider, null, null, capture);
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.port}/api/diagnostics/event-images`;
    const headers = { authorization: `Bearer ${token}` };
    for (const [suffix, method] of [["", "GET"], ["", "DELETE"], ["/export", "POST"]] as const) {
      for (const query of ["", `?token=${token}`, `?access_token=${createStreamToken("fixture", Math.floor(Date.now() / 1000) + 60, token)}`]) {
        const denied = await fetch(base + suffix + query, { method });
        assert.equal(denied.status, 401);
        assert.equal(denied.headers.get("cache-control"), "no-store");
      }
      assert.equal((await fetch(base + suffix, { method, headers: { authorization: "Bearer wrong" } })).status, 401);
    }
    assert.equal((await fetch(base + "/export", { method: "POST", headers })).status, 409);
    capture.capture(Buffer.from([1, 2, 3]), { model: "T8111" });
    const status = await fetch(base, { headers });
    assert.equal(status.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await status.text(), /bodyBase64|sha256|T8111/);
    const first = await fetch(base + "/export", { method: "POST", headers });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-disposition"), 'attachment; filename="eufy-event-image-evidence.json"');
    assert.equal(first.headers.get("cache-control"), "no-store");
    const body = await first.text();
    assert.equal(Number(first.headers.get("content-length")), Buffer.byteLength(body));
    assert.equal(await (await fetch(base + "/export", { method: "POST", headers })).text(), body);
    const wrongMethod = await fetch(base + "/export", { headers });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
    const oversized = await fetch(base + "/export", { method: "POST", headers, body: "x".repeat(16_385) });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.headers.get("cache-control"), "no-store");
    const cleared = await fetch(base, { method: "DELETE", headers });
    assert.equal((await cleared.json() as { state: string }).state, "cleared");
    const expired = await fetch(base + "/export", { method: "POST", headers });
    assert.equal(expired.status, 410);
    assert.equal(expired.headers.get("cache-control"), "no-store");
    assert.equal((await snapshots.readEvent("fixture"))!.data.toString(), "retained");
  } finally { capture.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("disabled, tokenless and failed-handler responses cannot expose samples and have no-store", async () => {
  for (const mode of ["disabled", "tokenless", "broken"] as const) {
    const capture = new EventImageCapture();
    capture.capture(Buffer.from([1]));
    if (mode === "broken") capture.archive = () => { throw new Error("synthetic failure"); };
    const config = { ...loadConfig({}), port: 0, apiToken: mode === "tokenless" ? null : "fixture-token", captureFailedEventImages: mode !== "disabled" };
    const server = new GatewayServer(config, new GatewayState(), new SnapshotStore(tmpdir()), {} as LiveStreamManager, {} as CameraProvider, null, null, capture);
    try {
      await server.listen();
      const response = await fetch(`http://127.0.0.1:${server.port}/api/diagnostics/event-images/export`, {
        method: "POST", headers: { authorization: "Bearer fixture-token" },
      });
      assert.equal(response.status, mode === "disabled" ? 404 : mode === "tokenless" ? 401 : 500);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.doesNotMatch(await response.text(), /bodyBase64|sha256/);
    } finally { capture.close(); await server.close(); }
  }
});
