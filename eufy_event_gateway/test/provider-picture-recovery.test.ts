/**
 * Exercises failed-picture recovery through real provider notification routing.
 * Test-owned cloud, inventory and station sessions forbid network operations.
 * Delayed replies expose visit replacement, cancellation and byte ownership.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver, parsePushEvent, type MegaPushEvent } from "../src/mega/push.js";
import type { PushRecordingReference } from "../src/mega/push-recording-reference.js";
import { MediaHttpError } from "../src/mega/media-request-diagnostic.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";

const path = "/zx/hdd_data0/Camera00/202611/20261102090000/20261102092000.zxvideo";
const jpeg = Buffer.from([255, 216, 1, 2, 255, 217]);

/** Let bounded test-owned promise chains settle without advancing protocol clocks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

/** Build an isolated provider whose only device effects are captured test callbacks. */
async function fixture(context: TestContext, mode = "success", recoveryEnabled = true, route: "homebase3" | "homebase2" | "standalone" = "homebase3") {
  const directory = await mkdtemp(join(tmpdir(), "picture-recovery-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  const parent = { device_sn: "invented-parent", device_model: mode === "homebase2" || route === "homebase2" ? "T8010" : "T8030", device_type: route === "homebase2" ? 0 : 18,
    category: "eufy_security", p2p_did: "TEST-12345678-TEST", p2p_conn: "invented", member: { admin_user_id: "invented-owner" }, params: [] };
  const child = { device_sn: "invented-child", device_model: route === "standalone" ? "T8172" : route === "homebase2" ? "T8210" : mode === "wrong-model" ? "T8113" : "T8113-Z",
    device_type: route === "standalone" ? 89 : route === "homebase2" ? 7 : 8,
    device_channel: route === "standalone" ? 0 : 2, parent_sn: route === "standalone" ? "invented-child" : parent.device_sn, category: "eufy_security", member: { admin_user_id: "invented-owner" }, params: [] };
  let inventories = 0;
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [...(route === "standalone" ? [] : [parent]),
    { ...child, ...(mode === "changed-inventory" && ++inventories > 1 ? { device_channel: 3 } : {}) }] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ "invented-parent": { key: "invented", expiresAt: null } }));
  context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => undefined);
  context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [] }));
  context.mock.method(HomeBasePpcsSession.prototype, "close", () => undefined);
  let deliver!: (event: MegaPushEvent) => void;
  context.mock.method(MegaPushReceiver.prototype, "start", async function(this: MegaPushReceiver) {
    deliver = Reflect.get(this, "onEvent") as typeof deliver;
  });
  let releaseCloud: (() => void) | undefined, cloudBytes: Buffer | undefined, cloudRequestSignal: AbortSignal | undefined;
  const cloud = context.mock.method(MegaClient.prototype, "download", async (_url: string, _limit?: number, requestSignal?: AbortSignal) => {
    if (mode === "cloud-cancelled") {
      if (cloud.mock.callCount() > 0) return jpeg;
      cloudRequestSignal = requestSignal;
      return await new Promise<Buffer>((resolve, reject) => {
        releaseCloud = () => { cloudBytes = Buffer.from(jpeg); resolve(cloudBytes); };
        requestSignal?.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
      });
    }
    if (mode === "cloud-success") return jpeg;
    if (mode === "cloud-superseded" || mode.startsWith("cloud-restarted") && cloud.mock.callCount() === 0) {
      await new Promise<void>(resolve => { releaseCloud = resolve; }); cloudBytes = Buffer.from(jpeg); return cloudBytes;
    }
    if (mode.startsWith("cloud-restarted")) return jpeg;
    if (mode === "untyped-error") throw Error("HTTP404");
    throw new MediaHttpError(mode === "http500" ? 500 : 404, 5, "eufy-eu");
  });
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => undefined);
  context.mock.method(FirstPartyPpcsSession.prototype, "close", function(this: FirstPartyPpcsSession) { this.output.end(); });
  const drained = context.mock.method(FirstPartyPpcsSession.prototype, "waitUntilClosed", async () => undefined);
  let release: (() => void) | undefined, signal: AbortSignal | undefined, returned: Buffer | undefined;
  const recovery = context.mock.method(FirstPartyPpcsSession.prototype, "recoverEventPicture", async (reference: PushRecordingReference, operationSignal: AbortSignal) => {
    assert.equal(reference.id, "42"); assert.equal(reference.storagePath, path); signal = operationSignal;
    if (["superseded", "shutdown", "restart"].includes(mode)) await new Promise<void>(resolve => { release = resolve; });
    returned = Buffer.from(jpeg);
    return returned;
  });
  const provider = new EufyProvider({ username: "invented", password: "invented", country: "AU", persistentDirectory: directory,
    maxStreamSeconds: 120, apiAuthenticationConfigured: mode !== "unauthenticated", experimentalHomeBaseEventImages: recoveryEnabled && !["off", "cloud-restarted-off"].includes(mode) });
  const pictures: Buffer[] = [];
  let motions = 0;
  const events = new Proxy({ motion: (_serial: string, active: boolean) => { if (active) motions++; },
    snapshot: (_serial: string, bytes: Buffer) => { pictures.push(Buffer.from(bytes)); } },
  { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) }) as unknown as ProviderEvents;
  await provider.start(events); await settle();
  const event = (id = "visit-a", picture = true) => parsePushEvent({ device_sn: child.device_sn, station_sn: route === "standalone" ? child.device_sn : parent.device_sn,
    payload: { event_type: 1, unique_id: id, ...(picture ? { pic_url: "https://example.invalid/picture" } : {}),
      ...(mode === "no-reference" ? {} : { record_id: 42, file_path: path,
        trigger_time: Date.now() + (mode === "stale" ? -301_000 : mode === "future" ? 10_000 : 0) }) } })!;
  return { provider, events, network, cloud, recovery, drained, pictures, event, send: (value: MegaPushEvent) => deliver(value),
    releaseCloud: () => releaseCloud?.(), cloudBytes: () => cloudBytes, cloudRequestSignal: () => cloudRequestSignal,
    motions: () => motions, signal: () => signal, returned: () => returned, release: () => release?.() };
}

