/**
 * Reruns synthetic socket arrivals through the real PPCS reorder/parser boundary.
 * Tests own sockets, packets and clocks. They qualify structural observation
 * and private export without any camera or physical-failure claim.
 */
import assert from "node:assert/strict";
import { Socket } from "node:dgram";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { PpcsReceiveTimeline, projectPpcsReceiveObservation } from "../src/stream/ppcs-receive-timeline.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { ppcsSourceDiagnostic } from "../src/diagnostics/ppcs-source-diagnostic.js";
import { BundleCapture } from "../src/diagnostics/bundle-capture.js";
import { GatewayState } from "../src/domain/gateway-state.js";

test("ring freezes, exposes overwritten ordinals and drops private extras", () => {
  const ring = new PpcsReceiveTimeline(true, () => 1000);
  for (let sequence = 0; sequence < 300; sequence++) ring.record("arrival", 1, 20, { sequence });
  const rows = ring.snapshot();
  assert.equal(rows.length, 256); assert.equal(rows[0]!.ordinal, 45);
  (rows[0] as { bytes: number }).bytes = 100;
  assert.equal(ring.snapshot()[0]!.bytes, 20);
  ring.close(); ring.record("ordered", 1, 20);
  assert.equal(ring.snapshot().at(-1)!.ordinal, 300);
  const off = new PpcsReceiveTimeline(false); off.record("arrival", 1, 20);
  assert.deepEqual(off.snapshot(), []);
  assert.doesNotMatch(JSON.stringify(projectPpcsReceiveObservation({ ...rows[1], payload: "PRIVATE", peer: "PRIVATE", key: "PRIVATE" })), /PRIVATE|payload|peer|key/);
  for (const change of [{ kind: "PRIVATE" }, { ordinal: 0 }, { bytes: -1 }, { sequence: 65536 },
    { command: 65536 }, { samePeer: "PRIVATE" }, { elapsedMs: Infinity }]) {
    assert.equal(projectPpcsReceiveObservation({ ...rows[1], ...change }), null);
  }
});

for (const eligible of [false, true]) {
  test(`exact S330 structural receive rerun enabled=${eligible}`, async context => {
    let socket: Socket | undefined;
    let sent = 0;
    context.mock.method(Socket.prototype, "bind", function(this: Socket) {
      socket = this;
      queueMicrotask(() => this.emit("message", Buffer.from([0xf1, 0x42, 0, 0]), { address: "127.0.0.1", port: 12345 }));
      return this;
    });
    context.mock.method(Socket.prototype, "send", function() { sent++; });
    context.mock.method(Socket.prototype, "close", function(this: Socket) { return this; });
    const session = new FirstPartyPpcsSession({ stationSerial: "SYNTHETIC1234567", p2pDid: "TEST-12345678-TEST", appConnection: "",
      dskKey: "synthetic", channel: 0, homeBaseAttached: false, cameraModel: "T86P2", cameraDeviceType: eligible ? 111 : 110,
      accountId: "synthetic-account", maxSeconds: 40 });
    const capture = new BundleCapture({ target: null, seconds: 30, media: false });
    try {
      await session.start();
      const frame = Buffer.alloc(31); frame.write("XZYH"); frame.writeUInt16LE(65000, 4);
      frame.writeUInt32LE(15, 6); frame.write("PRIVATE_PAYLOAD", 16);
      const receive = (sequence: number, data: Buffer, port = 12345): void => {
        const outer = Buffer.alloc(8); outer.set([0xf1, 0xd0]); outer.writeUInt16BE(data.length + 4, 2);
        outer.set([0xd1, 0], 4); outer.writeUInt16BE(sequence, 6);
        socket!.emit("message", Buffer.concat([outer, data]), { address: "127.0.0.1", port });
      };
      receive(10, frame.subarray(0, 5)); receive(12, frame.subarray(11)); receive(11, frame.subarray(5, 11));
      receive(14, Buffer.concat([Buffer.from("junk"), frame]));
      await new Promise(resolve => setTimeout(resolve, 300));
      receive(15, frame, 12346);
      const timeline = session.stats.receiveTimeline;
      assert.equal(session.stats.frameHeaders, 3); assert.equal(session.stats.sequenceGaps, 1);
      assert.equal(session.stats.parserResyncs, 1); assert.ok(sent > 0);
      if (eligible) {
        assert.deepEqual(timeline!.filter(row => row.kind === "arrival").map(row => row.sequence), [10, 12, 11, 14, 15]);
        assert.deepEqual(timeline!.filter(row => row.kind === "ordered").map(row => row.sequence), [10, 11, 12, 14, 15]);
        assert.equal(timeline!.filter(row => row.kind === "gap").length, 1);
        assert.equal(timeline!.find(row => row.kind === "resync")!.bytes, 4);
        assert.equal(timeline!.find(row => row.kind === "arrival" && row.sequence === 15)!.samePeer, false);
        const diagnostic = ppcsSourceDiagnostic(session.stats, 99);
        capture.transport("PRIVATE_SERIAL", diagnostic); capture.transport("PRIVATE_SERIAL", diagnostic);
        const archive = JSON.parse(gunzipSync(capture.archive(new GatewayState())!).toString());
        assert.equal(archive.records.filter((row: { event: string }) => row.event === "source-receive").length, timeline!.length);
        assert.doesNotMatch(JSON.stringify(archive), /PRIVATE|127\.0\.0|12345|synthetic-account/);
      } else assert.equal(timeline, undefined);
      session.close(); assert.deepEqual(session.stats.receiveTimeline, timeline);
    } finally { capture.clear(); session.close(); }
  });
}

