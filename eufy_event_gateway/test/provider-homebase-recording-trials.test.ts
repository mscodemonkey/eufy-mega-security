/**
 * Verifies owned recording trials across fresh account and route boundaries.
 * Synthetic inventory and mocked sessions own all effects. Provider results
 * reach the actual gateway state without contacting hardware or cloud services.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider, supportsExperimentalHomeBaseStoredRecordings } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";

for (const [model, deviceType] of [["T8113-Z", 8], ["T8210", 7]] as const) {
  for (const mode of ["owner", "admin", "super-admin", "disabled", "no-api", "no-binding", "no-key", "guest", "foreign-member", "parent-guest", "parent-owner", "hb2", "duplicate-channel", "duplicate-child", "revoked-before", "revoked-after", "account-before", "account-after"] as const) {
    test(`${model} recording trial checks fresh permission before and after retrieval: ${mode}`, async context => {
      const directory = await mkdtemp(join(tmpdir(), "hb-recording-trial-"));
      let reads = 0, queries = 0, bound = true;
      const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
      context.mock.method(globalThis, "setInterval", (() => ({ unref() {} })) as unknown as typeof setInterval);
      context.mock.method(globalThis, "clearInterval", (() => {}) as typeof clearInterval);
      context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
      context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (id: string) => id === (mode === "owner" ? "owner" : "member"));
      context.mock.method(MegaClient.prototype, "authenticatedBinding", () => mode === "no-binding" ? null : () => bound);
      context.mock.method(MegaClient.prototype, "inventory", async () => {
        reads++;
        const revoked = mode === "revoked-before" && reads > 1 || mode === "revoked-after" && reads > 2;
        const camera = { device_sn: "camera", device_model: model, device_type: deviceType, category: "eufy_security", parent_sn: "base", device_channel: 1,
          member: { admin_user_id: "owner", member_user_id: mode === "foreign-member" ? "foreign" : "member", member_type: mode === "guest" || revoked ? 0 : mode === "super-admin" ? 2 : 1 }, params: [] };
        return { devices: [
          { device_sn: "base", device_model: mode === "hb2" ? "T8010" : "T8030", device_type: mode === "hb2" ? 0 : 18,
            category: "eufy_security", p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic",
            member: { admin_user_id: mode === "parent-owner" ? "foreign-owner" : "owner", member_user_id: "member", member_type: mode === "parent-guest" ? 0 : 1 } },
          camera,
          ...(mode === "duplicate-child" ? [camera] : mode === "duplicate-channel" ? [{ ...camera, device_sn: "sibling" }] : []),
        ] };
      });
      context.mock.method(MegaClient.prototype, "dskKeys", async () => mode === "no-key" ? {} : { base: { key: "synthetic", expiresAt: null } });
      context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
      context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => { if (mode === "account-before") bound = false; });
      const close = context.mock.method(FirstPartyPpcsSession.prototype, "close");
      context.mock.method(FirstPartyPpcsSession.prototype, "listStoredRecordings", async () => {
        queries++; if (mode === "account-after") bound = false;
        return [{ storagePath: "/test/storage/Camera01/202611/20261116100000/20261116100000.zxvideo", startTime: "2026-11-16T00:00:00.000Z", endTime: "2026-11-16T00:00:02.000Z" }];
      });
      const state = new GatewayState();
      const events = new Proxy({ camera: (identity: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(identity) },
        { get: (target, name) => Reflect.get(target, name) ?? (() => {}) }) as unknown as ProviderEvents;
      const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: directory,
        maxStreamSeconds: 120, experimentalModelControls: mode !== "disabled", apiAuthenticationConfigured: mode !== "no-api" });
      try {
        await provider.start(events);
        assert.equal(state.getCamera("camera").storedRecordingsSupported,
          ["owner", "admin", "super-admin", "duplicate-child", "revoked-before", "revoked-after", "account-before", "account-after"].includes(mode));
        if (["owner", "admin", "super-admin"].includes(mode)) {
          const result = await provider.listStoredRecordings("camera", "2026-11-16");
          assert.equal(result.length, 1); assert.equal(queries, 1); assert.ok(close.mock.callCount() > 0);
          assert.equal(JSON.stringify(result).includes("zxvideo"), false);
        } else {
          await assert.rejects(provider.listStoredRecordings("camera", "2026-11-16"));
          assert.equal(queries, mode === "revoked-after" || mode === "account-after" ? 1 : 0);
        }
      } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); assert.equal(network.mock.callCount(), 0); }
    });
  }
}

test("nearby recording models cannot enter the HB3 trial", () => {
  const peer = { serial: "base", model: "T8030", deviceType: 18, category: "eufy_security", adminUserId: "owner" };
  const camera = { serial: "camera", model: "T8113-Z", deviceType: 8, category: "eufy_security", parentSerial: "base", channel: 1, adminUserId: "owner" };
  const route = { homeBaseAttached: true, peer };
  assert.equal(supportsExperimentalHomeBaseStoredRecordings(camera, route, true), true);
  for (const modified of [{ ...camera, model: "T8113" }, { ...camera, deviceType: 7 }, { ...camera, channel: -1 }, { ...camera, channel: 32 }]) {
    assert.equal(supportsExperimentalHomeBaseStoredRecordings(modified, route, true), false);
  }
  assert.equal(supportsExperimentalHomeBaseStoredRecordings(camera, { homeBaseAttached: false, peer }, true), false);
});
