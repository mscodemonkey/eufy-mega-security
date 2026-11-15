/**
 * Exercises opt-in late names through provider push routing without a device.
 * Test-owned inventory and sessions expose cancellation and stale visits. The
 * provider owns timers and peer reservations. No household setting is written.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver, parsePushEvent, type MegaPushEvent } from "../src/mega/push.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { HomeBasePpcsSession } from "../src/stream/homebase-ppcs.js";
import type { EventNameRecoveryOutcome } from "../src/stream/homebase-event-names.js";
import type { PushRecordingReference } from "../src/mega/push-recording-reference.js";

const storagePath = "/zx/hdd_data0/Camera02/202611/20261108092300/20261108092300.zxvideo";

/** Drain test-owned promise continuations without advancing protocol clocks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

/** Build an admitted synthetic doorbell and capture private name callbacks. */
async function fixture(context: TestContext, mode = "valid") {
  const logs: string[] = [];
  const write = process.stdout.write;
  context.mock.method(process.stdout, "write", ((value: unknown, ...args: unknown[]) => {
    if (String(value).includes("component=")) { logs.push(String(value)); return true; }
    return Reflect.apply(write, process.stdout, [value, ...args]);
  }) as typeof process.stdout.write);
  const directory = await mkdtemp(join(tmpdir(), "name-recovery-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  const parent = { device_sn: "parent", device_model: mode === "homebase2" ? "T8010" : "T8030", device_type: mode === "homebase2" ? 0 : 18,
    category: "eufy_security", p2p_did: "TEST-12345678-TEST", p2p_conn: "fixture", member: { admin_user_id: "owner" }, params: [] };
  const child = { device_sn: "child", device_model: mode === "wrong-model" ? "T8214" : "T8210", device_type: 7,
    device_channel: 2, parent_sn: "parent", category: "eufy_security", member: { admin_user_id: "owner" }, params: [] };
  let reads = 0;
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [parent,
    { ...child, ...(mode === "changed" && ++reads > 1 ? { device_channel: 3 } : {}) }] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ parent: { key: "fixture", expiresAt: null } }));
  context.mock.method(HomeBasePpcsSession.prototype, "connect", async () => undefined);
  context.mock.method(HomeBasePpcsSession.prototype, "readState", async () => ({ childParams: [] }));
  context.mock.method(HomeBasePpcsSession.prototype, "close", () => undefined);
  let deliver!: (event: MegaPushEvent) => void;
  context.mock.method(MegaPushReceiver.prototype, "start", async function(this: MegaPushReceiver) {
    deliver = Reflect.get(this, "onEvent") as typeof deliver;
  });
  context.mock.method(FirstPartyPpcsSession.prototype, "start", async () => undefined);
  const closed = context.mock.method(FirstPartyPpcsSession.prototype, "close", function(this: FirstPartyPpcsSession) { this.output.end(); });
  const drained = context.mock.method(FirstPartyPpcsSession.prototype, "waitUntilClosed", async () => undefined);
  let release: (() => void) | undefined;
  const recovery = context.mock.method(FirstPartyPpcsSession.prototype, "recoverEventName", async (reference: PushRecordingReference, _signal: AbortSignal, onOutcome?: (outcome: EventNameRecoveryOutcome) => void) => {
    assert.equal(reference.id, "42"); assert.equal(reference.storagePath, storagePath);
    if (mode === "superseded" || mode === "shutdown" || mode === "native-name" || mode === "conflicting-reference") await new Promise<void>(resolve => { release = resolve; });
    if (mode === "slow-empty") await new Promise<void>(resolve => setTimeout(resolve, 50_000));
    if (mode === "record-missing") { onOutcome?.("record_not_on_page"); return null; }
    if (mode === "crop-missing") { onOutcome?.("person_crop_missing"); return null; }
    return mode === "empty" || mode === "slow-empty" ? null : mode === "generic" ? "Unknown person" : "Fixture Person";
  });
  const names: unknown[][] = [], people: unknown[][] = [], presses: unknown[][] = [];
  const events = new Proxy({ personName: (...values: unknown[]) => names.push(values),
    doorbellName: (...values: unknown[]) => names.push(values), person: (...values: unknown[]) => people.push(values),
    doorbell: (...values: unknown[]) => presses.push(values) },
    { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "fixture", password: "fixture", country: "AU", persistentDirectory: directory,
    maxStreamSeconds: 120, apiAuthenticationConfigured: mode !== "unauthenticated", experimentalHomeBaseEventNames: mode !== "off" }, (milliseconds, signal) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
      const abort = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }));
  await provider.start(events); await settle();
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const event = (id = "visit", reference = true) => parsePushEvent({ device_sn: "child", station_sn: mode === "foreign-station" ? "foreign" : "parent",
    event_type: mode === "press" ? 3103 : 3102, msg_type: 18, unique_id: id,
    ...(reference ? { record_id: 42, file_path: storagePath, trigger_time: Date.now() + (mode === "future" ? 10_000 : mode === "stale" ? -600_001 : 0) } : {}) })!;
  return { provider, events, network, recovery, drained, closed, names, people, presses, event, logs,
    send: (value: MegaPushEvent) => deliver(value), release: () => release?.() };
}

