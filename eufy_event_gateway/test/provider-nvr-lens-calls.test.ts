/**
 * Exercises native pane call admission through public provider methods.
 * Synthetic inventory and session mocks own all effects. The budget is the
 * gateway's own count; nothing here qualifies the NVR's real call limit.
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
import { NvrRtcSession } from "../src/stream/nvr-rtc-session.js";
import { NvrTrialError } from "../src/stream/nvr-protocol.js";
import { GatewayState } from "../src/domain/gateway-state.js";

type Options = { sensor?: unknown; camera: string; maximumLifetimeMilliseconds?: number | null; liveControls?: boolean; audio?: boolean };

/** Two S4s and one E41 behind one owned NVR, with every session recorded. */
async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "nvr-lens-calls-"));
  const owner = { admin_user_id: "synthetic-owner" };
  const raw = { devices: [
    { device_sn: "synthetic-nvr", device_model: "T8N00", device_type: 300, category: "eufy_security", member: owner },
    { device_sn: "synthetic-s4", parent_sn: "synthetic-nvr", device_channel: 9, device_model: "T8E00", device_type: 301, category: "eufy_security", member: owner },
    { device_sn: "synthetic-s4b", parent_sn: "synthetic-nvr", device_channel: 10, device_model: "T8E00", device_type: 301, category: "eufy_security", member: owner },
    { device_sn: "synthetic-e41", parent_sn: "synthetic-nvr", device_channel: 8, device_model: "T8416", device_type: 104, category: "eufy_security", member: owner },
  ] };
  const started: Options[] = [], closed: Options[] = [];
  let startFailure: Error | null = null;
  context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.getter(MegaClient.prototype, "isAuthenticated", () => true);
  context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (value: string) => value === "synthetic-owner");
  context.mock.method(MegaClient.prototype, "inventory", async () => raw);
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
  context.mock.method(globalThis, "setInterval", () => ({ unref() {} }) as NodeJS.Timeout);
  context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => ({ host: "security-smart-ie.eufylife.com", region: "IE", authToken: "synthetic", gtoken: "synthetic", sign: "synthetic" }));
  context.mock.method(NvrRtcSession.prototype, "start", async function (this: NvrRtcSession) {
    if (startFailure) throw startFailure;
    started.push((this as unknown as { options: Options }).options);
  });
  const hungUp = new Set<NvrRtcSession>();
  context.mock.method(NvrRtcSession.prototype, "close", async function (this: NvrRtcSession) {

    // The real close is idempotent; count each session's hang-up once.
    if (hungUp.has(this)) return;
    hungUp.add(this);
    closed.push((this as unknown as { options: Options }).options);
    this.output.end();
  });
  context.mock.method(NvrRtcSession.prototype, "initialLiveSettings", async () => ({ night: null, quality: null, tracking: null }));
  context.mock.method(NvrRtcSession.prototype, "readLiveSettings", async () => ({ night: null, quality: null, tracking: null }));
  const state = new GatewayState();
  const events = new Proxy({ camera: (value: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(value) },
    { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory,
    maxStreamSeconds: 120, normalNvrLive: true, experimentalNvrLive: true, experimentalModelControls: true,
    experimentalNvrControls: true, apiAuthenticationConfigured: true });
  let active = false;
  const recording = new Set<string>();

  // The stream manager never yields a recording view's call; here no view yields.
  provider.setNvrLiveMediaChecks({ viewer: () => true, recording: serial => recording.has(serial), active: () => active,
    yieldable: () => false, settling: () => false });
  await provider.start(events);
  context.after(async () => { await provider.close(); await rm(directory, { recursive: true, force: true }); });
  const sensors = (list: Options[]) => list.map(options => `${options.camera}:${String(options.sensor)}`);
  return { provider, state, started, closed, sensors, failStarts: (error: Error | null) => { startFailure = error; },
    setActive: (value: boolean) => { active = value; }, setRecording: (serial: string) => { recording.add(serial); } };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

test("the two lens calls and one ordinary view fit the call budget, each lens on its own native call", async context => {
  const value = await fixture(context);
  assert.equal(value.provider.nvrSharedLensViewsAdmitted("synthetic-s4"), true);
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  const movable = await value.provider.openNvrLensCall("synthetic-s4", "movable");
  await value.provider.startStream("synthetic-e41"); await settle();
  assert.deepEqual(value.sensors(value.started), ["synthetic-s4:0", "synthetic-s4:1", "synthetic-e41:0"]);
  const panes = value.started.slice(0, 2);
  assert.ok(panes.every(options => options.maximumLifetimeMilliseconds === null && options.liveControls === false && options.audio === false),
    "pane calls are viewer-owned, video-only and carry no controls");
  assert.equal(fixed.codec(), null, "the codec comes from checked video, never the model");
  await Promise.all([fixed.close(), movable.close(), value.provider.stopStream("synthetic-e41")]);
});

test("calls beyond the budget are refused before any call is placed", async context => {
  const value = await fixture(context);
  await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  await value.provider.openNvrLensCall("synthetic-s4", "movable");
  await value.provider.openNvrLensCall("synthetic-s4b", "fixed");
  const placed = value.started.length;
  await assert.rejects(value.provider.openNvrLensCall("synthetic-s4b", "movable"), (error: unknown) => error instanceof NvrTrialError && error.stage === "admission");
  await assert.rejects(value.provider.startStream("synthetic-e41"), (error: unknown) => error instanceof NvrTrialError && error.stage === "admission");
  await assert.rejects(value.provider.openNvrLensCall("synthetic-s4", "fixed"), (error: unknown) => error instanceof NvrTrialError && error.stage === "admission");
  assert.equal(value.started.length, placed, "a refusal never opens a call");
  assert.equal(value.closed.length, 0, "a refusal never touches the admitted calls");
});

test("an exclusive state read waits for the panes, and panes wait for an exclusive read", async context => {
  const value = await fixture(context);
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  await assert.rejects(value.provider.readNvrStateTrial("synthetic-e41", new AbortController().signal), (error: unknown) => error instanceof NvrTrialError && error.stage === "admission");
  await fixed.close();
  const release = value.provider.reserveNvrLiveTrial("synthetic-e41", new AbortController().signal);
  await assert.rejects(value.provider.openNvrLensCall("synthetic-s4", "fixed"), (error: unknown) => error instanceof NvrTrialError && error.stage === "admission");
  await release();
  await (await value.provider.openNvrLensCall("synthetic-s4", "fixed")).close();
});

test("the idle settings refresh runs beside open panes as the one ordinary call", async context => {
  const value = await fixture(context);
  context.mock.method(NvrRtcSession.prototype, "readLiveSettings", async () => ({ night: 1, quality: 0, tracking: null }));
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  const movable = await value.provider.openNvrLensCall("synthetic-s4", "movable");
  await value.provider.refreshCameraCapabilities("synthetic-s4");
  assert.equal(value.state.getCamera("synthetic-s4").nightVisionMode, 1);
  assert.equal(value.closed.length, 1, "the refresh hung up its own call and left both panes");
  assert.equal(value.sensors(value.started).length, 2, "the refresh started no video");
  await Promise.all([fixed.close(), movable.close()]);
});

test("panes open beside a recording view without touching its call, and a new view cannot take it", async context => {
  const value = await fixture(context);
  value.setRecording("synthetic-s4");
  await value.provider.startStream("synthetic-s4"); await settle();
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  const movable = await value.provider.openNvrLensCall("synthetic-s4", "movable");
  assert.equal(value.started.length, 3, "each pane placed its own call beside the recording view");
  assert.deepEqual(value.sensors(value.started.slice(1)), ["synthetic-s4:0", "synthetic-s4:1"]);
  await assert.rejects(value.provider.startStream("synthetic-e41"), (error: unknown) => error instanceof NvrTrialError && error.stage === "admission");
  assert.equal(value.started.length, 3, "the refused view placed no call");
  assert.equal(value.closed.length, 0, "the recording view and both panes kept their calls");
  await Promise.all([fixed.close(), movable.close()]);
  assert.equal(value.closed.length, 2, "closing the panes hung up only the panes");
  await value.provider.stopStream("synthetic-s4");
});

test("closing one pane leaves the other call running, and the view stays fixed while a pane is open", async context => {
  const value = await fixture(context);
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  const movable = await value.provider.openNvrLensCall("synthetic-s4", "movable");
  await fixed.close();
  assert.deepEqual(value.sensors(value.closed), ["synthetic-s4:0"]);
  assert.equal(movable.output.readableEnded || movable.output.destroyed, false);
  await assert.rejects(value.provider.setNvrView("synthetic-s4", 1), { code: "busy" });
  await movable.close();
  assert.deepEqual(value.sensors(value.closed), ["synthetic-s4:0", "synthetic-s4:1"]);
  await value.provider.setNvrView("synthetic-s4", 1);
  assert.equal(value.provider.nvrSharedLensViewsAdmitted("synthetic-s4"), false);
  await assert.rejects(value.provider.openNvrLensCall("synthetic-s4", "fixed"), (error: unknown) => error instanceof NvrTrialError && error.stage === "admission");
});

for (const exit of ["close", "start_failure", "call_lost", "shutdown"] as const) {
  test(`a pane call is hung up and released on ${exit}`, async context => {
    const value = await fixture(context);
    if (exit === "start_failure") {
      value.failStarts(new NvrTrialError("video"));
      await assert.rejects(value.provider.openNvrLensCall("synthetic-s4", "fixed"), (error: unknown) => error instanceof NvrTrialError && error.stage === "video");
      value.failStarts(null);
    } else {
      const call = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
      if (exit === "close") { await call.close(); await call.close(); }
      if (exit === "call_lost") { call.output.destroy(new NvrTrialError("video")); await settle(); }
      if (exit === "shutdown") { await value.provider.close(); assert.equal(value.closed.length, 1); return; }
    }
    await settle();
    assert.equal(value.closed.length, 1, "exactly one hang-up");

    // The reservation is gone: the same lens and an exclusive lease are both admitted again.
    const again = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
    await again.close();
    const release = value.provider.reserveNvrLiveTrial("synthetic-e41", new AbortController().signal);
    await release();
  });
}
