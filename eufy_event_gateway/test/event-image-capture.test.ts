/**
 * Exercises private capture retention and provider failure isolation offline.
 * Synthetic buffers and clocks own all evidence; no vendor traffic is used.
 */
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import test from "node:test";

import { EventImageCapture, eventImageResponseMetadata } from "../src/diagnostics/event-image-capture.js";
import { safeCameraModel } from "../src/domain/safe-camera-model.js";
import { imageKey } from "../src/mega/image.js";
import { downloadPushSnapshot } from "../src/provider/eufy-provider.js";

const minute = 60_000;
const event = { pictureUrl: "https://example.invalid/private", stationSerial: "fixture-parent" };
const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);

test("retains immutable original bytes, with one sample per family and SHA deduplication", () => {
  const capture = new EventImageCapture();
  try {
    const body = Buffer.from([1, 2, 3]);
    capture.capture(body, { model: "T8111", deviceType: 1, topology: "attached" });
    body.fill(9);
    capture.capture(Buffer.from([1, 2, 3]), { model: "T8170" });
    capture.capture(Buffer.from([4]), { model: "T8111", deviceType: 1, topology: "attached" });
    assert.equal(capture.status().sampleCount, 1);
    assert.equal(capture.status().dropped, 1);
    const archive = capture.archive();
    assert.deepEqual(Buffer.from(archive!.samples[0]!.bodyBase64, "base64"), Buffer.from([1, 2, 3]));
    assert.equal(JSON.stringify(archive), JSON.stringify(capture.archive()));
    assert.doesNotMatch(JSON.stringify(capture.status()), /bodyBase64|sha256|metadata|T8111/);
    Object.assign(archive!.samples[0]!.metadata, { model: "changed" });
    assert.equal(capture.archive()!.samples[0]!.metadata.model, "T8111");
  } finally { capture.close(); }
});

test("bounds count, per-body and total retention even across concurrent callers", async () => {
  const capture = new EventImageCapture();
  const total = new EventImageCapture();
  try {
    await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      capture.capture(Buffer.from([index]), { model: `T${1000 + index}` });
    }));
    assert.equal(capture.status().sampleCount, 4);
    assert.equal(capture.status().dropped, 16);
    for (let index = 0; index < 4; index++) total.capture(Buffer.alloc(2 * 1024 * 1024, index), { model: `T${1000 + index}` });
    assert.equal(total.status().sampleCount, 3);
    assert.equal(total.status().dropped, 1);
    total.capture(Buffer.alloc(2 * 1024 * 1024 + 1), { model: "T9999" });
    assert.equal(total.status().skippedOversize, 1);
    assert.equal(total.prepare(Buffer.alloc(2 * 1024 * 1024 + 1)), null);
  } finally { capture.close(); total.close(); }
});

test("ends collection at 30 minutes but allows retryable export until 60 minutes", () => {
  let elapsed = 0;
  const capture = new EventImageCapture(() => elapsed);
  try {
    capture.capture(Buffer.from([1]));
    elapsed = 30 * minute;
    assert.equal(capture.status().acceptingSamples, false);
    capture.capture(Buffer.from([2]), { model: "T8111" });
    assert.equal(capture.status().sampleCount, 1);
    assert.ok(capture.archive());
    elapsed = 60 * minute;
    assert.equal(capture.archive(), null);
    assert.equal(capture.status().state, "expired");
    assert.equal(capture.status().sampleCount, 0);
  } finally { capture.close(); }
});

test("timer expiry and close clear buffers and timers without keeping the process alive", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const capture = new EventImageCapture(() => 0);
  capture.capture(Buffer.from([1]));
  context.mock.timers.tick(60 * minute);
  assert.equal(capture.status().state, "expired");
  const closed = new EventImageCapture(() => 0);
  closed.capture(Buffer.from([2]));
  closed.close();
  closed.capture(Buffer.from([3]));
  context.mock.timers.tick(60 * minute);
  assert.equal(closed.status().state, "cleared");
  assert.equal(closed.archive(), null);
  context.mock.timers.reset();
});

test("uses wall deadline after suspend and monotonic deadline after wall-clock rollback", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  let elapsed = 0;
  const capture = new EventImageCapture(() => elapsed);
  try {
    capture.capture(Buffer.from([1]));
    context.mock.timers.setTime(100_000 + 60 * minute);
    assert.equal(capture.archive(), null);
    context.mock.timers.setTime(100_000);
    const rollback = new EventImageCapture(() => elapsed);
    rollback.capture(Buffer.from([2]));
    context.mock.timers.setTime(0);
    elapsed = 60 * minute;
    assert.equal(rollback.archive(), null);
    rollback.close();
  } finally { capture.close(); context.mock.timers.reset(); }
});

