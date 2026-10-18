/**
 * Exercises explicit opt-in control admission through public provider methods.
 * Synthetic inventory and session mocks own all effects. No physical claim is made.
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
import { GatewayState } from "../src/domain/gateway-state.js";
import type { NvrLiveWrite } from "../src/stream/nvr-live-control-protocol.js";

async function fixture(context: TestContext, model = "T8E00", type = 301, flags = true, inherited = false, normal = true) {
  const directory = await mkdtemp(join(tmpdir(), "nvr-live-controls-"));
  let missing = false;
  let clock = 1000, viewer = true, recording = false, active = false, mismatch = false, partial = false;
  let night = 1, quality = 0;
  const raw = { devices: [
    { device_sn: "synthetic-parent", device_model: "T8N00", device_type: 300, category: "eufy_security", member: { admin_user_id: "synthetic-owner" } },
    { device_sn: "synthetic-camera", parent_sn: "synthetic-parent", device_channel: 3, device_model: model, device_type: type,
      category: "eufy_security", member: inherited ? {} : { admin_user_id: "synthetic-owner" } },
  ] };
  const writes: NvrLiveWrite[] = [], refreshes: (() => void)[] = [];
  context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.getter(MegaClient.prototype, "isAuthenticated", () => true);
  context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (owner: string) => owner === "synthetic-owner");
  context.mock.method(MegaClient.prototype, "inventory", async () => raw);
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
  context.mock.method(globalThis, "setInterval", (callback: () => void) => { refreshes.push(callback); return { unref() {} } as NodeJS.Timeout; });
  context.mock.method(performance, "now", () => clock);
  context.mock.method(Date, "now", () => 1792000000000 + clock);
  context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => ({ host: "security-smart-ie.eufylife.com", region: "IE", authToken: "synthetic", gtoken: "synthetic", sign: "synthetic" }));
  context.mock.method(NvrRtcSession.prototype, "start", async () => {});
  context.mock.method(NvrRtcSession.prototype, "close", async () => {});
  context.mock.method(NvrRtcSession.prototype, "initialLiveSettings", async () => ({ night, quality }));
  context.mock.method(NvrRtcSession.prototype, "readLiveSettings", async () => ({ night, quality: missing ? null : quality }));
  context.mock.method(NvrRtcSession.prototype, "prepareLiveControl", async () => {});
  context.mock.getter(NvrRtcSession.prototype, "remainingLifetimeMilliseconds", () => 120000);
  context.mock.method(NvrRtcSession.prototype, "writeLiveControl", async (request: NvrLiveWrite, signal: AbortSignal, before: () => void) => {
    signal.throwIfAborted(); before(); writes.push(request);
    if (partial && request.kind === "quality" && request.sensor === 1) throw Error("private canary");
    if (!mismatch && request.kind === "night") night = request.value;
    if (!mismatch && request.kind === "quality") quality = request.value;
  });
  const state = new GatewayState();
  const events = new Proxy({ camera: (value: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(value) }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory,
    maxStreamSeconds: 120, normalNvrLive: normal, experimentalNvrLive: true, experimentalModelControls: flags,
    experimentalNvrControls: flags, apiAuthenticationConfigured: flags });
  provider.setNvrLiveMediaChecks({ viewer: () => viewer, recording: () => recording, active: () => active });
  await provider.start(events);
  context.after(async () => { await provider.close(); await rm(directory, { recursive: true, force: true }); });
  return { provider, raw, state, writes, advance: () => { clock += 2000; }, noViewer: () => { viewer = false; },
    recording: () => { recording = true; }, active: () => { active = true; }, partial: () => { partial = true; },
    missing: () => { missing = true; }, events,
    mismatch: () => { mismatch = true; }, tick: (milliseconds: number) => { clock += milliseconds; context.mock.timers.tick(milliseconds); }, refresh: async () => { refreshes.at(-1)!(); await new Promise(resolve => setImmediate(resolve)); } };
}

test("normal settings confirm targets, quality writes both sources, refresh preserves observations", async context => {
  const value = await fixture(context);
  await value.provider.startStream("synthetic-camera");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(value.state.getCamera("synthetic-camera").nightVisionControlSupported, true);
  await value.provider.setCameraNightVision("synthetic-camera", 2);
  assert.equal(value.state.getCamera("synthetic-camera").nightVisionMode, 2);
  await assert.rejects(value.provider.performNvrLiveControl("synthetic-camera", { kind: "pan", direction: "left" }), { code: "rate_limited" });
  value.advance(); await value.provider.setCameraStreamingQuality("synthetic-camera", 3);
  assert.deepEqual(value.writes.filter(write => write.kind === "quality").map(write => write.sensor), [0, 1]);
  await value.refresh();
  assert.equal(value.state.getCamera("synthetic-camera").reportedSettings?.streamingQualityTier, 3);
  value.advance();
  assert.deepEqual(await value.provider.performNvrLiveControl("synthetic-camera", { kind: "pan", direction: "up" }), { outcome: "request_accepted", physicalConfirmationRequired: true });
  value.advance(); value.noViewer();
  await assert.rejects(value.provider.performNvrLiveControl("synthetic-camera", { kind: "pan", direction: "up" }), { code: "busy" });
});

for (const mode of ["disabled", "inherited", "recording", "drift", "partial", "view"] as const) test(`normal controls reject ${mode} without optimistic state`, async context => {
  const value = await fixture(context, "T8E00", 301, mode !== "disabled", mode === "inherited");
  if (mode === "disabled" || mode === "inherited") {
    await assert.rejects(value.provider.performNvrLiveControl("synthetic-camera", { kind: "pan", direction: "left" }), { code: "disabled" });
  } else if (mode === "view") {
    await value.provider.setNvrView("synthetic-camera", 0);
    assert.equal(value.state.getCamera("synthetic-camera").nvrPanControlSupported, false);
    value.active(); await assert.rejects(value.provider.setNvrView("synthetic-camera", 1), { code: "busy" });
  } else {
    await value.provider.startStream("synthetic-camera"); await new Promise(resolve => setImmediate(resolve));
    if (mode === "recording") value.recording();
    if (mode === "drift") value.raw.devices[1]!.member = {};
    if (mode === "partial") value.partial();
    await assert.rejects(value.provider.setCameraStreamingQuality("synthetic-camera", 3), { code: mode === "partial" ? "outcome_unknown" : mode === "recording" ? "busy" : "unavailable" });
    if (mode === "partial") assert.equal(value.state.getCamera("synthetic-camera").reportedSettings?.streamingQualityTier, null);
  }
  assert.equal(value.writes.length, mode === "partial" ? 2 : 0);
});

test("104 profile admits Wide default and software Telephoto choice, without optical zoom", async context => {
  const value = await fixture(context, "T8416", 104);
  assert.equal(value.state.getCamera("synthetic-camera").streamSupported, true);
  assert.equal(value.state.getCamera("synthetic-camera").nvrSelectedView, 0);
  assert.equal(value.state.getCamera("synthetic-camera").nvrOpticalZoomControlSupported, false);
  await value.provider.setNvrView("synthetic-camera", 1);
  assert.equal(value.state.getCamera("synthetic-camera").nvrSelectedView, 1);
});

test("104 streaming stays unavailable with only the video flag", async context => {
  const value = await fixture(context, "T8416", 104, false);
  assert.equal(value.state.getCamera("synthetic-camera").streamSupported, false);
  await assert.rejects(value.provider.startStream("synthetic-camera"));
  assert.equal(value.writes.length, 0);
});


test("native cache expires to unknown and refresh restores it", async context => {
  const value = await fixture(context);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  await value.provider.startStream("synthetic-camera"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(value.state.getCamera("synthetic-camera").nightVisionMode, 1);
  value.tick(1800001);
  assert.equal(value.state.getCamera("synthetic-camera").nightVisionMode, null);
  assert.equal(value.state.getCamera("synthetic-camera").nightVisionControlSupported, false);
  await value.provider.refreshCameraCapabilities("synthetic-camera");
  assert.equal(value.state.getCamera("synthetic-camera").nightVisionMode, 1);
  await assert.rejects(value.provider.refreshCameraCapabilities("synthetic-camera"), { code: "rate_limited" });
});

test("view change and binding change clear cached observations", async context => {
  const value = await fixture(context);
  await value.provider.startStream("synthetic-camera"); await new Promise(resolve => setImmediate(resolve));
  await value.provider.stopStream("synthetic-camera");
  await value.provider.setNvrView("synthetic-camera", 0);
  assert.equal(value.state.getCamera("synthetic-camera").nightVisionMode, null);
  value.raw.devices[1]!.device_channel = 4;
  await value.refresh();
  assert.equal(value.state.getCamera("synthetic-camera").nvrSelectedView, 1);
});

test("a second control is rejected while the first owns the parent", async context => {
  const value = await fixture(context);
  await value.provider.startStream("synthetic-camera");
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { finish = resolve; });
  context.mock.method(NvrRtcSession.prototype, "writeLiveControl", async (_request: NvrLiveWrite, _signal: AbortSignal, before: () => void) => { before(); entered(); await held; });
  const first = value.provider.performNvrLiveControl("synthetic-camera", { kind: "pan", direction: "left" });
  await started;
  await assert.rejects(value.provider.performNvrLiveControl("synthetic-camera", { kind: "pan", direction: "right" }), { code: "busy" });
  finish(); await first;
});


test("missing fresh baseline never uses a known cached quality", async context => {
  const value = await fixture(context);
  await value.provider.startStream("synthetic-camera"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(value.state.getCamera("synthetic-camera").reportedSettings?.streamingQualityTier, 0);
  value.missing();
  await assert.rejects(value.provider.setCameraStreamingQuality("synthetic-camera", 3), { code: "unavailable" });
  assert.equal(value.writes.length, 0);
  assert.equal(value.state.getCamera("synthetic-camera").reportedSettings?.streamingQualityTier, null);
});

for (const reason of ["duplicate", "guest"] as const) test(`fresh ${reason} ownership denies before dispatch`, async context => {
  const value = await fixture(context);
  await value.provider.startStream("synthetic-camera");
  if (reason === "duplicate") value.raw.devices.push({ ...value.raw.devices[1]! });
  else value.raw.devices[1]!.member = { admin_user_id: "synthetic-guest" };
  await assert.rejects(value.provider.performNvrLiveControl("synthetic-camera", { kind: "pan", direction: "left" }), { code: "unavailable" });
  assert.equal(value.writes.length, 0);
});

test("quality cancellation between writes never dispatches the second sensor", async context => {
  const value = await fixture(context); await value.provider.startStream("synthetic-camera");
  const controller = new AbortController(); let writes = 0;
  context.mock.method(NvrRtcSession.prototype, "writeLiveControl", async (_request: NvrLiveWrite, signal: AbortSignal, before: () => void) => {
    signal.throwIfAborted(); before(); writes++; controller.abort();
  });
  await assert.rejects(value.provider.setCameraStreamingQuality("synthetic-camera", 3, controller.signal), { code: "outcome_unknown", stage: "dispatch" });
  assert.equal(writes, 1);
});

test("pre-dispatch failures are unavailable and partial quality remains unknown", async context => {
  const value = await fixture(context); await value.provider.startStream("synthetic-camera");
  context.mock.method(NvrRtcSession.prototype, "writeLiveControl", async () => { throw Error("private canary"); });
  const lines: string[] = [];
  context.mock.method(process.stderr, "write", (chunk: unknown) => { lines.push(String(chunk)); return true; });
  await assert.rejects(value.provider.setCameraStreamingQuality("synthetic-camera", 3), { code: "unavailable" });
  value.advance(); let writes = 0;
  context.mock.method(NvrRtcSession.prototype, "writeLiveControl", async (_request: NvrLiveWrite, _signal: AbortSignal, before: () => void) => {
    if (writes) throw Error("private canary"); before(); writes++;
  });
  await assert.rejects(value.provider.setCameraStreamingQuality("synthetic-camera", 3), error => {
    assert.equal((error as { code: string }).code, "outcome_unknown"); assert.ok(!String(error).includes("private canary")); return true;
  });
  assert.equal(writes, 1); assert.ok(!lines.join("\n").includes("private canary"));
});

test("mismatched readback expires without replay under an advancing clock", async context => {
  const value = await fixture(context); await value.provider.startStream("synthetic-camera");
  context.mock.timers.enable({ apis: ["setTimeout"] }); value.mismatch();
  const operation = value.provider.setCameraStreamingQuality("synthetic-camera", 3);
  let settled = false; void operation.then(() => { settled = true; }, () => { settled = true; });
  for (let index = 0; index < 20 && !settled; index++) {
    await new Promise(resolve => setImmediate(resolve)); value.tick(1000);
  }
  await assert.rejects(operation, { code: "outcome_unknown" }); assert.equal(value.writes.length, 2);
  assert.equal(value.state.getCamera("synthetic-camera").reportedSettings?.streamingQualityTier, null);
});

test("owner omission withdraws admission and restart clears observed cache", async context => {
  const value = await fixture(context); await value.provider.startStream("synthetic-camera"); await new Promise(resolve => setImmediate(resolve));
  const child = value.raw.devices.pop()!; await value.refresh();
  assert.equal(value.provider.nvrLiveSettingAdmitted("synthetic-camera"), false);
  assert.equal(value.state.getCamera("synthetic-camera").nightVisionMode, null);
  value.raw.devices.push(child); await value.provider.close(); await value.provider.start(value.events);
  assert.equal(value.state.getCamera("synthetic-camera").nightVisionMode, null);
});


test("controls are not advertised when the normal route is disabled", async context => {
  const value = await fixture(context, "T8E00", 301, true, false, false);
  const camera = value.state.getCamera("synthetic-camera");
  assert.equal(camera.nvrPanControlSupported, false); assert.equal(camera.nvrOpticalZoomControlSupported, false);
  assert.deepEqual(camera.nvrViewOptions, []); assert.equal(camera.reportedSettings, null);
});


test("a restarted provider cannot write through a session from an older generation", async context => {
  const value = await fixture(context); await value.provider.startStream("synthetic-camera");
  await value.provider.start(value.events);
  await assert.rejects(value.provider.performNvrLiveControl("synthetic-camera", { kind: "pan", direction: "left" }), { code: "unavailable" });
  await assert.rejects(value.provider.refreshCameraCapabilities("synthetic-camera"), { code: "busy" });
  assert.equal(value.writes.length, 0);
});
