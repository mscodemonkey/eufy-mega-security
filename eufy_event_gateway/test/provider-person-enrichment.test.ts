/**
 * Replays staged person notifications through the provider without a network.
 * Fixtures own account and push delivery. A late name must enrich its original
 * event without publishing another detection or querying a camera.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayState } from "../src/domain/gateway-state.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver, parsePushEvent, type MegaPushEvent } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";

for (const kind of ["person", "generic", "doorbell-detection", "press", "motion", "unidentified", "newer-visit"] as const) {
 test(`staged ${kind} delivery keeps names separate from detection pulses`, async context => {
  const directory = await mkdtemp(join(tmpdir(), "person-enrichment-"));
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
  const people: unknown[][] = [], names: unknown[][] = [];
  const state = new GatewayState();
  const events = new Proxy({
    camera: (identity: Parameters<ProviderEvents["camera"]>[0]) => state.registerCamera(identity),
    person: (serial: string, detected: boolean, name: string | null, identity?: string | null) => {
      people.push([serial, detected, name, identity]); state.recordPerson(serial, detected, name, new Date(), identity);
    },
    personName: (serial: string, identity: string, name: string) => {
      names.push([serial, identity, name]); state.enrichPersonName(serial, identity, name);
    } },
    { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "fixture", password: "synthetic", country: "AU",
    persistentDirectory: directory, maxStreamSeconds: 120 });
  try {
    await provider.start(events);
    const person = ["person", "generic", "doorbell-detection", "unidentified", "newer-visit"].includes(kind);
    const event = parsePushEvent({ device_sn: "synthetic-camera", station_sn: "synthetic-station",
      a: kind === "generic" ? 1 : kind === "press" || kind === "doorbell-detection" ? 3103 : kind === "motion" ? 3101 : 3102,
      ...(kind === "unidentified" ? {} : { unique_id: "visit-one" }),
      ...(kind === "generic" ? { i: 123 } : {}),
      ...(kind === "doorbell-detection" ? { notification_style: 3, person_count: 1 } : {}),
    });
    assert.ok(event);
    deliver(event);
    if (kind === "newer-visit") deliver({ ...event, eventId: "visit-two" });
    const original = state.getCamera("synthetic-camera").lastDetection;
    deliver({ ...event, personName: "Fixture Person" });
    assert.equal(people.length, person ? kind === "unidentified" || kind === "newer-visit" ? 2 : 1 : 0);
    assert.equal(names.length, person && kind !== "unidentified" ? 1 : 0);
    if (names.length) {
      assert.equal(people[0]![3], names[0]![1]);
      assert.equal(names[0]![2], "Fixture Person");
      const latest = state.getCamera("synthetic-camera").lastDetection!;
      assert.equal(latest.id, original!.id); assert.equal(latest.occurredAt, original!.occurredAt);
      assert.equal(latest.personName, kind === "newer-visit" ? null : "Fixture Person");
    }
    assert.equal(network.mock.callCount(), 0);
  } finally { state.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

}
