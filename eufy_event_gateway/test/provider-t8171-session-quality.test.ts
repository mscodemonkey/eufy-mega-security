/**
 * Drives the production provider through synthetic inventory and owned media.
 * Cloud, push and PPCS effects are mocked. The tests verify fresh authority,
 * live-source retention and public session-state lifetime without hardware.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { ProviderEvents } from "../src/provider/provider.js";

for (const mode of ["ready", "idle", "disabled", "guest", "no-api", "no-binding", "changed-parent", "duplicate-child", "shared", "shared-guest", "shared-other-member", "shared-parent-role", "shared-changed-role"] as const) {
  test(`attached live quality keeps its exact active source and fresh authority: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "t8171-quality-"));
    let active = false, value: number | null = null, writes = 0, reads = 0, source: FirstPartyPpcsSession | undefined;
    context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (user: string) => mode.startsWith("shared") ? user === "member" : mode !== "guest");
    context.mock.method(MegaClient.prototype, "authenticatedBinding", () => mode === "no-binding" ? null : () => true);
    context.mock.method(MegaClient.prototype, "inventory", async () => {
      reads++;
      const camera = { device_sn: "camera", device_model: "T8171", device_type: 88, category: "eufy_security", parent_sn: "hub",
        device_channel: 1, member: { admin_user_id: "synthetic" }, params: [{ param_type: 1020, param_value: "3" }] };
      const parent = { device_sn: "hub", device_model: "T8030", device_type: 18, category: "eufy_security", parent_sn: "hub",
        p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic", member: { admin_user_id: "synthetic" }, params: [] };
      if (mode.startsWith("shared")) {
        Object.assign(camera.member, { member_type: mode === "shared-guest" ? 0 : 1, member_user_id: mode === "shared-other-member" ? "other" : "member" });
        Object.assign(parent.member, { member_type: mode === "shared-parent-role" ? 2 : 1, member_user_id: "member" });
        if (reads > 1 && mode === "shared-changed-role") Object.assign(camera.member, { member_type: 0 });
      }
      if (reads > 1 && mode === "changed-parent") parent.member.admin_user_id = "other";
      return { devices: reads > 1 && mode === "duplicate-child" ? [camera, camera, parent] : [camera, parent] };
    });
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ hub: { key: "synthetic", expiresAt: null } }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
    context.mock.method(FirstPartyPpcsSession.prototype, "start", async function (this: FirstPartyPpcsSession) {
      source = this; active = true; this.stats.videoOutputFrames = 0;
    });
    context.mock.getter(FirstPartyPpcsSession.prototype, "attachedQualityReady", () => active && (source?.stats.videoOutputFrames ?? 0) > 0);
    context.mock.getter(FirstPartyPpcsSession.prototype, "attachedStreamingQuality", () => active ? value : null);
    context.mock.method(FirstPartyPpcsSession.prototype, "writeAttachedStreamingQuality", async function (this: FirstPartyPpcsSession, quality: number) {
      assert.equal(this, source); assert.equal(active, true); writes++; value = quality;
    });
    const close = FirstPartyPpcsSession.prototype.close;
    context.mock.method(FirstPartyPpcsSession.prototype, "close", function (this: FirstPartyPpcsSession) {
      active = false; value = null; close.call(this);
    });
    const state = new GatewayState();
    const events = new Proxy({ camera: (identity: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(identity) },
      { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
    const provider = new EufyProvider({ username: "synthetic", password: "redacted", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalModelControls: mode !== "disabled", apiAuthenticationConfigured: mode !== "no-api" });
    try {
      await provider.start(events);
      assert.equal(state.getCamera("camera").reportedSettings?.streamingQualityTier, null);
      assert.equal(state.getCamera("camera").streamingQualityControlScope, "active_stream");
      if (mode === "ready" || mode === "idle" || mode === "shared") {
        assert.equal(state.getCamera("camera").streamingQualityControlReason, "live_view_required");
      }
      if (mode === "disabled") assert.equal(state.getCamera("camera").streamingQualityControlReason, "trial_disabled");
      if (mode === "shared-guest") assert.equal(state.getCamera("camera").streamingQualityControlReason, "account_membership_unconfirmed");
      if (mode !== "idle") {
        await provider.startStream("camera");
        source!.output.emit("data", Buffer.from([1]));
        source!.stats.videoOutputFrames++;
        await Promise.resolve();
      }
      if (mode === "ready" || mode === "shared") {
        assert.equal(state.getCamera("camera").streamingQualityControlSupported, true);
        assert.equal((await provider.setCameraStreamingQuality("camera", 1)).reportedSettings?.streamingQualityTier, 1);
        assert.equal(writes, 1); assert.equal(active, true);
        await provider.stopStream("camera");
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(state.getCamera("camera").reportedSettings?.streamingQualityTier, null);
        assert.equal(state.getCamera("camera").streamingQualityControlSupported, false);
      } else {
        await assert.rejects(provider.setCameraStreamingQuality("camera", 1));
        assert.equal(writes, 0);
      }
    } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

for (const parent of ["", "camera"]) {
  test(`standalone T8171 quality retains its existing writer with parent ${parent || "absent"}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "t8171-direct-quality-")); let value = 0, writes = 0;
    context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{
      device_sn: "camera", device_model: "T8171", device_type: 88, category: "eufy_security", parent_sn: parent,
      device_channel: 0, p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic", member: { admin_user_id: "synthetic" },
      params: [{ param_type: 1020, param_value: `${value}` }],
    }] }));
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ camera: { key: "synthetic", expiresAt: null } }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
    context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => {});
    context.mock.method(FirstPartyPpcsSession.prototype, "writeStreamingQuality", async (quality: number) => { writes++; value = quality; });
    const provider = new EufyProvider({ username: "synthetic", password: "redacted", country: "AU", persistentDirectory: directory, maxStreamSeconds: 120 });
    const state = new GatewayState();
    const events = new Proxy({ camera: (identity: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(identity) },
      { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
    try {
      await provider.start(events);
      assert.equal(state.getCamera("camera").streamingQualityControlScope, undefined);
      assert.equal((await provider.setCameraStreamingQuality("camera", 2)).reportedSettings?.streamingQualityTier, 2);
      assert.equal(writes, 1);
    } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