for (const mode of ["valid", "press", "off", "unauthenticated", "homebase2", "wrong-model", "foreign-station", "changed", "stale", "future"] as const) {
  test(`late name recovery admission and delivery: ${mode}`, async context => {
    const f = await fixture(context, mode);
    try {
      f.send(f.event()); await settle();
      const initialPeople = f.people.length, initialPresses = f.presses.length;
      context.mock.timers.tick(10_000); await settle();
      const admitted = mode === "valid" || mode === "press";
      assert.equal(f.recovery.mock.callCount(), admitted ? 1 : 0);
      assert.equal(f.names.length, admitted ? 1 : 0);
      if (admitted) {
        assert.equal(f.names[0]![0], "child"); assert.equal(f.names[0]![2], "Fixture Person");
        assert.equal(f.drained.mock.callCount(), 1);
      }
      assert.equal(f.people.length, initialPeople);
      assert.equal(f.presses.length, initialPresses);
      if (admitted) assert.equal(mode === "press" ? initialPresses : initialPeople, 1);
      assert.equal(f.network.mock.callCount(), 0);
    } finally { await f.provider.close(); context.mock.timers.reset(); }
  });
}

for (const mode of ["superseded", "shutdown", "native-name", "conflicting-reference"] as const) test(`a fetched late name loses ownership after ${mode}`, async context => {
  const f = await fixture(context, mode);
  try {
    const event = f.event(); f.send(event); await settle(); context.mock.timers.tick(10_000); await settle();
    assert.equal(f.recovery.mock.callCount(), 1);
    let closing: Promise<void> | undefined;
    if (mode === "superseded") f.send(f.event("new-visit", false));
    else if (mode === "native-name") f.send({ ...event, personName: "Native Name" });
    else if (mode === "conflicting-reference") f.send({ ...event, recording: { ...event.recording!, id: "43" } });
    else closing = f.provider.close();
    await settle(); const prior = f.names.length; f.release(); await closing; await settle();
    assert.equal(f.names.length, prior);
    assert.ok(f.names.every(values => values[2] !== "Fixture Person"));
    if (mode === "conflicting-reference") assert.ok(f.logs.some(line => /homebase_name_recovery_unavailable.*reason=reference_changed/.test(line)));
    if (mode === "shutdown" || mode === "native-name") assert.equal(f.logs.some(line => line.includes("homebase_name_recovery_unavailable")), false);
  } finally { f.release(); await f.provider.close(); context.mock.timers.reset(); }
});

for (const mode of ["empty", "generic"]) test(`unresolved ${mode} history is queried at most three times without creating a detection`, async context => {
  const f = await fixture(context, mode);
  try {
    f.send(f.event()); await settle();
    for (const wait of [10_000, 50_000, 480_000, 600_000]) { context.mock.timers.tick(wait); await settle(); }
    assert.equal(f.recovery.mock.callCount(), 3);
    assert.equal(f.names.length, 0); assert.equal(f.people.length, 1);
  } finally { await f.provider.close(); context.mock.timers.reset(); }
});

test("an active view keeps its peer and a later idle attempt can recover the name", async context => {
  const f = await fixture(context);
  try {
    await f.provider.startStream("child");
    const closedBefore = f.closed.mock.callCount();
    f.send(f.event()); await settle(); context.mock.timers.tick(10_000); await settle();
    assert.equal(f.recovery.mock.callCount(), 0);
    assert.equal(f.closed.mock.callCount(), closedBefore);
    await f.provider.stopStream("child");
    context.mock.timers.tick(50_000); await settle();
    assert.equal(f.recovery.mock.callCount(), 1); assert.equal(f.names.length, 1);
  } finally { await f.provider.close(); context.mock.timers.reset(); }
});

