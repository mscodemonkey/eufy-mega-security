/**
 * Exercises recovered and lost UDP data before PPCS command-frame parsing.
 *
 * Tests own synthetic packet bodies and timers. The session consumes this
 * ordering policy so late retransmissions can complete a split video frame.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PpcsDatagramReorderBuffer } from "../src/stream/first-party-ppcs.js";

test("recovers a split frame instead of dropping a late retransmission", () => {
  const delivered: string[] = [];
  const gaps: number[] = [];
  const repeats: string[] = [];
  const order = new PpcsDatagramReorderBuffer(
    (body) => delivered.push(body.toString()),
    (type) => gaps.push(type),
    (reason) => repeats.push(reason),
  );
  order.push(Buffer.from("header"), 10, 1);
  order.push(Buffer.from("tail"), 12, 1);
  order.push(Buffer.from("tail"), 12, 1);
  assert.deepEqual(delivered, ["header"]);
  order.push(Buffer.from("middle"), 11, 1);
  assert.deepEqual(delivered, ["header", "middle", "tail"]);
  assert.deepEqual(gaps, []);
  order.push(Buffer.from("middle"), 11, 1);
  assert.deepEqual(repeats, ["duplicate", "stale"]);
  order.close();
});

test("expires each hole before successors and gives a second hole its own wait", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: string[] = [];
  const order = new PpcsDatagramReorderBuffer(
    (body) => events.push(body.toString()),
    (type, reason) => events.push(`${type}:${reason}`),
    () => {},
  );
  order.push(Buffer.from("first"), 1, 1);
  order.push(Buffer.from("third"), 3, 1);
  order.push(Buffer.from("fifth"), 5, 1);
  t.mock.timers.tick(249);
  assert.deepEqual(events, ["first"]);
  t.mock.timers.tick(1);
  assert.deepEqual(events, ["first", "1:gap", "third"]);
  order.push(Buffer.from("fourth"), 4, 1);
  assert.deepEqual(events, ["first", "1:gap", "third", "fourth", "fifth"]);
  t.mock.timers.tick(250);
  assert.equal(events.length, 5);
  order.close();
});

test("wraps sequence values independently for each channel", () => {
  const events: string[] = [];
  const order = new PpcsDatagramReorderBuffer(
    (body, type) => events.push(`${type}:${body.toString()}`),
    () => assert.fail("recoverable wrap must not skip a frame"),
    () => {},
  );
  order.push(Buffer.from("start"), 65534, 1);
  order.push(Buffer.from("end"), 0, 1);
  order.push(Buffer.from("control"), 50, 0);
  order.push(Buffer.from("middle"), 65535, 1);
  assert.deepEqual(events, ["1:start", "0:control", "1:middle", "1:end"]);
  order.close();
});

test("abandons held packets on a numbering restart and session close", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: string[] = [];
  const order = new PpcsDatagramReorderBuffer(
    (body) => events.push(body.toString()),
    (_, reason) => events.push(reason),
    () => {},
  );
  order.push(Buffer.from("old"), 5000, 1);
  order.push(Buffer.from("discard"), 5002, 1);
  order.push(Buffer.from("new"), 1, 1);
  t.mock.timers.tick(250);
  assert.deepEqual(events, ["old", "restart", "new"]);
  order.push(Buffer.from("closed"), 3, 1);
  order.close();
  order.push(Buffer.from("ignored"), 2, 1);
  t.mock.timers.tick(250);
  assert.deepEqual(events, ["old", "restart", "new"]);
});

test("limits held packet count and bytes before waiting for a retransmission", () => {
  for (const packetBytes of [1, 65536]) {
    let deliveries = 0;
    let skips = 0;
    const order = new PpcsDatagramReorderBuffer(
      () => deliveries++,
      () => skips++,
      () => {},
    );
    order.push(Buffer.alloc(1), 0, 1);
    const count = packetBytes === 1 ? 128 : 32;
    for (let sequence = 2; sequence < count + 2; sequence++) {
      order.push(Buffer.alloc(packetBytes), sequence, 1);
    }
    assert.equal(skips, 1);
    assert.equal(deliveries, count + 1);
    order.close();
  }
});
