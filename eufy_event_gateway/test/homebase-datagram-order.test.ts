/**
 * Exercises HomeBase state reassembly through a real, test-owned UDP peer.
 * The peer owns fragment delivery order. The session must retain one complete
 * state response despite reordered or repeated transport datagrams.
 */
import assert from "node:assert/strict";
import { createSocket, Socket } from "node:dgram";
import { once } from "node:events";
import test from "node:test";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";
import { PpcsDatagramReorderBuffer } from "../src/stream/first-party-ppcs.js";

/** Build an unencrypted synthetic application frame independently of the implementation. */
function frame(command: number, body = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(16);
  header.write("XZYH");
  header.writeUInt16LE(command, 4);
  header.writeUInt32LE(body.length, 6);
  header[12] = 255;
  return Buffer.concat([header, body]);
}

/** Wrap a response fragment in the peer's DATA sequence envelope. */
function datagram(sequence: number, body: Buffer): Buffer {
  const header = Buffer.from([0xf1, 0xd0, 0, 0, 0xd1, 0, 0, 0]);
  header.writeUInt16BE(4 + body.length, 2);
  header.writeUInt16BE(sequence, 6);
  return Buffer.concat([header, body]);
}

for (const plan of [
  { order: [1, 3, 2] }, { order: [1, 2, 2, 3] }, { order: [1, 3, 3, 2] },
  { order: [1, 3, 4] }, { order: [1, 3, 2], splitHeader: true },
  { order: [65535, 1, 0], wrap: true }, { order: [1, 3, 4], oversized: true },
]) {
  const { order } = plan;
  test(`HomeBase state handles ${JSON.stringify(plan)}`, { timeout: 3000 }, async context => {
    const peer = createSocket("udp4");
    peer.bind(0, "127.0.0.1");
    await once(peer, "listening");
    const state = frame(1103, Buffer.from(JSON.stringify({ main_sw_version: "synthetic-ordered", params: [] })));
    const pieces = plan.splitHeader
      ? [state.subarray(0, 2), state.subarray(2, 15), state.subarray(15)]
      : [state.subarray(0, 24), state.subarray(24, 40), state.subarray(40)];
    const oversized = frame(1103);
    oversized.writeUInt32LE(16 * 1024 * 1024 + 1, 6);
    const acknowledged: number[] = [];
    let receivedAllAcknowledgements!: () => void;
    const acknowledgements = new Promise<void>(resolve => { receivedAllAcknowledgements = resolve; });
    peer.on("message", (packet, remote) => {
      if (packet.length >= 24 && packet.subarray(0, 2).equals(Buffer.from([0xf1, 0xd0]))) {
        const acknowledgement = Buffer.from([0xf1, 0xd1, 0, 6, 0xd1, 0, 0, 1, 0, 0]);
        acknowledgement.writeUInt16BE(packet.readUInt16BE(6), 8);
        peer.send(acknowledgement, remote.port, remote.address);
      }
      if (packet.subarray(0, 2).equals(Buffer.from([0xf1, 0x30]))) {
        peer.send(Buffer.from([0xf1, 0x42, 0, 0]), remote.port, remote.address);
      } else if (packet.subarray(0, 2).equals(Buffer.from([0xf1, 0xd1]))) {
        if (packet.length >= 10) {
          acknowledged.push(packet.readUInt16BE(8));
          if (acknowledged.length >= order.length + 1) receivedAllAcknowledgements();
        }
      } else if (packet.length >= 24 && packet.readUInt16LE(12) === 1100) {
        peer.send(datagram(plan.wrap ? 65534 : 0, frame(1100)), remote.port, remote.address);
      } else if (packet.length >= 24 && packet.readUInt16LE(12) === 1103) {
        for (const sequence of order) {
          const part = plan.wrap ? sequence === 65535 ? 0 : sequence === 0 ? 1 : 2 : sequence - 1;
          peer.send(datagram(sequence, sequence === 4 ? plan.oversized ? oversized : state : pieces[part]!), remote.port, remote.address);
        }
      }
    });
    const send = Socket.prototype.send;
    context.mock.method(Socket.prototype, "send", function (this: Socket, packet: Buffer, port: number, _host: string, callback?: (error: Error | null) => void) {
      return (send as (this: Socket, packet: Buffer, port: number, host: string, callback?: (error: Error | null) => void) => void)
        .call(this, packet, this === peer ? port : peer.address().port, "127.0.0.1", callback);
    });
    const session = new HomeBasePpcsSession({ serial: "SYNTHETIC1234567", p2pDid: "TEST-12345678-TEST",
      accountId: "synthetic-owner", userName: "Synthetic", localAddress: "127.0.0.1" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await session.connect();
      if (plan.oversized) {
        await assert.rejects(session.readState(false), /safety limit/);
        assert.match(session.diagnostics(), /sequence_gaps=1/);
        await assert.rejects(session.readState(false), /closed/);
        return;
      }
      const result = await Promise.race([session.readState(false).then(async value => {
        await acknowledgements;
        return value;
      }), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Delivered HomeBase fragments did not produce state")), 500);
      })]);
      assert.equal(result.firmware, "synthetic-ordered");
      assert.match(session.diagnostics(), /read_requests=2 read_acknowledged=2/);
      assert.deepEqual(acknowledged.slice(1), [...order]);
    } finally {
      clearTimeout(timer);
      session.close();
      await session.waitUntilClosed();
      peer.close();
    }
  });
}

test("HomeBase shutdown closes its receive window exactly once", async context => {
  const close = context.mock.method(PpcsDatagramReorderBuffer.prototype, "close");
  const session = new HomeBasePpcsSession({ serial: "SYNTHETIC1234567", p2pDid: "TEST-12345678-TEST",
    accountId: "synthetic-owner", userName: "Synthetic" });
  session.close();
  session.close();
  await session.waitUntilClosed();
  assert.equal(close.mock.callCount(), 1);
});
