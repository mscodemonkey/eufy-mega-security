/**
 * Exercises the microphone encoder with generated PCMU only. Tests own their
 * FFmpeg children and never open a host microphone, camera or account session.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { C31MicrophoneInput } from "../src/stream/c31-microphone.js";
import { c31TalkbackFrames } from "../src/stream/c31-talkback.js";


test("generated microphone packets encode incrementally before input ends", async () => {
  const input = new C31MicrophoneInput();
  let ended = false, beforeEnd = false, frames = 0;
  const reading = (async () => {
    for await (const frame of input.frames) {
      if (!ended) beforeEnd = true;
      assert.equal(c31TalkbackFrames(frame).length, 1); frames++;
    }
  })();
  try {
    for (let index = 0; index < 100; index++) {
      input.push(Buffer.alloc(160, 0xff), index, index * 160);
      await delay(20);
    }
    ended = true; input.end(); await input.finished; await reading;
    assert.equal(beforeEnd, true); assert.ok(frames > 20);
    assert.equal(input.summary.receivedPackets, 100);
    assert.equal(input.summary.outcome, "completed");
    assert.ok(input.summary.maximumQueuedFrames <= 16);
  } finally { input.close(); await input.finished; await reading.catch(() => undefined); }
});


test("microphone RTP wraps its clocks, ignores duplicates and fills only small missing intervals", async () => {
  const input = new C31MicrophoneInput();
  const reading = (async () => { for await (const frame of input.frames) assert.ok(frame.length > 0); })();
  try {
    input.push(Buffer.alloc(160, 0xff), 65535, 0xffff_ff60);
    input.push(Buffer.alloc(160, 0xff), 0, 0);
    input.push(Buffer.alloc(160, 0xff), 0, 0);
    input.push(Buffer.alloc(160, 0xff), 65535, 0xffff_ff60);
    input.push(Buffer.alloc(160, 0xff), 2, 320);
    input.end(); await input.finished; await reading;
    assert.equal(input.summary.receivedPackets, 3);
    assert.equal(input.summary.duplicatePackets, 2);
    assert.equal(input.summary.insertedSamples, 160);
  } finally { input.close(); await input.finished; await reading.catch(() => undefined); }
});

for (const kind of ["size", "sequence", "timestamp", "gap"]) {
  test(`microphone invalid input stops its owned encoder: ${kind}`, async () => {
    const input = new C31MicrophoneInput();
    const reading = assert.rejects((async () => { for await (const frame of input.frames) assert.ok(frame.length > 0); })());
    try {
      input.push(Buffer.alloc(160, 0xff), 1, 160);
      input.push(Buffer.alloc(kind === "size" ? 641 : 160, 0xff), kind === "sequence" ? -1 : 2,
        kind === "timestamp" ? -1 : kind === "gap" ? 10000 : 320);
      await input.finished; await reading;
      assert.equal(input.summary.outcome, kind === "gap" ? "timestamp_gap" : "invalid_packet");
    } finally { input.close(); await input.finished; }
  });
}


test("microphone queue has one consumer and cancellation releases a pending read", async () => {
  const input = new C31MicrophoneInput();
  const iterator = input.frames[Symbol.asyncIterator]();
  assert.throws(() => input.frames[Symbol.asyncIterator](), /already has a consumer/);
  const stopped = assert.rejects(iterator.next()); input.close();
  await input.finished; await stopped; assert.equal(input.summary.outcome, "cancelled");
});
