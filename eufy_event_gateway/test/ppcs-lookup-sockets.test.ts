/**
 * Verifies finite UDP lookup-port ownership with real loopback sockets.
 *
 * Tests own all sockets and use synthetic datagrams. The PPCS session consumes
 * the pool's winner so a cloud-selected probe can continue the same handshake.
 */
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import test from "node:test";
import { PpcsLookupSocketPool } from "../src/stream/ppcs-lookup-sockets.js";

test("binds eight distinct ports and adopts a responding probe", async () => {
  const primary = createSocket("udp4");
  primary.bind(0);
  await once(primary, "listening");
  const messages: string[] = [];
  let received!: () => void;
  const reply = new Promise<void>((resolve) => { received = resolve; });
  const pool = new PpcsLookupSocketPool(primary, (data, _, socket) => {
    messages.push(data.toString());
    assert.equal(pool.adopt(socket), true);
    received();
  }, (error) => assert.fail(error));
  try {
    await pool.bindProbes();
    const sockets = pool.sockets;
    assert.equal(sockets.length, 8);
    assert.equal(new Set(sockets.map((socket) => socket.address().port)).size, 8);
    const winner = sockets[7]!;
    const closed = sockets.filter((socket) => socket !== winner).map((socket) => once(socket, "close"));
    primary.send(Buffer.from("camera identity"), winner.address().port, "127.0.0.1");
    await reply;
    await Promise.all(closed);
    assert.deepEqual(messages, ["camera identity"]);
    assert.deepEqual(pool.sockets, [winner]);
    assert.equal(pool.adopt(primary), false);
    const ended = once(winner, "close");
    pool.close();
    await ended;
    assert.equal(pool.sockets.length, 0);
  } finally {
    pool.close();
  }
});

test("shutdown cancels probe binds and releases every port", async () => {
  const primary = createSocket("udp4");
  primary.bind(0);
  await once(primary, "listening");
  const pool = new PpcsLookupSocketPool(primary, () => assert.fail("closed pool delivered a packet"), () => {});
  const primaryClosed = once(primary, "close");
  const pending = pool.bindProbes();
  pool.close();
  await pending;
  await primaryClosed;
  assert.deepEqual(pool.sockets, []);
  assert.equal(pool.adopt(primary), false);
});
