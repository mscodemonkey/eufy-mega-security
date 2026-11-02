/**
 * Qualifies the C37 tracking trial through real provider admission and readback.
 * Fixtures own cloud, timers and transport effects. No camera is contacted and
 * no passing fixture establishes physical tracking on this model.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EufyProvider, safeInventoryReads } from "../src/provider/eufy-provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";
import type { ModelControlTrial, ModelControlRoute } from "../src/provider/model-control-trials.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import type { CameraIdentity } from "../src/domain/types.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** Keep every external effect offline while exposing the actual published camera. */
async function fixture(context: TestContext, mode = "ready") {
  const directory = await mkdtemp(join(tmpdir(), "c37-tracking-"));
  let tracking = true, owner = "synthetic-owner", did = "TEST-12345678-TEST";
  const cameras = new Map<string, CameraIdentity>();
  const sessions: FirstPartyPpcsSession[] = [];
  const refreshes: (() => void)[] = [];
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.getter(MegaClient.prototype, "isAuthenticated", () => true);
  context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (value: string) => mode !== "guest" && value === "synthetic-owner");
  const inventory = context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
    ...(mode === "attached" ? [{ device_sn: "synthetic-base", device_model: "T8030", device_type: 18,
      category: "eufy_security", member: { admin_user_id: owner }, p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic" }] : []),
    { device_sn: "synthetic-camera", device_model: mode === "model" ? "T814XS" : "T814X",
      device_type: mode === "type" ? 10039 : 10037, category: "eufy_security",
      parent_sn: mode === "attached" ? "synthetic-base" : "synthetic-camera", device_channel: mode === "channel" ? 1 : 0,
      member: { admin_user_id: owner }, p2p_did: did, p2p_conn: "synthetic",
      params: mode === "missing-state" ? [] : [{ param_type: 6016, param_value: mode === "invalid-state" ? "2" : tracking ? "1" : "0" }] },
  ] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => mode === "route" ? {} : ({
    "synthetic-camera": { key: "synthetic", expiresAt: null }, "synthetic-base": { key: "synthetic", expiresAt: null },
  }));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
  context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => {});
  context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [] }));
  context.mock.method(globalThis, "setInterval", (callback: () => void) => {
    refreshes.push(callback); return { unref() {} } as unknown as NodeJS.Timeout;
  });
  const start = context.mock.method(FirstPartyPpcsSession.prototype, "start", async function(this: FirstPartyPpcsSession) {
    sessions.push(this); this.stats.camId = 1; this.stats.videoOutputFrames = 1;
  });
  const close = context.mock.method(FirstPartyPpcsSession.prototype, "close", function(this: FirstPartyPpcsSession) {
    this.stats.closeReason = "client_stop"; this.output.end();
  });
  const writes: boolean[] = [];
  context.mock.method(FirstPartyPpcsSession.prototype, "writeAiTracking", async () => { assert.fail("C37 must not use the C31 serializer"); });
  context.mock.method(FirstPartyPpcsSession.prototype, "writeModelControlTrial", async (request: ModelControlTrial, _route: ModelControlRoute, current?: () => void) => {
    current?.(); assert.equal(request.action, "aiTracking");
    if (request.action === "aiTracking") { writes.push(request.enabled); tracking = request.enabled; }
  });
  const query = context.mock.method(FirstPartyPpcsSession.prototype, "queryPresetPositions", async (current?: () => void) => {
    current?.(); return [{ index: 0, enabled: true, isDefault: true }, { index: 1, enabled: false, isDefault: false }];
  });
  const moves: number[] = [];
  const move = context.mock.method(FirstPartyPpcsSession.prototype, "selectPresetPosition", async (index: number, current?: () => void) => {
    current?.(); moves.push(index);
  });
  const events = new Proxy({ camera: (camera: CameraIdentity) => cameras.set(camera.serial, camera) },
    { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "synthetic", password: "redacted", country: "AU",
    persistentDirectory: directory, maxStreamSeconds: 120, experimentalModelControls: mode !== "disabled",
    apiAuthenticationConfigured: mode !== "no-api-auth" });
  await provider.start(events);
  return { provider, cameras, inventory, start, close, writes, sessions, query, move, moves,
    rebind: async (field = "owner") => {
      if (field === "owner") owner = "other-owner"; else did = "TEST-87654321-TEST";
      refreshes.at(-1)!(); await tick(); await tick();
    },
    dispose: async () => {
      await provider.close(); assert.equal(network.mock.callCount(), 0);
      await rm(directory, { recursive: true, force: true });
    } };
}

test("C37 tracking is opt-in and confirms a write through fresh inventory", async context => {
  const f = await fixture(context);
  try {
    assert.equal(f.cameras.get("synthetic-camera")?.aiTrackingControlSupported, true);
    assert.equal(f.cameras.get("synthetic-camera")?.aiTrackingEnabled, true);
    const reads = f.inventory.mock.callCount();
    await f.provider.setCameraAiTracking("synthetic-camera", false);
    assert.deepEqual(f.writes, [false]);
    assert.ok(f.inventory.mock.callCount() > reads);
    assert.equal(f.cameras.get("synthetic-camera")?.aiTrackingEnabled, false);
    assert.equal(f.start.mock.callCount(), 1);
    assert.equal(f.close.mock.callCount(), 1);
    await assert.rejects(f.provider.setCameraAutoCruise("synthetic-camera", true));
    assert.equal(f.start.mock.callCount(), 1);
  } finally { await f.dispose(); }
});

