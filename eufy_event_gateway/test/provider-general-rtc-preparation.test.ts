/**
 * Verifies manual video sign-in ownership and account-wide admission offline.
 * Tests own synthetic account inventory and all authentication callbacks. The
 * provider boundary must never contact Eufy or actuate a device in these tests.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { MegaAuthResult } from "../src/mega/types.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import { GeneralRtcPreparationError, type ProviderEvents } from "../src/provider/provider.js";
import { GeneralRtcPreparation } from "../src/provider/general-rtc-preparation.js";
import { E30LockProvider } from "../src/provider/e30-lock-provider.js";
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
/** Start one offline parent with two admitted camera children. */
async function fixture(context: TestContext, mode = "valid") {
  const directory = await mkdtemp(join(tmpdir(), "general-provider-"));
  let bound = false;
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  const connect = context.mock.method(MegaClient.prototype, "connect", async (): Promise<MegaAuthResult> => ({ state: "authenticated" }));
  context.mock.method(MegaClient.prototype, "generalRtcCipher", () => bound ? ({ bindingKey: "synthetic", encrypt: (s: string) => s, decrypt: (s: string) => s }) : null);
  context.mock.getter(MegaClient.prototype, "isAuthenticated", () => mode !== "unauthenticated");
  context.mock.method(MegaClient.prototype, "generalRtcHasNativeIdentities", () => mode !== "native-identity");
  context.mock.method(MegaClient.prototype, "generalRtcAccount", () => mode === "unauthenticated" ? null : ({
    userId: "synthetic-owner", country: mode === "country" ? "bad" : "AU", token: mode === "token" ? "bad token" : "synthetic-token",
    securityHost: "security-app-ie.eufylife.com", smartHost: mode === "host" ? null : "security-smart-ie.eufylife.com",
    cipher: !bound ? null : { bindingKey: "synthetic", encrypt: (s: string) => s, decrypt: (s: string) => s },
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
  const lockEvents: unknown[] = [];
  const events = new Proxy({ locks: (values: unknown) => lockEvents.push(values), camera: (camera: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(camera) },
    { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory,
    maxStreamSeconds: 120, experimentalCloudRecordings: true, experimentalGeneralRtc: mode !== "disabled", apiAuthenticationConfigured: mode !== "no-api",
    experimentalE30Locks: mode === "lock-in-flight" });
  await provider.start(events); inventory.mock.resetCalls();
  context.after(async () => { await provider.close(); state.close(); assert.equal(network.mock.callCount(), 0); await rm(directory, { recursive: true, force: true }); });
  return { provider, state, inventory, connect, events, lockEvents, bind: () => { bound = true; } };
}

test("bound identity is a no-op without a login, pause or cooldown", async context => {
  const f = await fixture(context); f.bind(); f.connect.mock.resetCalls();
  assert.equal(f.provider.prepareGeneralRtc("synthetic-one"), "ready");
  assert.equal(f.connect.mock.callCount(), 0);
});

test("one detached forced login is shared, success needs fresh startup and no hidden recovery", async context => {
  const f = await fixture(context); f.connect.mock.resetCalls();
  let finish!: () => void;
  f.connect.mock.mockImplementation(async () => { await new Promise<void>(resolve => { finish = resolve; }); f.bind(); return { state: "authenticated" as const }; });
  assert.equal(f.provider.prepareGeneralRtc("synthetic-one"), "signing-in");
  assert.equal(f.provider.prepareGeneralRtc("synthetic-one"), "signing-in");
  await turn(); assert.equal(f.connect.mock.callCount(), 1);
  assert.deepEqual(f.connect.mock.calls[0]!.arguments, [undefined, undefined, true]);
  finish(); await turn(); await turn();
  assert.equal(f.provider.generalRtcPrepareStatus(), "ready");
  assert.equal(f.inventory.mock.callCount(), 1);
});

test("startup failure latches the gate without a second login or raw error", async context => {
  const f = await fixture(context); f.connect.mock.resetCalls();
  f.inventory.mock.mockImplementation(async () => { throw Error("SENTINEL_SERVER_SECRET"); });
  context.mock.method(MegaClient.prototype, "isSessionInvalidError", () => true);
  f.provider.prepareGeneralRtc("synthetic-one"); await turn(); await turn();
  assert.equal(f.provider.generalRtcPrepareStatus(), "failed");
  assert.equal(f.connect.mock.callCount(), 1);
  await assert.rejects(f.provider.start({} as ProviderEvents), GeneralRtcPreparationError);
});

test("close retires a hung login and its late result cannot restart inventory", async context => {
  const f = await fixture(context); let finish!: () => void;
  f.connect.mock.mockImplementation(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { state: "authenticated" as const }; });
  f.provider.prepareGeneralRtc("synthetic-one"); await turn(); await f.provider.close();
  finish(); await turn(); assert.equal(f.inventory.mock.callCount(), 0);
  assert.notEqual(f.provider.generalRtcPrepareStatus(), "ready");
});

test("autonomous lock work and a throwing busy getter refuse before the login", async context => {
  for (const throwing of [false, true]) {
    const f = await fixture(context, "lock-in-flight"); f.connect.mock.resetCalls();
    const getter = context.mock.getter(E30LockProvider.prototype, "busy", () => { if (throwing) throw Error("private"); return true; });
    assert.throws(() => f.provider.prepareGeneralRtc("synthetic-one"), (error: unknown) => error instanceof GeneralRtcPreparationError && error.stage === "busy");
    assert.equal(f.provider.generalRtcPrepareStatus(), "idle"); assert.equal(f.connect.mock.callCount(), 0); getter.mock.restore();
  }
});

test("every public effect method refuses before inspecting its arguments", async context => {
  const f = await fixture(context);
  f.connect.mock.mockImplementation(async () => await new Promise<never>(() => {}));
  f.provider.prepareGeneralRtc("synthetic-one");
  const permitted = new Set(["constructor", "close", "submitCaptcha", "submitVerification", "getCaptchaChallenge", "isVerificationRequired",
    "streamDiagnostic", "modelControlTrials", "nvrLiveSettingAdmitted", "setNvrLiveMediaChecks", "prepareGeneralRtc", "generalRtcPrepareStatus"]);
  const guarded = new Set(["refreshLock", "setLockState", "setLockSetting", "cloudHistory", "cloudCalendar", "cloudRecordingTrial", "readRecordingIndexTrial", "readLocalMotionTrial", "readT85V0StatusTrial", "listStoredRecordings", "downloadStoredRecording", "start", "reserveGeneralRtcTrial", "reserveDoorbellRtcTrial", "reserveNvrLiveTrial", "readNvrStateTrial", "testNvrCameraPower", "testNvrGuardMode", "startStream", "setNvrView", "performNvrLiveControl", "stopStream", "playCameraAudio", "setCameraEnabled", "setE21Preference", "setCameraPreference", "setCameraSetting", "performModelControlTrial", "setCameraMotionDetection", "setCameraAudioRecording", "setCameraStreamingQuality", "refreshCameraCapabilities", "setCameraGuardMode", "setCameraNightVision", "refreshStation", "setGuardMode", "setAlarmVolume", "setPromptVolume", "setAlarmTone", "setCameraLight", "setCameraSiren", "getCameraPresetPositions", "selectCameraPresetPosition", "setCameraAiTracking", "setCameraAutoCruise", "setHomeBaseSiren"]);
  const actual = Object.getOwnPropertyNames(EufyProvider.prototype);
  assert.deepEqual(new Set(actual), new Set([...permitted, ...guarded]));
  for (const name of guarded) {
    const operation = Reflect.get(f.provider, name) as (...args: unknown[]) => unknown;
    await assert.rejects(async () => operation.call(f.provider), GeneralRtcPreparationError, name);
  }
});

test("challenge answers stay on one owned epoch and wrong CAPTCHA remains waiting", async context => {
  const f = await fixture(context); let attempts = 0;
  f.connect.mock.mockImplementation(async (): Promise<MegaAuthResult> => {
    attempts++;
    if (attempts < 3) return { state: "captcha-required", captcha: { id: "synthetic", image: "" } };
    f.bind(); return { state: "authenticated" };
  });
  f.provider.prepareGeneralRtc("synthetic-one"); await turn();
  assert.equal(f.provider.generalRtcPrepareStatus(), "authentication-required");
  await f.provider.submitCaptcha("wrong");
  assert.equal(f.provider.generalRtcPrepareStatus(), "authentication-required");
  await f.provider.submitCaptcha("right");
  assert.equal(f.provider.generalRtcPrepareStatus(), "ready");
  assert.equal(attempts, 3);
  assert.equal(f.connect.mock.calls.filter(call => call.arguments[2] === true).length, 1);
});

test("verification completion uses the owned startup and missing cipher consumes cooldown", async context => {
  const f = await fixture(context); let calls = 0;
  f.connect.mock.mockImplementation(async (): Promise<MegaAuthResult> => (++calls === 1 ? { state: "verification-required" } : { state: "authenticated" }));
  f.provider.prepareGeneralRtc("synthetic-one"); await turn();
  assert.equal(f.provider.generalRtcPrepareStatus(), "authentication-required");
  await f.provider.submitVerification("123456");
  assert.equal(f.provider.generalRtcPrepareStatus(), "identity-unavailable");
  assert.throws(() => f.provider.prepareGeneralRtc("synthetic-one"), (error: unknown) => error instanceof GeneralRtcPreparationError && error.stage === "cooldown");
});

test("active deadline cancels a hung login and permanently gates effects", async context => {
  const real = globalThis.setTimeout;
  context.mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    real(callback, ms === 180_000 ? 20 : ms, ...args)) as typeof setTimeout);
  const f = await fixture(context);
  f.connect.mock.mockImplementation(async () => await new Promise<never>(() => {}));
  f.provider.prepareGeneralRtc("synthetic-one");
  await new Promise<void>(resolve => real(resolve, 40));
  assert.equal(f.provider.generalRtcPrepareStatus(), "failed");
  await assert.rejects(f.provider.startStream("synthetic-one"), GeneralRtcPreparationError);
});

test("challenge wait pauses the total active budget and cooldown remains monotonic", context => {
  let now = 0, deadline: (() => void) | undefined, expired = 0;
  const budgets: number[] = [];
  context.mock.method(globalThis, "setTimeout", ((callback: () => void, ms: number) => {
    budgets.push(ms); deadline = callback; return { unref() {} };
  }) as unknown as typeof setTimeout);
  context.mock.method(globalThis, "clearTimeout", (() => {}) as typeof clearTimeout);
  const preparation = new GeneralRtcPreparation(() => { expired++; }, () => now);
  const epoch = preparation.begin(); now = 30_000; preparation.challenge(epoch);
  now = 600_000; assert.equal(preparation.status(false), "authentication-required");
  preparation.resume(epoch); assert.deepEqual(budgets, [180_000, 150_000]);
  deadline!(); assert.equal(expired, 1); assert.equal(preparation.status(false), "failed");
  assert.throws(() => preparation.begin(), GeneralRtcPreparationError);
});

for (const method of ["cloudHistory", "cloudCalendar", "cloudRecordingTrial"] as const) {
  test(`an existing ${method} read refuses preparation until settlement`, async context => {
    const f = await fixture(context); f.connect.mock.resetCalls();
    let settle!: () => void;
    const held = new Promise<void>(resolve => { settle = resolve; });
    const query = { startTime: 1, endTime: 2 };
    let pending: Promise<unknown>;
    if (method === "cloudHistory") {
      context.mock.method(MegaClient.prototype, method, async () => { await held; return []; });
      pending = f.provider.cloudHistory("synthetic-one", query);
    } else if (method === "cloudCalendar") {
      context.mock.method(MegaClient.prototype, method, async () => { await held; return { month: "2026-10", days: [], droppedRows: 0 }; });
      pending = f.provider.cloudCalendar("synthetic-one", { month: "2026-10", timezoneOffset: 0 }, new AbortController().signal);
    } else {
      context.mock.method(MegaClient.prototype, method, async () => { await held; return Buffer.alloc(0); });
      pending = f.provider.cloudRecordingTrial("synthetic-one", "opaque", query, new AbortController().signal);
    }
    await turn();
    assert.throws(() => f.provider.prepareGeneralRtc("synthetic-one"), (error: unknown) => error instanceof GeneralRtcPreparationError && error.stage === "busy");
    assert.equal(f.connect.mock.callCount(), 0); assert.equal(f.provider.generalRtcPrepareStatus(), "idle");
    settle(); await pending;
    assert.equal(f.provider.prepareGeneralRtc("synthetic-one"), "signing-in"); await turn();
  });
}

test("mixed reads retain busy until the last rejection settles, and no registration survives argument failure", async context => {
  const f = await fixture(context); const finishes: (() => void)[] = [];
  context.mock.method(MegaClient.prototype, "cloudHistory", async () => await new Promise<never>((_resolve, reject) => {
    finishes.push(() => reject(Error("synthetic failure")));
  }));
  const one = f.provider.cloudHistory("synthetic-one", { startTime: 1, endTime: 2 }).catch(() => {});
  const two = f.provider.cloudHistory("synthetic-two", { startTime: 1, endTime: 2 }).catch(() => {});
  finishes[0]!(); await one;
  assert.throws(() => f.provider.prepareGeneralRtc("synthetic-one"), GeneralRtcPreparationError);
  finishes[1]!(); await two;
  await assert.rejects(f.provider.cloudHistory("missing", { startTime: 1, endTime: 2 }));
  assert.equal(f.provider.prepareGeneralRtc("synthetic-one"), "signing-in"); await turn();
});

test("a retired cloud recording clears its own count once and zeroes cancelled media", async context => {
  const f = await fixture(context); let finish!: () => void;
  const media = Buffer.from("synthetic private clip");
  context.mock.method(MegaClient.prototype, "cloudRecordingTrial", async () => { await new Promise<void>(resolve => { finish = resolve; }); return media; });
  const pending = f.provider.cloudRecordingTrial("synthetic-one", "opaque", { startTime: 1, endTime: 2 }, new AbortController().signal);
  const rejected = assert.rejects(pending);
  await f.provider.close(); await f.provider.start(f.events);
  assert.throws(() => f.provider.prepareGeneralRtc("synthetic-one"), GeneralRtcPreparationError);
  finish(); await rejected; assert.ok(media.every(value => value === 0));
  assert.equal(f.provider.prepareGeneralRtc("synthetic-one"), "signing-in"); await turn();
});

for (const method of ["cloudCalendar", "cloudRecordingTrial"] as const) test(`${method} aborted admission leaves preparation idle`, async context => {
  const f = await fixture(context), controller = new AbortController(); controller.abort();
  const pending = method === "cloudCalendar"
    ? f.provider.cloudCalendar("synthetic-one", { month: "2026-10", timezoneOffset: 0 }, controller.signal)
    : f.provider.cloudRecordingTrial("synthetic-one", "opaque", { startTime: 1, endTime: 2 }, controller.signal);
  await assert.rejects(pending);
  assert.equal(f.provider.prepareGeneralRtc("synthetic-one"), "signing-in"); await turn();
});

test("preparation defers autonomous lock inventory until challenge startup releases its gate", async context => {
  const observations: unknown[] = [];
  context.mock.method(E30LockProvider.prototype, "inventory", function(this: E30LockProvider, rows: unknown) {
    observations.push(rows);
    const options = Reflect.get(this, "options") as { changed: (locks: unknown[]) => void };
    options.changed([]);
  });
  const f = await fixture(context, "lock-in-flight"); observations.length = 0; f.lockEvents.length = 0;
  let count = 0;
  f.connect.mock.mockImplementation(async (): Promise<MegaAuthResult> => {
    if(++count === 1) return { state: "verification-required" };
    f.bind(); return { state: "authenticated" };
  });
  f.provider.prepareGeneralRtc("synthetic-one"); await turn();
  assert.equal(observations.length, 0); assert.equal(f.lockEvents.length, 1);
  await f.provider.submitVerification("123456");
  assert.equal(observations.length, 1); assert.equal(f.lockEvents.length, 2);
  assert.equal(f.provider.generalRtcPrepareStatus(), "ready");
});
