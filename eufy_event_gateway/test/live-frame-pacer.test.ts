/**
 * Checks viewer pacing with synthetic bytes and deterministic source clocks.
 * Tests own fake timers, media and disconnects. No hardware, account or network
 * enters the queue, clock-boundary and cancellation regressions.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { LiveFramePacer } from "../src/stream/live-frame-pacer.js";
import { markS340LiveFrameClock, markS340LiveSource, qualifiedS340LiveSource } from "../src/stream/live-frame-clock.js";

const adts = Buffer.from([0xff, 0xf1, 0x60, 0x40, 0x01, 0x1f, 0xfc, 0x00]);

/** Own one synthetic epoch and collect delivered copies under fake timers. */
function fixture(context: TestContext, audioWaitMilliseconds = 0) {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const epoch = Symbol();
  const events: { kind: string; at: number; bytes: Buffer }[] = [];
  const failures: string[] = [];
  const admissions: boolean[] = [];
  const pacer = new LiveFramePacer(
    data => events.push({ kind: "video", at: Date.now(), bytes: data }),
    data => events.push({ kind: "audio", at: Date.now(), bytes: data }),
    reason => failures.push(reason), () => Date.now(), audioWaitMilliseconds, available => admissions.push(available),
  );
  context.after(() => pacer.close());
  return { pacer, events, failures, admissions, epoch,
    frame(timestamp: number, byte = 1, sourceEpoch = epoch, formatChanged = false) {
      const data = Buffer.from([byte]);
      markS340LiveFrameClock(data, timestamp, sourceEpoch, formatChanged);
      return data;
    },
  };
}

test("bursts preserve bytes on camera video and existing AAC sample clocks", context => {
  const f = fixture(context), first = f.frame(1_000, 11);
  f.pacer.acceptVideo(first);
  f.pacer.acceptVideo(f.frame(1_067, 12));
  f.pacer.acceptVideo(f.frame(1_135, 13));
  for (let i = 0; i < 3; i++) f.pacer.acceptAudio(adts);
  first.fill(255);
  context.mock.timers.tick(5_999);
  assert.equal(f.events.length, 0);
  for (const delta of [1, 64, 3, 61, 7]) context.mock.timers.tick(delta);
  assert.deepEqual(f.events.map(({ kind, at }) => ({ kind, at })), [
    { kind: "video", at: 6_000 }, { kind: "audio", at: 6_000 }, { kind: "audio", at: 6_064 },
    { kind: "video", at: 6_067 }, { kind: "audio", at: 6_128 }, { kind: "video", at: 6_135 },
  ]);
  assert.deepEqual(f.events.filter(e => e.kind === "video").map(e => e.bytes[0]), [11, 12, 13]);
  assert.deepEqual(f.failures, []);
});

test("arrival jitter does not replace the source capture interval", context => {
  const f = fixture(context);
  f.pacer.acceptVideo(f.frame(0));
  context.mock.timers.tick(2_500);
  f.pacer.acceptVideo(f.frame(67));
  context.mock.timers.tick(3_500);
  context.mock.timers.tick(67);
  assert.deepEqual(f.events.map(e => e.at), [6_000, 6_067]);
  assert.equal(f.pacer.close().latePackets, 0);
});

test("source clock wrap preserves the next real frame", context => {
  const f = fixture(context);
  f.pacer.acceptVideo(f.frame(0xffff_fff0));
  f.pacer.acceptVideo(f.frame(0x34));
  context.mock.timers.tick(6_000);
  context.mock.timers.tick(68);
  assert.deepEqual(f.events.map(e => e.at), [6_000, 6_068]);
});

test("a qualified format restart closes missing source time without adding media or delaying AAC", context => {
  const f = fixture(context);
  f.pacer.acceptVideo(f.frame(1_000, 11));
  f.pacer.acceptVideo(f.frame(1_067, 12));
  for (let i = 0; i < 3; i++) f.pacer.acceptAudio(adts);
  context.mock.timers.tick(5_197);
  f.pacer.acceptVideo(f.frame(8_489, 13, f.epoch, true));
  for (const delta of [803, 64, 3, 61, 6]) context.mock.timers.tick(delta);
  assert.deepEqual(f.failures, []);
  assert.deepEqual(f.events.map(({ kind, at }) => [kind, at]), [
    ["video", 6_000], ["audio", 6_000], ["audio", 6_064],
    ["video", 6_067], ["audio", 6_128], ["video", 6_134],
  ]);
  assert.deepEqual(f.events.filter(e => e.kind === "video").map(e => e.bytes[0]), [11, 12, 13]);
  assert.equal(f.pacer.close().clockRebases, 1);
});

