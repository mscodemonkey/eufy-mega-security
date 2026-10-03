/**
 * Tests streaming size, truncation and cancellation at the cloud body boundary.
 * Synthetic streams own all bytes, so no remote media or credentials are used.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readBoundedResponse } from "../src/mega/bounded-response.js";

const signal = new AbortController().signal;

test("rejects streamed overflow even when content length is missing", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(3)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readBoundedResponse(response, 5, signal), /size limit/);
  assert.equal(cancelled, true);
});

test("validates declared length, finite limits and actual body length", async () => {
  for (const length of ["-1", "invalid", "9007199254740993", "6"]) {
    await assert.rejects(readBoundedResponse(new Response("abc", { headers: { "content-length": length } }), 5, signal), /invalid size/);
  }
  await assert.rejects(readBoundedResponse(new Response("abc", { headers: { "content-length": "4" } }), 5, signal), /truncated/);
  await assert.rejects(readBoundedResponse(new Response(""), 5, signal), /empty/);
  assert.equal((await readBoundedResponse(new Response("abc", { headers: { "content-length": "3" } }), 5, signal)).toString(), "abc");
});

test("cancellation interrupts a reader blocked waiting for the next chunk", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const result = readBoundedResponse(response, 5, controller.signal);
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(cancelled, true);
});


test("bounds decompressed bytes without comparing their size to a compressed transfer length", async () => {
  const response = new Response("decompressed-data", { headers: { "content-encoding": "gzip", "content-length": "2" } });
  assert.equal((await readBoundedResponse(response, 30, signal)).toString(), "decompressed-data");
  await assert.rejects(readBoundedResponse(new Response("decompressed-data", { headers: { "content-encoding": "gzip", "content-length": "2" } }), 5, signal), /size limit/);
});
