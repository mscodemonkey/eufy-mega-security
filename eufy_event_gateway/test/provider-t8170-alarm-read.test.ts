/**
 * Tests provider admission and ownership for an explicit T8170 read. Test-owned
 * cloud, push and session boundaries forbid external requests and device writes.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import type { AlarmStateTrialResult } from "../src/provider/model-control-trials.js";
import { GatewayState } from "../src/domain/gateway-state.js";

/** Own every external boundary for one synthetic inventory and disposable provider. */
async function fixture(context: TestContext, mode = "ready") {
  const directory = await mkdtemp(join(tmpdir(), "t8170-read-"));
  context.mock.method(globalThis, "fetch", async () => { assert.fail("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.method(MegaClient.prototype, "isAuthenticatedUser", () => mode !== "unauthenticated");
  let connection = "synthetic-route";
  const refreshes: (() => void)[] = [];
  context.mock.method(globalThis, "setInterval", (f: () => void) => { refreshes.push(f); return { unref() {} } as unknown as ReturnType<typeof setInterval>; });
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ device_sn: "fixture-camera", device_model: "T8170", device_type: 48,
    category: "eufy_security", device_channel: 0, p2p_did: mode === "missing-did" ? "" : "fixture-peer", p2p_conn: mode === "missing-connection" ? "" : connection,
    member: mode === "missing-admin" ? {} : { admin_user_id: "fixture-owner" } }] }));
  const keys = context.mock.method(MegaClient.prototype, "dskKeys", async () => mode === "no-key" ? {} : { "fixture-camera": {
    key: mode === "empty-key" ? "" : "fixture-key", expiresAt: mode === "expired-key" ? Date.now() + 59000 : null } });
  context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
  const starts = context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => undefined);
  const closes = context.mock.method(FirstPartyPpcsSession.prototype, "close");
  const forbidden = context.mock.method(FirstPartyPpcsSession.prototype, "writeModelControlTrial", async () => { assert.fail("Write forbidden"); });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const reads = context.mock.method(FirstPartyPpcsSession.prototype, "readT8170AlarmState", async (): Promise<AlarmStateTrialResult> => {
    enter(); if (["held", "drift", "shutdown", "abort"].includes(mode)) await gate;
    if (mode === "failure") throw Error("private-serial-owner-key");
    return { outcome: "decoded", parameterCount: 2, guardMode: 63 };
  });
  const logs: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout), stderr = process.stderr.write.bind(process.stderr);
  context.mock.method(process.stdout, "write", (v: string | Uint8Array) => {
    if(String(v).includes("component=")) { logs.push(String(v)); return true; }
    return stdout(v);
  });
  context.mock.method(process.stderr, "write", (v: string | Uint8Array) => {
    if(String(v).includes("component=")) { logs.push(String(v)); return true; }
    return stderr(v);
  });
  const state = new GatewayState();
  const events = new Proxy({ camera: (value: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(value) },
    { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: directory,
    maxStreamSeconds: 120, experimentalModelControls: mode !== "option-off", apiAuthenticationConfigured: mode !== "api-off" });
  await provider.start(events);
  context.after(async () => { release(); await provider.close(); await rm(directory, { recursive: true, force: true }); });
  return { provider, state, keys, starts, closes, forbidden, reads, entered, release, logs,
    drift: async () => { connection = "replacement"; refreshes.at(-1)!(); await new Promise(resolve => setImmediate(resolve)); } };
}

for (const mode of ["option-off", "api-off", "unauthenticated", "missing-admin", "missing-did", "missing-connection", "no-key", "empty-key", "expired-key"]) {
  test(`T8170 ${mode} refuses listing and perform without fetching keys or opening sessions`, async context => {
    const h = await fixture(context, mode), count = h.keys.mock.callCount();
    assert.deepEqual(h.provider.modelControlTrials("fixture-camera"), []);
    assert.deepEqual(await h.provider.performModelControlTrial("fixture-camera", { action: "alarmState", enabled: false }),
      { outcome: "unavailable", frames: 0, parseStage: "none", keyReady: false });
    assert.equal(h.keys.mock.callCount(), count); assert.equal(h.starts.mock.callCount(), 0); assert.equal(h.reads.mock.callCount(), 0);
    assert.equal(h.forbidden.mock.callCount(), 0);
  });
}

for (const mode of ["ready", "failure", "held", "drift", "shutdown", "abort"]) test(`T8170 provider ${mode} keeps private read ownership`, async context => {
  const h = await fixture(context, mode), before = h.state.getCamera("fixture-camera"), keyCalls = h.keys.mock.callCount();
  assert.deepEqual(h.provider.modelControlTrials("fixture-camera"), ["alarmState"]);
  const controller = new AbortController();
  const running = h.provider.performModelControlTrial("fixture-camera", { action: "alarmState", enabled: false }, controller.signal);
  const settled = running.then(value => ({ value }), error => ({ error }));
  await h.entered;
  if (["held", "drift", "shutdown", "abort"].includes(mode)) {
    assert.deepEqual(await h.provider.performModelControlTrial("fixture-camera", { action: "alarmState", enabled: false }),
      { outcome: "unavailable", frames: 0, parseStage: "none", keyReady: false });
    await assert.rejects(h.provider.startStream("fixture-camera"), /Wait/);
    if (mode === "drift") await h.drift();
    if (mode === "shutdown") await h.provider.close();
    if (mode === "abort") { controller.abort(); assert.equal(h.closes.mock.callCount(), 0); }
    h.release();
  }
  const result = await settled;
  if (mode === "drift" || mode === "shutdown") { assert.ok("error" in result); assert.equal(result.error.message, "Model control route changed or closed"); }
  else {
    assert.ok("value" in result);
    assert.deepEqual(result.value, mode === "failure" ? { outcome: "unavailable", frames: 0, parseStage: "none", keyReady: false }
      : { outcome: "decoded", parameterCount: 2, guardMode: 63 });
  }
  assert.deepEqual(h.state.getCamera("fixture-camera"), before); assert.equal(h.keys.mock.callCount(), keyCalls);
  assert.equal(h.forbidden.mock.callCount(), 0); assert.ok(h.closes.mock.callCount() >= 1);
  const lines = h.logs.filter(line => line.includes("action=alarmState")); assert.ok(lines.length >= 1);
  assert.equal(lines.some(line => /private-|guardMode|parameterCount|physical_confirmation|fixture-camera|fixture-owner/.test(line)), false);
});
