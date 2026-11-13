/**
 * Exercises T8442 admission, HomeBase child routing and event ownership through
 * the real provider. Test-owned inventory, transport and image mocks forbid
 * network and device operations. These checks do not prove camera playback.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver, parsePushEvent, type MegaPushEvent } from "../src/mega/push.js";
import { EufyProvider, isSupportedMegaCamera, ppcsStreamRoute, isPpcsStreamSupported, parseMegaInventory } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";

/** Own synthetic inventory and callback delivery until provider retirement. */
async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "t8442-"));
  const network = context.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  const parent = { device_sn: "synthetic-parent", device_model: "T8030", device_type: 18, category: "eufy_security",
    p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic", member: { admin_user_id: "synthetic-owner" }, params: [] };
  const children = [1, 3, 5].map(channel => ({ device_sn: `synthetic-${channel}`, device_model: "T8442", device_type: 46,
    category: "eufy_security", parent_sn: parent.device_sn, device_channel: channel,
    member: { admin_user_id: "synthetic-owner" }, params: [{ param_type: 1101, param_value: "100" },
      { param_type: 1035, param_value: "1" }, { param_type: 1277, param_value: "1" }, { param_type: 1015, param_value: "1" }] }));
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [parent, ...children] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ [parent.device_sn]: { key: "synthetic-key", expiresAt: null } }));
  context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => {});
  context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [] }));
  context.mock.method(HomeBasePpcsSession.prototype, "close", () => {});
  let deliver!: (event: MegaPushEvent) => void;
  context.mock.method(MegaPushReceiver.prototype, "start", async function(this: MegaPushReceiver) {
    deliver = Reflect.get(this, "onEvent") as typeof deliver;
  });
  const images = new Map<string, Buffer>(), detections: Array<[string, string]> = [], streams: string[] = [];
  const state = new GatewayState();
  const identities = new Map<string, Parameters<ProviderEvents["camera"]>[0]>();
  const events = new Proxy({
    camera: (camera: Parameters<ProviderEvents["camera"]>[0]) => { identities.set(camera.serial, camera); state.registerCamera(camera); },
    person: (serial: string) => detections.push([serial, "person"]),
    motion: (serial: string) => detections.push([serial, "motion"]),
    detection: (serial: string, kind: string) => detections.push([serial, kind]),
    snapshot: (serial: string, data: Buffer) => images.set(serial, Buffer.from(data)),
    streamStarted: (serial: string) => streams.push(serial),
  }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory, maxStreamSeconds: 120 });
  context.after(async () => { await provider.close(); assert.equal(network.mock.callCount(), 0); await rm(directory, { recursive: true, force: true }); });
  return { provider, events, state, identities, parent, children, images, detections, streams, deliver: (value: MegaPushEvent) => deliver(value) };
}

