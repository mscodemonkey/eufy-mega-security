/**
 * Exercises receiver status across registration, reconnect and shutdown.
 * Synthetic credentials and an injected transport keep this lifecycle test offline.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MegaPushReceiver } from "../src/mega/push.js";
import type { PushClient } from "../src/mega/android-push/push-client.js";
import type { PushActivationResult } from "../src/mega/client.js";

const READY: PushActivationResult = { activated: true, code: 0 };

test("publishes registration once, restores connected after reconnect and leaves stopped last", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-push-state-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({ version: 2, persistentIds: [], credentials: {
    fid: "synthetic", androidId: "123", securityToken: "456", fcmToken: "synthetic", createdAt: 1,
  } }));
  const transport = Object.assign(new EventEmitter(), {
    setPersistentIds() {},
    connect() { transport.emit("connect"); },
    close() { queueMicrotask(() => transport.emit("disconnect")); },
  });
  const states: string[] = [];
  const receiver = new MegaPushReceiver({ registerPushToken: async () => READY } as never, path,
    () => undefined, (state) => states.push(state), undefined, () => transport as unknown as PushClient);
  try {
    await receiver.start();
    transport.emit("disconnect");
    transport.emit("connect");
    await receiver.close();
    await Promise.resolve();
    assert.deepEqual(states, ["starting", "connected", "disconnected", "connected", "stopped"]);
  } finally {
    await receiver.close();
    await rm(directory, { recursive: true, force: true });
  }
});

/** Provide a stored synthetic identity and a fresh transport per start without network calls. */
async function receiverFixture(register: () => Promise<PushActivationResult>, automaticLogin = true) {
  const directory = await mkdtemp(join(tmpdir(), "eufy-push-race-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({ version: 2, persistentIds: [], credentials: {
    fid: "synthetic", androidId: "123", securityToken: "456", fcmToken: "synthetic", createdAt: 1,
  } }));
  const transports: EventEmitter[] = [];
  const states: string[] = [];
  let created!: () => void;
  const ready = new Promise<void>((resolve) => { created = resolve; });
  const receiver = new MegaPushReceiver({ registerPushToken: register } as never, path, () => undefined,
    (state) => states.push(state), undefined, () => {
      const transport = Object.assign(new EventEmitter(), {
        setPersistentIds() {},
        connect() { created(); if (automaticLogin) transport.emit("connect"); },
        close() { queueMicrotask(() => transport.emit("disconnect")); },
      });
      transports.push(transport);
      return transport as unknown as PushClient;
    });
  return { receiver, transports, states, ready, async cleanup() { await receiver.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("closing while registration is pending leaves stopped as the final state", async () => {
  let entered!: () => void;
  let finish!: () => void;
  const registering = new Promise<void>((resolve) => { entered = resolve; });
  const registration = new Promise<void>((resolve) => { finish = resolve; });
  const fixture = await receiverFixture(() => { entered(); return registration.then(() => READY); });
  try {
    const starting = fixture.receiver.start();
    await registering;
    await fixture.receiver.close();
    finish();
    await starting;
    assert.deepEqual(fixture.states, ["starting", "stopped"]);
  } finally { await fixture.cleanup(); }
});

test("a disconnect during registration stays disconnected until the next login", async () => {
  let entered!: () => void;
  let finish!: () => void;
  const registering = new Promise<void>((resolve) => { entered = resolve; });
  const registration = new Promise<void>((resolve) => { finish = resolve; });
  const fixture = await receiverFixture(() => { entered(); return registration.then(() => READY); });
  try {
    const starting = fixture.receiver.start();
    await registering;
    fixture.transports[0]!.emit("disconnect");
    finish();
    await starting;
    assert.deepEqual(fixture.states, ["starting", "disconnected"]);
    fixture.transports[0]!.emit("connect");
    assert.deepEqual(fixture.states, ["starting", "disconnected", "connected"]);
  } finally { await fixture.cleanup(); }
});

test("a stale registration rejection cannot clear a replacement receiver", async () => {
  let entered!: () => void;
  let reject!: (error: Error) => void;
  const registering = new Promise<void>((resolve) => { entered = resolve; });
  const registration = new Promise<PushActivationResult>((_resolve, failed) => { reject = failed; });
  let registrations = 0;
  const fixture = await receiverFixture(() => { if (++registrations === 1) { entered(); return registration; } return Promise.resolve(READY); });
  try {
    const starting = fixture.receiver.start();
    const rejected = assert.rejects(starting, /synthetic rejection/);
    await registering;
    await fixture.receiver.close();
    await fixture.receiver.start();
    fixture.transports[0]!.emit("connect");
    fixture.transports[0]!.emit("disconnect");
    reject(new Error("synthetic rejection"));
    await rejected;
    fixture.transports[1]!.emit("disconnect");
    fixture.transports[1]!.emit("connect");
    assert.deepEqual(fixture.states, ["starting", "stopped", "starting", "connected", "disconnected", "connected"]);
  } finally { await fixture.cleanup(); }
});

test("closing while login is pending cannot publish a later state", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = await receiverFixture(async () => READY, false);
  try {
    const starting = fixture.receiver.start();
    const rejected = assert.rejects(starting, /login timed out/);
    await fixture.ready;
    await fixture.receiver.close();
    context.mock.timers.tick(20_000);
    await rejected;
    assert.deepEqual(fixture.states, ["starting", "stopped"]);
  } finally { await fixture.cleanup(); }
});

test("retains an unconfirmed receiver state across reconnects", async () => {
  const fixture = await receiverFixture(async () => ({ activated: false, code: 10003 }));
  try {
    const status = await fixture.receiver.start();
    fixture.transports[0]!.emit("disconnect");
    fixture.transports[0]!.emit("connect");
    await fixture.receiver.close();
    await Promise.resolve();
    assert.equal(status, "activation-unconfirmed");
    assert.deepEqual(fixture.states, [
      "starting", "activation-unconfirmed", "disconnected", "activation-unconfirmed", "stopped",
    ]);
  } finally { await fixture.cleanup(); }
});
