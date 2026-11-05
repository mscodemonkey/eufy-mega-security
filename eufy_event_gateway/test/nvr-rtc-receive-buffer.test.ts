import assert from "node:assert/strict";
import type { Socket } from "node:dgram";
import test from "node:test";
import { RTCPeerConnection } from "werift";

import { widenNvrReceiveBuffers } from "../src/stream/nvr-rtc-session.js";

test("NVR peers get a receive buffer larger than the default on their real sockets", async () => {
  const peer = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false });
  try {
    peer.createDataChannel("probe");
    await peer.setLocalDescription(await peer.createOffer());
    const sockets = peer.iceTransports.flatMap(transport =>
      (transport.connection as unknown as { protocols: { transport?: { socket?: Socket } }[] }).protocols.map(protocol => protocol.transport?.socket));
    assert.ok(sockets.length > 0);
    const before = sockets.map(socket => socket!.getRecvBufferSize());
    widenNvrReceiveBuffers(peer);
    sockets.forEach((socket, index) => assert.ok(socket!.getRecvBufferSize() > before[index]!));
  } finally {
    await peer.close();
  }
});

test("a socket that refuses a larger buffer does not stop the session", () => {
  const socket = { setRecvBufferSize: () => { throw new Error("refused"); } };
  const peer = { iceTransports: [{ connection: { protocols: [{ transport: { socket } }, {}] } }] };
  assert.doesNotThrow(() => widenNvrReceiveBuffers(peer as unknown as RTCPeerConnection));
});
