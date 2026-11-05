/**
 * Replays the reported source-to-HA timing gap with fake converter pipes.
 * The manager owns delivery. Fixtures own clocks and processes, verifying that
 * written headers are distinct from a queued random-access group and HA display.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ServerResponse } from "node:http";
import { GatewayState } from "../src/domain/gateway-state.js";
import { LiveStreamManager, type ViewerStartupSummary } from "../src/stream/live-stream-manager.js";

/** Own inert pipes with an already reaped child identity, so cleanup creates no process timers. */
function child(): ChildProcessWithoutNullStreams {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), exitCode: 0, signalCode: null, kill: () => true }) as unknown as ChildProcessWithoutNullStreams;
}

/** Accept viewer writes without opening a socket. */
function response(): ServerResponse {
  const value = new PassThrough() as unknown as ServerResponse;
  value.writeHead = (() => value) as ServerResponse["writeHead"];
  value.on("data", () => {});
  return value;
}

const nal = (...bytes: number[]) => Buffer.from([0, 0, 0, 1, ...bytes]);

for (const outcome of ["ready", "headers-only"] as const) {
  test(`viewer timing distinguishes ${outcome} from first converter output`, async context => {
    let now = 0;
    context.mock.method(performance, "now", () => now);
    const state = new GatewayState();
    state.registerCamera({ serial: "synthetic-camera", name: "Private fixture", model: "T8140",
      stationSerial: "synthetic-station", streamSupported: true, doorbellSupported: false });
    const source = new PassThrough(), converter = child(), timings: ViewerStartupSummary[] = [];
    const manager = new LiveStreamManager(state, {} as never, {
      async startStream() { manager.attachSource("synthetic-camera", source, () => "h265"); },
      async stopStream() { source.end(); },
    }, 0, undefined, () => converter, child);
    manager.on("viewer-startup-timings", summary => timings.push(summary));
    const viewer = response();
    try {
      await manager.addClient("synthetic-camera", viewer);
      now = 100; source.write(nal(0x02, 0x01, 0xaa));
      now = 300; source.write(Buffer.concat([nal(0x40, 0x01, 0x0c), nal(0x42, 0x01, 0x01),
        nal(0x44, 0x01, 0xc0), nal(0x26, 0x01, 0xbb)]));
      now = 600; (converter.stdout as PassThrough).write(Buffer.concat([
        nal(0x67, 0x42, 0x00, 0x1f), nal(0x68, 0xce, 0x06), nal(0x09, 0xf0)]));
      assert.equal(timings.length, 0);
      if (outcome === "ready") {
        now = 800; (converter.stdout as PassThrough).write(nal(0x65, 0x88));
        assert.equal(timings.length, 1);
        assert.equal(timings[0]!.sourceFirstByteMilliseconds, 100);
        assert.equal(timings[0]!.sourceRandomAccessMilliseconds, 300);
        assert.equal(timings[0]!.conversionStartMilliseconds, 300);
        assert.equal(timings[0]!.conversionFirstOutputMilliseconds, 600);
        assert.equal(timings[0]!.viewerRandomAccessMilliseconds, 800);
        assert.equal(timings[0]!.firstWriteMilliseconds, 600);
        assert.equal(timings[0]!.readyWriteMilliseconds, 800);
      }
      if (outcome === "ready") {
        now = 1000;
        const native = response(); await manager.addClient("synthetic-camera", native, "native");
        assert.equal(timings.length, 2); assert.equal(timings[1]!.conversionStartMilliseconds, null);
        assert.equal(timings[1]!.conversionAttempt, 0); assert.equal(timings[1]!.readyWriteMilliseconds, 0);
        assert.equal(timings[1]!.warmSource, true); native.emit("close");
        now = 1200;
        const warm = response(); await manager.addClient("synthetic-camera", warm);
        assert.equal(timings.length, 3); assert.equal(timings[2]!.warmViewer, true);
        assert.equal(timings[2]!.readyWriteMilliseconds, 0); warm.emit("close");
      }
      viewer.emit("close");
      assert.equal(timings.length, outcome === "ready" ? 3 : 1);
      assert.equal(timings[0]!.outcome, outcome === "ready" ? "random_access_queued" : "closed_before_random_access");
      if (outcome === "headers-only") assert.equal(timings[0]!.readyWriteMilliseconds, null);
      assert.doesNotMatch(JSON.stringify(timings), /synthetic-camera|synthetic-station|Private fixture/);
    } finally { await manager.close(); state.close(); }
  });
}


test("a failed source start reports unknown stages without claiming viewer output", async () => {
  const state = new GatewayState();
  state.registerCamera({ serial: "synthetic-camera", name: "Private fixture", model: "T8140",
    stationSerial: "synthetic-station", streamSupported: true, doorbellSupported: false });
  const manager = new LiveStreamManager(state, {} as never, {
    async startStream() { throw new Error("Source unavailable"); }, async stopStream() {},
  }, 0);
  const timings: ViewerStartupSummary[] = [];
  manager.on("viewer-startup-timings", summary => timings.push(summary));
  try {
    await manager.addClient("synthetic-camera", response());
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(timings.length, 1); assert.equal(timings[0]!.sourceCodec, null);
    assert.equal(timings[0]!.outcome, "closed_before_random_access");
    assert.equal(timings[0]!.sourceFirstByteMilliseconds, null);
    assert.equal(timings[0]!.firstWriteMilliseconds, null); assert.equal(timings[0]!.readyWriteMilliseconds, null);
  } finally { await manager.close(); state.close(); }
});
