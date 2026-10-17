/**
 * Exercises C31 type-95 entity admission and delivered push handling offline.
 * Each test owns the provider, synthetic inventory and event sink. The existing
 * Home Assistant adapter consumes the resulting doorbellSupported capability.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver, parsePushEvent, type MegaPushEvent } from "../src/mega/push.js";
import { EufyProvider, isDoorbellDevice, safePushLogSummary } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";

for (const attached of [false, true]) test(`type95 C31 rings through the provider, attached=${attached}`, async context => {
  const directory = await mkdtemp(join(tmpdir(), "c31-ring-"));
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
    { device_sn: "t8223", device_model: "T8223", device_type: 95, category: "eufy_security",
      ...(attached ? { parent_sn: "hb3", device_channel: 1 } : {}) },
    ...(attached ? [{ device_sn: "hb3", device_model: "T8030", device_type: 18, category: "eufy_security" }] : []),
  ] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
  let receive!: (event: MegaPushEvent) => void;
  context.mock.method(MegaPushReceiver.prototype, "start", async function (this: MegaPushReceiver) {
    receive = (this as unknown as { onEvent: (event: MegaPushEvent) => void }).onEvent;
  });
  const state = new GatewayState(), rings: boolean[] = [], motions: boolean[] = [], people: boolean[] = [];
  const events = new Proxy({
    camera: (camera: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(camera),
    doorbell: (serial: string, active: boolean) => { rings.push(active); state.recordDoorbell(serial, active); },
    motion: (_serial: string, active: boolean) => { motions.push(active); },
    person: (_serial: string, active: boolean) => { people.push(active); },
  }, { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU",
    persistentDirectory: directory, maxStreamSeconds: 120 });
  const deliver = (fields: Record<string, unknown>): void => {
    const event = parsePushEvent({ device_sn: "t8223", station_sn: attached ? "hb3" : "t8223", payload: JSON.stringify(fields) });
    assert.ok(event); receive(event);
  };
  try {
    await provider.start(events);
    assert.equal(state.hasCamera("t8223"), true);
    assert.equal(state.getCamera("t8223").doorbellSupported, true);
    deliver({ a: 3103, notification_style: 1, unique_id: "press" });
    deliver({ a: 3103, notification_style: 1, unique_id: "press" });
    assert.deepEqual(rings, [true]);
    deliver({ a: 3103, notification_style: 3, f: "Synthetic person", unique_id: "person" });
    assert.deepEqual(rings, [true]); assert.deepEqual(people, [true]);
    deliver({ a: 3111, notification_style: 3, f: "Synthetic person", unique_id: "shared" });
    deliver({ a: 3103, notification_style: 1, unique_id: "shared" });
    assert.deepEqual(rings, [true, true]);
    deliver({ a: 3103, notification_style: 3, person_count: 1, unique_id: "detected" });
    assert.deepEqual(rings, [true, true]);
    deliver({ a: 3101, unique_id: "motion" });
    deliver({ a: 1, unique_id: "generic" });
    assert.deepEqual(rings, [true, true]); assert.ok(motions.length >= 3);
    deliver({ a: 3103, notification_style: 3, unique_id: "ambiguous" });
    assert.deepEqual(rings, [true, true, true]);
    assert.equal(network.mock.callCount(), 0);
  } finally { await provider.close(); state.close(); await rm(directory, { recursive: true, force: true }); }
});

test("doorbell identity and press summaries include only the supported category and types", () => {
  for (const deviceType of [5, 7, 91, 94, 95, 96, 203]) assert.equal(isDoorbellDevice({ category: "eufy_security", deviceType }), true);
  for (const deviceType of [2, 10, 93, 97, 104, 126, 127, null]) assert.equal(isDoorbellDevice({ category: "eufy_security", deviceType }), false);
  assert.equal(isDoorbellDevice({ category: "other", deviceType: 95 }), false);
  assert.equal(isDoorbellDevice({ category: undefined, deviceType: 95 } as never), false);
  const event = parsePushEvent({ device_sn: "t8223", payload: JSON.stringify({ a: 3103, notification_style: 1 }) });
  assert.ok(event);
  assert.match(safePushLogSummary(event, { model: "T8223", category: "eufy_security", deviceType: 95 } as never, false, false), /handling=doorbell_press/);
});