test("another metadata or recording reservation is never taken over", async context => {
  const f = await fixture(context);
  let release!: () => void;
  context.mock.method(FirstPartyPpcsSession.prototype, "readEventNameHistory", async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return { scope: "one_history_page" as const, records: 0, personCrops: 0, recordsWithFamiliarNames: 0, unresolvedPersonCrops: 0 };
  });
  const reading = f.provider.diagnoseEventNames("child", "2026-11-08", "0", new AbortController().signal);
  try {
    await settle(); assert.ok(release);
    f.send(f.event()); await settle(); context.mock.timers.tick(10_000); await settle();
    assert.equal(f.recovery.mock.callCount(), 0);
    release(); await reading;
  } finally { release?.(); await reading.catch(() => undefined); await f.provider.close(); context.mock.timers.reset(); }
});


test("missing notification references never cause a guessed history lookup", async context => {
  const f = await fixture(context);
  try {
    f.send(f.event("visit", false)); await settle(); context.mock.timers.tick(600_000); await settle();
    assert.equal(f.recovery.mock.callCount(), 0); assert.equal(f.names.length, 0);
  } finally { await f.provider.close(); context.mock.timers.reset(); }
});


test("slow history reads cannot push the nine-minute check outside the visit window", async context => {
  const f = await fixture(context, "slow-empty");
  try {
    f.send(f.event()); await settle();
    context.mock.timers.tick(10_000); await settle();
    assert.equal(f.recovery.mock.callCount(), 1);
    context.mock.timers.tick(50_000); await settle();
    context.mock.timers.tick(0); await settle();
    assert.equal(f.recovery.mock.callCount(), 2);
    context.mock.timers.tick(50_000); await settle();
    context.mock.timers.tick(430_000); await settle();
    assert.equal(f.recovery.mock.callCount(), 3);
    context.mock.timers.tick(50_000); await settle();
    assert.equal(f.names.length, 0);
    assert.ok(f.logs.some(line => /homebase_name_recovery_unavailable.*reason=no_name.*checks=3/.test(line)));
  } finally { await f.provider.close(); context.mock.timers.reset(); }
});

for (const mode of ["missing-reference", "superseded-before-read"] as const) test(`an unqueried late-name lookup reports ${mode}`, async context => {
  const f = await fixture(context);
  try {
    f.send(f.event("visit", mode !== "missing-reference")); await settle();
    if (mode === "superseded-before-read") { f.send(f.event("new-visit", false)); await settle(); }
    assert.equal(f.recovery.mock.callCount(), 0);
    const reason = mode === "missing-reference" ? "notification_reference_unavailable" : "visit_or_binding_changed";
    const lines = f.logs.filter(line => line.includes("event=homebase_name_recovery_unavailable"));
    assert.ok(lines.some(line => line.includes(`reason=${reason}`)));
    if (mode === "missing-reference") assert.ok(lines.some(line => /reference=id_absent visit_identity_present=true/.test(line)));
    assert.ok(lines.every(line => !/Fixture Person|Camera02|new-visit|record_id|file_path/.test(line)));
  } finally { await f.provider.close(); context.mock.timers.reset(); }
});


test("the rejected path warning describes the format without querying history or logging private fields", async context => {
  const f = await fixture(context);
  try {
    const event = parsePushEvent({ device_sn: "child", station_sn: "parent", event_type: 3102, msg_type: 18,
      unique_id: "PRIVATE_VISIT", record_id: 42, file_path: "/PRIVATE_ROOM/PRIVATE_CAMERA/202611/20261108092300.zxvideo",
      trigger_time: Date.now() })!;
    f.send(event); await settle(); context.mock.timers.tick(600_000); await settle();
    assert.equal(f.recovery.mock.callCount(), 0);
    assert.equal(f.names.length, 0);
    const line = f.logs.find(value => value.includes("homebase_name_recovery_unavailable"))!;
    assert.match(line, /reference=path_unsupported visit_identity_present=true/);
    assert.match(line, /path_shape=absolute.other.other.digits6.video14 path_calendar=unsupported trigger_clock=milliseconds/);
    assert.equal(/PRIVATE_|202611|record_id|file_path/.test(line), false);
  } finally { await f.provider.close(); context.mock.timers.reset(); }
});


test("a returned missing visit remains distinct from skipped recording checks", async context => {
  const f = await fixture(context, "record-missing");
  try {
    await f.provider.startStream("child");
    f.send(f.event()); await settle();
    context.mock.timers.tick(10_000); await settle();
    await f.provider.stopStream("child");
    context.mock.timers.tick(50_000); await settle();
    context.mock.timers.tick(480_000); await settle();
    assert.equal(f.recovery.mock.callCount(), 2);
    assert.equal(f.names.length, 0);
    const line = f.logs.find(value => value.includes("homebase_name_recovery_unavailable"))!;
    assert.match(line, /reason=no_name checks=2 busy_skips=1 history_result=record_not_on_page/);
    for (const value of ["Fixture Person", "parent", "child", storagePath]) assert.equal(line.includes(value), false);
  } finally { await f.provider.close(); context.mock.timers.reset(); }
});


