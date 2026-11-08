/**
 * Exercises opt-in HomeBase 2 event frames through real provider notification routing.
 * Test-owned cloud, inventory and session methods forbid network operations.
 * Held replies expose visit replacement, viewer precedence and peer reservation lifetimes.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { encode } from "jpeg-js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver, parsePushEvent, type MegaPushEvent } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";

const jpeg = (width: number, height: number): Buffer => encode({ width, height, data: Buffer.alloc(width * height * 4, 90) }, 50).data;
const CROP = jpeg(160, 128), FULL = jpeg(640, 360), FRAME = Buffer.from("full-scene-frame");
const RSA_KEY = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs8" }) as string;
const CHILD = "invented-child", SIBLING = "invented-sibling";

/** Let bounded test-owned promise chains settle without advancing protocol clocks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

/** One test-held completion, released explicitly so each race has a fixed order. */
function hold() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

interface FixtureOptions {
  readonly enabled?: boolean;
  readonly authenticated?: boolean;
  readonly push?: Buffer;
  readonly childModel?: string;
  readonly childType?: number;
  readonly parentModel?: "T8010" | "T8030";
  readonly cipherRow?: Record<string, unknown>;
  readonly holdLookup?: boolean;
  readonly holdReads?: boolean;
  readonly holdDrain?: boolean;
  readonly failReads?: number;
}

/** Build an isolated provider whose only device effects are captured test callbacks. */
async function fixture(context: TestContext, options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "homebase2-event-frame-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  const parentModel = options.parentModel ?? "T8010";
  const parent = { device_sn: "invented-parent", device_model: parentModel, device_type: parentModel === "T8010" ? 0 : 18,
    category: "eufy_security", p2p_did: "TEST-12345678-TEST", p2p_conn: "invented", member: { admin_user_id: "invented-owner" }, params: [] };
  const camera = (serial: string, channel: number) => ({ device_sn: serial, device_model: options.childModel ?? "T8140", device_type: options.childType ?? 14,
    device_channel: channel, parent_sn: parent.device_sn, category: "eufy_security", member: { admin_user_id: "invented-owner" }, params: [] });
  let childChannel = 2;
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [parent, camera(CHILD, childChannel), camera(SIBLING, 3)] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ [parent.device_sn]: { key: "invented", expiresAt: null } }));
  context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => undefined);
  context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [] }));
  context.mock.method(HomeBasePpcsSession.prototype, "close", () => undefined);
  let deliver!: (event: MegaPushEvent) => void;
  context.mock.method(MegaPushReceiver.prototype, "start", async function(this: MegaPushReceiver) {
    deliver = Reflect.get(this, "onEvent") as typeof deliver;
  });
  context.mock.method(MegaClient.prototype, "download", async () => Buffer.from(options.push ?? CROP));
  const lookupHold = hold();
  const lookups = context.mock.method(MegaClient.prototype, "getCiphers", async () => {
    if (options.holdLookup) await lookupHold.promise;
    return [options.cipherRow ?? { cipher_id: 7, private_key: RSA_KEY }];
  });

  // Order proves that publication and the next owner wait for the disconnect.
  const order: string[] = [];
  const starts = context.mock.method(FirstPartyPpcsSession.prototype, "start", async function(this: FirstPartyPpcsSession) {
    this.stats.camId = 1; this.stats.videoOutputFrames = 1;
  });
  context.mock.method(FirstPartyPpcsSession.prototype, "close", function(this: FirstPartyPpcsSession) { order.push("close"); this.output.end(); });
  const drainHold = hold();
  const drained = context.mock.method(FirstPartyPpcsSession.prototype, "waitUntilClosed", async () => {
    if (options.holdDrain) await drainHold.promise;
    order.push("drained");
  });
  const reads: { path: string; signal: AbortSignal; bytes: Buffer; release: () => void }[] = [];
  let failures = options.failReads ?? 0;
  context.mock.method(FirstPartyPpcsSession.prototype, "readHomeBase2EventFrame", async (path: string, key: KeyObject, signal: AbortSignal) => {
    assert.equal(key.asymmetricKeyType, "rsa");
    const held = hold(), bytes = Buffer.from(FRAME);
    reads.push({ path, signal, bytes, release: held.release });
    order.push("read");
    if (failures-- > 0) throw Error("Clip is not readable yet");
    if (options.holdReads) await held.promise;
    return bytes;
  });
  const provider = new EufyProvider({ username: "invented", password: "invented", country: "AU", persistentDirectory: directory, maxStreamSeconds: 120,
    apiAuthenticationConfigured: options.authenticated !== false, experimentalHomeBase2EventFrames: options.enabled !== false });
  const pictures: Buffer[] = [];
  let motions = 0;
  const events = new Proxy({
    motion: (_serial: string, active: boolean) => { if (active) motions++; },
    snapshot: (_serial: string, bytes: Buffer) => { pictures.push(Buffer.from(bytes)); order.push("picture"); },
  }, { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) }) as unknown as ProviderEvents;
  await provider.start(events); await settle();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const event = (id = "visit-a", overrides: { readonly picture?: boolean; readonly serial?: string; readonly clip?: Record<string, unknown> } = {}) => parsePushEvent({
    device_sn: overrides.serial ?? CHILD, station_sn: parent.device_sn,
    payload: { event_type: 1, unique_id: id, ...(overrides.picture === false ? {} : { pic_url: "https://example.invalid/picture" }),
      ...(overrides.clip ?? { p: id, c: overrides.serial === SIBLING ? 3 : 2, k: 7 }) },
  })!;
  return { provider, events, network, lookups, starts, drained, reads, pictures, order, event, motions: () => motions,
    send: (value: MegaPushEvent) => deliver(value), releaseLookup: lookupHold.release, releaseDrain: drainHold.release,
    changeBinding: () => { childChannel = 5; },
    advance: async (milliseconds: number) => { context.mock.timers.tick(milliseconds); await settle(); },

    // Real timers return first, because shutdown has bounded waits of its own.
    close: async () => { lookupHold.release(); drainHold.release(); for (const read of reads) read.release();
      context.mock.timers.reset(); await provider.close(); assert.equal(network.mock.callCount(), 0); } };
}

