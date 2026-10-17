/**
 * Exercises cloud motion clocks with synthetic timestamps. The clock owns only
 * baseline state; provider tests cover binding resets and gateway publication.
 * No network, sensor or phone setting is involved.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { InventoryMotionClock, inventoryMotionOutcome } from "../src/provider/inventory-motion.js";
import { safeInventoryReads } from "../src/provider/eufy-provider.js";

const now = 1_800_000_000_000;

test("T8910 accepts seconds and integer milliseconds without changing other families", context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  const reads = (value: unknown, type = 10, model = "T8910") => safeInventoryReads([{ param_type: 1605, param_value: value }], type, model);
  const seconds = now / 1_000 - 1;
  assert.deepEqual(reads(seconds), reads(seconds * 1_000));
  assert.deepEqual(reads(String(seconds)), reads(String(seconds * 1_000)));
  assert.equal(reads(now - 500).motionEventSeconds, seconds + 0.5);
  assert.equal(reads(now - 500).lastSeen, new Date(now - 500).toISOString());
  assert.equal(reads(now, 10, "T8911").motionEventSeconds, undefined);
  assert.equal(reads(now, 127, "T90M0").motionEventSeconds, undefined);
  assert.deepEqual(reads(now, 8, "T8171"), {});
  for (const value of [true, [], {}, null, "", "1e12", "+1800000000000", " 1800000000000 ", "0x1a3185c5000", now + 0.5, 99_000_000_000]) {
    assert.equal(reads(value).motionEventSeconds, undefined);
  }
  assert.equal(reads(` ${seconds}.5 `).motionEventSeconds, seconds + 0.5);
  assert.equal(safeInventoryReads([{ param_type: 1551, param_value: String(seconds) }], 2).lastSeen,
    new Date(seconds * 1_000).toISOString());
});

test("baseline consumes stale advances and never replays a rollback or missing value", () => {
  const clock = new InventoryMotionClock();
  assert.equal(clock.observe((now - 120_000) / 1_000, false, now), "none");
  assert.equal(clock.observe((now - 90_000) / 1_000, false, now), "none");
  assert.equal(clock.baselineSeconds, (now - 90_000) / 1_000);
  for (const value of [undefined, NaN, Infinity, (now - 120_000) / 1_000]) assert.equal(clock.observe(value, false, now), "none");
  assert.equal(clock.observe((now - 1_000) / 1_000, false, now), "cloud-motion");
  assert.equal(clock.observe((now - 2_000) / 1_000, false, now), "none");
  assert.equal(clock.observe((now - 1_000) / 1_000, false, now), "none");
});

test("future values stay quarantined as time catches up without freezing genuine motion", () => {
  const clock = new InventoryMotionClock((now - 10_000) / 1_000, now);
  assert.equal(clock.observe((now + 10_000) / 1_000, false, now), "none");
  assert.equal(clock.observe((now - 1_000) / 1_000, false, now), "cloud-motion");
  assert.equal(clock.observe((now + 10_000) / 1_000, false, now + 10_000), "none");
  assert.equal(clock.observe((now + 11_000) / 1_000, false, now + 11_000), "cloud-motion");
  const initiallyFuture = new InventoryMotionClock((now + 10_000) / 1_000, now);
  assert.equal(initiallyFuture.baselineSeconds, undefined);
  assert.equal(initiallyFuture.observe((now + 10_000) / 1_000, false, now + 10_000), "none");
});

test("freshness boundaries, push confirmation and default wall clock are explicit", context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  const baseline = (now - 120_000) / 1_000;
  for (const [milliseconds, expected] of [[now - 60_000, "cloud-motion"], [now - 60_001, "none"],
    [now + 2_000, "cloud-motion"], [now + 2_001, "none"]] as const) {
    assert.equal(inventoryMotionOutcome(baseline, milliseconds / 1_000, false), expected);
  }
  for (const received of [NaN, Infinity, -1]) assert.equal(inventoryMotionOutcome(baseline, now / 1_000, false, received), "none");
  const clock = new InventoryMotionClock(baseline, now);
  assert.equal(clock.observe((now - 1_000) / 1_000, true, now), "push-confirmed");
  assert.equal(clock.observe((now - 1_000) / 1_000, false, now), "none");
  assert.equal(new InventoryMotionClock().observe(now / 1_000, true, now), "none");
  const reset = new InventoryMotionClock();
  assert.equal(reset.observe(now / 1_000, false, now), "none");
});

test("future quarantine stays bounded and overflow fails closed until a binding reset", () => {
  const clock = new InventoryMotionClock((now - 1_000) / 1_000, now);
  for (let index = 0; index < 40; index++) assert.equal(clock.observe((now + 10_000 + index) / 1_000, false, now), "none");
  assert.equal(clock.observe(now / 1_000, false, now), "none");
  assert.equal(clock.baselineSeconds, (now - 1_000) / 1_000);
});
