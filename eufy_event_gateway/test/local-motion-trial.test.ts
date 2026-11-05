/**
 * Tests timestamp bounds with synthetic notifications and clocks. No network or
 * gateway state is involved. Provider and wire tests own session verification.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { LocalMotionCollector } from "../src/stream/local-motion-trial.js";
import { decodeSensorMotionNotification } from "../src/stream/sensor-status-notification.js";

const now = 1_800_000_000_000;
const row = { dev_type: 3, param_type: 1605, param_value: now };
const frame = (params: unknown[]) => Buffer.from(JSON.stringify({ cmd: 1829, payload: { params } }));

test("motion decoder accepts milliseconds and drops conflicting channels", () => {
  assert.deepEqual(decodeSensorMotionNotification(frame([row, row, { ...row, dev_type: "4", param_value: String(now + 1) }])),
    [{ channel: 3, triggeredAt: now }, { channel: 4, triggeredAt: now + 1 }]);
  assert.deepEqual(decodeSensorMotionNotification(frame([row, { ...row, param_value: now + 1 }, row])), []);
  for (const invalid of [now / 1000, 0, -1, now + 0.5, "1e12", true, null, {}, ""]) {
    assert.deepEqual(decodeSensorMotionNotification(frame([{ ...row, param_value: invalid }])), []);
  }
  for (const dev_type of [-1, 255, 0.5, true, "invalid"]) assert.deepEqual(decodeSensorMotionNotification(frame([{ ...row, dev_type }])), []);
  for (const input of [Buffer.alloc(65_537), frame(Array(257).fill(row)), Buffer.from("null"), Buffer.from("broken"),
    Buffer.from(JSON.stringify({ cmd: 1103, payload: { params: [row] } })), frame([{ ...row, param_type: 1550 }])]) {
    assert.deepEqual(decodeSensorMotionNotification(input), []);
  }
});

test("collector ignores cached, stale, future, repeated and foreign values, then closes", () => {
  const collector = new LocalMotionCollector(3, now);
  for (const [channel, triggeredAt, receivedAt] of [[3, now, now], [4, now + 1, now + 1],
    [3, now + 1, now + 60_002], [3, now + 2001, now], [3, now / 1000, now]]) {
    collector.observe({ channel: channel!, triggeredAt: triggeredAt! }, receivedAt!);
  }
  collector.observe({ channel: 3, triggeredAt: now + 1 }, now + 1);
  collector.observe({ channel: 3, triggeredAt: now + 1 }, now + 2);
  collector.observe({ channel: 3, triggeredAt: now - 1 }, now + 2);
  assert.deepEqual(collector.finish(), { outcome: "observed", candidates: 1 });
  collector.observe({ channel: 3, triggeredAt: now + 2 }, now + 2);
  assert.deepEqual(collector.finish(), { outcome: "observed", candidates: 1 });
});

test("public summary caps counts and contains no timestamp or channel", () => {
  const collector = new LocalMotionCollector(3, now);
  for (let index = 1; index < 30; index++) collector.observe({ channel: 3, triggeredAt: now + index }, now + index);
  const result = collector.finish();
  assert.deepEqual(result, { outcome: "observed", candidates: 16 });
  assert.doesNotMatch(JSON.stringify(result), /180000|triggered|channel/);
  assert.deepEqual(new LocalMotionCollector(3, now).finish(), { outcome: "inconclusive", candidates: 0 });
});
