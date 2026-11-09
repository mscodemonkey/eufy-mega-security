/**
 * Exercises the T8910 list comparison under a synthetic shared account.
 * Fake clocks own the observation window. No network or peer is available,
 * and diagnostic snapshots must never reach normal provider callbacks.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { ParameterCheckError } from "../src/provider/reported-parameter-check.js";

for (const mode of ["advanced", "hb2", "unchanged", "regressed", "missing", "absent-params", "future", "duplicate-param", "changed", "account", "cancel", "shutdown", "duplicate-device", "hung", "disabled", "wrong-model", "wrong-parent", "ambiguous", "busy"] as const) {
  test(`shared T8910 device-list comparison: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "device-list-motion-")), now = Date.now();
    let reads = 0, callbacks = 0, bound = true;
    context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "authenticatedBinding", () => () => bound);
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", () => false);
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    const forbidden = context.mock.method(MegaClient.prototype, "readReportedParameters", async () => { throw Error("Owner endpoint forbidden"); });
    const peer = context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => { throw Error("Peer forbidden"); });
    const controller = new AbortController();
    context.mock.method(MegaClient.prototype, "inventory", async (_signal?: AbortSignal, options?: { includeChargingDays?: boolean }) => {
      reads++;
      if (reads > 1) assert.equal(options?.includeChargingDays, false);
      if (reads > 1 && mode === "hung") return await new Promise<never>(() => undefined);
      const value = mode === "future" ? now + 300_000 : mode === "regressed" && reads > 2 ? now - 20_000
        : mode === "unchanged" || reads < 3 ? now - 5_000 : now;
      const params = mode === "missing" ? [] : [{ param_type: 1605, param_value: value },
        ...(mode === "duplicate-param" ? [{ param_type: 1605, param_value: value }] : [])];
      const sensor = { device_sn: "target", device_model: mode === "wrong-model" ? "T8910X" : "T8910", device_type: 10,
        device_channel: 1, parent_sn: reads > 2 && mode === "changed" ? "changed" : "station", category: "eufy_security", ...(mode === "absent-params" ? {} : { params }) };
      const parent = { device_sn: "station", device_model: mode === "wrong-parent" ? "T9000" : mode === "hb2" ? "T8010" : "T8030", device_type: mode === "hb2" ? 0 : 18,
        category: "eufy_security", member: { admin_user_id: "parent-owner" }, params: [] };
      return { devices: [parent, sensor, ...(reads > 1 && mode === "duplicate-device" ? [sensor] : []),
        ...(reads > 1 && mode === "ambiguous" ? [{ ...sensor, device_sn: "sibling" }] : [])] };
    });
    const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalModelControls: mode !== "disabled", apiAuthenticationConfigured: true });
    try {
      await provider.start(new Proxy({}, { get: (_target, key) => () => { if (["sensorMotion", "sensor", "camera", "snapshot"].includes(String(key))) callbacks++; } }) as ProviderEvents);
      const baseline = callbacks;
      context.mock.timers.enable({ apis: ["setTimeout"] });
      const operation = provider.readReportedParameters("target", controller.signal, "device_list");
      const success = ["advanced", "hb2", "unchanged", "regressed", "missing", "absent-params", "future", "duplicate-param", "busy"].includes(mode);
      const result = success ? operation : assert.rejects(operation, ParameterCheckError);
      await new Promise(resolve => setImmediate(resolve));
      if (mode === "busy") await assert.rejects(provider.readReportedParameters("target", controller.signal, "device_list"), ParameterCheckError);
      if (mode === "account") bound = false;
      if (mode === "cancel") controller.abort();
      if (mode === "shutdown") await provider.close();
      context.mock.timers.tick(mode === "hung" ? 30_000 : 10_000);
      const value = await result;
      if (success) {
        assert.equal(value?.source, "device_list");
        assert.equal(value?.change, ["missing", "absent-params", "future", "duplicate-param"].includes(mode) ? "unavailable" : ["busy", "hb2"].includes(mode) ? "advanced" : mode);
        assert.equal(reads, 3);
      }
      assert.equal(callbacks, baseline);
      assert.equal(forbidden.mock.callCount(), 0);
      assert.equal(peer.mock.callCount(), 0);
    } finally { context.mock.timers.reset(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
