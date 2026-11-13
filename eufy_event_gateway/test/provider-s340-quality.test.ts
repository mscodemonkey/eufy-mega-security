/**
 * Exercises S340 opt-in quality through the real provider and fresh cloud reads.
 * Test-owned client and sessions forbid network activity and physical writes.
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
import type { CameraSettingChange } from "../src/provider/camera-settings.js";
import type { ModelControlRoute } from "../src/provider/model-control-trials.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";

/** Own a synthetic attached camera, state changes and all session retirement. */
async function fixture(context: TestContext, options: { optIn?: boolean; owner?: boolean; apiAuth?: boolean; mode?: number; parentOwner?: string; missingAfter?: boolean; missingBefore?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "s340-quality-"));
  let quality = 0, writes = 0, reads = 0, stops = 0;
  const logs: string[] = [];
  context.mock.method(process.stdout, "write", ((chunk: unknown) => {
    logs.push(String(chunk)); return true;
  }) as typeof process.stdout.write);
  const network = context.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.method(MegaClient.prototype, "isAuthenticatedUser", () => options.owner !== false);
  context.mock.method(MegaClient.prototype, "authenticatedBinding", () => () => true);
  context.mock.method(MegaClient.prototype, "inventory", async () => {
    reads++;
    return { devices: [
      { device_sn: "synthetic-parent", device_model: "T8030", device_type: 18, category: "eufy_security",
        p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic", member: { admin_user_id: options.parentOwner ?? "synthetic-owner" }, params: [] },
      { device_sn: "synthetic-child", device_model: "T8170", device_type: 48, category: "eufy_security", parent_sn: "synthetic-parent",
        device_channel: 5, member: { admin_user_id: "synthetic-owner" }, params: writes && options.missingAfter || reads > 1 && options.missingBefore ? [] : [
          { param_type: 6243, param_value: String(options.mode ?? 0) },
          { param_type: 2730, param_value: Buffer.from(JSON.stringify({ mode_0: { quality }, mode_1: { quality: 2 } })).toString("base64") },
        ] },
    ] };
  });
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ "synthetic-parent": { key: "synthetic-key", expiresAt: null } }));
  context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => {});
  context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [] }));
  context.mock.method(HomeBasePpcsSession.prototype, "close", () => {});
  context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => {});
  context.mock.method(FirstPartyPpcsSession.prototype, "waitUntilClosed", async () => {});
  context.mock.method(FirstPartyPpcsSession.prototype, "close", function(this: FirstPartyPpcsSession) { stops++; this.output.end(); });
  context.mock.method(FirstPartyPpcsSession.prototype, "writeReviewedCameraSetting", async (change: CameraSettingChange, route: ModelControlRoute, dispatch: () => void) => {
    assert.equal(route.liveQualityVideoMode, 0); assert.equal(route.channel, 5); dispatch(); writes++; quality = change.value as number;
  });
  const identities = new Map<string, Parameters<ProviderEvents["camera"]>[0]>();
  const events = new Proxy({ camera: (value: Parameters<ProviderEvents["camera"]>[0]) => identities.set(value.serial, value) },
    { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory,
    maxStreamSeconds: 120, experimentalModelControls: options.optIn !== false, apiAuthenticationConfigured: options.apiAuth !== false });
  context.after(async () => { await provider.close(); assert.equal(network.mock.callCount(), 0); await rm(directory, { recursive: true, force: true }); });
  await provider.start(events);
  return { provider, identities, logs, writes: () => writes, reads: () => reads, stops: () => stops };
}

test("S340 quality is published only after one write and a fresh matching mode-zero read", async context => {
  const f = await fixture(context);
  assert.equal(f.identities.get("synthetic-child")?.streamingQualityControlSupported, true);
  assert.equal(f.identities.get("synthetic-child")?.streamingQualityControlReason, "ready");
  assert.deepEqual(f.identities.get("synthetic-child")?.streamingQualityModes?.map(row => row.name), ["Auto", "HD (720P)", "Full HD (1080P)", "3K"]);
  const changed = await f.provider.setCameraStreamingQuality("synthetic-child", 3);
  assert.equal(changed.reportedSettings?.streamingQualityTier, 3);
  assert.equal(f.writes(), 1); assert.ok(f.reads() >= 3);
});

for (const [options, reason] of [
  [{ optIn: false }, "trial_disabled"], [{ owner: false }, "owner_account_required"],
  [{ apiAuth: false }, "api_authentication_required"], [{ mode: 12 }, "live_mode_unconfirmed"],
  [{ parentOwner: "foreign-owner" }, "parent_owner_mismatch"],
] as const) {
  test(`S340 quality admission rejects ${JSON.stringify(options)}`, async context => {
    const f = await fixture(context, options);
    assert.equal(f.identities.get("synthetic-child")?.streamingQualityControlSupported, false);
    assert.equal(f.identities.get("synthetic-child")?.streamingQualityControlReason, reason);
    const admission = f.logs.filter(line => line.includes("event=camera_s340_quality_admission"));
    assert.equal(admission.length, 1);
    assert.ok(admission[0]!.endsWith(`model=T8170 reason=${reason}\n`));
    assert.ok(!admission[0]!.includes("synthetic-owner") && !admission[0]!.includes("synthetic-child"));
    await assert.rejects(f.provider.setCameraStreamingQuality("synthetic-child", 3));
    assert.equal(f.writes(), 0);
  });
}

test("S340 missing confirmation remains unknown without resending or retaining the old quality", async context => {
  const f = await fixture(context, { missingAfter: true });
  await assert.rejects(f.provider.setCameraStreamingQuality("synthetic-child", 3));
  assert.equal(f.writes(), 1);
  assert.equal(f.identities.get("synthetic-child")?.reportedSettings?.streamingQualityTier, null);
});

test("an active S340 view blocks the preference write without stopping that view", async context => {
  const f = await fixture(context);
  await f.provider.startStream("synthetic-child");
  const before = f.stops();
  await assert.rejects(f.provider.setCameraStreamingQuality("synthetic-child", 3), /Wait for other/);
  assert.equal(f.stops(), before);
  assert.equal(f.writes(), 0);
});


test("S340 vanished fresh baseline withdraws stale state before any write", async context => {
  const f = await fixture(context, { missingBefore: true });
  await assert.rejects(f.provider.setCameraStreamingQuality("synthetic-child", 3));
  assert.equal(f.writes(), 0);
  assert.equal(f.identities.get("synthetic-child")?.streamingQualityControlSupported, false);
  assert.equal(f.identities.get("synthetic-child")?.reportedSettings?.streamingQualityTier, null);
});

test("an unchanged fresh S340 preference needs no write", async context => {
  const f = await fixture(context);
  await f.provider.setCameraStreamingQuality("synthetic-child", 0);
  assert.equal(f.writes(), 0);
});


test("a pending S340 view start blocks the preference write", async context => {
  const f = await fixture(context);
  const starting = f.provider.startStream("synthetic-child");
  await assert.rejects(f.provider.setCameraStreamingQuality("synthetic-child", 3), /Wait for other/);
  await starting;
  assert.equal(f.writes(), 0);
});
