/**
 * Verifies fresh notification setup without contacting Firebase or Eufy.
 * Fake fetch requests and protobuf replies own all credentials and timing.
 * The receiver consumes only completed setup from its current lifetime.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FcmRegistrar } from "../src/mega/android-push/fcm.js";
import { checkinRoot } from "../src/mega/android-push/proto.js";
import { MegaPushReceiver } from "../src/mega/push.js";

/** Return synthetic responses for the three requests in initial registration. */
function reply(index: number): Response {
  if (index === 0) return Response.json({ refreshToken: "refresh-fixture", authToken: { token: "auth-fixture" } });
  if (index === 1) {
    const type = checkinRoot().lookupType("CheckinResponse");
    return new Response(Buffer.from(type.encode(type.create({ androidId: 123, securityToken: 456 })).finish()));
  }
  return new Response("token=token-fixture\n");
}

test("initial setup shares one thirty-second deadline across all three requests", async context => {
  const deadlines: number[] = [];
  const deadline = new AbortController();
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => { deadlines.push(milliseconds); return deadline.signal; });
  const signals: AbortSignal[] = [];
  context.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    assert.equal(options.redirect, "error");
    signals.push(options.signal as AbortSignal);
    return reply(signals.length - 1);
  });
  const result = await new FcmRegistrar().register(new AbortController().signal);
  assert.deepEqual(deadlines, [30_000]);
  assert.equal(signals.length, 3);
  assert.ok(signals.every(signal => signal === signals[0]));
  assert.equal(result.androidId, "123");
  assert.equal(result.securityToken, "456");
  assert.equal(result.fcmToken, "token-fixture");
});

for (const stage of [0, 1, 2]) {
  for (const duringBody of [false, true]) {
    test(`shutdown cancels initial request ${stage} during ${duringBody ? "body" : "fetch"}`, async context => {
      const controller = new AbortController();
      let calls = 0, bodyCancelled = false;
      context.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
        const index = calls++;
        if (index !== stage) return reply(index);
        const signal = options.signal as AbortSignal;
        if (duringBody) {
          setImmediate(() => controller.abort());
          return new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }));
        }
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          controller.abort();
        });
      });
      await assert.rejects(new FcmRegistrar().register(controller.signal));
      assert.equal(calls, stage + 1);
      assert.equal(bodyCancelled, duringBody);
    });
  }
}

test("the total deadline cancels a stalled fetch without creating another identity", async context => {
  const deadline = new AbortController();
  context.mock.method(AbortSignal, "timeout", () => deadline.signal);
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
      deadline.abort();
    });
  });
  await assert.rejects(new FcmRegistrar().register());
  assert.equal(calls, 1);
});

for (const stage of [0, 1, 2]) {
  test(`oversized initial response ${stage} stops setup`, async context => {
    let calls = 0;
    context.mock.method(globalThis, "fetch", async () => {
      const index = calls++;
      return index === stage ? new Response("x".repeat(65_537)) : reply(index);
    });
    await assert.rejects(new FcmRegistrar().register());
    assert.equal(calls, stage + 1);
  });
}

test("malformed installation credentials cannot reach Android check-in", async context => {
  const fetch = context.mock.method(globalThis, "fetch", async () => Response.json({ refreshToken: "private\nvalue", authToken: { token: "auth" } }));
  await assert.rejects(new FcmRegistrar().register());
  assert.equal(fetch.mock.callCount(), 1);
});

test("a stopped fresh setup is retired before the next receiver startup", async context => {
  const directory = await mkdtemp(join(tmpdir(), "push-initialization-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let entered!: () => void;
  const starting = new Promise<void>(resolve => { entered = resolve; });
  let setups = 0, aborts = 0, registrations = 0;
  context.mock.method(FcmRegistrar.prototype, "register", async (signal?: AbortSignal) => {
    setups++;
    if (setups === 1) return await new Promise<never>((_resolve, reject) => {
      assert.ok(signal);
      signal.addEventListener("abort", () => { aborts++; reject(signal.reason); }, { once: true });
      entered();
    });
    return { fid: "c123456789012345678901", androidId: "123", securityToken: "456", fcmToken: "fixture", createdAt: Date.now() };
  });
  const transport = Object.assign(new EventEmitter(), {
    setPersistentIds() {}, connect() { transport.emit("connect"); }, close() {},
  });
  const receiver = new MegaPushReceiver({ registerPushToken: async () => { registrations++; return { registered: true }; } } as never,
    join(directory, "state.json"), () => undefined, undefined, undefined, () => transport as never);
  try {
    const first = receiver.start();
    await starting;
    await receiver.close();
    await first;
    assert.equal(aborts, 1);
    assert.equal(registrations, 0);
    await receiver.start();
    assert.equal(setups, 2);
    assert.equal(registrations, 1);
  } finally { await receiver.close(); }
});
