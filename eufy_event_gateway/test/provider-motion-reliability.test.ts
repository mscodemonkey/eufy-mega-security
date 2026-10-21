/**
 * Checks motion connection ownership and fresh confirmation with offline peers.
 * The provider owns inventory and borrowed-stream selection. Tests replace
 * network/session effects and never actuate a camera or change an account.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";
import { CameraControlAcknowledgementTimeoutError, CameraMotionNotSentError, FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import type { ProviderEvents } from "../src/provider/provider.js";

/** Own a normalized camera, confirmed settings and all synthetic session effects. */
async function fixture(context: TestContext, standalone = false) {
  const directory = await mkdtemp(join(tmpdir(), "motion-reliability-"));
  let motion = true;
  const sessions: FirstPartyPpcsSession[] = [];
  const closes: FirstPartyPpcsSession[] = [];
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  const inventory = context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
    ...(!standalone ? [{ device_sn: "base", device_model: "T8010", device_type: 0,
      p2p_did: "synthetic-peer", p2p_conn: "synthetic-route", category: "eufy_security", member: { admin_user_id: "owner" } }] : []),
    { device_sn: "camera", device_model: standalone ? "T8171" : "T8113-Z", device_type: standalone ? 88 : 8,
      parent_sn: standalone ? "camera" : "base", device_channel: standalone ? 0 : 1,
      p2p_did: "synthetic-camera", p2p_conn: "synthetic-route", category: "eufy_security", member: { admin_user_id: "owner" },
      params: [{ param_type: standalone ? 6040 : 1011, param_value: motion ? "1" : "0" }] },
  ] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ base: { key: "synthetic", expiresAt: null }, camera: { key: "synthetic", expiresAt: null } }));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
  context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => undefined);
  context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [] }));
  context.mock.method(HomeBasePpcsSession.prototype, "close", () => undefined);
  const start = context.mock.method(FirstPartyPpcsSession.prototype, "start", async function (this: FirstPartyPpcsSession) {
    sessions.push(this); this.stats.camId = 1; this.stats.videoOutputFrames = 1;
  });
  context.mock.method(FirstPartyPpcsSession.prototype, "canBorrowMotionControl", function (this: FirstPartyPpcsSession) {
    return !standalone && this.stats.closeReason === "open" && this.stats.videoOutputFrames > 0;
  });
  context.mock.method(FirstPartyPpcsSession.prototype, "close", function (this: FirstPartyPpcsSession) {
    closes.push(this); this.stats.closeReason = "client_stop"; this.output.end();
  });
  const write = context.mock.method(FirstPartyPpcsSession.prototype, "writeMotionDetection", async (value: boolean) => { motion = value; });
  const schedule = globalThis.setTimeout;
  context.mock.method(globalThis, "setTimeout", (callback: () => void, milliseconds?: number) => schedule(callback, milliseconds === 2000 ? 0 : milliseconds));
  const provider = new EufyProvider({ username: "synthetic", password: "redacted", country: "AU", persistentDirectory: directory, maxStreamSeconds: 120 });
  const events = new Proxy({}, { get: () => () => undefined }) as ProviderEvents;
  await provider.start(events); await new Promise(resolve => setImmediate(resolve));
  return { provider, sessions, closes, start, write, inventory, setMotion: (value: boolean) => { motion = value; },
    dispose: async () => { await provider.close(); assert.equal(network.mock.callCount(), 0); await rm(directory, { recursive: true, force: true }); } };
}

test("motion borrows the exact decoded stream, confirms fresh state and never closes it", async context => {
  const f = await fixture(context);
  try {
    await f.provider.startStream("camera");
    const original = f.sessions[0]; const reads = f.inventory.mock.callCount();
    assert.equal((await f.provider.setCameraMotionDetection("camera", false)).motionDetectionEnabled, false);
    assert.equal(f.start.mock.callCount(), 1);
    assert.equal(f.write.mock.calls[0]!.this, original);
    assert.equal(f.closes.includes(original!), false);
    assert.ok(f.inventory.mock.callCount() > reads);
  } finally { await f.dispose(); }
});

for (const mode of ["unproven", "retired", "not-sent", "ack-lost", "closed-after-send", "hard-error", "busy", "readback-mismatch"]) {
  test(`motion connection and confirmation outcome: ${mode}`, async context => {
    const f = await fixture(context);
    try {
      await f.provider.startStream("camera");
      const active = f.sessions[0]!;
      if (mode === "unproven") active.stats.videoOutputFrames = 0;
      if (mode === "retired") active.stats.closeReason = "client_stop";
      context.mock.method(FirstPartyPpcsSession.prototype, "writeMotionDetection", async function (this: FirstPartyPpcsSession, value: boolean) {
        if (mode === "not-sent" && this === active) throw new CameraMotionNotSentError();
        if (mode === "hard-error") throw new Error("rejected");
        if (mode === "busy") throw new Error("Camera already has a control command in flight");
        if (mode !== "readback-mismatch") f.setMotion(value);
        if (mode === "closed-after-send") this.close();
        if (["ack-lost", "closed-after-send", "readback-mismatch"].includes(mode)) throw new CameraControlAcknowledgementTimeoutError();
      });
      if (["hard-error", "busy"].includes(mode)) await assert.rejects(f.provider.setCameraMotionDetection("camera", false), /rejected|already has/);
      else if (mode === "readback-mismatch") await assert.rejects(f.provider.setCameraMotionDetection("camera", false), /not confirmed/);
      else assert.equal((await f.provider.setCameraMotionDetection("camera", false)).motionDetectionEnabled, false);
      const owned = ["unproven", "retired", "not-sent"].includes(mode);
      assert.equal(f.start.mock.callCount(), owned ? 2 : 1);
      if (owned) assert.ok(f.closes.includes(f.sessions[1]!));
      if (mode !== "closed-after-send") assert.equal(f.closes.includes(active), false);
    } finally { await f.dispose(); }
  });
}

test("standalone motion retains its owned control connection", async context => {
  const f = await fixture(context, true);
  try {
    await f.provider.startStream("camera");
    assert.equal((await f.provider.setCameraMotionDetection("camera", false)).motionDetectionEnabled, false);
    assert.equal(f.start.mock.callCount(), 2);
    assert.ok(f.closes.includes(f.sessions[0]!));
    assert.ok(f.closes.includes(f.sessions[1]!));
  } finally { await f.dispose(); }
});

test("provider retirement prevents a no-send fallback from opening another connection", async context => {
  const f = await fixture(context);
  try {
    await f.provider.startStream("camera");
    context.mock.method(FirstPartyPpcsSession.prototype, "writeMotionDetection", async () => {
      await f.provider.close();
      throw new CameraMotionNotSentError();
    });
    await assert.rejects(f.provider.setCameraMotionDetection("camera", false), /cancelled/);
    assert.equal(f.start.mock.callCount(), 1);
  } finally { await f.dispose(); }
});
