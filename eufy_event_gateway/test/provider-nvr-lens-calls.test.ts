/**
 * Exercises native pane and multi-view call admission through public provider
 * methods. Synthetic inventory and session mocks own all effects. The budget is
 * the gateway's own count; nothing here qualifies the NVR's real call limit.
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

type Options = { sensor?: unknown; cells?: unknown; camera: string; maximumLifetimeMilliseconds?: number | null; liveControls?: boolean; audio?: boolean };

/** A synthetic camera behind the NVR, on one channel. */
const child = (serial: string, channel: number, model: string, type: number) => ({ device_sn: serial, parent_sn: "synthetic-nvr",
  device_channel: channel, device_model: model, device_type: type, category: "eufy_security", member: { admin_user_id: "synthetic-owner" } });

/** Seven cameras on channels 0 to 6 and a doorbell on 7, beside the default S4s and E41 on 8 to 10. */
const allChannels = [0, 1, 2, 3, 4, 5, 6].map(channel => child(`synthetic-cam${channel}`, channel, "T8416", 104))
  .concat(child("synthetic-doorbell", 7, "T8214", 94));

/** Two S4s and one E41 behind one owned NVR, and any other cameras given, with every session recorded. */
async function fixture(context: TestContext, others: ReturnType<typeof child>[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "nvr-lens-calls-"));
  const owner = { admin_user_id: "synthetic-owner" };
  const raw = { devices: [
    { device_sn: "synthetic-nvr", device_model: "T8N00", device_type: 300, category: "eufy_security", member: owner },
    child("synthetic-s4", 9, "T8E00", 301), child("synthetic-s4b", 10, "T8E00", 301), child("synthetic-e41", 8, "T8416", 104), ...others,
  ] };
  const started: Options[] = [], closed: Options[] = [], parkedLog: string[] = [], switched: string[] = [];
  let startFailure: Error | null = null, parkFailure: Error | null = null;

  // Calls placed and hang-ups finished, in order. A held hang-up stays running until let go.
  const order: string[] = [];
  let hangUpHold: Promise<void> | null = null, letGoHangUps = (): void => {};

  // Each mocked call delivers video once started, and can be parked and switched like a real one.
  const label = new Map<NvrRtcSession, string>(), outputs = new Map<NvrRtcSession, PassThrough>();
  const live = new Set<NvrRtcSession>(), parked = new Set<NvrRtcSession>();
  const fresh = (session: NvrRtcSession): PassThrough => {
    const output = new PassThrough(); output.on("error", () => {}); outputs.set(session, output); return output;
  };
  const optionsOf = (session: NvrRtcSession): Options => (session as unknown as { options: Options }).options;
  const tag = (options: Options): string => `${options.camera}:${typeof options.sensor === "object" && options.sensor
    ? `stitch${(options.sensor as { mode: number }).mode}` : String(options.sensor)}`;
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
    label.set(this, tag(target)); switched.push(label.get(this)!);
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
    started.push(optionsOf(this)); label.set(this, tag(optionsOf(this))); live.add(this);
    order.push(`placed ${label.get(this)!}`);
  });
  const hungUp = new Set<NvrRtcSession>(), hungUpLabels: string[] = [];
  context.mock.method(NvrRtcSession.prototype, "close", async function (this: NvrRtcSession) {

    // The real close is idempotent; count each session's hang-up once.
    if (ownerless.delete(this) || hungUp.has(this)) return;
    hungUp.add(this); live.delete(this); parked.delete(this);
    closed.push(optionsOf(this)); hungUpLabels.push(label.get(this) ?? "unstarted");
    this.output.end();
    if (hangUpHold) await hangUpHold;
    order.push(`hung up ${label.get(this) ?? "unstarted"}`);
  });
  context.mock.method(NvrRtcSession.prototype, "initialLiveSettings", async () => ({ night: null, quality: null, tracking: null }));
  context.mock.method(NvrRtcSession.prototype, "readLiveSettings", async () => ({ night: null, quality: null, tracking: null }));
  const state = new GatewayState();
  const stations: Parameters<ProviderEvents["station"]>[0][] = [];
  const events = new Proxy({ camera: (value: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(value),
    station: (value: Parameters<ProviderEvents["station"]>[0]) => { stations.push(value); } },
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
  context.after(async () => { letGoHangUps(); await provider.close(); await rm(directory, { recursive: true, force: true }); });
  const sensors = (list: Options[]) => list.map(tag);
  const holdHangUps = (): (() => void) => {
    let letGo = (): void => {};
    hangUpHold = new Promise<void>(resolve => { letGo = resolve; });
    letGoHangUps = () => { hangUpHold = null; letGo(); };
    return letGoHangUps;
  };
  return { provider, state, stations, started, closed, sensors, parkedLog, switched, hungUpLabels, order, holdHangUps,
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

const admission = (error: unknown): boolean => error instanceof NvrTrialError && error.stage === "admission";

test("a new pane waits for the last pane's hang-up to finish before placing its call", async context => {
  const value = await fixture(context);
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  const letGo = value.holdHangUps();
  const closing = fixed.close(); await settle();
  assert.deepEqual(value.hungUpLabels, ["synthetic-s4:0"], "the last pane hangs up rather than parks");
  const opening = value.provider.openNvrLensCall("synthetic-s4", "movable");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(value.started.length, 1, "no call is placed while the NVR's last hang-up is running");
  letGo();
  await closing;
  const movable = await opening;
  assert.deepEqual(value.order, ["placed synthetic-s4:0", "hung up synthetic-s4:0", "placed synthetic-s4:1"]);
  await movable.close();
});

test("an ordinary view waits for the last pane's hang-up to finish before placing its call", async context => {
  const value = await fixture(context);
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  const letGo = value.holdHangUps();
  const closing = fixed.close(); await settle();
  const opening = value.provider.startStream("synthetic-e41");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(value.started.length, 1, "no call is placed while the NVR's last hang-up is running");
  letGo();
  await closing; await opening; await settle();
  assert.deepEqual(value.order, ["placed synthetic-s4:0", "hung up synthetic-s4:0", "placed synthetic-e41:0"]);
  await value.provider.stopStream("synthetic-e41");
});

test("a pane and an ordinary view wait for the last ordinary view's hang-up to finish", async context => {
  const value = await fixture(context);
  await value.provider.startStream("synthetic-e41"); await settle();
  const letGo = value.holdHangUps();
  const stopping = value.provider.stopStream("synthetic-e41"); await settle();
  assert.deepEqual(value.hungUpLabels, ["synthetic-e41:0"]);
  const pane = value.provider.openNvrLensCall("synthetic-s4", "fixed");
  const view = value.provider.startStream("synthetic-s4");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(value.started.length, 1, "no call is placed while the NVR's last hang-up is running");
  letGo();
  await stopping;
  const fixed = await pane; await view; await settle();
  assert.deepEqual(value.order.slice(0, 2), ["placed synthetic-e41:0", "hung up synthetic-e41:0"]);
  assert.deepEqual(value.order.slice(2).sort(), ["placed synthetic-s4:0", "placed synthetic-s4:both"], "the pane and the view each placed a call after it");
  await Promise.all([fixed.close(), value.provider.stopStream("synthetic-s4")]);
});

test("a pane and an ordinary view wait while the last view in use hangs up with the parked calls", async context => {
  const value = await fixture(context);
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  const movable = await value.provider.openNvrLensCall("synthetic-s4", "movable");
  await value.provider.startStream("synthetic-e41"); await settle();
  await Promise.all([fixed.close(), movable.close()]);
  assert.deepEqual(value.parkedLog.sort(), ["synthetic-s4:0", "synthetic-s4:1"], "both panes parked beside the view");
  const letGo = value.holdHangUps();
  const stopping = value.provider.stopStream("synthetic-e41"); await settle();
  assert.deepEqual(value.hungUpLabels.sort(), ["synthetic-e41:0", "synthetic-s4:0", "synthetic-s4:1"], "the last view hangs up with both parked calls");
  const pane = value.provider.openNvrLensCall("synthetic-s4b", "fixed");
  const view = value.provider.startStream("synthetic-s4");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(value.started.length, 3, "no call is placed while those hang-ups are running");
  assert.deepEqual(value.switched, [], "and none of the calls being hung up is reused");
  letGo();
  await stopping;
  const other = await pane; await view; await settle();
  assert.equal(value.order.slice(3, 6).every(step => step.startsWith("hung up ")), true, "all three hang-ups finished first");
  assert.deepEqual(value.order.slice(6).sort(), ["placed synthetic-s4:both", "placed synthetic-s4b:0"]);
  await Promise.all([other.close(), value.provider.stopStream("synthetic-s4")]);
});

test("a hang-up that outlasts the wait refuses a new pane or view before any call", async context => {
  const value = await fixture(context);
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  const letGo = value.holdHangUps();
  const closing = fixed.close(); await settle();
  const now = performance.now.bind(performance);
  let skip = 0;
  context.mock.method(performance, "now", () => now() + skip);
  const pane = assert.rejects(value.provider.openNvrLensCall("synthetic-s4", "movable"), admission);
  const view = assert.rejects(value.provider.startStream("synthetic-e41"), admission);
  await new Promise(resolve => setTimeout(resolve, 150));
  skip = 7_000;
  await pane; await view;
  assert.equal(value.started.length, 1, "neither placed a call");
  letGo(); await closing;
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

const multiView = { mode: 3, width: 3840, height: 2160 };

test("the multi-view is one 3x3 call at 3840x2160 of the first nine cameras the NVR can stitch, in channel order", async context => {
  const value = await fixture(context, allChannels);
  assert.equal(value.provider.nvrMultiViewAdmitted("synthetic-nvr"), true);
  const call = await value.provider.openNvrMultiViewCall("synthetic-nvr");
  assert.equal(value.started.length, 1, "one call for the whole grid");
  const options = value.started[0]!;
  const channels = [0, 1, 2, 3, 4, 5, 6, 8, 9];
  assert.deepEqual(options.sensor, { ...multiView, cells: channels.map(channel => ({ channel, sensor: 0 })) },
    "the doorbell on 7 is left out, the S4 on 9 shows its Fixed lens, and the tenth camera (the second S4) waits for PR 2's pages");
  assert.deepEqual(options.cells, channels.map(channel => {
    const serial = channel === 8 ? "synthetic-e41" : channel === 9 ? "synthetic-s4" : `synthetic-cam${channel}`;
    return { camera: serial, channel, cameraType: channel === 9 ? 301 : 104 };
  }), "each cell's camera is checked against the NVR's camera list");
  assert.equal(options.camera, "synthetic-cam0");
  assert.ok(options.maximumLifetimeMilliseconds === null && options.liveControls === false && options.audio === false,
    "viewer-owned, video only, no controls");
  await call.close();
  assert.equal(value.closed.length, 1);
});

test("the NVR's station state says whether it offers the multi-view", async context => {
  const value = await fixture(context, allChannels);
  const nvr = value.stations.filter(station => station.serial === "synthetic-nvr").at(-1);
  assert.equal(nvr?.nvrMultiViewSupported, true);
});

test("an NVR with fewer than two cameras it can stitch offers no multi-view, and asking places no call", async context => {
  const value = await fixture(context);
  assert.equal(value.provider.nvrMultiViewAdmitted("synthetic-nvr"), true, "two S4s and an E41 make a grid of three");
  assert.equal(value.provider.nvrMultiViewAdmitted("synthetic-s4"), false, "a camera has no multi-view");
  await assert.rejects(value.provider.openNvrMultiViewCall("synthetic-s4"), admission);
  assert.equal(value.started.length, 0);
});

test("the multi-view counts as one call: it fits beside both panes, and a view past the budget is refused before any call", async context => {
  const value = await fixture(context, allChannels);
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  const movable = await value.provider.openNvrLensCall("synthetic-s4", "movable");
  const grid = await value.provider.openNvrMultiViewCall("synthetic-nvr");
  assert.deepEqual(value.sensors(value.started), ["synthetic-s4:0", "synthetic-s4:1", "synthetic-cam0:stitch3"]);
  await assert.rejects(value.provider.startStream("synthetic-e41"), admission);
  await assert.rejects(value.provider.openNvrLensCall("synthetic-s4b", "fixed"), admission);
  await assert.rejects(value.provider.openNvrMultiViewCall("synthetic-nvr"), admission);
  assert.equal(value.started.length, 3, "nothing past the budget placed a call");
  assert.equal(value.closed.length, 0, "and nothing admitted was touched");
  await Promise.all([fixed.close(), movable.close(), grid.close()]);
});

test("beside both panes and a view, the multi-view is refused before any call, and takes nothing from them", async context => {
  const value = await fixture(context, allChannels);
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  const movable = await value.provider.openNvrLensCall("synthetic-s4", "movable");
  await value.provider.startStream("synthetic-e41"); await settle();
  await assert.rejects(value.provider.openNvrMultiViewCall("synthetic-nvr"), admission);
  assert.equal(value.started.length, 3);
  assert.equal(value.closed.length + value.parkedLog.length, 0, "no pane or view yielded");
  await Promise.all([fixed.close(), movable.close(), value.provider.stopStream("synthetic-e41")]);
});

test("closing the multi-view parks its call beside a pane, and the panes' and multi-view's calls are reused both ways", async context => {
  const value = await fixture(context, allChannels);
  const movable = await value.provider.openNvrLensCall("synthetic-s4", "movable");
  const grid = await value.provider.openNvrMultiViewCall("synthetic-nvr");
  await grid.close();
  assert.deepEqual(value.parkedLog, ["synthetic-cam0:stitch3"], "a hang-up would end the pane's call too");
  assert.equal(value.closed.length, 0);
  assert.equal(movable.output.readableEnded || movable.output.destroyed, false, "the pane carries on");
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  assert.equal(value.started.length, 2, "the pane reused the multi-view's parked call");
  assert.deepEqual(value.switched, ["synthetic-s4:0"]);
  await fixed.close();
  const again = await value.provider.openNvrMultiViewCall("synthetic-nvr");
  assert.equal(value.started.length, 2, "and the multi-view took the pane's parked call back");
  assert.deepEqual(value.switched, ["synthetic-s4:0", "synthetic-cam0:stitch3"]);
  await again.close();
  assert.equal(value.closed.length, 0, "closing the multi-view beside a pane never hangs up");
  await movable.close(); await settle();
  assert.equal(value.closed.length, 2, "the last call in use hung up with the parked one");
});

test("a pane closing beside the multi-view parks, and the multi-view closing last hangs up every call together", async context => {
  const value = await fixture(context, allChannels);
  const grid = await value.provider.openNvrMultiViewCall("synthetic-nvr");
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  const movable = await value.provider.openNvrLensCall("synthetic-s4", "movable");
  await Promise.all([fixed.close(), movable.close()]);
  assert.deepEqual(value.parkedLog.sort(), ["synthetic-s4:0", "synthetic-s4:1"]);
  assert.equal(grid.output.readableEnded || grid.output.destroyed, false, "the multi-view carries on");
  await grid.close(); await settle();
  assert.deepEqual(value.hungUpLabels.sort(), ["synthetic-cam0:stitch3", "synthetic-s4:0", "synthetic-s4:1"]);
});

test("the multi-view waits for the NVR's last hang-up to finish, and a pane waits for the multi-view's", async context => {
  const value = await fixture(context, allChannels);
  const fixed = await value.provider.openNvrLensCall("synthetic-s4", "fixed");
  let letGo = value.holdHangUps();
  let closing = fixed.close(); await settle();
  const opening = value.provider.openNvrMultiViewCall("synthetic-nvr");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(value.started.length, 1, "no call is placed while the pane's hang-up is running");
  letGo(); await closing;
  const grid = await opening;
  letGo = value.holdHangUps();
  closing = grid.close(); await settle();
  const pane = value.provider.openNvrLensCall("synthetic-s4", "movable");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(value.started.length, 2, "no call is placed while the multi-view's hang-up is running");
  letGo(); await closing;
  await (await pane).close();
  assert.deepEqual(value.order, ["placed synthetic-s4:0", "hung up synthetic-s4:0", "placed synthetic-cam0:stitch3",
    "hung up synthetic-cam0:stitch3", "placed synthetic-s4:1", "hung up synthetic-s4:1"]);
});

for (const exit of ["close", "start_failure", "call_lost", "shutdown"] as const) {
  test(`the multi-view call is hung up and released on ${exit}`, async context => {
    const value = await fixture(context, allChannels);
    if (exit === "start_failure") {
      value.failStarts(new NvrTrialError("video"));
      await assert.rejects(value.provider.openNvrMultiViewCall("synthetic-nvr"), (error: unknown) => error instanceof NvrTrialError && error.stage === "video");
      value.failStarts(null);
    } else {
      const call = await value.provider.openNvrMultiViewCall("synthetic-nvr");
      if (exit === "close") { await call.close(); await call.close(); }
      if (exit === "call_lost") { call.output.destroy(new NvrTrialError("video")); await settle(); }
      if (exit === "shutdown") { await value.provider.close(); assert.equal(value.closed.length, 1); return; }
    }
    await settle();
    assert.equal(value.closed.length, 1, "exactly one hang-up");

    // The reservation is gone: the multi-view and an exclusive lease are both admitted again.
    await (await value.provider.openNvrMultiViewCall("synthetic-nvr")).close();
    await value.provider.reserveNvrLiveTrial("synthetic-e41", new AbortController().signal)();
  });
}
