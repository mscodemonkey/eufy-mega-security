/**
 * Exercises live-start ownership against automatic preset discovery.
 * Fixtures own all cloud, push and PPCS effects. The real provider coordinates
 * deferred reads and source starts without contacting or moving a camera.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";

/** Let the test retire an operation without a wall-clock sleep. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** Drain provider continuations while keeping real device effects forbidden. */
async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
}

/** Own synthetic camera state, deferred callbacks and all provider cleanup. */
async function fixture(context: TestContext, model = "T8171") {
  const directory = await mkdtemp(join(tmpdir(), "preset-source-owner-"));
  const attached = model === "T8171";
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.getter(MegaClient.prototype, "isAuthenticated", () => true);
  context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (owner: string) => owner === "synthetic-owner");
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
    ...(attached ? [{ device_sn: "synthetic-base", device_model: "T8030", device_type: 18,
      category: "eufy_security", member: { admin_user_id: "synthetic-owner" },
      p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic" }] : []),
    { device_sn: "synthetic-camera", device_model: model, device_type: attached ? 88 : 10031,
      category: "eufy_security", parent_sn: attached ? "synthetic-base" : "synthetic-camera",
      device_channel: attached ? 1 : 0, member: { admin_user_id: "synthetic-owner" },
      p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic" },
  ] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({
    "synthetic-base": { key: "synthetic", expiresAt: null }, "synthetic-camera": { key: "synthetic", expiresAt: null },
  }));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
  context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => {});
  context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [] }));
  context.mock.method(FirstPartyPpcsSession.prototype, "readCameraInfo", async () => []);
  const sessions: FirstPartyPpcsSession[] = [];
  const order: string[] = [];
  let framesReady = true;
  let onStart = async (_session: FirstPartyPpcsSession): Promise<void> => {};
  let onQuery = async (): Promise<void> => {};
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async function(this: FirstPartyPpcsSession) {
    sessions.push(this); order.push("start");
    await onStart(this);
    this.stats.camId = 1;
    this.stats.videoOutputFrames = framesReady ? 1 : 0;
  });
  context.mock.method(FirstPartyPpcsSession.prototype, "close", function(this: FirstPartyPpcsSession) {
    order.push("close"); this.stats.closeReason = "client_stop"; this.output.end();
  });
  const query = context.mock.method(FirstPartyPpcsSession.prototype, "queryPresetPositions", async (current?: () => void) => {
    await onQuery(); current?.(); return [{ index: 0, enabled: true, isDefault: true }];
  });
  const events = new Proxy({}, { get: () => () => {} }) as ProviderEvents;
  const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory, maxStreamSeconds: 120 });
  await provider.start(events); await flush(); sessions.length = 0; order.length = 0;
  const stop = context.mock.method(provider, "stopStream");
  return { provider, sessions, order, query, stop,
    setFrames: (ready: boolean): void => { framesReady = ready; },
    setStart: (callback: typeof onStart): void => { onStart = callback; },
    setQuery: (callback: typeof onQuery): void => { onQuery = callback; },
    dispose: async (): Promise<void> => {
      await provider.close(); await rm(directory, { recursive: true, force: true });
      assert.equal(network.mock.callCount(), 0);
    },
  };
}

for (const model of ["T8171", "T817L"]) {
  test(`preset discovery cannot cancel a pending ${model} live lookup`, async context => {
    const f = await fixture(context, model), entered = gate(), held = gate();
    let calls = 0;
    f.setStart(async () => { if (++calls === 1) { entered.release(); await held.promise; } });
    const opening = f.provider.startStream("synthetic-camera");
    void opening.catch(() => {});
    try {
      await entered.promise;
      await assert.rejects(f.provider.getCameraPresetPositions("synthetic-camera"), /starting|live/i);
      assert.equal(f.stop.mock.callCount(), 0);
      assert.equal(f.query.mock.callCount(), 0);
      held.release(); await opening;
      assert.equal(f.sessions.length, 1);
    } finally { held.release(); await Promise.allSettled([opening]); await f.dispose(); }
  });

  test(`preset discovery cannot replace ${model} while its first frame is pending`, async context => {
    const f = await fixture(context, model);
    f.setFrames(false);
    try {
      await f.provider.startStream("synthetic-camera");
      await assert.rejects(f.provider.getCameraPresetPositions("synthetic-camera"), /starting|live/i);
      assert.equal(f.stop.mock.callCount(), 0);
      assert.equal(f.sessions.length, 1);
    } finally { await f.dispose(); }
  });

  test(`preset discovery still shares a decoded ${model} viewer`, async context => {
    const f = await fixture(context, model);
    try {
      await f.provider.startStream("synthetic-camera");
      assert.equal((await f.provider.getCameraPresetPositions("synthetic-camera")).length, 1);
      assert.equal(f.sessions.length, 1);
      assert.equal(f.stop.mock.callCount(), 0);
    } finally { await f.dispose(); }
  });
}

test("live lookup waits for an existing preset query and its control cleanup", async context => {
  const f = await fixture(context), entered = gate(), held = gate();
  f.setQuery(async () => { entered.release(); await held.promise; });
  const reading = f.provider.getCameraPresetPositions("synthetic-camera");
  let opening: Promise<void> | undefined;
  try {
    await entered.promise;
    opening = f.provider.startStream("synthetic-camera");
    void opening.catch(() => {});
    await flush();
    assert.equal(f.sessions.length, 1);
    held.release(); await reading; await opening;
    assert.equal(f.sessions.length, 2);
    assert.deepEqual(f.order, ["start", "close", "start"]);
  } finally { held.release(); await Promise.allSettled([reading, opening]); await f.dispose(); }
});

test("stopping a lookup waiting on presets cannot wake it after the read finishes", async context => {
  const f = await fixture(context), entered = gate(), held = gate();
  f.setQuery(async () => { entered.release(); await held.promise; });
  const reading = f.provider.getCameraPresetPositions("synthetic-camera");
  let opening: Promise<void> | undefined;
  try {
    await entered.promise;
    opening = f.provider.startStream("synthetic-camera");
    void opening.catch(() => {});
    await flush(); await f.provider.stopStream("synthetic-camera");
    await assert.rejects(opening, /cancelled/i);
    held.release(); await reading; await flush();
    assert.equal(f.sessions.length, 1);
  } finally { held.release(); await Promise.allSettled([reading, opening]); await f.dispose(); }
});
