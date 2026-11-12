/**
 * Models RFC 8656 permission expiry around the real pinned TURN channel cache.
 * Test-owned request replies and transport replace network and authentication.
 * Virtual ten-minute runs establish renewal behavior, never E10 hardware repair.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Message, methods, classes, Connection, TurnProtocol, StunOverTurnProtocol, RTCPeerConnection, type Address, type Transport } from "werift";
import { installE10RelayLifetime, retainE10RelayPermissions } from "../src/stream/e10-relay-lifetime.js";

/** Own one synthetic relay's permission clock and authenticated-request substitute. */
function relay(channelAvailable: boolean) {
  const server: Address = ["127.0.0.1", 3478];
  const destination: Address = ["192.0.2.1", 4567];
  const transport = { type: "udp", send: async () => {}, close: async () => {}, onData() {} } as unknown as Transport;
  const turn = new TurnProtocol(server, "synthetic", "synthetic", 600, transport);
  let expires = 0;
  const binds: number[] = [], permissions: number[] = [];
  turn.requestWithRetry = async request => {
    if (request.messageMethod === methods.CHANNEL_BIND) {
      if (!channelAvailable) throw new Error("Synthetic channel binding unavailable");
      binds.push(Date.now());
    } else {
      assert.equal(request.messageMethod, methods.CREATE_PERMISSION);
      permissions.push(Date.now());
    }
    expires = Date.now() + 300_000;
    return [new Message(request.messageMethod, classes.RESPONSE), server];
  };
  return { turn, destination, binds, permissions, cameraCanSend: () => Date.now() < expires };
}

for (const channel of [true, false]) test(`renew ${channel ? "channel" : "send-indication"} permissions through ten virtual minutes`, async context => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const control = relay(channel), fixed = relay(channel);
  const owner = new AbortController();
  retainE10RelayPermissions(fixed.turn, owner.signal);
  const firstDenied: number[] = [];
  for (let elapsed = 0; elapsed <= 600_000; elapsed += 5000) {
    context.mock.timers.tick(elapsed === 0 ? 0 : 5000);
    await control.turn.sendData(Buffer.from("synthetic-consent"), control.destination);
    await fixed.turn.sendData(Buffer.from("synthetic-consent"), fixed.destination);
    if (!control.cameraCanSend()) firstDenied.push(elapsed);
    assert.equal(fixed.cameraCanSend(), true, `permission at ${elapsed}`);
  }
  assert.equal(firstDenied[0], 300_000);
  const renewed = channel ? fixed.binds : fixed.permissions;
  assert.deepEqual(renewed.map(time => time - 1_000_000), [0, 240_000, 480_000]);
  owner.abort();
});

test("fallback renewals coalesce by peer IP and retain retry after a rejection", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const fixture = relay(false), owner = new AbortController();
  const original = fixture.turn.getPermission;
  retainE10RelayPermissions(fixture.turn, owner.signal);
  await Promise.all([fixture.turn.getPermission(fixture.destination), fixture.turn.getPermission([fixture.destination[0], 9876])]);
  assert.equal(fixture.permissions.length, 1);
  context.mock.timers.tick(240_000);
  const request = fixture.turn.requestWithRetry;
  fixture.turn.requestWithRetry = async () => { throw new Error("Synthetic rejection"); };
  await assert.rejects(fixture.turn.getPermission(fixture.destination), /Synthetic rejection/);
  fixture.turn.requestWithRetry = request;
  await Promise.all([fixture.turn.getPermission(fixture.destination), fixture.turn.getPermission(fixture.destination)]);
  assert.equal(fixture.permissions.length, 2);
  owner.abort();
  assert.equal(fixture.turn.getPermission, original);
});

test("install only on the selected peer's relay checks and restore on retirement", async () => {
  const peer = new RTCPeerConnection({ iceServers: [] }), other = new RTCPeerConnection({ iceServers: [] });
  peer.createDataChannel("test-only-transport"); other.createDataChannel("untouched");
  const connection = peer.iceTransports[0]!.connection, otherConnection = other.iceTransports[0]!.connection;
  assert.ok(connection instanceof Connection); assert.ok(otherConnection instanceof Connection);
  const untouched = otherConnection.checkStart;
  const owner = new AbortController();
  let checks = 0;
  connection.checkStart = () => { checks++; return { awaitable: Promise.resolve(), resolve() {}, reject() {} }; };
  const originalCheck = connection.checkStart;
  const fixture = relay(true), protocol = new StunOverTurnProtocol(fixture.turn), originalPermission = fixture.turn.getPermission;
  try {
    installE10RelayLifetime(peer, owner.signal);
    connection.checkStart({ protocol: { type: "udp" } } as never);
    assert.equal(fixture.turn.getPermission, originalPermission);
    connection.checkStart({ protocol } as never);
    const installed = fixture.turn.getPermission;
    connection.checkStart({ protocol } as never);
    assert.equal(fixture.turn.getPermission, installed);
    assert.notEqual(installed, originalPermission);
    assert.equal(otherConnection.checkStart, untouched);
    assert.equal(checks, 3);
    owner.abort();
    assert.equal(connection.checkStart, originalCheck);
    assert.equal(fixture.turn.getPermission, originalPermission);
  } finally { owner.abort(); await peer.close(); await other.close(); }
});

test("unsupported and retired contracts refuse before changing the relay", () => {
  const fixture = relay(true), owner = new AbortController(), original = fixture.turn.getPermission;
  Reflect.set(fixture.turn, "channelRefreshTime", NaN);
  assert.throws(() => retainE10RelayPermissions(fixture.turn, owner.signal), /Unsupported/);
  assert.equal(fixture.turn.getPermission, original);
  owner.abort();
  assert.throws(() => retainE10RelayPermissions(fixture.turn, owner.signal));
  assert.equal(fixture.turn.getPermission, original);
});
