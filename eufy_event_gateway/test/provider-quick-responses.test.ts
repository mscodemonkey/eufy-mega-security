/**
 * Exercises saved-reply peer ownership through the production provider.
 * Fixtures own cloud, push and device effects. No actual playback is possible.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";

for (const mode of ["success", "disabled", "changed-account", "removed-slot", "duplicate-channel", "live-busy", "disconnect-held"]) {
  test(`saved reply provider ${mode} preserves its account, slot and peer reservation`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "quick-response-provider-"));
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.getter(MegaClient.prototype, "isAuthenticated", () => true);
    let bound = true;
    context.mock.method(MegaClient.prototype, "authenticatedBinding", () => () => bound);
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", () => false);
    const rows = [
      { device_sn: "base", device_model: "T8030", device_type: 18, category: "eufy_security",
        member: { admin_user_id: "synthetic-owner" }, p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic" },
      ...["camera", ...(mode === "duplicate-channel" ? ["duplicate"] : [])].map(device_sn => ({ device_sn,
        device_model: "T8210", device_type: 7, category: "eufy_security", parent_sn: "base", device_channel: 4,
        member: { admin_user_id: "synthetic-owner" } })),
    ];
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: rows }));
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ base: { key: "synthetic", expiresAt: null } }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
    context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => {});
    context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [] }));
    context.mock.method(FirstPartyPpcsSession.prototype, "readCameraInfo", async () => []);
    context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => {});
    context.mock.method(FirstPartyPpcsSession.prototype, "close", function(this: FirstPartyPpcsSession) {
      this.stats.closeReason = "client_stop"; this.output.end();
    });
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const disconnecting = new Promise<void>(resolve => { entered = resolve; });
    context.mock.method(FirstPartyPpcsSession.prototype, "waitUntilClosed", async () => {
      if (mode === "disconnect-held") { entered(); await held; }
    });
    const queries = context.mock.method(FirstPartyPpcsSession.prototype, "queryQuickResponses", async () => {
      if (mode === "changed-account") bound = false;
      return mode === "removed-slot" ? [] : [{ id: 100, name: "Synthetic reply", custom: true }];
    });
    const writes = context.mock.method(FirstPartyPpcsSession.prototype, "playQuickResponse", async (_id: number, current: () => void) => { current(); });
    const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU",
      persistentDirectory: directory, maxStreamSeconds: 120, experimentalModelControls: mode !== "disabled", apiAuthenticationConfigured: true });
    try {
      await provider.start(new Proxy({}, { get: () => () => {} }) as ProviderEvents);
      await new Promise(resolve => setImmediate(resolve));
      if (mode === "live-busy") await provider.startStream("camera");
      if (["disabled", "changed-account", "removed-slot", "duplicate-channel", "live-busy"].includes(mode)) {
        await assert.rejects(provider.playQuickResponse("camera", 100));
        assert.equal(writes.mock.callCount(), 0);
        if (mode === "live-busy" || mode === "disabled") assert.equal(queries.mock.callCount(), 0);
      } else if (mode === "disconnect-held") {
        const playing = provider.playQuickResponse("camera", 100); await disconnecting;
        await assert.rejects(provider.getQuickResponses("camera"), /stage=busy/);
        release(); await playing;
      } else {
        assert.equal((await provider.getQuickResponses("camera"))[0]!.id, 100);
        assert.equal(writes.mock.callCount(), 0);
        await provider.playQuickResponse("camera", 100);
        assert.equal(writes.mock.callCount(), 1);
      }
    } finally { release(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
    assert.equal(network.mock.callCount(), 0);
  });
}