for (const mode of ["success", "off", "unauthenticated", "cloud-success", "http500", "untyped-error", "no-reference",
  "wrong-model", "homebase2", "changed-inventory", "stale", "future"] as const) {
  test(`automatic picture recovery admission and publication: ${mode}`, async context => {
    const f = await fixture(context, mode);
    try {
      f.send(f.event()); await settle();
      const recovered = mode === "success";
      assert.equal(f.recovery.mock.callCount(), recovered ? 1 : 0);
      assert.equal(f.pictures.length, recovered || mode === "cloud-success" ? 1 : 0);
      assert.equal(f.motions(), 1); assert.equal(f.cloud.mock.callCount(), 1); assert.equal(f.network.mock.callCount(), 0);
      if (recovered) { assert.deepEqual(f.pictures[0], jpeg); assert.equal(f.drained.mock.callCount(), 1); }
      f.send(f.event()); await settle();
      assert.equal(f.motions(), 1); assert.equal(f.recovery.mock.callCount(), recovered ? 1 : 0);
    } finally { await f.provider.close(); }
  });
}

for (const mode of ["superseded", "shutdown", "restart"] as const) {
  test(`a late recovered image loses ownership after ${mode}`, async context => {
    const f = await fixture(context, mode);
    try {
      f.send(f.event()); await settle(); assert.equal(f.recovery.mock.callCount(), 1);
      let closing: Promise<void> | undefined;
      if (mode === "superseded") f.send(f.event("visit-b", false));
      else if (mode === "shutdown") closing = f.provider.close();
      else closing = f.provider.start(f.events);
      await settle(); assert.equal(f.signal()?.aborted, true);
      f.release(); await closing; await settle();
      assert.equal(f.pictures.length, 0); assert.ok(f.returned()?.every(byte => byte === 0));
      assert.equal(f.motions(), mode === "superseded" ? 2 : 1);
    } finally { f.release(); await f.provider.close(); }
  });
}

test("an older visit's delayed picture cannot take the current visit's owner", async context => {
  const f = await fixture(context);
  try {
    f.send(f.event("visit-a", false)); f.send(f.event("visit-b", false)); f.send(f.event("visit-a", true)); await settle();
    assert.equal(f.cloud.mock.callCount(), 0); assert.equal(f.recovery.mock.callCount(), 0);
    assert.equal(f.pictures.length, 0); assert.equal(f.motions(), 2);
  } finally { await f.provider.close(); }
});

for (const recoveryEnabled of [true, false]) test(`a newer event without a picture invalidates a late cloud response: recovery=${recoveryEnabled}`, async context => {
  const f = await fixture(context, "cloud-superseded", recoveryEnabled);
  try {
    f.send(f.event()); await settle(); f.send(f.event("visit-b", false));
    f.releaseCloud(); await settle();
    assert.equal(f.pictures.length, 0); assert.ok(f.cloudBytes()?.every(byte => byte === 0)); assert.equal(f.recovery.mock.callCount(), 0);
  } finally { f.releaseCloud(); await f.provider.close(); }
});

