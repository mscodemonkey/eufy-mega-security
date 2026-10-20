/**
 * Tests C31 admission and fresh confirmation with owned synthetic inventory and
 * sessions. No account is contacted and no physical control is actuated.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EufyProvider, nightVisionModes, parseMegaInventory, supportsAttachedDoorbellNightVision } from "../src/provider/eufy-provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";
import type { ProviderEvents } from "../src/provider/provider.js";

const parent = { device_sn: "base", device_model: "T8030", device_type: 18, category: "eufy_security", p2p_did: "fixture-peer", p2p_conn: "fixture-route", member: { admin_user_id: "owner" } };
const child = { device_sn: "camera", device_model: "T8223", device_type: 95, category: "eufy_security", parent_sn: "base", device_channel: 1, member: { admin_user_id: "owner" } };

/** Own startup, a real local-cache observation, offline writes and cleanup. */
async function fixture(context: TestContext, variant = "valid") {
  const directory = await mkdtemp(join(tmpdir(), "c31-night-"));
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  let mode = 1;
  const inventory = context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
    { ...parent, ...(variant === "owner" ? { member: {} } : {}), ...(variant === "parent" ? { device_model: "T9000", device_type: 27 } : {}), ...(variant === "peer" ? { p2p_did: "" } : {}) },
    { ...child, ...(variant === "type" ? { device_type: 96 } : {}), ...(variant === "model" ? { device_model: "T8210" } : {}), ...(variant === "standalone" ? { parent_sn: "camera" } : {}), ...(variant === "channel" ? { device_channel: null } : {}), ...(variant === "owner" ? { member: {} } : {}), params: variant === "unknown" ? [] : [{ param_type: 1277, param_value: String(mode) }] },
  ] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => variant === "dsk" ? {} : ({ base: { key: "fixture-key", expiresAt: null } }));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
  context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => undefined);
  context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [{ channel: 1, type: 1277, value: "1" }] }));
  context.mock.method(HomeBasePpcsSession.prototype, "close", () => undefined);
  const start = context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => undefined);
  const close = context.mock.method(FirstPartyPpcsSession.prototype, "close", () => undefined);
  const write = context.mock.method(FirstPartyPpcsSession.prototype, "writeNightVision", async (value: number) => { mode = value; });
  const auto = context.mock.method(FirstPartyPpcsSession.prototype, "writeAutoNightVision", async () => { throw Error("Wrong command"); });
  const state = new GatewayState();
  const events = new Proxy({ camera: (camera: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(camera) }, { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: directory, maxStreamSeconds: 120 });
  const schedule = globalThis.setTimeout;
  context.mock.method(globalThis, "setTimeout", (callback: () => void, milliseconds?: number) => schedule(callback, milliseconds === 2_000 ? 0 : milliseconds));
  await provider.start(events);
  await new Promise(resolve => setImmediate(resolve));
  return { provider, state, inventory, start, close, write, auto, setMode: (value: number) => { mode = value; }, dispose: async () => { await provider.close(); assert.equal(network.mock.callCount(), 0); await rm(directory, { recursive: true, force: true }); } };
}

test("exact profile requires normalized binary state and ready owned route", () => {
  const [base, camera] = parseMegaInventory({ devices: [parent, { ...child, params: [{ param_type: 1277, param_value: "1" }] }] });
  const route = { homeBaseAttached: true, peer: base! };
  for (const value of [0, 1, 2, undefined, null, true, "1", NaN, {}]) {
    const device = { ...camera!, reads: { nightVisionMode: value } } as typeof camera & {};
    const valid = value === 0 || value === 1;
    assert.equal(supportsAttachedDoorbellNightVision(device, route, true), valid);
    assert.deepEqual(nightVisionModes(device), valid ? [{ value: 0, name: "Off" }, { value: 1, name: "Auto night vision" }] : []);
  }
  for (const override of [{ model: "T8224" }, { deviceType: 96 }, { channel: null }, { channel: 255 }, { channel: 1.5 }, { adminUserId: "" }, { parentSerial: "other" }]) assert.equal(supportsAttachedDoorbellNightVision({ ...camera!, ...override }, route, true), false);
  assert.equal(supportsAttachedDoorbellNightVision(camera!, route, false), false);
  assert.equal(supportsAttachedDoorbellNightVision(camera!, { ...route, homeBaseAttached: false }, true), false);
  assert.equal(supportsAttachedDoorbellNightVision(camera!, { ...route, peer: { ...base!, model: "T8030-extra" } }, true), false);
});

for (const variant of ["valid", "type", "model", "standalone", "parent", "peer", "channel", "owner", "dsk", "unknown"]) {
  test(`discovery and dispatch admission: ${variant}`, async context => {
    const f = await fixture(context, variant);
    try {
      assert.equal(f.start.mock.callCount(), 0);
      if (variant === "model") {
        assert.equal(f.state.hasCamera("camera"), false);
        await assert.rejects(async () => f.provider.setCameraNightVision("camera", 0), /Unknown Eufy camera/);
        assert.equal(f.start.mock.callCount(), 0);
        return;
      }
      assert.equal(f.state.getCamera("camera").nightVisionControlSupported, variant === "valid");
      assert.equal(f.state.getCamera("camera").autoNightVisionControlSupported, false);
      if (variant !== "valid") {
        await assert.rejects(f.provider.setCameraNightVision("camera", 0), /requires|not supported/);
        assert.equal(f.start.mock.callCount(), 0);
        return;
      }
      for (const mode of [2, 3, -1, 1.5, "1", true, NaN]) await assert.rejects(f.provider.setCameraNightVision("camera", mode as number), /not supported|integer/);
      assert.equal(f.start.mock.callCount(), 0);
      assert.equal((await f.provider.setCameraNightVision("camera", 0)).nightVisionMode, 0);
      assert.equal(f.write.mock.callCount(), 1);
      assert.equal(f.close.mock.callCount(), 1);
      assert.equal(f.auto.mock.callCount(), 0);
    } finally { await f.dispose(); }
  });
}

test("stale local target cannot confirm mismatched fresh inventory", async context => {
  const f = await fixture(context);
  try {
    assert.equal(f.state.getCamera("camera").nightVisionMode, 1);
    f.setMode(0);
    context.mock.method(FirstPartyPpcsSession.prototype, "writeNightVision", async () => undefined);
    const before = f.inventory.mock.callCount();
    await assert.rejects(f.provider.setCameraNightVision("camera", 1), /not confirmed/);
    assert.equal(f.inventory.mock.callCount() - before, 12);
    assert.equal(f.state.getCamera("camera").nightVisionMode, 0);
  } finally { await f.dispose(); }
});

test("writes serialize through fresh confirmation", async context => {
  const f = await fixture(context);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const values: number[] = [];
  context.mock.method(FirstPartyPpcsSession.prototype, "writeNightVision", async (value: number) => { values.push(value); if (values.length === 1) await pending; f.setMode(value); });
  try {
    const first = f.provider.setCameraNightVision("camera", 0);
    const second = f.provider.setCameraNightVision("camera", 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(values, [0]);
    finish();
    assert.equal((await first).nightVisionMode, 0);
    assert.equal((await second).nightVisionMode, 1);
    assert.deepEqual(values, [0, 1]);
  } finally { finish(); await f.dispose(); }
});