test("a cropped picture is replaced after the read and the disconnect", async context => {
  const f = await fixture(context);
  try {
    f.send(f.event()); await settle();
    assert.deepEqual(f.pictures, [CROP]);
    assert.equal(f.lookups.mock.callCount(), 0, "nothing happens before the clip has had time to be written");
    await f.advance(20_000);
    assert.equal(f.reads[0]?.path, "/media/mmcblk0p1/Camera02/visit-a.dat");
    assert.deepEqual(f.pictures, [CROP, FRAME]);
    assert.deepEqual(f.order, ["picture", "read", "close", "drained", "picture"]);
    assert.equal(f.motions(), 1, "a replaced picture is not another detection");
    await f.advance(600_000);
    assert.equal(f.reads.length, 1, "one success ends the job");
  } finally { await f.close(); }
});

for (const [name, options, clip] of [
  ["the option is off", { enabled: false }, undefined],
  ["the gateway API is unauthenticated", { authenticated: false }, undefined],
  ["the event picture already shows the scene", { push: FULL }, undefined],
  ["the event picture is unreadable", { push: Buffer.from([255, 216, 1, 2, 255, 217]) }, undefined],
  ["the camera is another model", { childModel: "T8113", childType: 8 }, undefined],
  ["the camera is on a HomeBase 3", { parentModel: "T8030" }, undefined],
  ["the push names no clip", {}, { c: 2, k: 7 }],
  ["the push names no cipher", {}, { p: "visit-a", c: 2 }],
  ["the push cipher is empty", {}, { p: "visit-a", c: 2, k: 0 }],
  ["the push names another camera's channel", {}, { p: "visit-a", c: 3, k: 7 }],
  ["the clip is in another camera's folder", {}, { file_path: "/media/mmcblk0p1/Camera03/visit-a.dat", k: 7 }],
  ["the clip is outside the camera folders", {}, { file_path: "/etc/passwd", k: 7 }],
] as const) test(`no clip is read when ${name}`, async context => {
  const f = await fixture(context, options);
  try {
    f.send(f.event("visit-a", clip ? { clip } : {})); await settle();
    await f.advance(600_000);
    assert.equal(f.reads.length, 0); assert.equal(f.starts.mock.callCount(), 0); assert.equal(f.lookups.mock.callCount(), 0);
    assert.equal(f.pictures.length, 1, "the retained push picture stays"); assert.equal(f.motions(), 1);
  } finally { await f.close(); }
});

test("a T8140-Z and an absolute clip path in the camera's own folder are admitted", async context => {
  const f = await fixture(context, { childModel: "T8140-Z" });
  try {
    f.send(f.event("visit-a", { clip: { file_path: "/media/mmcblk0p1/Camera02/visit-a.dat", cipher: 7 } })); await settle();
    await f.advance(20_000);
    assert.deepEqual(f.pictures, [CROP, FRAME]);
  } finally { await f.close(); }
});

