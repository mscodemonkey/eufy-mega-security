/**
 * Checks live-start repair against an injected clock and synthetic datagrams.
 * Tests own time and outbound bytes; the session owns peer and ACK validation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PpcsMediaStart } from "../src/stream/ppcs-media-start.js";

/** Advance exactly one tracker tick without sleeping or opening a socket. */
function fixture() {
  let now = 0;
  let tick: (() => void) | null = null;
  const sent: Buffer[] = [];
  const tracker = new PpcsMediaStart(packet => sent.push(Buffer.from(packet)), {
    now: () => now,
    repeat: callback => { tick = callback; return () => { tick = null; }; },
  });
  return { tracker, sent, advance: (milliseconds: number) => { now += milliseconds; tick?.(); },
    scheduled: () => tick !== null };
}

test("lost starts repeat byte-identically and exact ACK stops all repair", () => {
  const f = fixture();
  const packet = Buffer.from("synthetic-ciphertext");
  f.tracker.start(65535, packet);
  packet.fill(0);
  f.advance(150);
  assert.deepEqual(f.sent, [Buffer.from("synthetic-ciphertext"), Buffer.from("synthetic-ciphertext")]);
  f.tracker.acknowledge(0);
  assert.equal(f.tracker.pending, true);
  f.tracker.acknowledge(65535);
  f.tracker.acknowledge(65535);
  f.advance(300);
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.tracker.stats, { acknowledged: 1, retransmitted: 1, expired: 0 });
  assert.equal(f.scheduled(), false);
});

test("key upgrade repairs both original sequences without extending their deadlines", () => {
  const f = fixture();
  f.tracker.start(65535, Buffer.from("level-one"));
  f.advance(1500);
  f.tracker.start(0, Buffer.from("level-two"));
  assert.equal(f.tracker.start(1, Buffer.from("third")), false);
  f.advance(1499);
  assert.deepEqual(f.sent.slice(-2), [Buffer.from("level-one"), Buffer.from("level-two")]);
  f.advance(1);
  assert.equal(f.tracker.stats.expired, 1);
  assert.equal(f.tracker.pending, true);
  f.tracker.acknowledge(0);
  assert.equal(f.tracker.pending, false);
  assert.equal(f.scheduled(), false);
});

for (const action of ["stop", "mediaReceived", "close"] as const) {
  test(`${action} cancels current repair and never sends after retirement`, () => {
    const f = fixture();
    f.tracker.start(1, Buffer.from("start"));
    f.tracker[action]();
    f.advance(5000);
    assert.equal(f.sent.length, 1);
    assert.equal(f.scheduled(), false);
    if (action === "close") assert.equal(f.tracker.start(2, Buffer.from("late")), false);
  });
}

test("stop retains only the displaced sequence and close cancels it", () => {
  const f = fixture();
  f.tracker.start(1, Buffer.from("old"));
  f.tracker.start(2, Buffer.from("current"));
  f.tracker.stop();
  f.advance(150);
  assert.deepEqual(f.sent.at(-1), Buffer.from("old"));
  f.tracker.close();
  f.advance(5000);
  assert.equal(f.sent.length, 3);
});

test("expiry sends nothing at the deadline and retires the timer", () => {
  const f = fixture();
  f.tracker.start(7, Buffer.from("lost"));
  f.advance(2999);
  f.advance(1);
  assert.equal(f.sent.length, 2);
  assert.equal(f.tracker.stats.expired, 1);
  assert.equal(f.scheduled(), false);
});
