/**
 * Verifies manual parameter-read admission and cancellation using fake inventory.
 * The fixture owns all account facts. No cloud, peer, media or device command is
 * available, and returned candidates must never reach normal provider callbacks.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { ParameterCheckError, projectReportedParameters, type ParameterCheckModel } from "../src/provider/reported-parameter-check.js";

for (const mode of ["valid", "attached", "root", "self", "unauthenticated", "hung-inventory", "controls-off", "token", "shared", "shared-denied", "missing-owner", "parent-owner", "model", "type", "parent", "channel", "ambiguous", "raw-duplicate", "changed", "binding", "inventory", "cancelled", "hung", "shutdown", "busy", "late", "pir-hb2", "pir-hb3", "pir-standalone", "pir-self", "pir-alias", "pir-type", "pir-parent", "pir-channel", "pir-parent-owner", "pir-duplicate", "pir-shared-denied", "pir-missing-owner"] as const) {
  test(`reported parameters: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "parameter-provider-"));
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    let bound = true, reads = 0;
    context.mock.method(MegaClient.prototype, "authenticatedBinding", () => mode === "unauthenticated" ? null : () => bound);
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (id: string) => mode !== "shared" && id === "owner");
    const pir = mode.startsWith("pir-");
    const attached = (pir && !["pir-standalone", "pir-self"].includes(mode)) || ["attached", "parent-owner", "parent", "channel", "ambiguous"].includes(mode);
    const sensor = { device_sn: "target", device_model: pir ? mode === "pir-alias" ? "T8910C" : "T8910" : ["root", "controls-off"].includes(mode) ? "T8030" : attached ? "T8417" : mode === "model" ? "T8410C" : "T8410",
      device_type: pir ? mode === "pir-type" ? 2 : 10 : ["root", "controls-off"].includes(mode) ? 18 : attached ? 105 : mode === "type" ? 105 : 31, device_channel: ["channel", "pir-channel"].includes(mode) ? 255 : 1,
      parent_sn: attached ? "station" : ["self", "pir-self"].includes(mode) ? "target" : "", category: "eufy_security", member: { admin_user_id: ["missing-owner", "pir-missing-owner"].includes(mode) ? "" : "owner" }, params: [] };
    const station = { device_sn: "station", device_model: ["parent", "pir-parent"].includes(mode) ? "T9000" : mode === "pir-hb2" ? "T8010" : "T8030", device_type: mode === "pir-hb2" ? 0 : 18,
      category: "eufy_security", member: { admin_user_id: mode === "pir-missing-owner" ? "" : ["parent-owner", "pir-parent-owner"].includes(mode) ? "other" : "owner" }, params: [] };
    const inventory = context.mock.method(MegaClient.prototype, "inventory", async () => {
      reads++;
      if (reads > 1 && mode === "hung-inventory") await new Promise(() => undefined);
      if (reads > 1 && mode === "inventory") throw Error("SENTINEL_PRIVATE");
      return { devices: [station, { ...sensor, ...(mode === "changed" && reads > 2 ? { parent_sn: "changed" } : {}) },
        ...(mode === "raw-duplicate" && reads > 1 ? [{ ...sensor }] : []),
        ...(["ambiguous", "pir-duplicate"].includes(mode) && reads > 1 ? [{ ...sensor, device_sn: "other" }] : [])] };
    });
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => undefined);
    context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [] }));
    context.mock.method(HomeBasePpcsSession.prototype, "close", () => undefined);
    const peer = context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => { throw Error("Peer forbidden"); });
    const controller = new AbortController();
    const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalModelControls: false, apiAuthenticationConfigured: mode !== "token" });
    let callbackCount = 0;
    const events = new Proxy({}, { get: () => () => { callbackCount++; } }) as ProviderEvents;
    let resolve!: () => void;
    const query = context.mock.method(MegaClient.prototype, "readReportedParameters", async (_serial: string, model: ParameterCheckModel) => {
      if (["shared-denied", "pir-shared-denied"].includes(mode)) throw new ParameterCheckError("owner_account_required");
      if (mode === "binding") bound = false;
      if (mode === "shutdown") await provider.close();
      if (mode === "cancelled") controller.abort();
      if (["hung", "late", "busy"].includes(mode)) await new Promise<void>(done => { resolve = done; });
      return projectReportedParameters(model, { params: pir ? [{ param_type: 1605, param_value: Date.now() - 1_000 }] : [] });
    });
    try {
      await provider.start(events); await new Promise(done => setImmediate(done));
      const before = callbackCount, beforeReads = reads;
      context.mock.timers.enable({ apis: ["setTimeout"], now: Date.now() });
      const operation = provider.readReportedParameters("target", controller.signal);
      const succeeds = ["valid", "attached", "root", "controls-off", "self", "busy", "shared", "pir-hb2", "pir-hb3"].includes(mode);
      const localBindingFailure = ["missing-owner", "parent-owner", "pir-parent-owner", "pir-missing-owner"].includes(mode);
      const cloudRefusal = ["shared-denied", "pir-shared-denied"].includes(mode);
      const result = succeeds ? operation : assert.rejects(operation, error => error instanceof ParameterCheckError
        && (!localBindingFailure || error.stage === "owner_binding_unavailable")
        && (!cloudRefusal || error.stage === "owner_account_required"));
      for (let index = 0; index < 10; index++) await new Promise(done => setImmediate(done));
      if (["busy", "hung", "late", "hung-inventory"].includes(mode)) {
        await assert.rejects(provider.readReportedParameters("target", new AbortController().signal), /busy/);
        if (mode === "busy") resolve();
        else context.mock.timers.tick(30_000);
      }
      await result;
      if (succeeds && pir) assert.deepEqual((await operation).observations, { 1605: "recent" });
      if (pir) assert.equal(callbackCount, before);
      if (localBindingFailure) assert.equal(query.mock.callCount(), 0);
      if (cloudRefusal) assert.equal(query.mock.callCount(), 1);
      if (succeeds) { assert.equal(query.mock.callCount(), 1); assert.equal(reads, beforeReads + 2); assert.equal(callbackCount, before); }
      if (["hung", "late", "hung-inventory"].includes(mode)) {
        if (mode === "late") resolve();
        const next = provider.readReportedParameters("target", new AbortController().signal);
        const nextResult = assert.rejects(next, error => error instanceof ParameterCheckError && error.stage === "timeout");
        for (let index = 0; index < 10; index++) await new Promise(done => setImmediate(done));
        context.mock.timers.tick(30_000); await nextResult;
      }
      if (["token", "unauthenticated", "missing-owner", "parent-owner", "model", "type", "parent", "channel", "pir-standalone", "pir-self", "pir-alias", "pir-type", "pir-parent", "pir-channel", "pir-parent-owner"].includes(mode)) {
        assert.equal(reads, beforeReads); assert.equal(query.mock.callCount(), 0);
      }
      assert.equal(network.mock.callCount(), 0); assert.equal(peer.mock.callCount(), 0);
      assert.equal(inventory.mock.callCount(), reads);
    } finally { context.mock.timers.reset(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
