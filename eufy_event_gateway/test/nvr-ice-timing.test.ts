/**
 * Checks the public pinned ICE seam with owned real peers and synthetic requests.
 * Tests never open cloud connections and close every peer they create.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Connection, RTCPeerConnection } from 'werift';
import { installNvrIceTiming } from '../src/stream/nvr-ice-timing.js';

test('ICE timing is scoped to one peer and one UDP check, preserving TCP and consent', async () => {
  const peer = new RTCPeerConnection({ iceServers: [] }), other = new RTCPeerConnection({ iceServers: [] });
  peer.createDataChannel('synthetic'); other.createDataChannel('synthetic');
  const connection = peer.iceTransports[0]!.connection, otherConnection = other.iceTransports[0]!.connection;
  assert.ok(connection instanceof Connection); assert.ok(otherConnection instanceof Connection);
  const untouched = otherConnection.checkStart;
  const seen: unknown[][] = [];
  const udp = { type: 'udp', request: async (...args: unknown[]) => { seen.push(args); } };
  const tcp = { type: 'tcp', request: async (...args: unknown[]) => { seen.push(args); } };
  connection.checkStart = () => ({ awaitable: Promise.resolve(), resolve() {}, reject() {} });
  const signal = new AbortController().signal;
  try {
    installNvrIceTiming(peer, signal);
    await connection.checkStart({ protocol: udp } as never);
    const wrapped = udp.request;
    await connection.checkStart({ protocol: udp } as never); assert.equal(udp.request, wrapped);
    await udp.request({ messageMethod: 1 }, ['192.0.2.1', 1234], 'synthetic-integrity', 4);
    assert.deepEqual(seen[0]![3], { retransmissions: 7, responseTimeout: 500, signal });
    const consent = { retransmissions: 0, responseTimeout: 1000 };
    await udp.request({ messageMethod: 1 }, [], 'synthetic-integrity', consent);
    assert.equal(seen[1]![3], consent);
    await connection.checkStart({ protocol: tcp } as never);
    await tcp.request({ messageMethod: 1 }, [], 'synthetic-integrity', 0);
    assert.equal(seen[2]![3], 0); assert.equal(otherConnection.checkStart, untouched);
    assert.equal(seen[0]![2], 'synthetic-integrity');
  } finally { await peer.close(); await other.close(); }
});
