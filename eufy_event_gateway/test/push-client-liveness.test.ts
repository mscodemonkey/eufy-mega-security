/**
 * Exercises Android push connection liveness without a network.
 * A fake socket stands in for the MCS TLS connection so the tests can show a
 * silently dropped connection is abandoned instead of reported as connected.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type tls from "node:tls";
import test from "node:test";

import { PushClient } from "../src/mega/android-push/push-client.js";
import { MessageTag } from "../src/mega/android-push/message-tags.js";
import { mcsRoot } from "../src/mega/android-push/proto.js";

/** Owns synthetic writes and schedules socket closure without contacting Firebase. */
class FakeSocket extends EventEmitter {
  readonly writes: Buffer[] = [];
  destroyed = false;
  setKeepAlive(): this { return this; }
  write(chunk: Buffer): boolean { this.writes.push(chunk); return true; }
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      queueMicrotask(() => this.emit("close"));
    }
    return this;
  }
}

function loginResponse(): Buffer {
  const LoginResponse = mcsRoot().lookupType("mcs_proto.LoginResponse");
  const body = LoginResponse.encodeDelimited({ id: "login" }).finish();
  return Buffer.concat([Buffer.from([41, MessageTag.LoginResponse]), body]);
}

function heartbeatAck(): Buffer {
  const Ack = mcsRoot().lookupType("mcs_proto.HeartbeatAck");
  return Buffer.concat([Buffer.from([MessageTag.HeartbeatAck]), Ack.encodeDelimited({}).finish()]);
}

const credentials = { androidId: "1234567890", securityToken: "987654321" } as never;

function client(sockets: FakeSocket[]): PushClient {
  return new PushClient(credentials, {
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as tls.TLSSocket;
    },
    heartbeatMilliseconds: 20,
    heartbeatReplyTimeoutMilliseconds: 30,
    loginTimeoutMilliseconds: 40,
  });
}

test("drops a push connection whose heartbeat goes unanswered", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const sockets: FakeSocket[] = [];
  const push = client(sockets);
  const disconnects: number[] = [];
  push.on("disconnect", () => disconnects.push(Date.now()));
  push.on("error", () => undefined);
  push.connect();
  sockets[0]!.emit("data", loginResponse());

  for (let index = 0; index < 6; index++) {
    context.mock.timers.tick(20);
    await Promise.resolve();
  }

  assert.equal(sockets[0]!.destroyed, true);
  assert.equal(disconnects.length, 1);
  push.close();
});

test("keeps a push connection whose heartbeat is answered", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const sockets: FakeSocket[] = [];
  const push = client(sockets);
  push.on("error", () => undefined);
  push.connect();
  const socket = sockets[0]!;
  socket.emit("data", loginResponse());
  const originalWrite = socket.write.bind(socket);
  socket.write = (chunk: Buffer) => {
    const result = originalWrite(chunk);
    if (chunk[0] === MessageTag.HeartbeatPing) setTimeout(() => socket.emit("data", heartbeatAck()), 5);
    return result;
  };

  for (let index = 0; index < 6; index++) {
    context.mock.timers.tick(20);
    await Promise.resolve();
  }

  assert.equal(socket.destroyed, false);
  push.close();
});

test("abandons a connection attempt that never completes login", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const sockets: FakeSocket[] = [];
  const push = client(sockets);
  push.on("error", () => undefined);
  push.connect();

  context.mock.timers.tick(80);
  await Promise.resolve();

  assert.equal(sockets[0]!.destroyed, true);
  push.close();
});


test("reconnects after a missed heartbeat and cancels recovery on shutdown", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const sockets: FakeSocket[] = [];
  const push = client(sockets);
  context.after(() => push.close());
  push.on("error", () => undefined);
  push.connect();
  sockets[0]!.emit("data", loginResponse());
  context.mock.timers.tick(20);
  context.mock.timers.tick(30);
  await Promise.resolve();
  assert.equal(sockets[0]!.destroyed, true);
  context.mock.timers.tick(5_000);
  assert.equal(sockets.length, 2);
  sockets[1]!.emit("data", loginResponse());
  push.close();
  await Promise.resolve();
  context.mock.timers.tick(60_000);
  assert.equal(sockets.length, 2);
});


test("ignores stale socket events and never reports disconnect after shutdown", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const sockets: FakeSocket[] = [];
  const push = client(sockets);
  let disconnects = 0;
  let errors = 0;
  push.on("disconnect", () => disconnects++);
  push.on("error", () => errors++);
  push.connect();
  const old = sockets[0]!;
  push.close();
  push.connect();
  old.emit("data", Buffer.from([0xff]));
  old.emit("error", new Error("stale"));
  old.emit("secureConnect");
  await Promise.resolve();
  sockets[1]!.emit("data", loginResponse());
  context.mock.timers.tick(5_000);
  assert.equal(sockets.length, 2);
  assert.equal(old.writes.length, 0);
  assert.equal(disconnects, 0);
  assert.equal(errors, 0);
  push.close();
  await Promise.resolve();
  assert.equal(disconnects, 0);
});

test("replays received persistent IDs on the next socket login", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const sockets: FakeSocket[] = [];
  const push = client(sockets);
  push.on("error", () => undefined);
  push.connect();
  sockets[0]!.emit("data", loginResponse());
  const data = mcsRoot().lookupType("mcs_proto.DataMessageStanza");
  sockets[0]!.emit("data", Buffer.concat([Buffer.from([MessageTag.DataMessageStanza]), data.encodeDelimited({ persistentId: "synthetic-delivery" }).finish()]));
  sockets[0]!.destroy();
  await Promise.resolve();
  context.mock.timers.tick(5_000);
  sockets[1]!.emit("secureConnect");
  const login = mcsRoot().lookupType("mcs_proto.LoginRequest").decodeDelimited(sockets[1]!.writes[0]!.subarray(2));
  assert.deepEqual((login as unknown as { receivedPersistentId: string[] }).receivedPersistentId, ["synthetic-delivery"]);
  push.close();
});