for (const change of ["no-cadence", "backwards", "epoch"] as const) {
  test(`format restart still rejects ${change}`, context => {
    const f = fixture(context);
    f.pacer.acceptVideo(f.frame(1_000));
    if (change !== "no-cadence") f.pacer.acceptVideo(f.frame(1_067));
    f.pacer.acceptVideo(f.frame(change === "backwards" ? 999 : 8_489, 2,
      change === "epoch" ? Symbol() : f.epoch, true));
    assert.equal(f.failures.length, 1);
    context.mock.timers.tick(20_000);
    assert.deepEqual(f.events, []);
  });
}

test("a format change with an ordinary clock interval keeps its measured timing", context => {
  const f = fixture(context);
  f.pacer.acceptVideo(f.frame(1_000));
  f.pacer.acceptVideo(f.frame(1_067, 2, f.epoch, true));
  context.mock.timers.tick(6_000);
  context.mock.timers.tick(67);
  assert.deepEqual(f.events.map(e => e.at), [6_000, 6_067]);
  assert.equal(f.pacer.close().clockRebases, 0);
});

test("a late packet is counted without creating replacement frames", context => {
  const f = fixture(context);
  f.pacer.acceptVideo(f.frame(0));
  context.mock.timers.tick(6_800);
  f.pacer.acceptVideo(f.frame(67));
  context.mock.timers.tick(1);
  assert.equal(f.events.length, 2);
  assert.equal(f.pacer.close().latePackets, 1);
});

for (const change of ["epoch", "backwards", "jump", "missing"] as const) {
  test(`${change} clock change cancels queued media before crossing a source boundary`, context => {
    const f = fixture(context);
    f.pacer.acceptVideo(f.frame(1_000));
    f.pacer.acceptVideo(change === "missing" ? Buffer.from([1]) : f.frame(
      change === "backwards" ? 999 : change === "jump" ? 6_001 : 1_067,
      2, change === "epoch" ? Symbol() : f.epoch,
    ));
    context.mock.timers.tick(20_000);
    assert.equal(f.failures.length, 1);
    assert.equal(f.events.length, 0);
  });
}

test("cached bootstrap waits beside the first qualified current unit", context => {
  const f = fixture(context);
  f.pacer.acceptVideo(Buffer.from([99]));
  context.mock.timers.tick(100);
  f.pacer.acceptVideo(f.frame(10_000, 5));
  context.mock.timers.tick(5_999);
  assert.equal(f.events.length, 0);
  context.mock.timers.tick(1);
  assert.deepEqual(f.events.map(e => ({ at: e.at, value: e.bytes[0] })), [{ at: 6_100, value: 99 }, { at: 6_100, value: 5 }]);
});

test("missing qualification has a finite startup lifetime", context => {
  const f = fixture(context);
  f.pacer.acceptVideo(Buffer.from([1]));
  f.pacer.acceptAudio(adts);
  context.mock.timers.tick(10_000);
  assert.deepEqual(f.failures, ["pacing_clock_missing"]);
  assert.equal(f.events.length, 0);
});

test("disconnect cancels both media clocks and admission callbacks", context => {
  const f = fixture(context);
  f.pacer.acceptVideo(f.frame(100));
  f.pacer.acceptAudio(adts);
  f.pacer.close();
  f.pacer.acceptVideo(f.frame(167));
  f.pacer.acceptAudio(adts);
  context.mock.timers.tick(30_000);
  assert.equal(f.events.length, 0);
  assert.deepEqual(f.failures, []);
});

test("oversized bytes are rejected before a queued copy is allocated", context => {
  const f = fixture(context), large = Buffer.alloc(4 * 1024 * 1024 + 1);
  markS340LiveFrameClock(large, 0, f.epoch);
  f.pacer.acceptVideo(large);
  assert.deepEqual(f.failures, ["pacing_input_limit"]);
  assert.equal(f.pacer.close().maximumQueuedBytes, 0);
});

