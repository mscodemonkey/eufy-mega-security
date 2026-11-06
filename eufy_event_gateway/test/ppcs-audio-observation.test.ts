/**
 * Sends synthetic audio through a test-owned UDP peer and the real PPCS parser.
 * Session counters feed diagnostics without admitting an unsupported model or
 * retaining audio. These fixtures establish software behaviour, not device support.
 */
import assert from "node:assert/strict";
import { createSocket, Socket } from "node:dgram";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { ppcsSourceDiagnostic } from "../src/diagnostics/ppcs-source-diagnostic.js";

/** Build a complete synthetic audio frame, with an independently specified ADTS header. */
function audioFrame(channel: number, sign: number, valid = true): Buffer {
  const body = Buffer.alloc(24);
  body.writeUInt32LE(8);
  Buffer.from([0xff, 0xf1, 0x60, 0x40, 0x01, 0x1f, 0xfc, 0x00]).copy(body, 16);
  if (!valid) body[5] = 7;
  const header = Buffer.alloc(16);
  header.write("XZYH");
  header.writeUInt16LE(1301, 4);
  header.writeUInt32LE(body.length, 6);
  header[12] = channel;
  header[13] = sign;
  return Buffer.concat([header, body]);
}

for (const model of ["T8134", "T8171"]) {
  test(`${model} counts audio independently of playback admission and frame-shape limits`, { timeout: 5000 }, async context => {
    const peer = createSocket("udp4");
    peer.bind(0, "127.0.0.1");
    await once(peer, "listening");
    let target: { port: number; address: string } | undefined;
    peer.on("message", (packet, remote) => {
      target = remote;
      if (packet.subarray(0, 2).equals(Buffer.from([0xf1, 0x30]))) {
        peer.send(Buffer.from([0xf1, 0x42, 0, 0]), remote.port, remote.address);
      }
    });
    const send = Socket.prototype.send;
    context.mock.method(Socket.prototype, "send", function (this: Socket, packet: Buffer, port: number, _host: string, callback?: (error: Error | null) => void) {
      return (send as (this: Socket, packet: Buffer, port: number, host: string, callback?: (error: Error | null) => void) => void)
        .call(this, packet, this === peer ? port : peer.address().port, "127.0.0.1", callback);
    });
    const session = new FirstPartyPpcsSession({ stationSerial: "SYNTHETIC1234567", p2pDid: "TEST-12345678-TEST", appConnection: "",
      dskKey: "synthetic", accountId: "synthetic-owner", localAddress: "127.0.0.1", channel: 0,
      cameraModel: model, homeBaseAttached: false, purpose: "media", maxSeconds: 30 });
    const output: Buffer[] = [];
    session.audioOutput.on("data", chunk => output.push(chunk));
    try {
      await session.start();

      // A busy video source can exhaust the shape sample before audio arrives.
      session.stats.frameShapes = Array.from({ length: 20 }, (_, index) => `1300:0:${100 + index}:1`);
      const bodies = [audioFrame(0, 0), audioFrame(0, 8), audioFrame(1, 0), audioFrame(0, 0, false)];
      for (const [sequence, body] of bodies.entries()) {
        const header = Buffer.from([0xf1, 0xd0, 0, 0, 0xd1, 1, 0, 0]);
        header.writeUInt16BE(body.length + 4, 2);
        header.writeUInt16BE(sequence, 6);
        peer.send(Buffer.concat([header, body]), target!.port, target!.address);
      }
      const deadline = performance.now() + 1000;
      while (session.stats.audioFrames < bodies.length && performance.now() < deadline) await delay(5);
      const diagnostic = ppcsSourceDiagnostic(session.stats, 1);
      assert.equal(diagnostic.counters.audioFrames, 4);
      assert.equal(diagnostic.counters.audioClearFrames, 2);
      assert.equal(diagnostic.counters.audioAdtsFrames, 1);
      assert.equal(diagnostic.counters.audioProtectedFrames, 1);
      assert.equal(diagnostic.counters.foreignAudioFrames, 1);
      assert.equal(diagnostic.frameKinds?.some(value => value.kind === "audio"), false);
      assert.equal(diagnostic.counters.videoOutputFrames, 0);
      assert.equal(output.length, model === "T8171" ? 1 : 0);
      assert.equal(session.audioOutput.readableLength, 0);
    } finally {
      session.close();
      await session.waitUntilClosed();
      peer.close();
    }
  });
}
