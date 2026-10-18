/**
 * Exercises general RTC admission and parent exclusivity through public provider
 * methods. Fixtures own synthetic inventory and mock all account/network owners.
 * No settings command, login, key exchange or physical camera is contacted.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { GeneralRtcError, type GeneralRtcStage } from "../src/stream/general-rtc-protocol.js";
import { E30LockError } from "../src/provider/e30-lock-protocol.js";
import { E30LockProvider } from "../src/provider/e30-lock-provider.js";

/** Start one offline parent with two admitted camera children. */
async function fixture(context: TestContext, mode = "valid") {
  const directory = await mkdtemp(join(tmpdir(), "general-provider-"));
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.getter(MegaClient.prototype, "isAuthenticated", () => mode !== "unauthenticated");
  context.mock.method(MegaClient.prototype, "generalRtcHasNativeIdentities", () => mode !== "native-identity");
  context.mock.method(MegaClient.prototype, "generalRtcAccount", () => mode === "unauthenticated" ? null : ({
    userId: "synthetic-owner", country: mode === "country" ? "bad" : "AU", token: mode === "token" ? "bad token" : "synthetic-token",
    securityHost: "security-app-ie.eufylife.com", smartHost: mode === "host" ? null : "security-smart-ie.eufylife.com",
    cipher: mode === "cipher" ? null : { bindingKey: "synthetic", encrypt: (s: string) => s, decrypt: (s: string) => s },
  }));
  const inventory = context.mock.method(MegaClient.prototype, "inventory", async () => ({ groups: [], devices: [
    { device_sn: "synthetic-parent", device_model: mode === "nvr" ? "T9000" : "T8030", device_type: mode === "nvr" ? 27 : 18,
      category: "eufy_security", member: { admin_user_id: "synthetic-owner" } },
    ...["synthetic-one", "synthetic-two"].map((serial, index) => ({ device_sn: serial, device_model: mode === "doorbell" ? "T8224" : "T8171",
      device_type: mode === "doorbell" ? 96 : 88, category: "eufy_security", parent_sn: "synthetic-parent", device_channel: index + 3,
      member: { admin_user_id: mode === "guest" ? "other-owner" : "synthetic-owner" } })),
  ] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
  const state = new GatewayState();
  const events = new Proxy({ camera: (camera: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(camera) },
    { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory,
    maxStreamSeconds: 120, experimentalGeneralRtc: mode !== "disabled", apiAuthenticationConfigured: mode !== "no-api",
    experimentalE30Locks: mode === "lock-in-flight" });
  await provider.start(events); inventory.mock.resetCalls();
  context.after(async () => { await provider.close(); state.close(); assert.equal(network.mock.callCount(), 0); await rm(directory, { recursive: true, force: true }); });
  return { provider, state, inventory };
}

for (const mode of ["disabled", "no-api", "unauthenticated", "native-identity", "guest", "host", "country", "token", "nvr", "doorbell", "cipher"]) {
  test(`general admission refuses ${mode} synchronously without cloud reads`, async context => {
    const f = await fixture(context, mode);
    assert.throws(() => f.provider.reserveGeneralRtcTrial("synthetic-one", new AbortController().signal), (error: unknown) =>
      error instanceof GeneralRtcError && error.stage === (mode === "cipher" ? "reconnect_required" : "admission"));
    assert.equal(f.inventory.mock.callCount(), 0);
  });
}

test("same-parent trials, streams, controls and lock operations refuse while a lease is held", async context => {
  const f = await fixture(context); const before = f.state.getCamera("synthetic-one").streamSupported;
  const first = f.provider.reserveGeneralRtcTrial("synthetic-one", new AbortController().signal);
  assert.throws(() => f.provider.reserveGeneralRtcTrial("synthetic-two", new AbortController().signal),
    (error: unknown) => error instanceof GeneralRtcError && error.stage === "busy");
  await assert.rejects(f.provider.startStream("synthetic-two"));
  const controls = [() => f.provider.setCameraEnabled("synthetic-two", true), () => f.provider.setCameraMotionDetection("synthetic-two", true),
    () => f.provider.setCameraAudioRecording("synthetic-two", true), () => f.provider.setCameraStreamingQuality("synthetic-two", 0),
    () => f.provider.refreshCameraCapabilities("synthetic-two"), () => f.provider.setCameraGuardMode("synthetic-two", 1),
    () => f.provider.setCameraNightVision("synthetic-two", 0), () => f.provider.setCameraLight("synthetic-two", true),
    () => f.provider.setCameraSiren("synthetic-two", 5), () => f.provider.setCameraEnabled("synthetic-two", false),
    () => f.provider.setGuardMode("synthetic-parent", 1), () => f.provider.setAlarmVolume("synthetic-parent", 1)];
  for (const operation of controls) await assert.rejects(async () => operation());
  await assert.rejects(f.provider.refreshLock("synthetic-two"), (error: unknown) => error instanceof E30LockError && error.code === "busy");
  await assert.rejects(f.provider.setLockState("synthetic-two", true), (error: unknown) => error instanceof E30LockError && error.code === "busy");
  assert.equal(f.inventory.mock.callCount(), 0);
  await first.release();
  const second = f.provider.reserveGeneralRtcTrial("synthetic-two", new AbortController().signal);
  await first.release();
  assert.throws(() => f.provider.reserveGeneralRtcTrial("synthetic-one", new AbortController().signal), GeneralRtcError);
  await second.release();
  assert.equal(f.state.getCamera("synthetic-one").streamSupported, before);
});

const operations: readonly [string, (provider: EufyProvider) => Promise<unknown>][] = [
  ["enabled", p => p.setCameraEnabled("synthetic-two", true)], ["motion", p => p.setCameraMotionDetection("synthetic-two", true)],
  ["audio", p => p.setCameraAudioRecording("synthetic-two", true)], ["quality", p => p.setCameraStreamingQuality("synthetic-two", 0)],
  ["capabilities", p => p.refreshCameraCapabilities("synthetic-two")], ["guard", p => p.setCameraGuardMode("synthetic-two", 1)],
  ["night", p => p.setCameraNightVision("synthetic-two", 0)], ["light", p => p.setCameraLight("synthetic-two", true)],
  ["siren", p => p.setCameraSiren("synthetic-two", 5)],
];
for (const [name, start] of operations) test(`an already queued ${name} operation refuses a same-parent general trial`, async context => {
  const f = await fixture(context);
  const pending = start(f.provider); void pending.catch(() => undefined);
  assert.throws(() => f.provider.reserveGeneralRtcTrial("synthetic-one", new AbortController().signal),
    (error: unknown) => error instanceof GeneralRtcError && error.stage === "busy");
  await pending.catch(() => undefined);
  const lease = f.provider.reserveGeneralRtcTrial("synthetic-one", new AbortController().signal); await lease.release();
});

test("provider shutdown retires general leases before cancelling the client request lifetime", async context => {
  const f = await fixture(context); const lease = f.provider.reserveGeneralRtcTrial("synthetic-one", new AbortController().signal);
  const order: string[] = [], release = lease.release.bind(lease), cancel = MegaClient.prototype.cancelPendingRequests;
  context.mock.method(lease, "release", async (stage?: GeneralRtcStage) => { order.push("release"); return release(stage); });
  context.mock.method(MegaClient.prototype, "cancelPendingRequests", function(this: MegaClient) { order.push("cancel"); cancel.call(this); });
  await f.provider.close(); assert.deepEqual(order.slice(0, 2), ["release", "cancel"]);
  await assert.rejects(lease.prepare("1234"), (error: unknown) => error instanceof GeneralRtcError && error.stage === "shutdown");
});

test("pending lock work blocks a parent trial until every overlapping operation settles", async context => {
  const f = await fixture(context, "lock-in-flight");
  const releases: (() => void)[] = [];
  context.mock.method(E30LockProvider.prototype, "refresh", async () => await new Promise<never>((_resolve, reject) => {
    releases.push(() => reject(new E30LockError("unavailable")));
  }));
  const first = f.provider.refreshLock("synthetic-two").catch(() => undefined);
  const second = f.provider.refreshLock("synthetic-two").catch(() => undefined);
  assert.throws(() => f.provider.reserveGeneralRtcTrial("synthetic-one", new AbortController().signal), GeneralRtcError);
  releases[0]!(); await first;
  assert.throws(() => f.provider.reserveGeneralRtcTrial("synthetic-one", new AbortController().signal), GeneralRtcError);
  releases[1]!(); await second;
  const lease = f.provider.reserveGeneralRtcTrial("synthetic-one", new AbortController().signal); await lease.release();
});
