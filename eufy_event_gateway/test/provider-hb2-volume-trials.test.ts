/**
 * Verifies independent HB2 volume admission and one-write local confirmation.
 * Mocked inventory and station sessions own all effects. Production station
 * events expose only confirmed results, including unknown state after failure.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HomeBaseState } from "../src/domain/types.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { HomeBaseCommandAcknowledgementTimeoutError, HomeBasePpcsSession, type HomeBasePpcsState } from "../src/stream/homebase-ppcs.js";

for (const field of ["promptVolume", "alarmVolume"] as const) {
  for (const mode of ["owner", "admin", "super-admin", "disabled", "no-api", "no-binding", "guest", "foreign-member", "missing-baseline", "read-missing", "wrong-type", "revoked-before", "revoked-after", "account-during-read", "read-fails-after", "ack-missing", "alarm-unknown"] as const) {
    test(`HB2 ${field} requires its own fresh baseline and restores once: ${mode}`, async context => {
      const directory = await mkdtemp(join(tmpdir(), "hb2-volume-"));
      let actual = 16, writes = 0, phase = "warm", bound = true;
      const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
      context.mock.method(globalThis, "setInterval", (() => ({ unref() {} })) as unknown as typeof setInterval);
      context.mock.method(globalThis, "clearInterval", (() => {}) as typeof clearInterval);
      context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
      context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (id: string) => id === (mode === "owner" ? "owner" : "member"));
      context.mock.method(MegaClient.prototype, "authenticatedBinding", () => mode === "no-binding" ? null : () => bound);
      context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ device_sn: "SYNTHETIC1234567", device_model: "T8010",
        device_type: mode === "wrong-type" ? 18 : 0, category: "eufy_security", p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic",
        member: { admin_user_id: "owner", member_user_id: mode === "foreign-member" ? "foreign" : "member",
          member_type: mode === "guest" || phase === "control" && mode === "revoked-before" || writes > 0 && mode === "revoked-after" ? 0 : mode === "super-admin" ? 2 : 1 }, params: [] }] }));
      context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ SYNTHETIC1234567: { key: "synthetic", expiresAt: null } }));
      context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
      context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => {});
      context.mock.method(HomeBasePpcsSession.prototype, "close", () => {});
      context.mock.method(HomeBasePpcsSession.prototype, "waitUntilClosed", async () => {});
      context.mock.method(HomeBasePpcsSession.prototype, "readState", async (): Promise<HomeBasePpcsState> => {
        if (mode === "read-fails-after" && writes) throw Error("Read unavailable");
        if (mode === "account-during-read" && phase === "control") bound = false;
        const state: HomeBasePpcsState = { firmware: null, guardMode: null, effectiveMode: null,
          alarmVolume: mode === "alarm-unknown" ? null : field === "alarmVolume" ? actual : 16,
          alarmVolumeObservation: mode === "alarm-unknown" ? "missing" : "valid", promptVolume: field === "promptVolume" ? actual : 16,
          alarmTone: null, storage: null, storageDiagnostic: null, childParams: [] };
        return mode === "missing-baseline" || mode === "read-missing" && phase === "control" ? { ...state, [field]: null } : state;
      });
      const write = async (value: number): Promise<void> => {
        writes++; actual = value;
        if (mode === "ack-missing") throw new HomeBaseCommandAcknowledgementTimeoutError();
      };
      context.mock.method(HomeBasePpcsSession.prototype, "setPromptVolume", write);
      context.mock.method(HomeBasePpcsSession.prototype, "setAlarmVolume", write);
      const stations = new Map<string, HomeBaseState>();
      const events = new Proxy({ station: (state: HomeBaseState) => stations.set(state.serial, state) },
        { get: (target, name) => Reflect.get(target, name) ?? (() => {}) }) as unknown as ProviderEvents;
      const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: directory,
        maxStreamSeconds: 120, experimentalModelControls: mode !== "disabled", apiAuthenticationConfigured: mode !== "no-api" });
      const invoke = (value: number) => field === "promptVolume" ? provider.setPromptVolume("SYNTHETIC1234567", value) : provider.setAlarmVolume("SYNTHETIC1234567", value);
      const flag = field === "promptVolume" ? "promptVolumeControlSupported" : "alarmVolumeControlSupported";
      try {
        await provider.start(events);
        if (mode === "wrong-type") {
          await assert.rejects(provider.refreshStation("SYNTHETIC1234567"));
          await assert.rejects(invoke(17));
          assert.equal(writes, 0);
          return;
        }
        await provider.refreshStation("SYNTHETIC1234567");
        const initiallyReady = ["owner", "admin", "super-admin", "read-missing", "revoked-before", "revoked-after", "account-during-read", "read-fails-after", "ack-missing"].includes(mode)
          || mode === "alarm-unknown" && field === "promptVolume";
        assert.equal(stations.get("SYNTHETIC1234567")?.[flag] === true, initiallyReady);
        assert.equal(stations.get("SYNTHETIC1234567")?.controlsSupported, false);
        if (mode === "alarm-unknown") assert.notEqual(stations.get("SYNTHETIC1234567")?.alarmVolumeControlSupported, true);
        phase = "control";
        if (["owner", "admin", "super-admin", "ack-missing"].includes(mode) || mode === "alarm-unknown" && field === "promptVolume") {
          assert.equal((await invoke(17))[field], 17); assert.equal(writes, 1);
          assert.equal((await invoke(16))[field], 16); assert.equal(writes, 2); assert.equal(actual, 16);
        } else {
          await assert.rejects(invoke(17));
          assert.equal(writes, mode === "revoked-after" || mode === "read-fails-after" ? 1 : 0);
          if (writes) {
            assert.equal(stations.get("SYNTHETIC1234567")?.[field], null);
            assert.notEqual(stations.get("SYNTHETIC1234567")?.[flag], true);
          }
        }
      } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); assert.equal(network.mock.callCount(), 0); }
    });
  }
}
