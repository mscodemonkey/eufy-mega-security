/**
 * Verifies read-only T8N00 mode observations from generic numeric transitions.
 * Fixtures own inventory, transport timestamps and callbacks. No reporter
 * schedule, account, NVR or security command is used by these tests.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HomeBaseState } from "../src/domain/types.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver, parsePushEvent, type MegaPushEvent } from "../src/mega/push.js";
import { EufyProvider, applyNvrModePush, initialHomeBaseState, refreshInventoryStationState,
  safePushLogSummary, type MegaInventoryDevice } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";

const identity = { serial: "station", model: "T8N00", deviceType: 300, category: "eufy_security",
  name: "Synthetic NVR", firmware: null, reads: { guardMode: 2 }, guardModeNames: { 3: "Night" } } as unknown as MegaInventoryDevice;
const now = Date.UTC(2026, 9, 15, 12);

/** Construct only the source-defined paired fields and an independently owned transport time. */
function event(mode = 1, previous = 0, sent = now): MegaPushEvent {
  const parsed = parsePushEvent({ device_sn: "station", station_sn: "station", payload: JSON.stringify({
    a: 9, arming: 2, mode, before_change_mode: previous, alarm_delay: 60, user_name: "PRIVATE_USER", t: "PRIVATE_TEXT",
  }) });
  assert.ok(parsed);
  return { ...parsed, transportSentAtMilliseconds: sent };
}

test("paired NVR modes stay separate from generic HomeBase values and private strings", () => {
  const parsed = event(3, 1);
  assert.equal(parsed.guardMode, null); assert.equal(parsed.effectiveMode, null);
  assert.equal(parsed.effectiveModeField, "mode");
  assert.deepEqual(parsed.nvrModeChange, { configured: 2, effective: 3, previous: 1 });
  assert.doesNotMatch(JSON.stringify(parsed), /PRIVATE_/);
  for (const mode of ["3", true, null]) {
    assert.equal(parsePushEvent({ device_sn: "station", a: 9, arming: 2, mode, before_change_mode: 1 })?.nvrModeChange, null);
  }
  assert.equal(parsePushEvent({ device_sn: "station", a: 10, arming: 2, mode: 3, before_change_mode: 1 })?.nvrModeChange, null);
});

test("fresh observed transitions preserve configured Schedule and publish effective state without writes", () => {
  let station = initialHomeBaseState(identity, false), previousSent: number | null = null;
  for (const [index, [mode, previous]] of [[0, 1], [1, 0], [3, 1], [1, 3]].entries()) {
    const message = event(mode, previous, now + index * 1000);
    const updated = applyNvrModePush(station, identity, message, now - 10_000, previousSent, now + index * 1000);
    assert.ok(updated); station = updated; previousSent = message.transportSentAtMilliseconds!;
    assert.equal(station.guardMode, 2); assert.equal(station.effectiveMode, mode);
    assert.equal(station.guardModeControlSupported, false); assert.equal(station.controlsSupported, false);
    assert.equal(station.effectiveModeReportedAt, new Date(previousSent).toISOString());
  }
  assert.equal(station.stateReadSupported, true);
  const changed = refreshInventoryStationState(station, { ...identity, reads: { guardMode: 0 } });
  assert.equal(changed.guardMode, 0); assert.equal(changed.effectiveMode, null); assert.equal(changed.effectiveModeReportedAt, null);
  assert.equal(refreshInventoryStationState(station, identity).effectiveMode, 1);
  const line = safePushLogSummary(event(3, 1), identity, true, true);
  assert.match(line, /model=T8N00/); assert.match(line, /effective_mode_field=mode/);
  assert.doesNotMatch(line, /effective_mode=3|configured=2|PRIVATE_/);
});

