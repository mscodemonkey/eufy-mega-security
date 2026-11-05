/**
 * Replays recognised doorbell-press context through an isolated provider.
 * Fixtures own the device inventory and notification callbacks. No message is
 * sent to Home Assistant, a camera, or a cloud account.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver, parsePushEvent, type MegaPushEvent } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { GatewayEvent } from "../src/domain/types.js";

for (const delivery of ["initial", "late", "foreign-late"] as const) {
test(`${delivery} button-press recognition stays with its source without a person pulse`, async context => {
  const staged = delivery !== "initial";
  const directory = await mkdtemp(join(tmpdir(), "named-press-"));
  const network = context.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
    { device_sn: "synthetic-camera", device_model: "T8210", device_type: 7, category: "eufy_security", parent_sn: "synthetic-station" },
    { device_sn: "synthetic-station", device_model: "T8030", device_type: 18, category: "eufy_security" },
  ] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
  let deliver!: (event: MegaPushEvent) => void;
  context.mock.method(MegaPushReceiver.prototype, "start", async function(this: MegaPushReceiver) {
    deliver = Reflect.get(this, "onEvent") as (event: MegaPushEvent) => void;
  });
  const presses: unknown[][] = [], people: unknown[][] = [];
  const state = new GatewayState(), emitted: GatewayEvent[] = [];
  state.on("event", event => emitted.push(event));
  const events = new Proxy({
    camera: (identity: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(identity),
    doorbell: (serial: string, pressed: boolean, name?: string | null, identity?: string | null) => {
      presses.push([serial, pressed, name, identity]);
      state.recordDoorbell(serial, pressed, new Date(), name ?? null, identity ?? null);
    },
    doorbellName: (serial: string, identity: string, name: string) => state.enrichDoorbellName(serial, identity, name),
    person: (...args: unknown[]) => people.push(args) },
    { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "fixture", password: "synthetic", country: "AU",
    persistentDirectory: directory, maxStreamSeconds: 120 });
  try {
    await provider.start(events);
    const event = parsePushEvent({ device_sn: "synthetic-camera", station_sn: "synthetic-station",
      event_type: 3103, notification_style: 1, ...(staged ? {} : { f: "Fixture Person" }), unique_id: "ring-one" });
    assert.ok(event);
    deliver(event);
    const original = state.getCamera("synthetic-camera").lastDetection!;
    const named = { ...event, personName: "Fixture Person",
      ...(delivery === "foreign-late" ? { stationSerial: "different-station" } : {}) };
    deliver(named);
    deliver(named);
    assert.equal(presses.length, 1);
    assert.equal(presses[0]![2], staged ? null : "Fixture Person");
    assert.equal(typeof presses[0]![3], "string");
    assert.equal(people.length, 0);
    const latest = state.getCamera("synthetic-camera").lastDetection!;
    assert.deepEqual(latest, delivery === "foreign-late" ? original : { ...original, personName: "Fixture Person", recognized: true });
    assert.equal(latest.kind, "doorbell");
    assert.equal(emitted.filter(event => event.type === "detection").length, 1);
    assert.equal(network.mock.callCount(), 0);
  } finally { state.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
}

test("recognition belongs to the press without setting person or motion flags", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const state = new GatewayState(1000), events: GatewayEvent[] = [];
  state.registerCamera({ serial: "fixture", name: "Fixture", model: "T8210", stationSerial: "station", doorbellSupported: true, streamSupported: false });
  state.on("event", event => events.push(event));
  try {
    state.recordDoorbell("fixture", true, new Date("2026-01-01T00:00:00Z"), "Fixture Person", "private-press");
    const camera = state.getCamera("fixture");
    assert.equal(camera.doorbellPressed, true);
    assert.equal(camera.personDetected, false);
    assert.equal(camera.motionDetected, false);
    assert.equal(camera.lastDetection?.kind, "doorbell");
    assert.equal(camera.lastDetection?.personName, "Fixture Person");
    assert.equal(camera.lastDetection?.recognized, true);
    const detection = events.filter(event => event.type === "detection");
    assert.equal(detection.length, 1);
    assert.equal(detection[0]!.detection.personName, "Fixture Person");
    context.mock.timers.tick(1000);
    assert.equal(state.getCamera("fixture").doorbellPressed, false);
    assert.doesNotMatch(JSON.stringify([camera, events]), /private-press|doorbellEventIdentity/);
  } finally { state.close(); }
});

test("a name on the same press does not ring again or revive an expired pulse", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const state = new GatewayState(1000), events: GatewayEvent[] = [];
  state.registerCamera({ serial: "fixture", name: "Fixture", model: "T8210", stationSerial: "station", doorbellSupported: true, streamSupported: false });
  state.on("event", event => events.push(event));
  try {
    state.recordDoorbell("fixture", true, new Date("2026-01-01T00:00:00Z"), null, "private-press");
    const original = state.getCamera("fixture").lastDetection!;
    context.mock.timers.tick(1000);
    state.enrichDoorbellName("fixture", "private-press", "Fixture Person");
    const camera = state.getCamera("fixture");
    assert.deepEqual(camera.lastDetection, { ...original, personName: "Fixture Person", recognized: true });
    assert.equal(camera.doorbellPressed, false);
    assert.equal(camera.personDetected, false);
    assert.equal(events.filter(event => event.type === "detection").length, 1);
    assert.doesNotMatch(JSON.stringify([camera, events]), /private-press|doorbellEventIdentity/);
  } finally { state.close(); }
});

test("a source-owned press does not inherit recognition from the previous person", () => {
  const state = new GatewayState();
  state.registerCamera({ serial: "fixture", name: "Fixture", model: "T8210", stationSerial: "station", doorbellSupported: true, streamSupported: false });
  try {
    state.recordPerson("fixture", true, "Earlier Person", new Date(), "earlier-person");
    state.recordDoorbell("fixture", true, new Date(), null, "new-press");
    const press = state.getCamera("fixture").lastDetection!;
    assert.equal(press.kind, "doorbell");
    assert.equal(press.personName, null);
    state.enrichPersonName("fixture", "earlier-person", "Earlier Person");
    assert.deepEqual(state.getCamera("fixture").lastDetection, press);
    state.enrichDoorbellName("fixture", "new-press", "Current Person");
    assert.equal(state.getCamera("fixture").lastDetection?.personName, "Current Person");
  } finally { state.close(); }
});

for (const reason of ["new-press", "wrong-identity", "no-identity", "changed-binding", "other-kind", "already-named", "generic-name"] as const) {
  test(`press recognition refuses ${reason}`, () => {
    const state = new GatewayState();
    const camera = { serial: "fixture", name: "Fixture", model: "T8210", stationSerial: "station", doorbellSupported: true, streamSupported: false };
    state.registerCamera(camera);
    try {
      state.recordDoorbell("fixture", true, new Date(), reason === "already-named" ? "Original Person" : null,
        reason === "no-identity" ? null : "press-one");
      if (reason === "new-press") state.recordDoorbell("fixture", true, new Date(), null, "press-two");
      if (reason === "changed-binding") state.registerCamera({ ...camera, stationSerial: "replacement-station" });
      if (reason === "other-kind") state.recordPerson("fixture", true, null, new Date(), "person-visit");
      const before = state.getCamera("fixture");
      state.enrichDoorbellName("fixture", reason === "wrong-identity" ? "other-press" : "press-one",
        reason === "generic-name" ? "Unknown person" : "Fixture Person");
      assert.deepEqual(state.getCamera("fixture"), before);
    } finally { state.close(); }
  });
}
