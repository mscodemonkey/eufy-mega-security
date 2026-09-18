/**
 * Exercises viewer restarts through real HTTP responses and synthetic media.
 * Each test owns a loopback server and fake provider source. The manager consumes
 * those sources without a camera connection, exposing header lifecycle failures
 * that a permissive ServerResponse mock would miss.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";

import { GatewayState } from "../src/domain/gateway-state.js";
import { LiveStreamManager } from "../src/stream/live-stream-manager.js";

for (const codec of ["h264", "h265"] as const) {
  test(`a restarted ${codec} viewer receives fresh media after the previous source ends`, async (t) => {
    const state = new GatewayState();
    state.registerCamera({
      serial: "test-camera", name: "Test", model: "T8210",
      stationSerial: "test-station", streamSupported: true, doorbellSupported: true,
    });
    let starts = 0;
    let manager: LiveStreamManager;
    manager = new LiveStreamManager(state, {} as never, {
      async startStream(serial) {
        starts++;
        const source = new PassThrough();
        manager.attachSource(serial, source);
        const headers = codec === "h264"
          ? [0, 0, 0, 1, 0x67, 0x42, 0, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 6]
          : [0, 0, 0, 1, 0x40, 1, 12, 0, 0, 0, 1, 0x42, 1, 1, 0, 0, 0, 1, 0x44, 1, 0xc0];
        source.end(Buffer.from([...headers, 0, 0, 0, 1, codec === "h264" ? 0x65 : 0x26, 1, starts]));
      },
      async stopStream() {},
    }, 5);
    const server = createServer((_request, response) => {
      void manager.addClient("test-camera", response);
    });
    t.after(async () => {
      await manager.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}/`, { signal: AbortSignal.timeout(2_000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(response.headers.get("content-type"), `video/${codec}`);
      assert.ok(bytes.includes(Buffer.from([0, 0, 0, 1, codec === "h264" ? 0x65 : 0x26, 1, attempt])));
    }
    assert.equal(starts, 2);
  });
}
