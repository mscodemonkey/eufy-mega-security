/**
 * Verifies exact native doorbell admission and exclusive diagnostic leases.
 * Each fixture owns synthetic inventory, timers and mocked transports. No
 * account, camera or household setting is contacted or changed by these tests.
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
import { GatewayState } from "../src/domain/gateway-state.js";
import { DoorbellRtcSession } from "../src/stream/doorbell-rtc-session.js";
import { DoorbellRtcError } from "../src/stream/doorbell-rtc-offer.js";

const contextValue = { host: "security-smart-eu.eufylife.com", region: "EU" as const,
  authToken: "synthetic-token", gtoken: "synthetic-gtoken", sign: "synthetic-sign" };

/** Own one provider whose only doorbell has the documented missing-PPCS topology. */
async function fixture(context: TestContext, mode = "valid") {
  const directory = await mkdtemp(join(tmpdir(), "doorbell-provider-"));
  const network = context.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.getter(MegaClient.prototype, "isAuthenticated", () => mode !== "unauthenticated");
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{
    device_sn: "synthetic-doorbell", device_model: mode === "wrong-model" ? "T8223" : "T8224",
    device_type: mode === "wrong-type" ? 95 : 96, category: "eufy_security", device_channel: 0,
    parent_sn: mode === "attached" ? "other-station" : "synthetic-doorbell",
    ...(mode === "ppcs-ready" ? { p2p_conn: "synthetic-route", p2p_did: "synthetic-peer" } : {}),
    member: mode === "missing-owner" ? {} : { admin_user_id: "synthetic-owner" },
  }] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
  const state = new GatewayState();
  const events = new Proxy({ camera: (camera: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(camera) },
    { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU",
    persistentDirectory: directory, maxStreamSeconds: 120, experimentalDoorbellRtc: mode !== "disabled" });
  await provider.start(events);
  return { provider, state, network, close: async () => {
    await provider.close(); assert.equal(network.mock.callCount(), 0); await rm(directory, { recursive: true, force: true });
  } };
}

for (const mode of ["disabled", "unauthenticated", "wrong-model", "wrong-type", "attached", "missing-owner", "ppcs-ready", "aborted"]) {
  test(`native doorbell refuses ${mode} without a cloud call`, async context => {
    const f = await fixture(context, mode);
    const sign = context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => contextValue);
    const controller = new AbortController(); if (mode === "aborted") controller.abort();
    try {
      assert.throws(() => f.provider.reserveDoorbellRtcTrial("synthetic-doorbell", controller.signal),
        error => error instanceof DoorbellRtcError && error.stage === "admission");
      assert.equal(sign.mock.callCount(), 0);
    } finally { await f.close(); }
  });
}

test("normal media uses the opted-in RTC path and cleanup retains the exclusive lease", async context => {
  const f = await fixture(context);
  let finish!: () => void;
  const closing = new Promise<void>(resolve => { finish = resolve; });
  const starts = context.mock.method(DoorbellRtcSession.prototype, "start", async () => undefined);
  const closes = context.mock.method(DoorbellRtcSession.prototype, "close", () => closing);
  const sign = context.mock.method(MegaClient.prototype, "nvrSignallingContext", async (serial: string) => {
    assert.equal(serial, "synthetic-doorbell"); return contextValue;
  });
  try {
    assert.equal(f.state.getCamera("synthetic-doorbell").streamSupported, true);
    await f.provider.startStream("synthetic-doorbell");
    assert.equal(starts.mock.callCount(), 1); assert.equal(sign.mock.callCount(), 1);
    const first = f.provider.stopStream("synthetic-doorbell");
    assert.throws(() => f.provider.reserveDoorbellRtcTrial("synthetic-doorbell", new AbortController().signal));
    finish(); await first; assert.equal(closes.mock.callCount(), 1);
    const next = f.provider.reserveDoorbellRtcTrial("synthetic-doorbell", new AbortController().signal); await next();
    assert.equal(f.state.getCamera("synthetic-doorbell").streamSupported, true);
  } finally { finish(); await f.close(); }
});

test("disabled doorbell option keeps normal live media unavailable", async context => {
  const f = await fixture(context, "disabled");
  const sign = context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => contextValue);
  try {
    assert.equal(f.state.getCamera("synthetic-doorbell").streamSupported, false);
    await assert.rejects(f.provider.startStream("synthetic-doorbell"), /unavailable/);
    assert.equal(sign.mock.callCount(), 0);
  } finally { await f.close(); }
});

test("stopping a pending sign prevents late media and releases only the original trial", async context => {
  const f = await fixture(context);
  let finish!: (value: typeof contextValue) => void, entered!: () => void;
  const pending = new Promise<typeof contextValue>(resolve => { finish = resolve; });
  const entering = new Promise<void>(resolve => { entered = resolve; });
  context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => { entered(); return pending; });
  const starts = context.mock.method(DoorbellRtcSession.prototype, "start", async () => undefined);
  try {
    const release = f.provider.reserveDoorbellRtcTrial("synthetic-doorbell", new AbortController().signal);
    const failed = assert.rejects(f.provider.startStream("synthetic-doorbell"), error => error instanceof DoorbellRtcError && error.stage === "cancelled");
    await entering; await f.provider.stopStream("synthetic-doorbell");
    const next = f.provider.reserveDoorbellRtcTrial("synthetic-doorbell", new AbortController().signal);
    finish(contextValue); await failed; await release();
    assert.throws(() => f.provider.reserveDoorbellRtcTrial("synthetic-doorbell", new AbortController().signal));
    assert.equal(starts.mock.callCount(), 0); await next();
  } finally { finish(contextValue); await f.close(); }
});