test("bundle reports omitted ring entries, rejects extras and enforces its record cap", () => {
  const capture = new BundleCapture({ target: null, seconds: 30, media: false });
  const ring = new PpcsReceiveTimeline(true, () => 1000);
  const counters = { dataDatagrams: 0, frameHeaders: 0, videoFrames: 0, videoOutputFrames: 0,
    sequenceGaps: 0, sequenceRestarts: 0, duplicateDatagrams: 0, staleDatagrams: 0,
    parserResyncs: 0, pendingBytes: 0, incompleteAccessUnits: 0, incompleteAccessUnitBytes: 0 };
  try {
    for (let page = 0; page < 90; page++) {
      for (let index = 0; index < 300; index++) ring.record("arrival", 0, 4, { sequence: index });
      capture.transport("PRIVATE", { stage: "media", sourceAttempt: 42, counters,
        receiveTimeline: ring.snapshot().map(row => ({ ...row, payload: "PRIVATE", address: "PRIVATE" })) });
    }
    const archive = JSON.parse(gunzipSync(capture.archive(new GatewayState())!).toString());
    assert.equal(archive.capture.state, "record_limit"); assert.equal(archive.records.length, 20_000);
    assert.ok(archive.records.some((row: { event: string }) => row.event === "source-receive-gap"));
    assert.doesNotMatch(JSON.stringify(archive), /PRIVATE|payload|address/);
  } finally { capture.clear(); }
});

test("other models, topologies and control purposes have no receive ring", () => {
  for (const change of [{ cameraModel: "T86P2X" }, { cameraDeviceType: 110 }, { homeBaseAttached: true },
    { purpose: "control" as const }, { purpose: "passive" as const }]) {
    const session = new FirstPartyPpcsSession({ stationSerial: "SYNTHETIC1234567", p2pDid: "TEST-12345678-TEST", appConnection: "",
      dskKey: "synthetic", accountId: "synthetic-account", channel: 0, homeBaseAttached: false, cameraModel: "T86P2", cameraDeviceType: 111, ...change });
    try { assert.equal(session.stats.receiveTimeline, undefined); } finally { session.close(); }
  }
});
