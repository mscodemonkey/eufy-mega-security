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

for (const mode of ["valid", "attached", "root", "self", "unauthenticated", "hung-inventory", "disabled", "token", "shared", "missing-owner", "parent-owner", "model", "type", "parent", "channel", "ambiguous", "raw-duplicate", "changed", "binding", "inventory", "cancelled", "hung", "shutdown", "busy", "late"] as const) {
  test(`reported parameters: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "parameter-provider-"));
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    let bound = true, reads = 0;
    context.mock.method(MegaClient.prototype, "authenticatedBinding", () => mode === "unauthenticated" ? null : () => bound);
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (id: string) => mode !== "shared" && id === "owner");
    const attached = ["attached", "parent-owner", "parent", "channel", "ambiguous"].includes(mode);
    const sensor = { device_sn: "target", device_model: mode === "root" ? "T8030" : attached ? "T8417" : mode === "model" ? "T8410C" : "T8410",
      device_type: mode === "root" ? 18 : attached ? 105 : mode === "type" ? 105 : 31, device_channel: mode === "channel" ? 255 : 1,
      parent_sn: attached ? "station" : mode === "self" ? "target" : "", category: "eufy_security", member: { admin_user_id: mode === "missing-owner" ? "" : "owner" }, params: [] };
    const station = { device_sn: "station", device_model: mode === "parent" ? "T9000" : "T8030", device_type: 18,
      category: "eufy_security", member: { admin_user_id: mode === "parent-owner" ? "other" : "owner" }, params: [] };
    const inventory = context.mock.method(MegaClient.prototype, "inventory", async () => {
      reads++;
      if (reads > 1 && mode === "hung-inventory") await new Promise(() => undefined);
      if (reads > 1 && mode === "inventory") throw Error("SENTINEL_PRIVATE");
      return { devices: [station, { ...sensor, ...(mode === "changed" && reads > 2 ? { parent_sn: "changed" } : {}) },
        ...(mode === "raw-duplicate" && reads > 1 ? [{ ...sensor }] : []),
        ...(mode === "ambiguous" && reads > 1 ? [{ ...sensor, device_sn: "other" }] : [])] };
    });
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => undefined);
    context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [] }));
    context.mock.method(HomeBasePpcsSession.prototype, "close", () => undefined);
    const peer = context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => { throw Error("Peer forbidden"); });
    const controller = new AbortController();
    const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalModelControls: mode !== "disabled", apiAuthenticationConfigured: mode !== "token" });
    let callbackCount = 0;
    const events = new Proxy({}, { get: () => () => { callbackCount++; } }) as ProviderEvents;
    let resolve!: () => void;
    const query = context.mock.method(MegaClient.prototype, "readReportedParameters", async (_serial: string, model: ParameterCheckModel) => {
      if (mode === "binding") bound = false;
      if (mode === "shutdown") await provider.close();
      if (mode === "cancelled") controller.abort();
      if (["hung", "late", "busy"].includes(mode)) await new Promise<void>(done => { resolve = done; });
      return projectReportedParameters(model, { params: [] });
    });
    try {
      await provider.start(events); await new Promise(done => setImmediate(done));
      const before = callbackCount, beforeReads = reads;
      context.mock.timers.enable({ apis: ["setTimeout"], now: Date.now() });
      const operation = provider.readReportedParameters("target", controller.signal);
      const succeeds = ["valid", "attached", "root", "self", "busy"].includes(mode);
      const result = succeeds ? operation : assert.rejects(operation, ParameterCheckError);
      for (let index = 0; index < 10; index++) await new Promise(done => setImmediate(done));
      if (["busy", "hung", "late", "hung-inventory"].includes(mode)) {
        await assert.rejects(provider.readReportedParameters("target", new AbortController().signal), /busy/);
        if (mode === "busy") resolve();
        else context.mock.timers.tick(30_000);
      }
      await result;
      if (succeeds) { assert.equal(query.mock.callCount(), 1); assert.equal(reads, beforeReads + 2); assert.equal(callbackCount, before); }
      if (["hung", "late", "hung-inventory"].includes(mode)) {
        if (mode === "late") resolve();
        const next = provider.readReportedParameters("target", new AbortController().signal);
        const nextResult = assert.rejects(next, error => error instanceof ParameterCheckError && error.stage === "timeout");
        for (let index = 0; index < 10; index++) await new Promise(done => setImmediate(done));
        context.mock.timers.tick(30_000); await nextResult;
      }
      if (["disabled", "token", "unauthenticated", "shared", "missing-owner", "parent-owner", "model", "type", "parent", "channel"].includes(mode)) {
        assert.equal(reads, beforeReads); assert.equal(query.mock.callCount(), 0);
      }
      assert.equal(network.mock.callCount(), 0); assert.equal(peer.mock.callCount(), 0);
      assert.equal(inventory.mock.callCount(), reads);
    } finally { context.mock.timers.reset(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