for (const mode of ["disabled", "no-api-auth", "guest", "type", "model", "attached", "channel", "route", "missing-state", "invalid-state"]) {
  test(`C37 tracking rejects before transport: ${mode}`, async context => {
    const f = await fixture(context, mode);
    try {
      assert.notEqual(f.cameras.get("synthetic-camera")?.aiTrackingControlSupported, true);
      if (mode !== "missing-state" && mode !== "invalid-state") assert.deepEqual(f.provider.modelControlTrials("synthetic-camera"), []);
      await assert.rejects(f.provider.setCameraAiTracking("synthetic-camera", false));
      if (mode !== "missing-state" && mode !== "invalid-state") {
        await assert.rejects(f.provider.getCameraPresetPositions("synthetic-camera"));
        await assert.rejects(f.provider.selectCameraPresetPosition("synthetic-camera", 0));
        assert.deepEqual(f.moves, []);
      }
      assert.deepEqual(f.writes, []);
      assert.equal(f.start.mock.callCount(), 0);
    } finally { await f.dispose(); }
  });
}

for (const field of ["owner", "peer"]) test(`C37 tracking rejects changed ${field} after connecting, before writing`, async context => {
  const f = await fixture(context);
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => { await f.rebind(field); });
  try {
    await assert.rejects(f.provider.setCameraAiTracking("synthetic-camera", false), /changed|retired/);
    assert.deepEqual(f.writes, []);
    assert.equal(f.close.mock.callCount(), 1);
  } finally { await f.dispose(); }
});

test("C37 tracking does not interrupt an existing camera viewer", async context => {
  const f = await fixture(context);
  try {
    await f.provider.startStream("synthetic-camera");
    await assert.rejects(f.provider.setCameraAiTracking("synthetic-camera", false), /live view/);
    assert.deepEqual(f.writes, []);
    assert.equal(f.close.mock.callCount(), 0);
  } finally { await f.dispose(); }
});

test("C37 tracking rejects an owner change in fresh readback", async context => {
  const f = await fixture(context);
  context.mock.method(FirstPartyPpcsSession.prototype, "writeModelControlTrial", async () => { await f.rebind(); });
  try {
    await assert.rejects(f.provider.setCameraAiTracking("synthetic-camera", false), /changed|retired/);
    assert.equal(f.close.mock.callCount(), 1);
  } finally { await f.dispose(); }
});

for (const afterWrite of [false, true]) test(`C37 read failure is safe and visible, afterWrite=${afterWrite}`, async context => {
  const f = await fixture(context);
  const logs: string[] = [];
  context.mock.method(process.stderr, "write", (value: unknown) => { logs.push(String(value)); return true; });
  const failRead = () => context.mock.method(MegaClient.prototype, "inventory", async () => {
    throw Error("synthetic-private-error-should-not-appear");
  });
  if (afterWrite) context.mock.method(FirstPartyPpcsSession.prototype, "writeModelControlTrial", async () => { failRead(); });
  else failRead();
  try {
    await assert.rejects(f.provider.setCameraAiTracking("synthetic-camera", false));
    assert.equal(f.cameras.get("synthetic-camera")?.aiTrackingEnabled, true);
    assert.equal(f.start.mock.callCount(), afterWrite ? 1 : 0);
    assert.ok(logs.some(line => line.includes("event=camera_c37_control_failed")
      && line.includes(`stage=${afterWrite ? "confirmation_read" : "initial_read"}`)));
    assert.ok(logs.every(line => !line.includes("synthetic-private-error-should-not-appear")));
  } finally { await f.dispose(); }
});

test("C37 rejected writes are not retried or published as successful", async context => {
  const f = await fixture(context);
  const write = context.mock.method(FirstPartyPpcsSession.prototype, "writeModelControlTrial", async () => { throw Error("rejected"); });
  try {
    await assert.rejects(f.provider.setCameraAiTracking("synthetic-camera", false), /rejected/);
    assert.equal(write.mock.callCount(), 1);
    assert.equal(f.close.mock.callCount(), 1);
    assert.equal(f.cameras.get("synthetic-camera")?.aiTrackingEnabled, true);
  } finally { await f.dispose(); }
});