test("an older clip finishing after a newer detection cannot replace its picture", async context => {
  const f = await fixture(context, { holdReads: true });
  try {
    f.send(f.event("visit-a")); await settle();
    await f.advance(20_000);
    assert.equal(f.reads[0]?.path, "/media/mmcblk0p1/Camera02/visit-a.dat");
    f.send(f.event("visit-b")); await settle();
    assert.equal(f.reads[0]!.signal.aborted, true);
    f.reads[0]!.release(); await settle();
    assert.deepEqual(f.pictures, [CROP, CROP], "the older frame is not published");
    assert.ok(f.reads[0]!.bytes.every(byte => byte === 0), "the older frame is cleared");
    await f.advance(20_000);
    assert.equal(f.reads[1]?.path, "/media/mmcblk0p1/Camera02/visit-b.dat", "the newer crop gets its own read");
    f.reads[1]!.release(); await settle();
    assert.deepEqual(f.pictures, [CROP, CROP, FRAME]);
    assert.equal(f.motions(), 2);
  } finally { await f.close(); }
});

test("a newer detection without a picture still invalidates an older clip", async context => {
  const f = await fixture(context, { holdReads: true });
  try {
    f.send(f.event("visit-a")); await settle();
    await f.advance(20_000);
    f.send(f.event("visit-b", { picture: false })); await settle();
    f.reads[0]!.release(); await settle();
    await f.advance(600_000);
    assert.deepEqual(f.pictures, [CROP]); assert.equal(f.reads.length, 1);
    assert.ok(f.reads[0]!.bytes.every(byte => byte === 0));
  } finally { await f.close(); }
});

test("a newer detection during the clip session's disconnect still wins", async context => {
  const f = await fixture(context, { holdDrain: true });
  try {
    f.send(f.event("visit-a")); await settle();
    await f.advance(20_000);
    assert.deepEqual(f.order, ["picture", "read", "close"], "the read has already passed its own ownership check");
    f.send(f.event("visit-b", { picture: false })); await settle();
    f.releaseDrain(); await settle();
    assert.deepEqual(f.pictures, [CROP], "ownership is checked again immediately before publishing");
    assert.ok(f.reads[0]!.bytes.every(byte => byte === 0));
  } finally { await f.close(); }
});

test("a newer detection during the wait stops the older job before any work", async context => {
  const f = await fixture(context);
  try {
    f.send(f.event("visit-a")); await settle();
    await f.advance(10_000);
    f.send(f.event("visit-b", { picture: false })); await settle();
    await f.advance(600_000);
    assert.equal(f.lookups.mock.callCount(), 0); assert.equal(f.starts.mock.callCount(), 0); assert.equal(f.reads.length, 0);
  } finally { await f.close(); }
});

test("a repeated delivery of one visit starts one job, using fields from its first delivery", async context => {
  const f = await fixture(context);
  try {
    f.send(f.event("visit-a", { picture: false })); f.send(f.event("visit-a", { clip: {} })); f.send(f.event("visit-a", { clip: {} })); await settle();
    await f.advance(20_000);
    assert.equal(f.reads.length, 1); assert.equal(f.reads[0]?.path, "/media/mmcblk0p1/Camera02/visit-a.dat");
    assert.deepEqual(f.pictures, [CROP, FRAME]); assert.equal(f.motions(), 1);
  } finally { await f.close(); }
});

for (const viewer of [CHILD, SIBLING]) test(`a viewer starting during the key lookup keeps the HomeBase: ${viewer}`, async context => {
  const f = await fixture(context, { holdLookup: true });
  try {
    f.send(f.event()); await settle();
    await f.advance(20_000);
    assert.equal(f.lookups.mock.callCount(), 1); assert.equal(f.starts.mock.callCount(), 0, "the lookup holds no peer");
    await f.provider.startStream(viewer);
    assert.equal(f.starts.mock.callCount(), 1);
    f.releaseLookup(); await settle();
    assert.equal(f.reads.length, 0, "the busy check follows the lookup");
    assert.equal(f.starts.mock.callCount(), 1, "no second session overlaps the viewer");
    assert.deepEqual(f.pictures, [CROP]);
    await f.provider.stopStream(viewer); await settle();
    await f.advance(40_000);
    assert.equal(f.reads.length, 1, "the next attempt reads once the viewer has left");
    assert.equal(f.lookups.mock.callCount(), 1, "the key is not fetched again");
    assert.deepEqual(f.pictures, [CROP, FRAME]);
  } finally { await f.close(); }
});

test("viewers cannot join the HomeBase while a clip is being read", async context => {
  const f = await fixture(context, { holdReads: true });
  try {
    f.send(f.event()); await settle();
    await f.advance(20_000);
    assert.equal(f.starts.mock.callCount(), 1);
    await assert.rejects(f.provider.startStream(SIBLING), /Wait for recording retrieval/);
    const waiting = f.provider.startStream(CHILD); await settle();
    assert.equal(f.starts.mock.callCount(), 1, "the same camera's viewer waits for the read");
    f.reads[0]!.release(); await waiting;
    assert.equal(f.starts.mock.callCount(), 2);
    assert.deepEqual(f.order.filter(step => step !== "picture"), ["read", "close", "drained"], "the viewer starts only after the disconnect");
  } finally { await f.close(); }
});