/** Let independent event-picture work settle without moving protocol clocks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

test("exact T8442/46 creates separate cameras without enabling controls or startup wakes", async context => {
  const f = await fixture(context);
  await f.provider.start(f.events);
  for (const child of f.children) {
    const camera = f.identities.get(child.device_sn)!;
    assert.equal(f.state.getCamera(child.device_sn).model, "T8442");
    assert.equal(camera.model, "T8442"); assert.equal(camera.stationSerial, f.parent.device_sn);
    assert.equal(camera.catalogueStatus, "ready_to_test"); assert.equal(camera.streamSupported, true);
    assert.equal(camera.battery, null);
    assert.equal(camera.startupSnapshotSupported, false); assert.equal(camera.liveAudioSupported, false);
    assert.deepEqual(camera.supportedDetections, ["motion", "person", "pet", "vehicle"]);
    for (const [name, value] of Object.entries(camera)) if (name.endsWith("ControlSupported")) assert.equal(value, false, name);
    for (const write of [() => f.provider.setCameraEnabled(child.device_sn, false),
      () => f.provider.setCameraMotionDetection(child.device_sn, false), () => f.provider.setCameraNightVision(child.device_sn, 0),
      () => f.provider.setCameraSiren(child.device_sn, 1)]) {
      assert.throws(write, /T8442 camera controls/);
    }
    await assert.rejects(f.provider.setCameraSetting(child.device_sn, { setting: "motionDetection", value: false }), /T8442 camera controls/);
  }
  for (const device of [{ model: "T8442", deviceType: 45 }, { model: "T8441", deviceType: 46 },
    { model: "T8442-alias", deviceType: 46 }, { model: "T8442", deviceType: 46, category: "other" }]) {
    assert.equal(isSupportedMegaCamera({ category: "eufy_security", ...device }), false);
  }
});

test("reported person, pet and vehicle pushes retain only the owning camera's pictures and suppress duplicates", async context => {
  const f = await fixture(context), requests: string[] = [];
  context.mock.method(MegaClient.prototype, "download", async (url: string) => {
    requests.push(url); return Buffer.from([255, 216, url.endsWith("person") ? 1 : url.endsWith("pet") ? 2 : 3, 255, 217]);
  });
  await f.provider.start(f.events);
  const person = parsePushEvent({ device_sn: "synthetic-1", station_sn: f.parent.device_sn, a: 3102, msg_type: 18,
    notification_style: 2, unique_id: "synthetic-person", pic_url: "https://example.invalid/person" })!;
  const pet = parsePushEvent({ device_sn: "synthetic-3", station_sn: f.parent.device_sn, a: 3106, msg_type: 18,
    notification_style: 2, unique_id: "synthetic-pet", pic_url: "https://example.invalid/pet" })!;
  const vehicle = parsePushEvent({ device_sn: "synthetic-5", station_sn: f.parent.device_sn, a: 3107, msg_type: 18,
    notification_style: 2, unique_id: "synthetic-vehicle", pic_url: "https://example.invalid/vehicle" })!;
  f.deliver(person); f.deliver(pet); f.deliver(vehicle); await settle();
  assert.deepEqual(f.detections, [["synthetic-1", "person"], ["synthetic-3", "pet"], ["synthetic-5", "vehicle"]]);
  assert.equal(f.images.get("synthetic-1")?.[2], 1); assert.equal(f.images.get("synthetic-3")?.[2], 2);
  assert.equal(f.images.get("synthetic-5")?.[2], 3);
  f.deliver(person); f.deliver({ ...pet, stationSerial: "foreign-parent", eventId: "foreign-event" }); await settle();
  assert.equal(f.detections.length, 3); assert.equal(requests.length, 3);
});

test("HomeBase provider media starts remain separated by child camera", async context => {
  const f = await fixture(context);
  let started = 0;
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async function(this: FirstPartyPpcsSession) {
    started++;
  });
  context.mock.method(FirstPartyPpcsSession.prototype, "close", function(this: FirstPartyPpcsSession) { this.output.end(); });
  context.mock.method(FirstPartyPpcsSession.prototype, "waitUntilClosed", async () => {});
  await f.provider.start(f.events);
  for (const child of f.children) { await f.provider.startStream(child.device_sn); await f.provider.stopStream(child.device_sn); }
  assert.equal(started, 3);
  assert.deepEqual(f.streams, f.children.map(child => child.device_sn));
});

test("missing parents, wrong HomeBase types, foreign ownership and invalid channels cannot become media routes", async context => {
  const f = await fixture(context);
  const rows = parseMegaInventory({ devices: [f.parent, ...f.children] });
  const child = rows.find(row => row.serial === "synthetic-1")!, parent = rows.find(row => row.serial === f.parent.device_sn)!;
  const route = (camera = child, station = parent) => ppcsStreamRoute(camera, new Map([[station.serial, station], [camera.serial, camera]]));
  assert.equal(route()?.peer.serial, parent.serial);
  for (const channel of [1, 3, 5]) assert.equal(route({ ...child, channel })?.homeBaseAttached, true);
  for (const channel of [-1, 32, 1.5, null]) assert.equal(route({ ...child, channel }), null);
  for (const model of ["T8010", "T9000", "T8N00"]) assert.equal(route(child, { ...parent, model }), null);
  assert.equal(route(child, { ...parent, deviceType: 0 }), null);
  assert.equal(route(child, { ...parent, adminUserId: "foreign-owner" }), null);
  assert.equal(ppcsStreamRoute(child, new Map([[child.serial, child]])), null);
  assert.equal(route({ ...child, parentSerial: child.serial, channel: 0 }), null);
  assert.equal(isPpcsStreamSupported(child, new Map([[parent.serial, parent], [child.serial, child]]), new Set()), false);
});
