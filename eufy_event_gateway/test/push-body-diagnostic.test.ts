/**
 * Qualifies content-free body rejection diagnostics for received notifications.
 * Tests own synthetic MCS data and make no connections. The transport summary
 * must explain discarded bodies without publishing values or changing the
 * notification handed to the provider.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { decodeMcsAppData, mcsDeliveryLogSummary } from "../src/mega/android-push/push-client.js";

const body = (value: unknown) => ({ appData: [{ key: "device_sn", value: "PRIVATE-DEVICE" }, { key: "payload", value }] });

for (const [value, status] of [
  ["private.invalid", "invalid_base64"],
  ["A".repeat(90_001), "encoded_limit"],
  [Buffer.from("a".repeat(65_537)).toString("base64"), "decoded_limit"],
  [42, "invalid_value"],
] as const) {
  test(`rejected body is diagnosed as ${status} while outer identity survives`, () => {
    const input = body(value);
    assert.deepEqual(decodeMcsAppData(input), { device_sn: "PRIVATE-DEVICE" });
    const summary = mcsDeliveryLogSummary(input, false);
    assert.ok(summary.includes(`payload_status=${status}`));
    assert.ok(!summary.includes("PRIVATE-DEVICE"));
    assert.ok(!summary.includes("private.invalid"));
  });
}

test("valid NUL-terminated JSON retains semantics and never logs its contents", () => {
  const payload = { a: 3101, device_sn: "PRIVATE-DEVICE", pic_url: "https://private.invalid/secret" };
  const input = body(Buffer.from(JSON.stringify(payload) + "\0ignored").toString("base64"));
  assert.deepEqual(decodeMcsAppData(input).payload, payload);
  const summary = mcsDeliveryLogSummary(input, false);
  assert.ok(summary.includes("payload_status=json_object"));
  for (const forbidden of ["3101", "PRIVATE", "private.invalid", "secret", "ignored"]) assert.ok(!summary.includes(forbidden));
});

test("invalid JSON remains available for the existing normalization rejection", () => {
  const input = body(Buffer.from("PRIVATE-MALFORMED").toString("base64"));
  assert.equal(decodeMcsAppData(input).payload, "PRIVATE-MALFORMED");
  const summary = mcsDeliveryLogSummary(input, false);
  assert.ok(summary.includes("payload_status=invalid_json"));
  assert.ok(!summary.includes("PRIVATE-MALFORMED"));
});

test("non-object JSON and absent bodies have separate fixed categories", () => {
  assert.ok(mcsDeliveryLogSummary(body(Buffer.from("null").toString("base64")), false).includes("payload_status=json_other"));
  assert.ok(mcsDeliveryLogSummary({ appData: [] }, false).includes("payload_status=absent"));
});

test("duplicate payload entries are marked ambiguous without changing last accepted body", () => {
  const input = { appData: [
    { key: "payload", value: Buffer.from('{"a":3101}').toString("base64") },
    { key: "payload", value: "invalid.value" },
  ] };
  assert.deepEqual(decodeMcsAppData(input).payload, { a: 3101 });
  assert.ok(mcsDeliveryLogSummary(input, false).includes("payload_status=multiple"));
});

test("URL-safe push bodies preserve the same event and bounded diagnostics as standard base64", () => {
  const payload = { event_type: 3101, name: "synthetic>??", note: "\uffff" };
  const bytes = Buffer.from(JSON.stringify(payload) + "\0");
  const standard = bytes.toString("base64");
  const urlSafe = bytes.toString("base64url");
  assert.match(standard, /[+/]/);
  assert.match(urlSafe, /[-_]/);
  for (const value of [standard, urlSafe, urlSafe + "=".repeat((4 - urlSafe.length % 4) % 4)]) {
    const input = body(value);
    assert.deepEqual(decodeMcsAppData(input).payload, payload);
    assert.ok(mcsDeliveryLogSummary(input, false).includes("payload_status=json_object"));
    assert.ok(!mcsDeliveryLogSummary(input, false).includes("synthetic"));
  }
});
