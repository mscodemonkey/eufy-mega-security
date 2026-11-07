/**
 * Qualify C35 manual-light ownership, encrypted commands and fresh confirmation.
 * Fixtures own all accounts and responses. No hardware or vendor code executes.
 */
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modelControlTrialActions, type ModelControlRoute, type ModelControlTrial } from "../src/provider/model-control-trials.js";
import { EufyProvider, safeInventoryReads } from "../src/provider/eufy-provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { FirstPartyPpcsSession, buildModelControlTrialPayload } from "../src/stream/first-party-ppcs.js";
import type { ProviderEvents } from "../src/provider/provider.js";
const route: ModelControlRoute = { model: "T8110", deviceType: 10035, channel: 0,
  homeBaseAttached: false, selfPeer: true, peerModel: "T8110" };

test("C35 manual switch keeps its exact route and level-one frame separate from master enable", () => {
  assert.deepEqual(modelControlTrialActions(route), ["spotlight"]);
  for (const patch of [{ model: "T8110S" }, { deviceType: 1 }, { channel: 1 }, { selfPeer: false },
    { homeBaseAttached: true }, { peerModel: "T8030" }]) assert.deepEqual(modelControlTrialActions({ ...route, ...patch }), []);
  const key = Buffer.alloc(16, 9);
  for (const enabled of [true, false]) {
    const frame = buildModelControlTrialPayload({ action: "spotlight", enabled }, route, "synthetic", key, null, 1, 1_800_000_000_000);
    assert.equal(frame.command, 1700);
    const cipher = createDecipheriv("aes-128-ecb", key, null); cipher.setAutoPadding(false);
    const plain = Buffer.concat([cipher.update(frame.payload.subarray(10)), cipher.final()]).toString().replace(/\0+$/, "");
    assert.deepEqual(JSON.parse(plain), { commandType: 1400, data: { value: enabled ? 1 : 0,
      open: enabled ? 1 : 0, type: 2, transaction: "1800000000000" } });
  }
  assert.equal(safeInventoryReads([{ param_type: 1400, param_value: "0" }, { param_type: 1403, param_value: "1" }], 10035, "T8110", true).spotlightEnabled, false);
  assert.equal(safeInventoryReads([{ param_type: 1400, param_value: "1" }], 10035, "T8110", false).spotlightEnabled, undefined);
});

for (const mode of ["ready", "disabled", "guest", "unknown-state", "failed-confirmation"]) {
  test(`C35 provider light confirmation: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "c35-light-"));
    let light = false, writes = 0;
    context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(globalThis, "setInterval", (() => ({ unref() {} })) as unknown as typeof setInterval);
    context.mock.method(globalThis, "clearInterval", (() => {}) as typeof clearInterval);
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", () => mode !== "guest");
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ device_sn: "test", device_model: "T8110", device_type: 10035,
      category: "eufy_security", parent_sn: "test", device_channel: 0, member: { admin_user_id: "synthetic" },
      p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic", params: [{ param_type: 1400, param_value: "0" }] }] }));
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ test: { key: "synthetic", expiresAt: null } }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
    context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => {});
    context.mock.method(FirstPartyPpcsSession.prototype, "close", () => {});
    context.mock.method(FirstPartyPpcsSession.prototype, "readCameraInfo", async () => mode === "unknown-state" ? [] : [{ param_type: 1400, param_value: light ? "1" : "0" }]);
    context.mock.method(FirstPartyPpcsSession.prototype, "writeModelControlTrial", async (request: ModelControlTrial) => {
      assert.equal(request.action, "spotlight"); writes++;
      if (request.action === "spotlight" && mode !== "failed-confirmation") light = request.enabled;
    });
    const provider = new EufyProvider({ username: "synthetic", password: "redacted", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalModelControls: mode !== "disabled", apiAuthenticationConfigured: true });
    try {
      await provider.start(new Proxy({}, { get: () => () => {} }) as ProviderEvents);
      if (mode === "ready") { await provider.setCameraLight("test", true); assert.equal(light, true); assert.equal(writes, 1); }
      else { await assert.rejects(provider.setCameraLight("test", true)); assert.equal(writes, mode === "failed-confirmation" ? 1 : 0); }
    } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