test("packet count also bounds tiny buffered frames", context => {
  const f = fixture(context);
  for (let i = 0; i < 1_025; i++) f.pacer.acceptVideo(f.frame(i));
  context.mock.timers.tick(30_000);
  assert.deepEqual(f.failures, ["pacing_input_limit"]);
  assert.equal(f.events.length, 0);
});

test("invalid audio cannot establish a fabricated sample clock", context => {
  const f = fixture(context);
  f.pacer.acceptVideo(f.frame(0));
  f.pacer.acceptAudio(Buffer.from([1, 2, 3]));
  context.mock.timers.tick(10_000);
  assert.deepEqual(f.failures, ["pacing_audio_invalid"]);
  assert.equal(f.events.length, 0);
});

test("source qualification belongs to the original object", () => {
  const source = {};
  assert.equal(qualifiedS340LiveSource(source), false);
  markS340LiveSource(source);
  assert.equal(qualifiedS340LiveSource(source), true);
  assert.equal(qualifiedS340LiveSource({}), false);
  assert.equal(qualifiedS340LiveSource(null), false);
  assert.throws(() => markS340LiveFrameClock(Buffer.from([1]), -1, Symbol()), /Invalid qualified/);
});

test("late initial AAC admits both relative clocks together without a video burst", context => {
  const f = fixture(context, 12_000);
  f.pacer.acceptVideo(f.frame(0, 11));
  f.pacer.acceptVideo(f.frame(100, 12));
  f.pacer.acceptVideo(f.frame(200, 13));
  context.mock.timers.tick(7_500);
  assert.equal(f.events.length, 0);
  for (let index = 0; index < 3; index++) f.pacer.acceptAudio(adts);
  assert.deepEqual(f.admissions, [true]);
  context.mock.timers.tick(5_999);
  assert.equal(f.events.length, 0);
  for (const delta of [1, 64, 36, 28, 72]) context.mock.timers.tick(delta);
  assert.deepEqual(f.events.map(({ kind, at }) => ({ kind, at })), [
    { kind: "video", at: 13_500 }, { kind: "audio", at: 13_500 },
    { kind: "audio", at: 13_564 }, { kind: "video", at: 13_600 },
    { kind: "audio", at: 13_628 }, { kind: "video", at: 13_700 },
  ]);
  assert.deepEqual(f.events.filter(event => event.kind === "video").map(event => event.bytes[0]), [11, 12, 13]);
  assert.equal(f.pacer.close().latePackets, 0);
});

test("audio arriving before video shares the eventual qualified video origin", context => {
  const f = fixture(context, 12_000);
  f.pacer.acceptAudio(adts);
  context.mock.timers.tick(1_000);
  f.pacer.acceptVideo(f.frame(0));
  context.mock.timers.tick(5_999);
  assert.equal(f.events.length, 0);
  context.mock.timers.tick(1);
  assert.deepEqual(f.events.map(({ kind, at }) => ({ kind, at })), [
    { kind: "audio", at: 7_000 }, { kind: "video", at: 7_000 },
  ]);
  assert.deepEqual(f.admissions, [true]);
});

test("a muted source uses its finite audio wait once and ignores later AAC", context => {
  const f = fixture(context, 12_000);
  f.pacer.acceptVideo(f.frame(0));
  context.mock.timers.tick(12_000);
  assert.deepEqual(f.admissions, [false]);
  f.pacer.acceptAudio(adts);
  context.mock.timers.tick(5_999);
  assert.equal(f.events.length, 0);
  context.mock.timers.tick(1);
  assert.deepEqual(f.events.map(({ kind, at }) => ({ kind, at })), [{ kind: "video", at: 18_000 }]);
});

test("disconnect during initial audio admission cancels its timer and media", context => {
  const f = fixture(context, 12_000);
  f.pacer.acceptVideo(f.frame(0));
  context.mock.timers.tick(500);
  f.pacer.close();
  context.mock.timers.tick(20_000);
  assert.deepEqual(f.admissions, []);
  assert.equal(f.events.length, 0);
});
