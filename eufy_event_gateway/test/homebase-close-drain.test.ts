/**
 * Verifies HomeBase retirement with a real test-owned UDP peer.
 * The session owns discovery and final local send completion. The provider
 * consumes that completion before releasing ownership for another operation.
 */
import assert from "node:assert/strict";
import { createSocket, Socket } from "node:dgram";
import { once } from "node:events";
import test from "node:test";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";

test("HomeBase close delivers one END datagram before closing the socket", { timeout: 5000 }, async context => {
  const peer = createSocket("udp4");
  peer.bind(0, "127.0.0.1");
  await once(peer, "listening");
  let ends = 0;
  let received!: () => void;
  const end = new Promise<void>(resolve => { received = resolve; });
  peer.on("message", (packet, remote) => {
    if (packet.subarray(0, 2).equals(Buffer.from([0xf1, 0xf0]))) { ends++; received(); return; }
    if (packet.subarray(0, 2).equals(Buffer.from([0xf1, 0x30]))) {
      peer.send(Buffer.from([0xf1, 0x42, 0, 0]), remote.port, remote.address);
    } else if (packet.length >= 24 && packet.readUInt16LE(12) === 1100) {
      const reply = Buffer.alloc(24);
      reply.set([0xf1, 0xd0, 0, 20, 0xd1, 0, 0, 0]);
      reply.write("XZYH", 8); reply.writeUInt16LE(1100, 12);
      peer.send(reply, remote.port, remote.address);
    }
  });
  const send = Socket.prototype.send;
  context.mock.method(Socket.prototype, "send", function (this: Socket, packet: Buffer, port: number, _host: string, callback?: (error: Error | null) => void) {
    return (send as (this: Socket, packet: Buffer, port: number, host: string, callback?: (error: Error | null) => void) => void)
      .call(this, packet, this === peer ? port : peer.address().port, "127.0.0.1", callback);
  });
  const session = new HomeBasePpcsSession({ serial: "SYNTHETIC1234567", p2pDid: "TEST-12345678-TEST",
    accountId: "synthetic-owner", userName: "Synthetic", localAddress: "127.0.0.1" });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await session.connect();
    const cancelledRead = assert.rejects(session.readState(false), /closed/);
    session.close(); session.close();
    await cancelledRead;
    await session.waitUntilClosed();
    await Promise.race([end, new Promise<void>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("HomeBase END datagram was discarded")), 500);
    })]);
    assert.equal(ends, 1);
  } finally {
    clearTimeout(deadline);
    session.close();
    await session.waitUntilClosed();
    peer.close();
  }
});

test("HomeBase closed sessions reject new reads and writes without binding a socket", async () => {
  const session = new HomeBasePpcsSession({ serial: "SYNTHETIC1234567", p2pDid: "TEST-12345678-TEST",
    accountId: "synthetic-owner", userName: "Synthetic" });
  session.close();
  await session.waitUntilClosed();
  await assert.rejects(session.connect(), /closed/);
  await assert.rejects(session.readState(), /closed/);
  await assert.rejects(session.setGuardMode(1), /closed/);
  await assert.rejects(session.setAlarmVolume(1), /closed/);
  await assert.rejects(session.setSiren(0), /closed/);
});

test("HomeBase close cancels a pending lookup before a late bind callback", async context => {
  let sends = 0;
  context.mock.method(Socket.prototype, "bind", function (this: Socket, _port: number, callback: () => void) {
    queueMicrotask(callback);
    return this;
  });
  context.mock.method(Socket.prototype, "send", () => { sends++; });
  const session = new HomeBasePpcsSession({ serial: "SYNTHETIC1234567", p2pDid: "TEST-12345678-TEST",
    accountId: "synthetic-owner", userName: "Synthetic" });
  const cancelled = assert.rejects(session.connect(), /closed/);
  session.close();
  await cancelled;
  await session.waitUntilClosed();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 0);
});

for (const failure of ["missing", "throw"] as const) test(`HomeBase close finishes after ${failure} send completion`, async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let socket!: Socket;
  let closes = 0;
  let sends = 0;
  context.mock.method(Socket.prototype, "bind", function (this: Socket, _port: number, callback: () => void) {
    socket = this;
    queueMicrotask(callback);
    return this;
  });
  context.mock.method(Socket.prototype, "setBroadcast", function (this: Socket) { return this; });
  context.mock.method(Socket.prototype, "close", function (this: Socket) { closes++; return this; });
  context.mock.method(Socket.prototype, "send", (packet: Buffer) => {
    sends++;
    if (packet.subarray(0, 2).equals(Buffer.from([0xf1, 0x30]))) {
      queueMicrotask(() => socket.emit("message", Buffer.from([0xf1, 0x42, 0, 0]), { address: "127.0.0.1", port: 12345 }));
    } else if (packet.length >= 24 && packet.readUInt16LE(12) === 1100) {
      const reply = Buffer.alloc(24); reply.set([0xf1, 0xd0, 0, 20, 0xd1, 0, 0, 0]);
      reply.write("XZYH", 8); reply.writeUInt16LE(1100, 12);
      queueMicrotask(() => socket.emit("message", reply, { address: "127.0.0.1", port: 12345 }));
    } else if (failure === "throw" && packet.subarray(0, 2).equals(Buffer.from([0xf1, 0xf0]))) {
      throw new Error("synthetic send failure");
    }
  });
  const session = new HomeBasePpcsSession({ serial: "SYNTHETIC1234567", p2pDid: "TEST-12345678-TEST",
    accountId: "synthetic-owner", userName: "Synthetic" });
  await session.connect();
  session.close(); session.close();
  const count = sends;
  if (failure === "missing") {
    context.mock.timers.tick(499);
    assert.equal(closes, 0);
    context.mock.timers.tick(1);
  }
  await session.waitUntilClosed();
  assert.equal(closes, 1);
  socket.emit("message", Buffer.from([0xf1, 0x42, 0, 0]), { address: "127.0.0.1", port: 12345 });
  await assert.rejects(session.readState(), /closed/);
  await assert.rejects(session.setGuardMode(1), /closed/);
  context.mock.timers.tick(20000);
  assert.equal(sends, count);
});
