/**
 * Exercises recovered and lost UDP data before PPCS command-frame parsing.
 *
 * Tests own synthetic packet bodies and timers. The session consumes this
 * ordering policy so late retransmissions can complete a split video frame.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Socket } from "node:dgram";
import { FirstPartyPpcsSession, PpcsDatagramReorderBuffer } from "../src/stream/first-party-ppcs.js";

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

test("records short stale runs without accepting them as new data", () => {
  const delivered: number[] = [];
  const order = new PpcsDatagramReorderBuffer((body) => delivered.push(body[0]!), () => {}, () => {});
  for (const sequence of [500, 100, 101, 102, 500, 80, 82, 81, 81]) {
    order.push(Buffer.from([sequence & 255]), sequence, 2);
  }
  assert.deepEqual(delivered, [500 & 255]);
  assert.equal(order.diagnostics(), "t2:rx=500-81/9,ac=500-500/1,st=100-81/7,behind=398-420,run=3/3");
  order.close();
  assert.equal(order.diagnostics(), "none");
  order.push(Buffer.alloc(0), 501, 2);
  assert.equal(order.diagnostics(), "none");
});

test("counts held arrivals separately from delivery and resets stale runs", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const order = new PpcsDatagramReorderBuffer(() => {}, () => {}, () => {});
  for (const sequence of [10, 12, 12, 11]) order.push(Buffer.alloc(0), sequence, 1);
  assert.equal(order.diagnostics(), "t1:rx=10-11/4,ac=10-12/3,st=---/0,behind=---,run=0/0");
  order.push(Buffer.alloc(0), 14, 1);
  context.mock.timers.tick(250);
  assert.match(order.diagnostics(), /rx=10-14\/5,ac=10-14\/4/);
  for (const sequence of [7, 8, 14, 4, 5]) order.push(Buffer.alloc(0), sequence, 1);
  assert.match(order.diagnostics(), /run=2\/2$/);
  order.close();
});

test("keeps wrapping channels separate and bounds summaries", () => {
  const order = new PpcsDatagramReorderBuffer(() => {}, () => {}, () => {});
  for (const sequence of [65535, 0, 65534, 65535]) order.push(Buffer.alloc(0), sequence, 2);
  order.push(Buffer.alloc(0), 400, 0);
  assert.match(order.diagnostics(), /^t0:rx=400-400\/1.*\|t2:rx=65535-65535\/4,ac=65535-0\/2,st=65534-65535\/2,behind=1-2,run=2\/2$/);
  for (let type = 3; type < 20; type++) order.push(Buffer.alloc(0), 65535, type);
  const summary = order.diagnostics();
  assert.match(summary, /\|t8:.*\|omitted=11$/);
  assert.equal(summary.split("|").length, 9);
  assert.ok(summary.length < 2_048);
  order.close();
});

test("invalid diagnostic inputs preserve existing packet callbacks", () => {
  const delivered: number[] = [];
  const order = new PpcsDatagramReorderBuffer((body) => delivered.push(body[0]!), () => {}, () => {});
  for (const [type, sequence] of [[-1, 3], [256, 4], [0, -1], [1, 65536], [2, 1.5], [3.5, 1]]) {
    order.push(Buffer.from([1]), sequence!, type!);
  }
  assert.equal(delivered.length, 6);
  assert.equal(order.diagnostics(), "none");
  order.close();
});

test("session stats expose live sequence evidence and freeze it before timeout shutdown", (context) => {
  let live = "t2:rx=500-102/4,ac=500-500/1,st=100-102/3,behind=398-400,run=3/3";
  context.mock.method(PpcsDatagramReorderBuffer.prototype, "diagnostics", () => live);
  context.mock.method(PpcsDatagramReorderBuffer.prototype, "close", () => { live = "none"; });
  context.mock.method(Socket.prototype, "close", function (this: Socket) { return this; });
  const session = new FirstPartyPpcsSession({
    stationSerial: "synthetic", p2pDid: "synthetic", appConnection: "synthetic",
    dskKey: "synthetic", channel: 1, homeBaseAttached: true, cameraModel: "T8144", accountId: null,
  });
  const stats = session.stats;
  const expected = live;
  assert.equal(stats.sequenceChannels, expected);
  session.close("first_frame_timeout");
  assert.equal(stats.sequenceChannels, expected);
  assert.equal(stats.closeReason, "first_frame_timeout");
  assert.equal(live, "none");
});