test("C37 movement is an explicitly armed one-click trial without guessed position state", async context => {
  const f = await fixture(context, "missing-state");
  const requests: unknown[] = [];
  const read = context.mock.method(FirstPartyPpcsSession.prototype, "readCameraInfo", async () => []);
  context.mock.method(FirstPartyPpcsSession.prototype, "writeModelControlTrial", async (request: ModelControlTrial, _route: ModelControlRoute, current?: () => void) => {
    current?.(); requests.push(request);
  });
  try {
    assert.deepEqual(f.provider.modelControlTrials("synthetic-camera"), ["ptz", "spotlight", "aiTracking"]);
    const result = await f.provider.performModelControlTrial("synthetic-camera", { action: "ptz", direction: "left" });
    assert.equal(result.outcome, "acknowledged");
    assert.equal(result.physicalConfirmationRequired, true);
    assert.deepEqual(requests, [{ action: "ptz", direction: "left" }]);
    assert.equal(read.mock.callCount(), 0);
    assert.equal(f.close.mock.callCount(), 1);
  } finally { await f.dispose(); }
});

for (const available of ["manual", "master-only", "invalid"]) test(`C37 spotlight requires its own fresh manual setting: ${available}`, async context => {
  const f = await fixture(context);
  let light = false;
  const write = context.mock.method(FirstPartyPpcsSession.prototype, "writeModelControlTrial", async (request: ModelControlTrial, _route: ModelControlRoute, current?: () => void) => {
    current?.(); assert.equal(request.action, "spotlight");
    if (request.action === "spotlight") light = request.enabled;
  });
  const read = context.mock.method(FirstPartyPpcsSession.prototype, "readCameraInfo", async () => [
    { param_type: available === "master-only" ? 1403 : 1400, param_value: available === "invalid" ? "2" : light ? "1" : "0" },
  ]);
  try {
    const trial = f.provider.performModelControlTrial("synthetic-camera", { action: "spotlight", enabled: true });
    if (available === "manual") {
      const result = await trial;
      assert.equal(result.outcome, "confirmed");
      assert.equal(result.physicalConfirmationRequired, true);
      assert.equal(write.mock.callCount(), 1);
      assert.equal(read.mock.callCount(), 2);
    } else {
      await assert.rejects(trial, /fresh reported original/);
      assert.equal(write.mock.callCount(), 0);
    }
    assert.equal(f.close.mock.callCount(), 1);
  } finally { await f.dispose(); }
});

test("a cancelled C37 movement trial cannot dispatch", async context => {
  const f = await fixture(context);
  const write = context.mock.method(FirstPartyPpcsSession.prototype, "writeModelControlTrial", async () => { assert.fail("No write"); });
  try {
    await assert.rejects(f.provider.performModelControlTrial("synthetic-camera", { action: "ptz", direction: "up" }, AbortSignal.abort()));
    assert.equal(write.mock.callCount(), 0);
    assert.equal(f.start.mock.callCount(), 0);
  } finally { await f.dispose(); }
});

test("C37 reported settings use the exact direct model and manual light field", () => {
  const params = [{ param_type: 1400, param_value: "1" }, { param_type: 1403, param_value: "0" },
    { param_type: 6016, param_value: "1" }];
  const reads = safeInventoryReads(params, 10037, "T814X", true);
  assert.equal(reads.spotlightEnabled, true);
  assert.equal(reads.aiTrackingEnabled, true);
  for (const [model, type, direct] of [["T814X", 10039, true], ["T814XS", 10037, true], ["T814X", 10037, false]] as const) {
    const other = safeInventoryReads(params, type, model, direct);
    assert.equal(other.aiTrackingEnabled, undefined);
    assert.equal(other.spotlightEnabled, undefined);
  }
});

test("C37 saved positions are freshly queried and an empty slot cannot be selected", async context => {
  const f = await fixture(context, "missing-state");
  try {
    assert.equal(f.cameras.get("synthetic-camera")?.presetPositionControlSupported, true);
    assert.equal((await f.provider.getCameraPresetPositions("synthetic-camera")).length, 2);
    const reads = f.query.mock.callCount();
    await f.provider.selectCameraPresetPosition("synthetic-camera", 0);
    assert.equal(f.query.mock.callCount(), reads + 1);
    assert.deepEqual(f.moves, [0]);
    await assert.rejects(f.provider.selectCameraPresetPosition("synthetic-camera", 1), /not enabled/);
    assert.deepEqual(f.moves, [0]);
  } finally { await f.dispose(); }
});

test("C37 rejects an unrecognised preset reply without presenting an empty list", async context => {
  const f = await fixture(context);
  context.mock.method(FirstPartyPpcsSession.prototype, "queryPresetPositions", async () => { throw Error("unrecognised response"); });
  try {
    await assert.rejects(f.provider.getCameraPresetPositions("synthetic-camera"), /unrecognised/);
    assert.deepEqual(f.moves, []);
  } finally { await f.dispose(); }
});

test("C37 rejects preset movement when its owner changed during the query", async context => {
  const f = await fixture(context);
  context.mock.method(FirstPartyPpcsSession.prototype, "queryPresetPositions", async () => {
    await f.rebind(); return [{ index: 0, enabled: true, isDefault: true }];
  });
  try {
    await assert.rejects(f.provider.selectCameraPresetPosition("synthetic-camera", 0), /changed|retired/);
    assert.deepEqual(f.moves, []);
  } finally { await f.dispose(); }
});