/** Read only the public, opaque reference emitted for a notification's recovery. */
function loggedVisitReference(line: string): string {
  const match = /\bvisit_ref=([a-f0-9]{16}|unavailable)\b/.exec(line);
  assert.ok(match, "the original push and delayed result need a joinable safe reference");
  return match[1]!;
}

test("an older cancelled lookup remains identifiable after the next visit's push", async context => {
  const f = await fixture(context, "crop-missing");
  try {
    await f.provider.startStream("child");
    f.send(f.event("private-older-visit")); await settle();
    context.mock.timers.tick(10_000); await settle();
    f.send(f.event("private-newer-visit")); await settle();
    const pushes = f.logs.filter(line => line.includes("event=push_received"));
    const oldResult = f.logs.find(line => /homebase_name_recovery_unavailable.*reason=visit_or_binding_changed/.test(line))!;
    assert.equal(pushes.length, 2);
    assert.match(oldResult, /checks=0 busy_skips=1 history_result=not_observed/);
    assert.ok(f.logs.indexOf(oldResult) > f.logs.indexOf(pushes[1]!));
    const older = loggedVisitReference(pushes[0]!), newer = loggedVisitReference(pushes[1]!);
    assert.notEqual(older, newer);
    assert.equal(loggedVisitReference(oldResult), older);
    context.mock.timers.tick(10_000); await settle();
    await f.provider.stopStream("child");
    context.mock.timers.tick(50_000); await settle();
    context.mock.timers.tick(480_000); await settle();
    const newResult = f.logs.find(line => /homebase_name_recovery_unavailable.*reason=no_name.*history_result=person_crop_missing/.test(line))!;
    assert.match(newResult, /checks=2 busy_skips=1/);
    assert.equal(loggedVisitReference(newResult), newer);
    assert.equal(f.recovery.mock.callCount(), 2);
    assert.equal(f.names.length, 0);
    for (const line of [oldResult, newResult, ...pushes]) {
      assert.equal(/private-older|private-newer|Fixture Person|parent|child|Camera02/.test(line), false);
    }
  } finally { await f.provider.close(); context.mock.timers.reset(); }
});

test("duplicate notification logs and successful recovery keep the same opaque reference", async context => {
  const f = await fixture(context);
  try {
    const event = f.event("private-repeat-visit"); f.send(event); await settle();
    context.mock.timers.tick(1_000); f.send(event); await settle();
    const pushes = f.logs.filter(line => line.includes("event=push_received"));
    assert.equal(pushes.length, 2);
    const reference = loggedVisitReference(pushes[0]!);
    assert.equal(loggedVisitReference(pushes[1]!), reference);
    context.mock.timers.tick(10_000); await settle();
    const recovered = f.logs.find(line => line.includes("event=homebase_name_recovered"))!;
    assert.equal(loggedVisitReference(recovered), reference);
    assert.equal(f.recovery.mock.callCount(), 1);
    assert.equal(recovered.includes("Fixture Person"), false);
  } finally { await f.provider.close(); context.mock.timers.reset(); }
});

test("a notification without an identity does not acquire a guessed visit reference", async context => {
  const f = await fixture(context);
  try {
    f.send({ ...f.event(), eventId: null }); await settle();
    assert.equal(loggedVisitReference(f.logs.find(line => line.includes("event=push_received"))!), "unavailable");
    assert.equal(f.recovery.mock.callCount(), 0);
  } finally { await f.provider.close(); context.mock.timers.reset(); }
});


test("identical synthetic visit IDs cannot be linked across provider instances", async context => {
  let firstReference: string;
  const first = await fixture(context, "off");
  try {
    first.send(first.event("same-private-id")); await settle();
    firstReference = loggedVisitReference(first.logs.find(line => line.includes("event=push_received"))!);
  } finally { await first.provider.close(); context.mock.timers.reset(); }
  const second = await fixture(context, "off");
  try {
    second.send(second.event("same-private-id")); await settle();
    const secondReference = loggedVisitReference(second.logs.find(line => line.includes("event=push_received"))!);
    assert.notEqual(firstReference, secondReference);
  } finally { await second.provider.close(); context.mock.timers.reset(); }
});
