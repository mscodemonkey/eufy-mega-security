/**
 * Exercises attached C35 enablement through real provider admission and readback.
 * Synthetic inventory, account bindings and PPCS methods own every side effect.
 * Repository validation consumes these tests without contacting camera hardware.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";
import { GatewayState } from "../src/domain/gateway-state.js";

for (const mode of ["ready", "disabled", "guest", "no-api", "no-binding", "wrong-parent-owner",
  "duplicate-channel", "missing-read", "duplicate-read", "lost-baseline", "changed-binding", "pending-stream"] as const) {
  test(`attached C35 keeps owner, channel and fresh-read gates: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "c35-attached-"));
    let actual = 0, writes = 0, reads = 0, bound = true;
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(globalThis, "setInterval", (() => ({ unref() {} })) as unknown as typeof setInterval);
    context.mock.method(globalThis, "clearInterval", (() => {}) as typeof clearInterval);
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (id: string) => mode !== "guest" && id === "owner");
    context.mock.method(MegaClient.prototype, "authenticatedBinding", () => mode === "no-binding" ? null : () => bound);
    context.mock.method(MegaClient.prototype, "inventory", async () => {
      reads++;
      if (mode === "changed-binding" && reads > 1) bound = false;
      const params = mode === "missing-read" || mode === "lost-baseline" && reads > 1 ? []
        : Array.from({ length: mode === "duplicate-read" ? 2 : 1 }, () => ({ param_type: 1035, param_value: `${actual}` }));
      const camera = { device_sn: "camera", device_model: "T8110", device_type: 10035, category: "eufy_security",
        parent_sn: "station", device_channel: 2, member: { admin_user_id: "owner" }, params };
      return { devices: [camera, ...(mode === "duplicate-channel" ? [{ ...camera, device_sn: "other" }] : []),
        { device_sn: "station", device_model: "T8030", device_type: 18, category: "eufy_security",
          p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic", member: { admin_user_id: mode === "wrong-parent-owner" ? "other" : "owner" } }] };
    });
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ station: { key: "synthetic", expiresAt: null } }));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
    context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => {});
    context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [] }));
    context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => {});
    context.mock.method(FirstPartyPpcsSession.prototype, "writeReviewedCameraSetting", async (_change: unknown, _route: unknown, dispatch: () => void) => {
      dispatch(); writes++; actual = 1;
    });
    const state = new GatewayState();
    const events = new Proxy({ camera: (identity: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(identity) },
      { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
    const provider = new EufyProvider({ username: "synthetic", password: "redacted", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalModelControls: mode !== "disabled", apiAuthenticationConfigured: mode !== "no-api" });
    try {
      await provider.start(events);
      if (mode === "pending-stream") {
        const pending = provider.startStream("camera").catch(() => {});
        await assert.rejects(provider.setCameraEnabled("camera", false));
        await provider.stopStream("camera");
        await pending;
        assert.equal(writes, 0);
        return;
      }
      if (mode === "ready") {
        assert.equal(state.getCamera("camera").enableControlSupported, true);
        assert.equal((await provider.setCameraEnabled("camera", false)).enabled, false);
        assert.equal(writes, 1);
      } else {
        if (!["lost-baseline", "changed-binding"].includes(mode)) assert.equal(state.getCamera("camera").enableControlSupported, false);
        await assert.rejects(provider.setCameraEnabled("camera", false));
        assert.equal(writes, 0);
      }
    } finally {
      await provider.close(); await rm(directory, { recursive: true, force: true });
      assert.equal(network.mock.callCount(), 0);
    }
  });
}
