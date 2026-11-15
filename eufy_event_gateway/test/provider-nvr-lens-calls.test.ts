/**
 * Exercises native pane call admission through public provider methods.
 * Synthetic inventory and session mocks own all effects. The budget is the
 * gateway's own count; nothing here qualifies the NVR's real call limit.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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
  const started: Options[] = [], closed: Options[] = [], parkedLog: string[] = [], switched: string[] = [];
  let startFailure: Error | null = null, parkFailure: Error | null = null;

  // Each mocked call delivers video once started, and can be parked and switched like a real one.
  const label = new Map<NvrRtcSession, string>(), outputs = new Map<NvrRtcSession, PassThrough>();
  const live = new Set<NvrRtcSession>(), parked = new Set<NvrRtcSession>();
  const fresh = (session: NvrRtcSession): PassThrough => {
    const output = new PassThrough(); output.on("error", () => {}); outputs.set(session, output); return output;
  };
  const optionsOf = (session: NvrRtcSession): Options => (session as unknown as { options: Options }).options;
  context.mock.getter(NvrRtcSession.prototype, "output", function (this: NvrRtcSession) { return outputs.get(this) ?? fresh(this); });
  context.mock.getter(NvrRtcSession.prototype, "switchable", function (this: NvrRtcSession) { return live.has(this); });
  context.mock.getter(NvrRtcSession.prototype, "idle", function (this: NvrRtcSession) { return parked.has(this); });
  const ownerless = new Set<NvrRtcSession>();
  context.mock.method(NvrRtcSession.prototype, "park", async function (this: NvrRtcSession, owner: { signal: AbortSignal }) {
    if (parkFailure) throw parkFailure;
    parkedLog.push(label.get(this)!); live.delete(this); parked.add(this);
    const old = outputs.get(this), output = fresh(this);

    // The real park moves the call off the viewer's signal at once. A mock can't
    // remove that listener, so here the viewer's cancellation is ignored instead.
    const destroy = output.destroy.bind(output);
    output.destroy = ((error?: Error) => {
      if (error instanceof NvrTrialError && error.stage === "cancelled" && parked.has(this) && !owner.signal.aborted) { ownerless.add(this); return output; }
      return destroy(error);
    }) as typeof output.destroy;
    old?.end();
  });
  context.mock.method(NvrRtcSession.prototype, "switchCamera", async function (this: NvrRtcSession, target: Options) {
    label.set(this, `${target.camera}:${String(target.sensor)}`); switched.push(label.get(this)!);
    parked.delete(this); live.add(this);
    const old = outputs.get(this); fresh(this); old?.end();
    return 100;
  });
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
    started.push(optionsOf(this)); label.set(this, `${optionsOf(this).camera}:${String(optionsOf(this).sensor)}`); live.add(this);
  });
  const hungUp = new Set<NvrRtcSession>(), hungUpLabels: string[] = [];
  context.mock.method(NvrRtcSession.prototype, "close", async function (this: NvrRtcSession) {

    // The real close is idempotent; count each session's hang-up once.
    if (ownerless.delete(this) || hungUp.has(this)) return;
    hungUp.add(this); live.delete(this); parked.delete(this);
    closed.push(optionsOf(this)); hungUpLabels.push(label.get(this) ?? "unstarted");
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
  return { provider, state, started, closed, sensors, parkedLog, switched, hungUpLabels,
    failParks: (error: Error | null) => { parkFailure = error; }, failStarts: (error: Error | null) => { startFailure = error; },
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

test("the settings refresh waits for the panes, because a call of its own would hang up beside them", async context => {
  const value = await fixture(context);
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  const movable = await value.provider.openNvrLensCall("synthetic-s4", "movable");
  await assert.rejects(value.provider.refreshCameraCapabilities("synthetic-s4"), { code: "busy" });
  assert.equal(value.started.length, 2, "the refresh placed no call");
  assert.equal(value.closed.length, 0, "and touched neither pane");
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
  assert.equal(value.closed.length, 0, "the panes parked their calls beside the recording view");
  assert.deepEqual(value.parkedLog.sort(), ["synthetic-s4:0", "synthetic-s4:1"]);
  await value.provider.stopStream("synthetic-s4"); await settle();
  assert.equal(value.closed.length, 3, "the last call in use hung up with both parked calls");
});

test("closing one pane parks its call while the other runs, and the view stays fixed while a pane is open", async context => {
  const value = await fixture(context);
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  const movable = await value.provider.openNvrLensCall("synthetic-s4", "movable");
  await fixed.close();
  assert.deepEqual(value.parkedLog, ["synthetic-s4:0"], "a hang-up would end the Movable call too, so Fixed's call is parked");
  assert.deepEqual(value.closed, []);
  assert.equal(movable.output.readableEnded || movable.output.destroyed, false);
  await assert.rejects(value.provider.setNvrView("synthetic-s4", 1), { code: "busy" });
  await movable.close(); await settle();
  assert.deepEqual(value.hungUpLabels.sort(), ["synthetic-s4:0", "synthetic-s4:1"], "the last call hung up with the parked one");
  await value.provider.setNvrView("synthetic-s4", 1);
  assert.equal(value.provider.nvrSharedLensViewsAdmitted("synthetic-s4"), false);
  await assert.rejects(value.provider.openNvrLensCall("synthetic-s4", "fixed"), (error: unknown) => error instanceof NvrTrialError && error.stage === "admission");
});

test("a pane or view opened beside a parked call takes it over instead of placing a call", async context => {
  const value = await fixture(context);
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  const movable = await value.provider.openNvrLensCall("synthetic-s4", "movable");
  await fixed.close();
  const again = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  assert.equal(value.started.length, 2, "the reopened pane placed no call");
  assert.deepEqual(value.switched, ["synthetic-s4:0"], "it switched the parked call to its lens");
  await value.provider.startStream("synthetic-e41"); await settle();
  assert.equal(value.started.length, 3, "with nothing parked, a view places the third call");
  await value.provider.stopStream("synthetic-e41"); await settle();
  assert.equal(value.parkedLog.length, 2, "the view parked its call beside the panes");
  await value.provider.startStream("synthetic-e41"); await settle();
  assert.equal(value.started.length, 3, "and took it back without a new call");
  assert.deepEqual(value.switched, ["synthetic-s4:0", "synthetic-e41:0"]);
  assert.equal(value.closed.length, 0, "no call was hung up while others were in use");
  await Promise.all([again.close(), movable.close(), value.provider.stopStream("synthetic-e41")]); await settle();
  assert.equal(value.closed.length, 3, "the last call in use hung up every call together");
});

test("the budget counts parked calls, and a new call reuses one before anything is refused", async context => {
  const value = await fixture(context);
  await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  await value.provider.openNvrLensCall("synthetic-s4", "movable");
  await value.provider.startStream("synthetic-e41"); await settle();
  await value.provider.stopStream("synthetic-e41"); await settle();
  const other = await value.provider.openNvrLensCall("synthetic-s4b", "fixed");
  assert.equal(value.started.length, 3, "the second S4's pane reused the parked call");
  assert.deepEqual(value.switched, ["synthetic-s4b:0"]);
  await assert.rejects(value.provider.openNvrLensCall("synthetic-s4b", "movable"), (error: unknown) => error instanceof NvrTrialError && error.stage === "admission");
  assert.equal(value.started.length, 3, "three calls in use: the next is refused before any call");
  await other.close();
});

test("a call that cannot be parked is hung up as before", async context => {
  const value = await fixture(context);
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  const movable = await value.provider.openNvrLensCall("synthetic-s4", "movable");
  value.failParks(new NvrTrialError("stop"));
  await fixed.close(); await settle();
  assert.deepEqual(value.hungUpLabels, ["synthetic-s4:0"]);
  assert.equal(movable.output.readableEnded || movable.output.destroyed, false);
  value.failParks(null);
  await movable.close();
});

test("shutdown hangs up parked calls with the rest", async context => {
  const value = await fixture(context);
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  await value.provider.openNvrLensCall("synthetic-s4", "movable");
  await fixed.close();
  assert.equal(value.closed.length, 0);
  await value.provider.close();
  assert.equal(value.closed.length, 2);
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