test("metadata uses closed header sets and omits malformed declared lengths", () => {
  const metadata = eventImageResponseMetadata(new Response("x", { headers: {
    "content-type": "IMAGE/JPEG; account=private", "content-encoding": "gzip, br", "content-length": "not-a-number",
    "set-cookie": "private", location: "https://example.invalid/private",
  } }));
  assert.deepEqual(metadata, { status: 200, contentType: "image/jpeg", contentEncoding: "other", bodyRepresentation: "fetch-body" });
  for (const length of ["-1", "+1", "1.5", "9007199254740992"]) {
    assert.equal(eventImageResponseMetadata(new Response("x", { headers: { "content-length": length } })).declaredLength, undefined);
  }
  assert.equal(eventImageResponseMetadata(new Response("x", { headers: { "content-length": "0001" } })).declaredLength, 1);
  const capture = new EventImageCapture();
  try {
    capture.capture(Buffer.from([1]), { model: "private-label", deviceType: NaN, topology: "invalid" as "direct" },
      { ...metadata, contentType: "private", contentEncoding: "private", declaredLength: -1 });
    assert.doesNotMatch(JSON.stringify(capture.archive()), /private|invalid|declaredLength/);
    assert.equal(safeCameraModel("T8113-V"), "T8113-V");
    assert.equal(safeCameraModel("my-camera"), "unknown");
  } finally { capture.close(); }
});

test("capture is optional, metadata method is bound, and successful images are never retained", async () => {
  const capture = new EventImageCapture();
  let metadataCalls = 0;
  const client = {
    body: jpeg,
    async download() { return this.body; },
    async downloadWithMetadata() {
      metadataCalls++;
      return { data: this.body, status: 200, contentType: "image/jpeg", contentEncoding: "identity", bodyRepresentation: "fetch-body" as const };
    },
  };
  try {
    assert.deepEqual(await downloadPushSnapshot(client, event, new Map()), { data: jpeg });
    assert.equal(metadataCalls, 0);
    assert.deepEqual(await downloadPushSnapshot(client, event, new Map(), capture), { data: jpeg });
    assert.equal(metadataCalls, 1);
    assert.equal(capture.status().sampleCount, 0);
    client.body = Buffer.from([1, 2]);
    await assert.rejects(downloadPushSnapshot(client, event, new Map(), capture), /missing_both/);
    assert.equal(capture.archive()!.samples[0]!.metadata.contentType, "image/jpeg");
  } finally { capture.close(); }
});

test("captures missing identity and thrown decryption failures, but not failed downloads", async () => {
  const capture = new EventImageCapture();
  try {
    const body = Buffer.from("eufysecurity:incomplete");
    await assert.rejects(downloadPushSnapshot({ download: async () => body }, event, new Map(), capture, { model: "T8111" }), /HomeBase identity/);
    await assert.rejects(downloadPushSnapshot({ download: async () => body }, event,
      new Map([["fixture-parent", { p2pDid: "ABC-123456-XYZ" }]]), capture, { model: "T8170" }));
    assert.equal(capture.status().sampleCount, 1);
    assert.deepEqual(Buffer.from(capture.archive()!.samples[0]!.bodyBase64, "base64"), body);
    const error = new Error("synthetic network failure");
    await assert.rejects(downloadPushSnapshot({ download: async () => { throw error; } }, event, new Map(), capture), (actual) => actual === error);
    assert.equal(capture.status().sampleCount, 1);
  } finally { capture.close(); }
});

test("successful legacy decryption leaves no private evidence behind", async () => {
  const capture = new EventImageCapture();
  const serial = "0123456789abcdef";
  const code = "ab00000001";
  const peer = "ABC-123456-XYZ";
  const decoded = Buffer.alloc(256, 1);
  decoded[0] = 0xff; decoded[1] = 0xd8;
  decoded[254] = 0xff; decoded[255] = 0xd9;
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(imageKey(serial, peer, code)).subarray(0, 16), null);
  cipher.setAutoPadding(false);
  const encoded = Buffer.concat([Buffer.from(`eufysecurity:${serial}:${code}:`), cipher.update(decoded), cipher.final()]);
  try {
    const result = await downloadPushSnapshot({ download: async () => encoded }, event,
      new Map([["fixture-parent", { p2pDid: peer }]]), capture);
    assert.deepEqual(result, { data: decoded });
    assert.equal(capture.archive(), null);
    assert.equal(capture.status().sampleCount, 0);
  } finally { capture.close(); }
});

test("collector failure cannot replace the original provider error", async () => {
  const broken = { prepare: () => Buffer.from([1]), capture: () => { throw new Error("synthetic collector error"); } } as unknown as EventImageCapture;
  await assert.rejects(downloadPushSnapshot({ download: async () => Buffer.from([1]) }, event, new Map(), broken), /format=binary.*missing_both/);
});
