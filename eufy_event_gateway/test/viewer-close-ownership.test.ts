/**
 * Distinguishes first-view termination without a camera or network. The fixture
 * owns provider completion and HTTP events, including duplicate close callbacks.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import { LiveStreamManager, type ViewerClientSummary } from "../src/stream/live-stream-manager.js";

/** Emit the same response lifecycle events consumed by the manager, without opening HTTP. */
class Viewer extends EventEmitter {
  headersSent = false;
  writableLength = 0;
  writableEnded = false;
  destroyed = false;
  writeHead(): void { this.headersSent = true; }
  write(): boolean { return true; }
  end(): void { this.writableEnded = true; this.emit("close"); }
  destroy(error?: Error): this {
    this.destroyed = true;
    if (error) this.emit("error", error);
    this.emit("close");
    return this;
  }
}

for (const mode of ["consumer_closed", "consumer_error", "start_failed", "provider_stopped", "source_ended", "source_error", "gateway_closed"]) {
  test(`zero-byte viewer identifies ${mode}`, async () => {
    const state = new GatewayState();
    state.registerCamera({ serial: "fixture", name: "Fixture", model: "T8172", stationSerial: "synthetic-station", doorbellSupported: true, streamSupported: true });
    const source = new PassThrough();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const attached = ["provider_stopped", "source_ended", "source_error"].includes(mode);
    let manager!: LiveStreamManager;
    manager = new LiveStreamManager(state, {} as never, {
      async startStream() {
        if (mode === "start_failed") throw Error("private start detail");
        if (attached) manager.attachSource("fixture", source);
        else await held;
      },
      async stopStream() {},
    }, 60_000);
    manager.on("warning", () => undefined);
    const summaries: ViewerClientSummary[] = [];
    manager.on("viewer-client-stopped", value => summaries.push(value));
    const viewer = new Viewer();
    const starting = manager.addClient("fixture", viewer as unknown as ServerResponse);
    try {
      await new Promise(resolve => setImmediate(resolve));
      if (mode === "consumer_closed") viewer.emit("close");
      if (mode === "consumer_error") viewer.destroy(Error("private socket detail"));
      if (mode === "provider_stopped") manager.markStopped("fixture");
      if (mode === "source_ended") source.end();
      if (mode === "source_error") source.destroy(Error("private source detail"));
      if (mode === "gateway_closed") await manager.close();
      await new Promise(resolve => setImmediate(resolve));
      release(); await starting;
      assert.equal(summaries.length, 1);
      const row = summaries[0] as unknown as Record<string, unknown>;
      assert.equal(row.closeReason, mode);
      assert.equal(row.sourceAttached, attached);
      assert.equal(row.deliveredBytes, 0);
      assert.doesNotMatch(JSON.stringify(row), /private .* detail/);
    } finally { release(); await starting; await manager.close(); }
  });
}

test("a viewer joining a warm source records attachment before the first picture", async () => {
  const state = new GatewayState();
  state.registerCamera({ serial: "fixture", name: "Fixture", model: "T8172", stationSerial: "synthetic-station", doorbellSupported: true, streamSupported: true });
  let manager!: LiveStreamManager;
  manager = new LiveStreamManager(state, {} as never, {
    async startStream() { manager.attachSource("fixture", new PassThrough()); },
    async stopStream() {},
  }, 60_000);
  const summaries: ViewerClientSummary[] = [];
  manager.on("viewer-client-stopped", value => summaries.push(value));
  const first = new Viewer(), warm = new Viewer();
  try {
    await manager.addClient("fixture", first as unknown as ServerResponse);
    await manager.addClient("fixture", warm as unknown as ServerResponse);
    warm.emit("close");
    const row = summaries[0] as unknown as Record<string, unknown>;
    assert.equal(row.sourceAttached, true);
    assert.equal(row.closeReason, "consumer_closed");
    assert.equal(row.deliveredBytes, 0);
  } finally { await manager.close(); }
});
