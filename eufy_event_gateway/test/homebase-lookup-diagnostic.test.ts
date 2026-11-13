/**
 * Qualifies discovery-submission diagnostics without reaching a real station.
 * Test-owned socket mocks consume queued packets. The provider consumes only
 * counters and a separate safe source enum, never network destinations.
 */
import assert from "node:assert/strict";
import { Socket } from "node:dgram";
import test from "node:test";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";

for (const directed of [false, true]) test(`lookup diagnostics count actual queued destinations: ${directed}`, async context => {
  const hosts: string[] = [];
  context.mock.method(Socket.prototype, "bind", function (this: Socket, _port: number, callback: () => void) {
    queueMicrotask(callback);
    return this;
  });
  context.mock.method(Socket.prototype, "setBroadcast", function (this: Socket) { return this; });
  context.mock.method(Socket.prototype, "close", function (this: Socket) { return this; });
  context.mock.method(Socket.prototype, "send", (_packet: Buffer, _port: number, host: string) => { hosts.push(host); });
  const session = new HomeBasePpcsSession({ serial: "SYNTHETIC1234567", p2pDid: "TEST-12345678-TEST",
    accountId: "synthetic-owner", userName: "Synthetic", localAddress: directed ? "10.23.4.5" : null });
  const cancelled = assert.rejects(session.connect(), /closed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(hosts, directed ? ["255.255.255.255", "10.23.4.5"] : ["255.255.255.255"]);
  assert.match(session.diagnostics(), /lookup_broadcast_queued=1/);
  assert.match(session.diagnostics(), new RegExp(`lookup_directed_queued=${directed ? 1 : 0}`));
  assert.doesNotMatch(session.diagnostics(), /10\.23|255\.255|synthetic-owner|SYNTHETIC/);
  session.close();
  await cancelled;
  await session.waitUntilClosed();
  assert.equal(hosts.length, directed ? 2 : 1);
});
