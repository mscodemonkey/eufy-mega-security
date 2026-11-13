/**
 * Exercises the exact C35 enablement trial through provider-owned confirmation.
 * Test-owned inventory and sessions forbid network activity and physical writes.
 * Existing settings tests supply deadline and unknown-outcome regression coverage.
 */
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { cameraSettingProfile, readCameraSetting, type CameraSettingChange } from "../src/provider/camera-settings.js";
import type { ModelControlRoute } from "../src/provider/model-control-trials.js";
import { buildReviewedCameraSettingPayload, FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";

const route: ModelControlRoute = { model: "T8110", deviceType: 10035, peerModel: "T8110", peerDeviceType: 10035,
  homeBaseAttached: false, selfPeer: true, channel: 0 };

/** Own a synthetic C35's privacy parameter and refuse external traffic. */
async function fixture(context: TestContext, options: { optIn?: boolean; owner?: boolean; apiAuth?: boolean; missing?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "c35-enabled-"));
  let privacy = 0, writes = 0, stops = 0;
  const params = () => options.missing ? [] : [{ param_type: 6250, param_value: `${privacy}` }];
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.method(MegaClient.prototype, "isAuthenticatedUser", () => options.owner !== false);
  context.mock.method(MegaClient.prototype, "authenticatedBinding", () => () => true);
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
    { device_sn: "synthetic-c35", device_model: "T8110", device_type: 10035, category: "eufy_security",
      device_channel: 0, p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic", member: { admin_user_id: "synthetic-owner" }, params: params() },
  ] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ "synthetic-c35": { key: "synthetic-key", expiresAt: null } }));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => {});
  context.mock.method(FirstPartyPpcsSession.prototype, "readCameraInfo", async () => params());
  context.mock.method(FirstPartyPpcsSession.prototype, "waitUntilClosed", async () => {});
  context.mock.method(FirstPartyPpcsSession.prototype, "close", function(this: FirstPartyPpcsSession) { stops++; this.output.end(); });
  context.mock.method(FirstPartyPpcsSession.prototype, "writeReviewedCameraSetting", async (change: CameraSettingChange, selected: ModelControlRoute, dispatch: () => void) => {
    assert.equal(change.setting, "cameraEnabled"); assert.equal(selected.model, "T8110"); dispatch(); writes++;
    privacy = change.value ? 0 : 1;
  });
  const identities = new Map<string, Parameters<ProviderEvents["camera"]>[0]>();
  const events = new Proxy({ camera: (value: Parameters<ProviderEvents["camera"]>[0]) => identities.set(value.serial, value) },
    { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory,
    maxStreamSeconds: 120, experimentalModelControls: options.optIn !== false, apiAuthenticationConfigured: options.apiAuth !== false });
  context.after(async () => { await provider.close(); assert.equal(network.mock.callCount(), 0); await rm(directory, { recursive: true, force: true }); });
  await provider.start(events);
  return { provider, identities, writes: () => writes, stops: () => stops };
}

test("C35 uses its own privacy parameter and one protected absolute request", () => {
  const key = Buffer.alloc(32, 5);
  const frame = buildReviewedCameraSettingPayload({ setting: "cameraEnabled", value: false }, route, "synthetic-owner", key, 1, 1791464400000);
  const encrypted = frame.payload.subarray(10), decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
  decipher.setAAD(Buffer.from("eufy security")); decipher.setAuthTag(encrypted.subarray(0, 16));
  assert.equal(frame.command, 1350);
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]).toString()),
    { account_id: "synthetic-owner", cmd: 6250, mChannel: 0, mValue3: 0, payload: { switch: 1 } });
  assert.equal(readCameraSetting([{ param_type: 6250, param_value: "0" }], "T8110", 10035, true, "cameraEnabled"), true);
  for (const params of [[], [{ param_type: 1035, param_value: "0" }], [{ param_type: 6250, param_value: true }],
    [{ param_type: 6250, param_value: "0" }, { param_type: 6250, param_value: "0" }]]) {
    assert.equal(readCameraSetting(params, "T8110", 10035, true, "cameraEnabled"), undefined);
  }
  for (const modified of [{ ...route, deviceType: 88 }, { ...route, model: "T8110X" }, { ...route, homeBaseAttached: true }, { ...route, channel: 1 }]) {
    assert.equal(cameraSettingProfile(modified, "cameraEnabled"), null);
  }
});

test("C35 trial publishes a fresh result after one write and retires its own session", async context => {
  const f = await fixture(context);
  assert.equal(f.identities.get("synthetic-c35")?.enableControlSupported, true);
  assert.equal((await f.provider.setCameraEnabled("synthetic-c35", false)).enabled, false);
  assert.equal(f.writes(), 1); assert.ok(f.stops() > 0);
});

for (const options of [{ optIn: false }, { owner: false }, { apiAuth: false }, { missing: true }]) {
  test(`C35 enablement refuses ${JSON.stringify(options)} without writing`, async context => {
    const f = await fixture(context, options);
    assert.equal(f.identities.get("synthetic-c35")?.enableControlSupported, false);
    await assert.rejects(f.provider.setCameraEnabled("synthetic-c35", false));
    assert.equal(f.writes(), 0);
  });
}

test("an active C35 view is preserved when the enablement trial is refused", async context => {
  const f = await fixture(context);
  await f.provider.startStream("synthetic-c35"); const stopped = f.stops();
  await assert.rejects(f.provider.setCameraEnabled("synthetic-c35", false));
  assert.equal(f.writes(), 0); assert.equal(f.stops(), stopped);
});
