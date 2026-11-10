/**
 * Exercises saved-token renewal without contacting Firebase or Eufy. Fixtures
 * own the private state and fake transport. The receiver consumes renewed tokens
 * only within its active lifetime and keeps its installation on lookup failure.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FcmRegistrar } from "../src/mega/android-push/fcm.js";
import type { FcmCredentials } from "../src/mega/android-push/types.js";
import { MegaPushReceiver } from "../src/mega/push.js";

const credentials: FcmCredentials = { fid: "c123456789012345678901", androidId: "123", securityToken: "456",
  refreshToken: "private-refresh-fixture", fcmToken: "old-token-fixture", createdAt: 1 };

test("renews the notification token through the existing installation without check-in or identity creation", async context => {
  const calls: { url: string; options: RequestInit }[] = [];
  context.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    calls.push({ url, options });
    return calls.length === 1 ? Response.json({ token: "auth-fixture" }) : new Response("token=renewed-token-fixture\n");
  });
  const before = { ...credentials };
  const renewed = await new FcmRegistrar().refresh(credentials, new AbortController().signal);
  assert.deepEqual(credentials, before);
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.url.endsWith(`/installations/${credentials.fid}/authTokens:generate`));
  assert.equal(new Headers(calls[0]!.options.headers).get("authorization"), "FIS_v2 private-refresh-fixture");
  assert.deepEqual(JSON.parse(calls[0]!.options.body as string), { installation: { sdkVersion: "a:16.3.1" } });
  const body = new URLSearchParams(calls[1]!.options.body as string);
  assert.equal(body.get("device"), credentials.androidId);
  assert.equal(body.get("X-appid"), credentials.fid);
  assert.equal(body.get("X-Goog-Firebase-Installations-Auth"), "auth-fixture");
  assert.equal(new Headers(calls[1]!.options.headers).get("authorization"), "AidLogin 123:456");
  assert.equal(renewed.fcmToken, "renewed-token-fixture");
  assert.equal(renewed.androidId, before.androidId);
  assert.equal(renewed.fid, before.fid);
  assert.equal(renewed.securityToken, before.securityToken);
  assert.equal(renewed.createdAt, before.createdAt);
  assert.ok(renewed.tokenCheckedAt! > 0);
});

test("rejects expired installation authorization without creating a new identity or exposing the response", async context => {
  const fetch = context.mock.method(globalThis, "fetch", async () => new Response("PRIVATE_ERROR_FIXTURE", { status: 401 }));
  await assert.rejects(new FcmRegistrar().refresh(credentials, new AbortController().signal),
    error => error instanceof Error && error.message === "Firebase token renewal unavailable");
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(credentials.fcmToken, "old-token-fixture");
});

test("an aborted token lookup never proceeds to notification registration", async context => {
  const controller = new AbortController();
  const fetch = context.mock.method(globalThis, "fetch", async () => {
    controller.abort();
    return Response.json({ token: "auth-fixture" });
  });
  await assert.rejects(new FcmRegistrar().refresh(credentials, controller.signal));
  assert.equal(fetch.mock.callCount(), 1);
});

test("a rejected register3 response cannot publish a token from its error body", async context => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => ++calls === 1
    ? Response.json({ token: "auth-fixture" }) : new Response("token=must-not-be-used", { status: 403 }));
  await assert.rejects(new FcmRegistrar().refresh(credentials, new AbortController().signal));
  assert.equal(calls, 2);
  assert.equal(credentials.fcmToken, "old-token-fixture");
});

test("refuses malformed or oversized Firebase credentials and response bodies", async context => {
  const fetch = context.mock.method(globalThis, "fetch", async () => new Response("x".repeat(16_385)));
  await assert.rejects(new FcmRegistrar().refresh({ ...credentials, fid: "../wrong-path" }, new AbortController().signal));
  assert.equal(fetch.mock.callCount(), 0);
  await assert.rejects(new FcmRegistrar().refresh(credentials, new AbortController().signal));
  assert.equal(fetch.mock.callCount(), 1);
});

for (const outcome of ["renewed", "unavailable", "recent", "cancelled"] as const) {
  test(`saved-token startup handles ${outcome} without replacing the MCS identity`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "eufy-token-renewal-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "state.json");
    const initial = { ...credentials, ...(outcome === "recent" ? { tokenCheckedAt: Date.now() } : {}) };
    await writeFile(path, JSON.stringify({ version: 2, persistentIds: ["previous-delivery"], credentials: initial }));
    let finish!: (value: FcmCredentials) => void;
    let entered!: () => void;
    const pending = new Promise<FcmCredentials>(resolve => { finish = resolve; });
    const refreshing = new Promise<void>(resolve => { entered = resolve; });
    const refresh = context.mock.method(FcmRegistrar.prototype, "refresh", async () => {
      entered();
      if (outcome === "unavailable") throw new Error("PRIVATE_REFRESH_ERROR");
      return outcome === "cancelled" ? await pending : { ...initial, fcmToken: "renewed-token-fixture", tokenCheckedAt: Date.now() };
    });
    const create = context.mock.method(FcmRegistrar.prototype, "register", async () => { throw new Error("Must not replace identity"); });
    const received: string[] = [];
    const transport = Object.assign(new EventEmitter(), {
      setPersistentIds(ids: string[]) { assert.deepEqual(ids, ["previous-delivery"]); },
      connect() { transport.emit("connect"); }, close() {},
    });
    const receiver = new MegaPushReceiver({ registerPushToken: async (token: string) => {
      received.push(token); return { registered: true, code: 0 };
    } } as never, path, () => undefined, undefined, undefined, identity => {
      assert.equal(identity.androidId, initial.androidId);
      assert.equal(identity.securityToken, initial.securityToken);
      return transport as never;
    });
    try {
      const start = receiver.start();
      if (outcome === "cancelled") {
        await refreshing;
        await receiver.close();
        finish({ ...initial, fcmToken: "late-token-fixture", tokenCheckedAt: Date.now() });
      }
      await start;
      if (outcome !== "cancelled") {
        transport.emit("disconnect"); transport.emit("connect");
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      await receiver.close();
      assert.equal(create.mock.callCount(), 0);
      assert.equal(refresh.mock.callCount(), outcome === "recent" ? 0 : 1);
      assert.deepEqual(received, outcome === "cancelled" ? [] : Array(2).fill(outcome === "renewed" ? "renewed-token-fixture" : initial.fcmToken));
      const saved = JSON.parse(await readFile(path, "utf8"));
      assert.equal(saved.credentials.fcmToken, outcome === "renewed" ? "renewed-token-fixture" : initial.fcmToken);
      assert.equal(saved.credentials.fid, initial.fid);
      assert.deepEqual(saved.persistentIds, ["previous-delivery"]);
    } finally { await receiver.close(); }
  });
}