test("the HomeBase stays reserved until the clip session's disconnect has finished", async context => {
  const f = await fixture(context, { holdDrain: true });
  try {
    f.send(f.event()); await settle();
    await f.advance(20_000);
    assert.deepEqual(f.order, ["picture", "read", "close"]);
    assert.equal(f.drained.mock.callCount(), 1);
    await assert.rejects(f.provider.startStream(SIBLING), /Wait for recording retrieval/);
    const waiting = f.provider.startStream(CHILD); await settle();
    assert.equal(f.starts.mock.callCount(), 1, "no viewer session overlaps the disconnect");
    assert.deepEqual(f.pictures, [CROP], "the frame is published after the peer is released");
    f.releaseDrain(); await waiting;
    assert.equal(f.starts.mock.callCount(), 2);
    assert.deepEqual(f.pictures, [CROP, FRAME]);
    await f.provider.startStream(SIBLING).catch((error: Error) => assert.doesNotMatch(error.message, /Wait for recording retrieval/));
  } finally { await f.close(); }
});

test("two cameras on one HomeBase read their clips one at a time", async context => {
  const f = await fixture(context, { holdReads: true });
  try {
    f.send(f.event("visit-a")); f.send(f.event("visit-b", { serial: SIBLING })); await settle();
    assert.equal(f.pictures.length, 2);
    await f.advance(20_000);
    assert.equal(f.reads.length, 1);
    assert.equal(f.starts.mock.callCount(), 1);
    f.reads[0]!.release(); await settle();
    assert.equal(f.pictures.length, 3);
    await f.advance(40_000);
    assert.equal(f.reads.length, 2);
    assert.notEqual(f.reads[1]!.path, f.reads[0]!.path);
    f.reads[1]!.release(); await settle();
    assert.equal(f.pictures.length, 4);
  } finally { await f.close(); }
});

test("attempts continue while the clip is being written", async context => {
  const f = await fixture(context, { failReads: 1 });
  try {
    f.send(f.event()); await settle();
    await f.advance(20_000);
    assert.equal(f.reads.length, 1); assert.deepEqual(f.pictures, [CROP]);
    await f.advance(40_000);
    assert.equal(f.reads.length, 2); assert.deepEqual(f.pictures, [CROP, FRAME]);
    await f.advance(600_000);
    assert.equal(f.reads.length, 2);
  } finally { await f.close(); }
});

test("three failed attempts leave the crop in place", async context => {
  const f = await fixture(context, { failReads: 3 });
  try {
    f.send(f.event()); await settle();
    await f.advance(20_000); await f.advance(40_000); await f.advance(60_000);
    assert.equal(f.reads.length, 3);
    await f.advance(600_000);
    assert.equal(f.reads.length, 3); assert.deepEqual(f.pictures, [CROP]);
  } finally { await f.close(); }
});

test("a cipher row without an RSA key reads nothing", async context => {
  const f = await fixture(context, { cipherRow: { cipher_id: 7, ecc_private_key: "11".repeat(32) } });
  try {
    f.send(f.event()); await settle();
    await f.advance(20_000); await f.advance(40_000); await f.advance(60_000);
    assert.equal(f.reads.length, 0); assert.equal(f.starts.mock.callCount(), 0); assert.deepEqual(f.pictures, [CROP]);
  } finally { await f.close(); }
});

test("a changed camera binding found in fresh inventory stops the read", async context => {
  const f = await fixture(context);
  try {
    f.send(f.event()); await settle();
    f.changeBinding();
    await f.advance(20_000);
    assert.equal(f.reads.length, 0); assert.equal(f.starts.mock.callCount(), 0); assert.deepEqual(f.pictures, [CROP]);
  } finally { await f.close(); }
});

for (const mode of ["shutdown", "restart"] as const) test(`a late clip frame loses ownership after ${mode}`, async context => {
  const f = await fixture(context, { holdReads: true });
  try {
    f.send(f.event()); await settle();
    await f.advance(20_000);
    assert.equal(f.reads.length, 1);
    context.mock.timers.reset();
    const closing = mode === "shutdown" ? f.provider.close() : f.provider.start(f.events);
    await settle();
    assert.equal(f.reads[0]!.signal.aborted, true);
    f.reads[0]!.release(); await closing; await settle();
    assert.deepEqual(f.pictures, [CROP]);
    assert.ok(f.reads[0]!.bytes.every(byte => byte === 0));
  } finally { await f.close(); }
});
