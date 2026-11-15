/**
 * Checks native speaker framing, paced delivery and cancellation with synthetic AAC.
 * Tests own their sink. Physical speaker output is validated separately on hardware.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { c31TalkbackBody, c31TalkbackFrames, C31TalkbackSender } from "../src/stream/c31-talkback.js";

function frame(): Buffer { return Buffer.concat([Buffer.from([0xff, 0xf9, 0x60, 0x40, 4, 0x1f, 0xfc]), Buffer.alloc(25)]); }

test("native speaker metadata preserves whole AAC and rejects unsupported or oversized clips", () => {
  const audio = frame(), body = c31TalkbackBody(audio);
  assert.equal(body.readUInt32LE(0), 32);
  assert.ok(body.subarray(4, 16).every((byte) => byte === 0));
  assert.deepEqual(body.subarray(16), audio);
  assert.equal(c31TalkbackFrames(Buffer.concat([audio, audio])).length, 2);
  for (const bytes of [Buffer.alloc(0), audio.subarray(0, -1), Buffer.concat(Array(313).fill(audio))]) assert.throws(() => c31TalkbackFrames(bytes));
  assert.throws(() => c31TalkbackBody(Buffer.concat([audio, audio])));
  const wrongRate = Buffer.from(audio); wrongRate[2] = 0x50;
  assert.throws(() => c31TalkbackFrames(wrongRate), /16 kHz/);
});

test("speaker frames are paced and stop exactly once after acknowledged completion", async () => {
  const times: number[] = []; let starts = 0, stops = 0;
  const sender = new C31TalkbackSender({ start: () => { starts++; }, stop: () => { stops++; }, send: () => {
    const seq = times.length; times.push(performance.now()); queueMicrotask(() => sender.acknowledge(seq)); return seq;
  } });
  await sender.play(Buffer.concat(Array(4).fill(frame()))); sender.close();
  assert.equal(starts, 1); assert.equal(stops, 1); assert.equal(times.length, 4);
  assert.ok(times[3]! - times[0]! >= 170); await assert.rejects(sender.play(frame()));
});

test("lost ACK retries its original sequence and fails after bounded recovery", async () => {
  const sequences: number[] = []; let stops = 0;
  const sender = new C31TalkbackSender({ start: () => {}, stop: () => { stops++; }, send: (_, retry) => {
    sequences.push(retry ?? 7); return retry ?? 7;
  } });
  await assert.rejects(sender.play(frame()), /did not acknowledge/);
  assert.deepEqual(sequences, [7, 7]); assert.equal(stops, 1);
});

test("cancellation during startup stops without transmitting queued audio", async () => {
  const controller = new AbortController(); let starts = 0, stops = 0, sent = 0;
  const sender = new C31TalkbackSender({ start: () => { starts++; }, stop: () => { stops++; }, send: () => sent++ });
  const operation = sender.play(frame(), controller.signal); controller.abort(); await assert.rejects(operation);
  assert.equal(starts, 1); assert.equal(stops, 1); assert.equal(sent, 0);
});


test("live input is sent before its producer finishes and stops once", async () => {
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  let sent!: () => void;
  const observed = new Promise<void>(resolve => { sent = resolve; });
  let starts = 0, stops = 0, count = 0;
  const sender = new C31TalkbackSender({ start: () => { starts++; }, stop: () => { stops++; }, send: () => {
    const sequence = count++; queueMicrotask(() => sender.acknowledge(sequence)); sent(); return sequence;
  } });
  async function* input(): AsyncGenerator<Buffer> { yield frame(); await done; yield frame(); }
  const operation = sender.stream(input());
  await observed; assert.equal(stops, 0); assert.equal(count, 1);
  finish(); await operation; sender.close();
  assert.equal(starts, 1); assert.equal(stops, 1); assert.equal(count, 2);
});


test("empty or malformed live input never starts a speaker", async () => {
  for (const kind of ["empty", "invalid"]) {
    let starts = 0, stops = 0;
    const sender = new C31TalkbackSender({ start: () => { starts++; }, stop: () => { stops++; }, send: () => 1 });
    async function* input(): AsyncGenerator<Buffer> { if (kind === "invalid") yield Buffer.alloc(3); }
    if (kind === "invalid") await assert.rejects(sender.stream(input()));
    else await sender.stream(input());
    assert.equal(starts, 0); assert.equal(stops, 0);
  }
});


test("live cancellation interrupts a stalled producer and retires only its speaker", async () => {
  const abort = new AbortController(); let stops = 0, sent!: () => void;
  const observed = new Promise<void>(resolve => { sent = resolve; });
  const sender = new C31TalkbackSender({ start: () => {}, stop: () => { stops++; }, send: () => { sent(); return 1; } });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  async function* input(): AsyncGenerator<Buffer> { yield frame(); await held; }
  const operation = sender.stream(input(), abort.signal);
  await observed; abort.abort(); await assert.rejects(operation); release();
  assert.equal(stops, 1); sender.close(); assert.equal(stops, 1);
});