test("mode updates reject other models, malformed state, stale times and replay ordering", () => {
  const station = initialHomeBaseState(identity, false), valid = event();
  for (const changed of [{ ...identity, model: "T9000" }, { ...identity, model: "T8N001" },
    { ...identity, deviceType: 27 }, { ...identity, category: "other" }, { ...identity, serial: "other" }]) {
    assert.equal(applyNvrModePush(station, changed, valid, now - 10_000, null, now), null);
  }
  for (const changed of [{ ...valid, stationSerial: "other" }, { ...valid, cameraSerial: "child" },
    { ...valid, eventType: 10 }]) {
    assert.equal(applyNvrModePush(station, identity, changed, now - 10_000, null, now), null);
  }
  for (const changed of [{ ...valid, nvrModeChange: null },
    { ...valid, nvrModeChange: { configured: 2, effective: 2, previous: 1 } },
    { ...valid, nvrModeChange: { configured: 999, effective: 1, previous: 0 } },
    { ...valid, nvrModeChange: { configured: 2, effective: 1, previous: 47 } },
    { ...valid, effectiveMode: 3 }]) {
    const updated = applyNvrModePush({ ...station, effectiveMode: 3 }, identity, changed, now - 10_000, null, now);
    assert.ok(updated); assert.equal(updated.effectiveMode, null);
  }
  const { transportSentAtMilliseconds, ...unclocked } = valid;
  assert.equal(typeof transportSentAtMilliseconds, "number");
  assert.equal(applyNvrModePush(station, identity, unclocked, now - 10_000, null, now), null);
  for (const sent of [null, NaN, now - 120_001, now + 60_001]) {
    assert.equal(applyNvrModePush(station, identity, { ...valid, transportSentAtMilliseconds: sent }, now - 600_000, null, now), null);
  }
  assert.equal(applyNvrModePush(station, identity, valid, now + 5001, null, now), null);
  assert.equal(applyNvrModePush(station, identity, valid, now - 10_000, now, now), null);
  assert.equal(applyNvrModePush(station, identity, valid, now - 10_000, now + 1, now), null);
});

test("provider accepts fresh NVR push state, clears it on receiver loss and rejects retired callbacks", async context => {
  const directory = await mkdtemp(join(tmpdir(), "nvr-mode-provider-"));
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ device_sn: "station", device_model: "T8N00",
    device_type: 300, category: "eufy_security" }] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
  let callbacks!: { onEvent: (event: MegaPushEvent) => void; onReceiverState: (state: "disconnected") => void };
  context.mock.method(MegaPushReceiver.prototype, "start", async function(this: MegaPushReceiver) {
    callbacks = this as unknown as typeof callbacks;
  });
  const rows: HomeBaseState[] = [];
  const events = new Proxy({ station: (station: HomeBaseState) => { rows.push(station); } },
    { get: (target, property) => Reflect.get(target, property) ?? (() => undefined) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory, maxStreamSeconds: 120 });
  try {
    await provider.start(events); assert.equal(rows.at(-1)?.effectiveMode, null);
    const first = Date.now(); callbacks.onEvent(event(3, 1, first));
    assert.equal(rows.at(-1)?.guardMode, 2); assert.equal(rows.at(-1)?.effectiveMode, 3);
    assert.equal(rows.at(-1)?.controlsSupported, false); assert.equal(rows.at(-1)?.guardModeControlSupported, false);
    assert.equal(rows.at(-1)?.stateReadSupported, true);
    callbacks.onReceiverState("disconnected"); assert.equal(rows.at(-1)?.effectiveMode, null);
    callbacks.onEvent(event(1, 3, first)); assert.equal(rows.at(-1)?.effectiveMode, null);
    callbacks.onEvent(event(1, 3, first + 1)); assert.equal(rows.at(-1)?.effectiveMode, 1);
    await provider.close(); assert.equal(rows.at(-1)?.effectiveMode, null);
    const count = rows.length; callbacks.onEvent(event(0, 1, first + 2)); assert.equal(rows.length, count);
    assert.equal(network.mock.callCount(), 0);
  } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
