/**
 * Verifies HB3 E30 settings through production admission and state publication.
 * Synthetic inventory and mocked PPCS own every effect. These checks cover
 * one-send confirmation, restoration, missing state and revoked membership.
 */
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { cameraSettingProfile, readCameraSetting, type CameraSettingChange } from "../src/provider/camera-settings.js";
import { EufyProvider, safeInventoryReads } from "../src/provider/eufy-provider.js";
import type { ModelControlRoute } from "../src/provider/model-control-trials.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { buildReviewedCameraSettingPayload, FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";

const route: ModelControlRoute = { model: "T8171", deviceType: 88, peerModel: "T8030", homeBaseAttached: true, selfPeer: false, channel: 1 };
const settings = [
  { name: "cameraEnabled", parameter: 6250, inverted: true, field: "enabled", admission: "enableControlSupported" },
  { name: "audioRecording", parameter: 1288, inverted: true, field: "audioRecordingEnabled", admission: "audioRecordingControlSupported" },
  { name: "aiTracking", parameter: 6016, inverted: false, field: "aiTrackingEnabled", admission: "aiTrackingControlSupported" },
] as const;

for (const selected of settings) {
  test(`attached E30 ${selected.name} preserves native polarity and child envelope`, () => {
    for (const value of [false, true]) {
      const raw = Number(selected.inverted ? !value : value);
      const params = [{ param_type: selected.parameter, param_value: String(raw) }];
      assert.equal(readCameraSetting(params, "T8171", 88, false, selected.name), value);
      assert.equal(readCameraSetting([...params, ...params], "T8171", 88, false, selected.name), undefined);
      assert.equal(safeInventoryReads(params, 88, "T8171", false)[selected.field], value);
      const key = Buffer.alloc(32, 7), change = { setting: selected.name, value } as CameraSettingChange;
      const frame = buildReviewedCameraSettingPayload(change, route, "owner", key, 1, 1_800_000_000_000);
      const ciphertext = frame.payload.subarray(10);
      const decipher = createDecipheriv("aes-256-gcm", key, ciphertext.subarray(16, 28));
      decipher.setAAD(Buffer.from("eufy security")); decipher.setAuthTag(ciphertext.subarray(0, 16));
      const clear = Buffer.concat([decipher.update(ciphertext.subarray(32)), decipher.final()]);
      assert.deepEqual(JSON.parse(clear.toString()), selected.name === "aiTracking"
        ? { commandType: 6016, data: { value: raw } }
        : { account_id: "owner", cmd: selected.parameter, mChannel: 1, mValue3: 0,
          payload: selected.name === "audioRecording" ? { record_mute: raw, channel: 1 } : { switch: raw } });
      assert.equal(frame.command, selected.name === "aiTracking" ? 1700 : 1350);
      for (const variant of [{ ...route, channel: 2 }, { ...route, model: "T8171X" }, { ...route, deviceType: 89 },
        { ...route, peerModel: "T8010" }, { ...route, homeBaseAttached: false }, { ...route, selfPeer: true }]) {
        assert.equal(cameraSettingProfile(variant, selected.name), null);
        assert.throws(() => buildReviewedCameraSettingPayload(change, variant, "owner", key, 1, 1_800_000_000_000));
      }
    }
  });

  for (const mode of ["owner", "admin", "super-admin", "disabled", "no-api", "no-binding", "guest", "foreign-member", "parent-guest", "parent-owner", "missing-baseline", "duplicate-baseline", "outdoor", "duplicate-channel", "revoked-before", "revoked-after", "read-fails-after"] as const) {
    test(`attached E30 ${selected.name} confirms once and restores: ${mode}`, async context => {
      const directory = await mkdtemp(join(tmpdir(), "e30-setting-"));
      let actual = true, writes = 0, reads = 0;
      const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
      context.mock.method(globalThis, "setInterval", (() => ({ unref() {} })) as unknown as typeof setInterval);
      context.mock.method(globalThis, "clearInterval", (() => {}) as typeof clearInterval);
      context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
      context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (id: string) => id === (mode === "owner" ? "owner" : "member"));
      context.mock.method(MegaClient.prototype, "authenticatedBinding", () => mode === "no-binding" ? null : () => true);
      context.mock.method(MegaClient.prototype, "inventory", async () => {
        reads++;
        if (mode === "read-fails-after" && writes) throw Error("Inventory unavailable");
        const revoked = mode === "revoked-before" && reads > 1 || mode === "revoked-after" && writes > 0;
        const parameter = { param_type: selected.parameter, param_value: String(Number(selected.inverted ? !actual : actual)) };
        return { devices: [
          { device_sn: "base", device_model: "T8030", device_type: 18, category: "eufy_security", p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic",
            member: { admin_user_id: mode === "parent-owner" ? "foreign-owner" : "owner", member_user_id: "member", member_type: mode === "parent-guest" ? 0 : 1 } },
          { device_sn: "camera", parent_sn: "base", device_model: "T8171", device_type: 88, category: "eufy_security", device_channel: 1,
            member: { admin_user_id: "owner", member_user_id: mode === "foreign-member" ? "foreign" : "member", member_type: mode === "guest" || revoked ? 0 : mode === "super-admin" ? 2 : 1 },
            params: [{ param_type: 6271, param_value: mode === "outdoor" ? "1" : "0" },
              ...(mode === "missing-baseline" ? [] : mode === "duplicate-baseline" ? [parameter, parameter] : [parameter])] },
          ...(mode === "duplicate-channel" ? [{ device_sn: "other", parent_sn: "base", device_model: "T8113-Z", device_type: 8, device_channel: 1, member: { admin_user_id: "owner" }, params: [] }] : []),
        ] };
      });
      context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ base: { key: "synthetic", expiresAt: null } }));
      context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
      context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => {});
      context.mock.method(FirstPartyPpcsSession.prototype, "close");
      context.mock.method(FirstPartyPpcsSession.prototype, "writeReviewedCameraSetting", async (change: CameraSettingChange, _route: unknown, dispatch: () => void) => {
        dispatch(); writes++; actual = change.value as boolean;
      });
      const state = new GatewayState();
      const events = new Proxy({ camera: (identity: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(identity) },
        { get: (target, name) => Reflect.get(target, name) ?? (() => {}) }) as unknown as ProviderEvents;
      const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: directory,
        maxStreamSeconds: 120, experimentalModelControls: mode !== "disabled", apiAuthenticationConfigured: mode !== "no-api" });
      const invoke = async (value: boolean): Promise<void> => {
        if (selected.name === "cameraEnabled") await provider.setCameraEnabled("camera", value);
        else if (selected.name === "audioRecording") await provider.setCameraAudioRecording("camera", value);
        else await provider.setCameraAiTracking("camera", value);
      };
      try {
        await provider.start(events);
        assert.equal(state.getCamera("camera")[selected.admission], ["owner", "admin", "super-admin", "revoked-before", "revoked-after", "read-fails-after"].includes(mode));
        if (["owner", "admin", "super-admin"].includes(mode)) {
          await invoke(false); assert.equal(writes, 1); assert.equal(actual, false);
          await invoke(true); assert.equal(writes, 2); assert.equal(actual, true);
        } else {
          await assert.rejects(invoke(false));
          assert.equal(writes, mode === "revoked-after" || mode === "read-fails-after" ? 1 : 0);
          if (mode === "revoked-before" || mode === "revoked-after") assert.equal(state.getCamera("camera")[selected.admission], false);
        }
      } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); assert.equal(network.mock.callCount(), 0); }
    });
  }
}
