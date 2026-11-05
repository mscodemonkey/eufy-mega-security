/**
 * Checks session retirement at the real loopback UDP boundary.
 * Tests own every peer and route. The provider consumes send completion before
 * reusing a camera peer, while the session owns immediate logical cancellation.
 */
import assert from "node:assert/strict";
import { createSocket, Socket } from "node:dgram";
import { once } from "node:events";
import test from "node:test";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";

test("closing a connected control session delivers END before releasing its UDP port", { timeout: 5000 }, async context => {
  const peer = createSocket("udp4");
  peer.bind(0, "127.0.0.1");
  await once(peer, "listening");
  let ends = 0;
  let received!: () => void;
  const end = new Promise<void>(resolve => { received = resolve; });
  peer.on("message", (packet, remote) => {
    if (packet.subarray(0, 2).equals(Buffer.from([0xf1, 0xf0]))) { ends++; received(); return; }
    peer.send(Buffer.from([0xf1, 0x42, 0, 0]), remote.port, remote.address);
  });
  const send = Socket.prototype.send;
  context.mock.method(Socket.prototype, "send", function (this: Socket, packet: Buffer, port: number, _host: string, callback?: (error: Error | null) => void) {
    return (send as (this: Socket, packet: Buffer, port: number, host: string, callback?: (error: Error | null) => void) => void).call(this, packet, this === peer ? port : peer.address().port, "127.0.0.1", callback);
  });
  const session = new FirstPartyPpcsSession({ stationSerial: "synthetic", p2pDid: "synthetic", appConnection: "",
    dskKey: "synthetic", accountId: "synthetic-owner", localAddress: "127.0.0.1", channel: 1, cameraModel: "T8113-Z", stationModel: "T8010",
    homeBaseAttached: true, purpose: "control", maxSeconds: 30 });
  try {
    await session.start();
    session.close();
    session.close();
    assert.equal(session.output.writableEnded, true);
    await session.waitUntilClosed();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([end, new Promise<void>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("END was discarded")), 500);
      })]);
    } finally { clearTimeout(deadline); }
    assert.equal(ends, 1);
  } finally { session.close(); await session.waitUntilClosed(); peer.close(); }
});
