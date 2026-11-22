/**
 * Exercises T8214 ring priority through the parsed push and provider boundary.
 * Tests own synthetic inventory, provider state and event sinks. Home Assistant
 * consumes the resulting updates without any device operation.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver, parsePushEvent, type MegaPushEvent } from "../src/mega/push.js";
import { doorbellPushKind, EufyProvider, safePushLogSummary } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";

test("T8214 rings once with person metadata and retains separate person detections", async context => {
  const directory = await mkdtemp(join(tmpdir(), "t8214-ring-"));
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
    { device_sn: "doorbell", device_model: "T8214", device_type: 94, category: "eufy_security", parent_sn: "hb3", device_channel: 1 },
    { device_sn: "hb3", device_model: "T8030", device_type: 18, category: "eufy_security" },
  ] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
  let receive!: (event: MegaPushEvent) => void;
  context.mock.method(MegaPushReceiver.prototype, "start", async function (this: MegaPushReceiver) {
    receive = (this as unknown as { onEvent: (event: MegaPushEvent) => void }).onEvent;
  });
  const rings: (string | null | undefined)[] = [], people: (string | null | undefined)[] = [], motions: boolean[] = [];
  const events = new Proxy({
    doorbell: (_serial: string, _active: boolean, name?: string | null) => rings.push(name),
    person: (_serial: string, _active: boolean, name?: string | null) => people.push(name),
    motion: (_serial: string, active: boolean) => motions.push(active),
  }, { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory, maxStreamSeconds: 120 });
  const deliver = (fields: Record<string, unknown>): void => {
    const event = parsePushEvent({ device_sn: "doorbell", station_sn: "hb3", payload: JSON.stringify({ msg_type: 18, notification_style: 3, ...fields }) });
    assert.ok(event); receive(event);
  };
  try {
    await provider.start(events);
    deliver({ event_type: 3103, person_count: 1, f: "Fixture person", unique_id: "ring" });
    deliver({ event_type: 3103, person_count: 1, f: "Fixture person", unique_id: "ring" });
    assert.deepEqual(rings, ["Fixture person"]);
    assert.deepEqual(people, ["Fixture person"]);
    assert.deepEqual(motions, [true]);
    deliver({ event_type: 3102, person_count: 1, f: "Fixture person", unique_id: "walkup" });
    assert.deepEqual(rings, ["Fixture person"]);
    assert.deepEqual(people, ["Fixture person", "Fixture person"]);
    deliver({ event_type: 3103, unique_id: "plain-ring" });
    assert.deepEqual(rings, ["Fixture person", null]);
    assert.deepEqual(motions, [true]);
    assert.equal(network.mock.callCount(), 0);
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ring priority requires the qualified model, type, category and message envelope", () => {
  const event = { eventType: 3103, messageType: 18, notificationStyle: 3, detectionEvidence: ["person"] as const, pictureUrl: null, alarmType: null };
  const device = { model: "T8214", category: "eufy_security", deviceType: 94 };
  assert.equal(doorbellPushKind(event, device), "press");
  assert.match(safePushLogSummary(event, device, true, true), /handling=doorbell_press/);
  for (const other of [null, { ...device, model: "T8210" }, { ...device, deviceType: 95 }, { ...device, category: "other" }]) assert.equal(doorbellPushKind(event, other), "detection");
  assert.equal(doorbellPushKind({ ...event, messageType: 17 }, device), "detection");
  assert.equal(doorbellPushKind({ ...event, messageType: null }, device), "detection");
  assert.equal(doorbellPushKind({ ...event, eventType: 3102 }, device), null);
  assert.equal(doorbellPushKind({ ...event, eventType: 3111 }, device), null);
});
