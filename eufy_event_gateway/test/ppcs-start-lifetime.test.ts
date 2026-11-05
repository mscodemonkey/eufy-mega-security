/**
 * Checks lookup retirement with an inert UDP bind, so no camera or network is used.
 * The session owns its lookup timer and pending start promise. The provider
 * consumes the typed timeout to decide whether a new media connection is safe.
 */
import assert from "node:assert/strict";
import { Socket } from "node:dgram";
import test from "node:test";
import { FirstPartyPpcsSession, PpcsLookupTimeoutError, type PpcsCameraOptions } from "../src/stream/first-party-ppcs.js";

const options: PpcsCameraOptions = { stationSerial: "synthetic", p2pDid: "synthetic",
  appConnection: "", dskKey: "synthetic", channel: 0, cameraModel: "T8170", accountId: "synthetic" };

test("closing a pending lookup rejects start immediately and prevents a later retry timeout", async context => {
  context.mock.method(Socket.prototype, "bind", function (this: Socket) { return this; });
  const session = new FirstPartyPpcsSession(options);
  const rejected = assert.rejects(session.start(), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "PPCS camera lookup cancelled");
    assert.equal(error instanceof PpcsLookupTimeoutError, false);
    return true;
  });
  session.close();
  await rejected;
  assert.equal(session.stats.closeReason, "client_stop");
});

test("an exhausted lookup retires its session and returns the typed timeout", async context => {
  context.mock.method(Socket.prototype, "bind", function (this: Socket) { return this; });
  const session = new FirstPartyPpcsSession({ ...options, lookupTimeoutMs: 5 });
  await assert.rejects(session.start(), error => error instanceof PpcsLookupTimeoutError);
  assert.equal(session.stats.closeReason, "start_failed");
});

test("lookup deadlines cannot extend the original connection limit", () => {
  for (const lookupTimeoutMs of [0, -1, NaN, Infinity, 20_001, 1.5]) {
    assert.throws(() => new FirstPartyPpcsSession({ ...options, lookupTimeoutMs }), /Invalid PPCS lookup deadline/);
  }
});
