/** Synthetic HomeBase fixtures never contact or move a real camera. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import type { CameraIdentity } from "../src/domain/types.js";
import type { PanControlTransport } from "../src/stream/pan-controllable.js";
import { T8410 } from "../src/stream/t8410-pan.js";
import type { PanExecutionPolicy } from "../src/stream/pan-controllable.js";

function executionPolicy(context: TestContext, changes: Partial<PanExecutionPolicy>): void {
  const original = Object.getOwnPropertyDescriptor(T8410, "execution")!;
  Object.defineProperty(T8410, "execution", { ...original, value: { ...T8410.execution, ...changes } });
  context.after(() => { Object.defineProperty(T8410, "execution", original); });
}

function receipt(channel = 2, result = 0) {
  const header = Buffer.alloc(16); header.writeUInt16LE(1700, 4); header[12] = channel; header[14] = 1;
  const payload = Buffer.alloc(132, 0xa5); payload.writeInt32LE(result);
  return { header, payload };
}

for (const [direction, rotate] of [["left", 1], ["right", 2], ["up", 3], ["down", 4]] as const) {
  test(`HomeBase T8410 ${direction} sends exactly one child-scoped command`, async () => {
    const calls: unknown[] = [];
    const controller: T8410 = new T8410({ isConnected: () => true, decodeResult: () => { throw Error("T8410 uses its clear receipt layout"); }, sendJson: async (command, value, channel, current) => {
      current(); calls.push({ command, value: JSON.parse(value), channel });
      const r = receipt(); assert.equal(controller.handleFrame(r.header, r.payload, 0), true);
    } }, 2);
    await controller.pan(direction, () => {});
    assert.equal(calls.length, 1);
    const row = calls[0] as { command: number; channel: number; value: { commandType: number; data: Record<string, unknown> } };
    assert.equal(row.command, 1700); assert.equal(row.channel, 2); assert.equal(row.value.commandType, 6030);
    assert.equal(row.value.data.rotate_type, rotate); assert.equal(row.value.data.cmd_type, 1);
    assert.match(String(row.value.data.transaction), /^\d{13}$/);
    controller.close();
  });
}

test("HomeBase T8410 ignores unrelated replies and rejects a nonzero result without replay", async () => {
  let sends = 0;
  const controller: T8410 = new T8410({ isConnected: () => true, decodeResult: () => null, sendJson: async (_command, _value, _channel, current) => {
    current(); sends++;
    const r = receipt(2, -1);
    for (const [offset, value] of [[4, 0], [12, 1], [13, 1], [14, 0], [15, 1]]) {
      const bad = Buffer.from(r.header); bad[offset!] = value!;
      assert.equal(controller.handleFrame(bad, r.payload, 0), false);
    }
    assert.equal(controller.handleFrame(r.header, r.payload, 2), false);
    for (const length of [0, 4, 15, 17]) {
      assert.equal(controller.handleFrame(Buffer.alloc(length), r.payload, 0), false);
    }
    for (const length of [0, 3, 8, 131, 133]) {
      assert.equal(controller.handleFrame(r.header, Buffer.alloc(length), 0), false);
    }
    assert.equal(controller.handleFrame(r.header, r.payload, 0), true);
  } }, 2);
  await assert.rejects(controller.pan("left", () => {}), /rejected/);
  assert.equal(sends, 1); controller.close();
});

test("movement receipts are ignored before dispatch and after closure", async () => {
  const r = receipt();
  const controller = new T8410({ isConnected: () => true, decodeResult: () => null, sendJson: async () => {} }, 2);
  assert.equal(controller.handleFrame(r.header, r.payload, 0), false);
  controller.close();
  assert.equal(controller.handleFrame(r.header, r.payload, 0), false);
});

test("closing during negotiation prevents dispatch and overlapping movements", async () => {
  let release!: () => void, sends = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controller: T8410 = new T8410({ isConnected: () => true, decodeResult: () => null, sendJson: async (_command, _value, _channel, current) => {
    await gate; current(); sends++;
  } }, 2);
  const first = assert.rejects(controller.pan("left", () => {}), /retired/);
  await assert.rejects(controller.pan("right", () => {}), /unavailable/);
  controller.close(); release(); await first; assert.equal(sends, 0);
});

test("lost movement receipts time out without replay", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let sends = 0;
  const controller: T8410 = new T8410({ isConnected: () => true, decodeResult: () => null, sendJson: async (_command, _value, _channel, current) => { current(); sends++; } }, 2);
  const pending = assert.rejects(controller.pan("left", () => {}), /acknowledgement timed out/);
  context.mock.timers.tick(10_000); await pending; assert.equal(sends, 1); controller.close();
});

async function fixture(context: TestContext, mode = "ready") {
  const owner = "synthetic-owner";
  const cameras = new Map<string, CameraIdentity>(), sessions: FirstPartyPpcsSession[] = [];
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.getter(MegaClient.prototype, "isAuthenticated", () => mode !== "signed-out");
  context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (id: string) => mode !== "guest" && id === "synthetic-owner");
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
    { device_sn: "base", device_model: mode === "hb2" ? "T8001" : "T8030", device_type: 18, category: "eufy_security",
      p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic", member: { admin_user_id: owner } },
    ...["camera", "other"].map((serial, index) => ({ device_sn: serial, device_model: mode === "model" ? "T8413" : "T8410",
      device_type: mode === "type" ? 30 : 31, category: "eufy_security", parent_sn: mode === "standalone" ? serial : "base",
      device_channel: mode === "channel" ? 255 : index + 2, p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic",
      member: { admin_user_id: owner }, params: [] })),
  ] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => mode === "no-dsk" ? {} : ({
    base: { key: "synthetic", expiresAt: null }, camera: { key: "synthetic", expiresAt: null }, other: { key: "synthetic", expiresAt: null },
  }));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
  context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => {});
  context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [] }));
  context.mock.method(FirstPartyPpcsSession.prototype, "readCameraInfo", async () => []);
  context.mock.method(FirstPartyPpcsSession.prototype, "hasHomeBaseViewerBinding", function(this: FirstPartyPpcsSession, binding: Parameters<FirstPartyPpcsSession["hasHomeBaseViewerBinding"]>[0]) {
    return binding.stationSerial === "base" && this.stats.closeReason === "open" && this.stats.videoOutputFrames > 0;
  });
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async function(this: FirstPartyPpcsSession) {
    sessions.push(this); this.stats.camId = 1; this.stats.videoOutputFrames = 1;
  });
  const closes = context.mock.method(FirstPartyPpcsSession.prototype, "close", function(this: FirstPartyPpcsSession) {
    this.stats.closeReason = "client_stop"; this.output.end();
  });
  context.mock.method(FirstPartyPpcsSession.prototype, "waitUntilClosed", async () => {});
  const provider = new EufyProvider({ username: "synthetic", password: "redacted", country: "US",
    persistentDirectory: "/nonexistent/synthetic", maxStreamSeconds: 120,
    experimentalModelControls: mode !== "disabled", apiAuthenticationConfigured: mode !== "no-auth" });
  context.after(async () => { await provider.close(); assert.equal(network.mock.callCount(), 0); });
  await provider.start(new Proxy({ camera: (camera: CameraIdentity) => cameras.set(camera.serial, camera) },
    { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents);
  return { provider, cameras, sessions, closes };
}

for (const mode of ["standalone", "model", "type", "channel", "hb2", "signed-out", "disabled", "no-auth", "no-dsk"]) {
  test(`HomeBase T8410 excludes ${mode}`, async context => {
    const f = await fixture(context, mode);
    assert.equal(f.cameras.get("camera")?.directionalPanControlSupported, false);
    await assert.rejects(f.provider.panCamera("camera", "left"), /unavailable/);
    assert.equal(f.sessions.length, 0);
  });
}

for (const mode of ["ready", "guest"]) test(`HomeBase T8410 ${mode} login uses the isolated trial and closes its control connection`, async context => {
  const f = await fixture(context, mode);
  context.mock.method(FirstPartyPpcsSession.prototype, "panCamera", async function(this: FirstPartyPpcsSession, ...[direction, current, create]: Parameters<FirstPartyPpcsSession["panCamera"]>) {
    const control = create({ isConnected: () => true, decodeResult: () => null, sendJson: async (_command: number, _value: string, channel: number, check: () => void) => {
      check(); assert.equal(channel, 2); const r = receipt(); control.handleFrame(r.header, r.payload, 0);
    } } as PanControlTransport);
    await control.pan(direction, current); control.close();
  });
  assert.equal(f.cameras.get("camera")?.directionalPanControlSupported, true);
  await f.provider.panCamera("camera", "left");
  assert.equal(f.sessions.length, 1); assert.equal(f.closes.mock.callCount(), 1);
});

for (const source of ["camera", "other"]) {
  test(`HomeBase T8410 borrows ${source} playback without replacing its connection`, async context => {
    const f = await fixture(context);
    await f.provider.startStream(source);
    const closed = f.closes.mock.callCount();
    const pan = context.mock.method(FirstPartyPpcsSession.prototype, "panCamera", async () => {});
    await f.provider.panCamera("camera", "left");
    assert.equal(pan.mock.callCount(), 1); assert.equal(f.sessions.length, 1);
    assert.equal(pan.mock.calls[0]!.arguments[3], 2);
    assert.equal(f.closes.mock.callCount(), closed); assert.equal(f.sessions[0]!.stats.closeReason, "open");
  });
}

test("the existing trial reservation rejects concurrent movement and viewer starts", async context => {
  const f = await fixture(context);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const pan = context.mock.method(FirstPartyPpcsSession.prototype, "panCamera", async () => { entered(); await held; });
  const movement = f.provider.panCamera("camera", "left"); await started;
  try {
    assert.throws(() => f.provider.panCamera("other", "right"), /trial/);
    assert.throws(() => f.provider.setCameraMotionDetection("other", true), /trial/);
    await assert.rejects(f.provider.startStream("other"), /Wait|trial|reserved/i);
    assert.equal(pan.mock.callCount(), 1); assert.equal(f.sessions.length, 1);
  } finally { release(); await movement; }
});

test("shutdown retires an isolated HomeBase movement and releases its reservation", async context => {
  const f = await fixture(context);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  context.mock.method(FirstPartyPpcsSession.prototype, "panCamera", async () => { entered(); await held; });
  const movement = f.provider.panCamera("camera", "left");
  const result = assert.rejects(movement, /changed|closed|retired/);
  await started; await f.provider.close(); release(); await result;
});

test("pan does not replace a sibling viewer that is still starting", async context => {
  const f = await fixture(context);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async function(this: FirstPartyPpcsSession) {
    f.sessions.push(this); entered(); await held;
  });
  const pan = context.mock.method(FirstPartyPpcsSession.prototype, "panCamera", async () => {});
  const opening = f.provider.startStream("other"); await started;
  try {
    assert.throws(() => f.provider.panCamera("camera", "left"), /Wait for camera/);
    assert.equal(pan.mock.callCount(), 0); assert.equal(f.closes.mock.callCount(), 0);
  } finally { release(); await opening; }
});


test("borrowed pan uses the existing peer reservation and releases it without closing playback", async context => {
  const f = await fixture(context, "guest"); await f.provider.startStream("other");
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered=resolve; });
  const held = new Promise<void>(resolve => { release=resolve; });
  const pan = context.mock.method(FirstPartyPpcsSession.prototype,"panCamera",async () => { entered(); await held; });
  const first = f.provider.panCamera("camera","left"); await started;
  try {
    assert.throws(() => f.provider.panCamera("camera","right"),/trial/);
    assert.throws(() => f.provider.setCameraMotionDetection("other",true),/trial/);
    await assert.rejects(f.provider.startStream("camera"),/Wait|trial|reserved/i);
    assert.equal(f.closes.mock.callCount(),0);
  } finally { release(); await first; }
  await f.provider.panCamera("camera","right");
  assert.equal(pan.mock.callCount(),2); assert.equal(f.sessions.length,1); assert.equal(f.closes.mock.callCount(),0);
});

test("unready viewer binding rejects movement without opening an isolated connection", async context => {
  const f = await fixture(context); await f.provider.startStream("other");
  context.mock.method(FirstPartyPpcsSession.prototype,"hasHomeBaseViewerBinding",() => false);
  const pan=context.mock.method(FirstPartyPpcsSession.prototype,"panCamera",async () => {});
  await assert.rejects(f.provider.panCamera("camera","left"),/viewer to become ready/);
  assert.equal(pan.mock.callCount(),0); assert.equal(f.sessions.length,1); assert.equal(f.closes.mock.callCount(),0);
});

test("an unready viewer does not hide a ready sibling viewer", async context => {
  const f = await fixture(context);
  await f.provider.startStream("camera");
  await f.provider.startStream("other");
  f.sessions[0]!.stats.videoOutputFrames = 0;
  let borrowed: FirstPartyPpcsSession | undefined;
  const pan = context.mock.method(FirstPartyPpcsSession.prototype, "panCamera", async function(this: FirstPartyPpcsSession) {
    borrowed = this;
  });
  await f.provider.panCamera("camera", "left");
  assert.equal(pan.mock.callCount(), 1);
  assert.equal(borrowed, f.sessions[1]);
  assert.equal(f.sessions.length, 2);
  assert.equal(f.closes.mock.callCount(), 0);
});

test("borrowed command failure releases the reservation without replay or viewer cleanup", async context => {
  const f=await fixture(context); await f.provider.startStream("other");
  const pan=context.mock.method(FirstPartyPpcsSession.prototype,"panCamera",async () => { throw Error("synthetic refusal"); });
  await assert.rejects(f.provider.panCamera("camera","left"),/synthetic refusal/);
  assert.equal(pan.mock.callCount(),1); assert.equal(f.sessions.length,1); assert.equal(f.closes.mock.callCount(),0);
  pan.mock.mockImplementation(async () => {});
  await f.provider.panCamera("camera","right"); assert.equal(pan.mock.callCount(),2);
});

test("a viewer retired during movement invalidates the command and releases peer ownership", async context => {
  const f=await fixture(context); await f.provider.startStream("other");
  let entered!: () => void, release!: () => void;
  const started=new Promise<void>(resolve => { entered=resolve; });
  const held=new Promise<void>(resolve => { release=resolve; });
  context.mock.method(FirstPartyPpcsSession.prototype,"panCamera",async () => { entered(); await held; });
  const first=f.provider.panCamera("camera","left"); const failed=assert.rejects(first,/changed|retired/);
  await started; await f.provider.stopStream("other"); release(); await failed;
  await f.provider.startStream("other"); await f.provider.panCamera("camera","right");
  assert.equal(f.sessions.length,2);
});

test("registered execution policy queues movements and refreshes inventory without a model-specific path", async context => {
  executionPolicy(context, { connection: "isolated", scheduling: "queued", refreshInventory: true });
  const f = await fixture(context);
  const inventory = MegaClient.prototype.inventory;
  let refreshes = 0;
  context.mock.method(MegaClient.prototype, "inventory", async function(this: MegaClient) {
    refreshes++;
    return inventory.call(this);
  });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  context.mock.method(FirstPartyPpcsSession.prototype, "panCamera", async (_direction: unknown, current: () => void) => {
    if (++calls === 1) { enter(); await held; }
    current();
  });
  const first = f.provider.panCamera("camera", "left");
  const second = f.provider.panCamera("camera", "right");
  const completed = Promise.all([first, second]);
  void completed.catch(() => {});
  try {
    await entered;
    assert.equal(calls, 1);
    await assert.rejects(f.provider.startStream("other"), /Wait|trial|reserved/i);
  } finally { release(); await completed; }
  assert.equal(calls, 2);
  assert.equal(refreshes, 2);
  assert.equal(f.closes.mock.callCount(), 2);
});

test("isolated device policy rejects an existing viewer without replacing it", async context => {
  executionPolicy(context, { connection: "isolated" });
  const f = await fixture(context);
  await f.provider.startStream("camera");
  const closed = f.closes.mock.callCount();
  const pan = context.mock.method(FirstPartyPpcsSession.prototype, "panCamera", async () => {});
  await assert.rejects(f.provider.panCamera("camera", "left"), /Close live view/);
  assert.equal(pan.mock.callCount(), 0);
  assert.equal(f.sessions.length, 1);
  assert.equal(f.closes.mock.callCount(), closed);
});

test("registered movement trials reject cancelled requests before opening a session", async context => {
  const f = await fixture(context);
  await assert.rejects(f.provider.performModelControlTrial("camera", { action: "ptz", direction: "left" }, AbortSignal.abort()), /retired/);
  assert.equal(f.sessions.length, 0);
});