test("automatic recovery leaves another operation's peer reservation alone", async context => {
  const f = await fixture(context);
  let release!: () => void;
  context.mock.method(FirstPartyPpcsSession.prototype, "readEventPicture", async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return { scope: "one_history_thumbnail" as const, records: 1, imageBytes: 6, width: 8, height: 4 };
  });
  const pending = f.provider.diagnoseEventPicture("invented-child", "2026-11-02", "0", undefined, new AbortController().signal);
  try {
    await settle(); assert.ok(release); f.send(f.event()); await settle();
    assert.equal(f.recovery.mock.callCount(), 0); assert.equal(f.pictures.length, 0);
    release(); assert.equal((await pending).scope, "one_history_thumbnail");
  } finally { release?.(); await pending.catch(() => undefined); await f.provider.close(); }
});

test("a previously unseen older notification cannot replace the newer recording's picture", async context => {
  const f = await fixture(context, "cloud-success");
  try {
    const current = f.event("new-visit"), earlier = f.event("late-earlier-visit");
    const delayed = { ...earlier, recording: { ...earlier.recording!, id: "41",
      storagePath: path.replace("092000", "091900"), triggerMilliseconds: current.recording!.triggerMilliseconds - 1_000 } };
    f.send(current); await settle(); f.send(delayed); await settle();
    assert.equal(f.pictures.length, 1); assert.equal(f.cloud.mock.callCount(), 1); assert.equal(f.motions(), 2);
  } finally { await f.provider.close(); }
});

for (const mode of ["cloud-restarted", "cloud-restarted-off"]) {
  test(`a restarted provider does not wait for a retired picture queue: ${mode}`, { timeout: 10_000 }, async context => {
    const f = await fixture(context, mode);
    try {
      f.send(f.event("before-restart"));
      await settle();
      assert.equal(f.cloud.mock.callCount(), 1);
      await f.provider.start(f.events);
      f.send(f.event("after-restart"));
      await settle();
      assert.equal(f.cloud.mock.callCount(), 2);
      assert.equal(f.pictures.length, 1);
      f.releaseCloud();
      await settle();
      assert.equal(f.pictures.length, 1);
      assert.ok(f.cloudBytes()?.every(byte => byte === 0));
    } finally {
      f.releaseCloud();
      await f.provider.close();
    }
  });
}

for (const recoveryEnabled of [true, false]) for (const newPicture of [true, false]) {
  test(`a newer visit cancels its obsolete cloud picture: recovery=${recoveryEnabled}, replacement=${newPicture}`, async context => {
    const f = await fixture(context, "cloud-cancelled", recoveryEnabled);
    try {
      f.send(f.event("older-visit"));
      await settle();
      assert.equal(f.cloud.mock.callCount(), 1);
      f.send(f.event("current-visit", newPicture));
      await settle();
      assert.equal(f.cloudRequestSignal()?.aborted, true);
      assert.equal(f.cloud.mock.callCount(), newPicture ? 2 : 1);
      assert.equal(f.pictures.length, newPicture ? 1 : 0);
      assert.equal(f.recovery.mock.callCount(), 0);
    } finally {
      f.releaseCloud();
      await f.provider.close();
    }
  });
}


for (const route of ["homebase2", "standalone"] as const) for (const recoveryEnabled of [false, true]) {
  for (const replacement of [false, true]) test(`normal cloud pictures retire old visits without a recovery route: ${route}, opt-in=${recoveryEnabled}, replacement=${replacement}`, async context => {
    const f = await fixture(context, "cloud-cancelled", recoveryEnabled, route);
    try {
      f.send(f.event("old-alert")); await settle();
      assert.equal(f.cloud.mock.callCount(), 1);
      f.send(f.event("new-alert", replacement)); await settle();
      assert.equal(f.cloudRequestSignal()?.aborted, true);
      assert.equal(f.cloud.mock.callCount(), replacement ? 2 : 1);
      assert.equal(f.pictures.length, replacement ? 1 : 0);
      assert.equal(f.recovery.mock.callCount(), 0);
      assert.equal(f.network.mock.callCount(), 0);
    } finally { f.releaseCloud(); await f.provider.close(); }
  });

  test(`a late cloud reply cannot overwrite a newer visit without a recovery route: ${route}, opt-in=${recoveryEnabled}`, async context => {
    const f = await fixture(context, "cloud-superseded", recoveryEnabled, route);
    try {
      f.send(f.event("old-alert")); await settle(); f.send(f.event("new-alert", false));
      f.releaseCloud(); await settle();
      assert.equal(f.pictures.length, 0);
      assert.ok(f.cloudBytes()?.every(byte => byte === 0));
      assert.equal(f.recovery.mock.callCount(), 0);
    } finally { f.releaseCloud(); await f.provider.close(); }
  });
}
