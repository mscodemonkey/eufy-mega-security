/**
 * Tests the private trial HTTP contract on loopback with a synthetic recorder.
 * The real recording boundary is tested separately. These fixtures own server,
 * lease and temporary storage, and never read an account or camera connection.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "../src/config.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { CameraProvider } from "../src/provider/provider.js";
import type { GeneralRtcTrialLease } from "../src/provider/general-rtc-trial.js";
import { GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";
import { GeneralRtcError, type GeneralRtcStage } from "../src/stream/general-rtc-protocol.js";
import type { recordGeneralRtcClip } from "../src/stream/general-rtc-recording.js";

const token = "SENTINEL_API_TOKEN".padEnd(32, "x"), pin = "SENTINEL_PIN", sentinel = `${pin}/${token}/SENTINEL_SCALAR`;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

/** Own one authenticated local server and configurable fake recording outcome. */
async function fixture(context: TestContext, enabled = true, providerAvailable = true) {
  const directory = await mkdtemp(join(tmpdir(), "general-http-"));
  const state = new GatewayState();
  state.registerCamera({ serial: "synthetic", name: "Synthetic", model: "T8171", stationSerial: "synthetic", streamSupported: false, doorbellSupported: false });
  let acquired = 0, released = 0, busy = false, mode: GeneralRtcStage | "success" | "raw" | "wait" = "success";
  let entered!: () => void, retired!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; }), retiring = new Promise<void>(resolve => { retired = resolve; });
  const logs: string[] = [];
  context.mock.method(process.stderr, "write", ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stderr.write);
  const lease: GeneralRtcTrialLease = { prepare: async () => ({ stop: async () => {}, verify: async () => {} }), start: async () => {},
    release: async () => { released++; retired(); } };
  const provider = { ...(providerAvailable ? { reserveGeneralRtcTrial: () => { acquired++; return lease; } } : {}) } as unknown as CameraProvider;
  const streams = { hasActiveSession: () => busy } as unknown as LiveStreamManager;
  const recorder: typeof recordGeneralRtcClip = async (value, submittedPin, signal) => {
    assert.equal(value, lease); assert.equal(submittedPin, pin); entered();
    if (mode === "raw") throw Error(sentinel);
    if (mode === "wait") await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    if (mode !== "success") throw new GeneralRtcError(mode === "wait" ? "cancelled" : mode);
    return Buffer.from("synthetic-private-clip");
  };
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: token, experimentalGeneralRtc: enabled }, state,
    new SnapshotStore(directory), streams, provider, null, null, null, 82_000, 30_000, recorder);
  await server.listen();
  context.after(async () => { await server.close(); state.close(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.port}/api/cameras/synthetic/general-rtc-trial`;
  const request = (body: BodyInit = JSON.stringify({ consent: true, pin }), changes: RequestInit = {}, target = url) => fetch(target, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body, ...changes,
  });
  return { request, url, entering, retiring, logs, mode: (value: typeof mode) => { mode = value; }, busy: (value: boolean) => { busy = value; },
    counts: () => ({ acquired, released }) };
}

test("HTTP admission, media type, tokenizer and byte limits reject before taking a lease", async context => {
  const f = await fixture(context);
  for (const [result, status] of [
    [await f.request(undefined, { headers: {} }), 401],
    [await f.request(undefined, {}, f.url.replace("/synthetic/", "/missing/")), 404],
    [await f.request(undefined, {}, f.url + "?"), 400],
    [await f.request(undefined, {}, f.url + "?value=1"), 400],
    [await f.request(undefined, { headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" } }), 415],
    [await f.request("x".repeat(16_385)), 413],
    [await f.request(Buffer.from([0xff])), 400],
    [await f.request('{"consent":true,"pin":"1234","p\\u0069n":"other"}'), 400],
    [await f.request('{"consent":true,"pin":"\\u0000"}'), 400],
    [await f.request('\ufeff{"consent":true,"pin":"1234"}'), 400],
    [await f.request('{"consent":true,"pin":"1234"}{}'), 400],
  ] as const) {
    assert.equal(result.status, status); assert.equal(result.headers.get("cache-control"), "no-store");
    assert.deepEqual(await result.json(), { stage: "admission" });
  }
  assert.equal(f.counts().acquired, 0);
  f.busy(true); const busy = await f.request(); assert.equal(busy.status, 409); assert.deepEqual(await busy.json(), { stage: "busy" });
  assert.equal(f.counts().acquired, 0);
});

for (const [enabled, available] of [[false, true], [true, false]]) test(`disabled or missing provider ${enabled}/${available} refuses before camera lookup`, async context => {
  const f = await fixture(context, enabled, available);
  const result = await f.request(undefined, {}, f.url.replace("/synthetic/", "/missing/"));
  assert.equal(result.status, 409); assert.deepEqual(await result.json(), { stage: "admission" }); assert.equal(f.counts().acquired, 0);
});

test("success is a private MP4 response and every fixed failure stage has a closed body", async context => {
  const f = await fixture(context);
  const success = await f.request(); assert.equal(success.status, 200); assert.equal(success.headers.get("content-type"), "video/mp4");
  assert.equal(success.headers.get("cache-control"), "no-store"); assert.equal(await success.text(), "synthetic-private-clip");
  await turn(); assert.deepEqual(f.counts(), { acquired: 1, released: 1 });
  const stages: GeneralRtcStage[] = ["admission", "reconnect_required", "busy", "cooldown", "locked", "preflight_required", "preflight",
    "inventory", "binding", "pin", "sign", "budget", "join", "call", "turn", "offer", "peer", "video", "cancelled", "deadline", "shutdown"];
  for (const stage of stages) {
    f.mode(stage); const result = await f.request(); assert.equal(result.status, 409);
    assert.deepEqual(await result.json(), { stage }); assert.equal(result.headers.get("cache-control"), "no-store");
  }
  f.mode("raw"); const raw = await f.request(); assert.deepEqual(await raw.json(), { stage: "video" });
  await turn(); assert.equal(f.counts().released, f.counts().acquired);
  assert.equal(f.logs.join("\n").includes(sentinel), false);
  assert.equal(f.logs.join("\n").includes(pin), false); assert.equal(f.logs.join("\n").includes(token), false);
});

test("concurrent requests refuse busy and disconnect cancels the exact lease before another can start", async context => {
  const f = await fixture(context); f.mode("wait");
  const controller = new AbortController();
  const first = f.request(undefined, { signal: controller.signal }); void first.catch(() => undefined);
  await f.entering;
  const busy = await f.request(); assert.equal(busy.status, 409); assert.deepEqual(await busy.json(), { stage: "busy" });
  assert.equal(f.counts().acquired, 1);
  controller.abort(); await assert.rejects(first); await f.retiring; await turn();
  f.mode("success"); assert.equal((await f.request()).status, 200); await turn();
  assert.deepEqual(f.counts(), { acquired: 2, released: 2 });
});

test("the 170-second route backstop cancels a stalled recorder and releases the lease", async context => {
  const original = globalThis.setTimeout;
  context.mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) =>
    original(callback, milliseconds === 170_000 ? 25 : milliseconds, ...args)) as typeof setTimeout);
  const f = await fixture(context); f.mode("wait");
  const result = await f.request(); assert.equal(result.status, 409); assert.deepEqual(await result.json(), { stage: "deadline" });
  await f.retiring; assert.deepEqual(f.counts(), { acquired: 1, released: 1 });
});
