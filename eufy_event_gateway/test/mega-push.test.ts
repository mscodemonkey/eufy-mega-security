/**
 * Tests normalization of generation-specific Eufy Android push envelopes.
 *
 * Fixtures include nested JSON and optional fields, proving that only the
 * whitelisted `MegaPushEvent` data crosses into provider logic.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { decodeMcsAppData, mcsDeliveryLogSummary } from "../src/mega/android-push/push-client.js";
import { parsePushEvent, safeUnparsedShape } from "../src/mega/push.js";

test("summarizes every MCS delivery without retaining identifiers or payloads", () => {
  const summary = mcsDeliveryLogSummary({
    persistentId: "private-persistent-id",
    category: "private-category",
    appData: [
      { key: "payload", value: "private-payload" },
      { key: "device_sn", value: "private-device" },
    ],
  }, true);

  assert.equal(
    summary,
    "persistent_id_present=true duplicate=true app_data_entries=2 payload_entry=true device_entry=true station_entry=false event_entry=false category_present=true",
  );
  assert.equal(summary.includes("private"), false);
});

test("retains Firebase sibling identity beside a decoded payload entry", () => {
  const payload = Buffer.from(`${JSON.stringify({ a: 3101, msg_type: 1 })}\0`).toString("base64");
  const decoded = decodeMcsAppData({ appData: [
    { key: "payload", value: payload },
    { key: "device_sn", value: "camera" },
    { key: "station_sn", value: "station" },
  ] });

  assert.deepEqual(decoded, {
    payload: { a: 3101, msg_type: 1 },
    device_sn: "camera",
    station_sn: "station",
  });
  assert.equal(parsePushEvent(decoded)?.cameraSerial, "camera");
  assert.equal(parsePushEvent(decoded)?.stationSerial, "station");
  assert.equal(parsePushEvent(decoded)?.eventType, 3101);
});

test("normalizes a nested HomeBase 3 Mega notification", () => {
  const result = parsePushEvent({ payload: JSON.stringify({
    station_sn: "station", device_sn: "camera", content: "Alex has been detected.",
    payload: { name: "Test camera", a: "3111", nick_name: "Alex", pic_url: "https://example.invalid/image", msg_type: 1 },
  }) });
  assert.deepEqual(result, {
    cameraSerial: "camera", stationSerial: "station", cameraName: "Test camera", eventType: 3111,
    messageType: 1, notificationStyle: null, personName: "Alex", detectionEvidence: [],
    content: "Alex has been detected.",
    pictureUrl: "https://example.invalid/image", filePath: null, fetchId: null, senseId: null,
    guardMode: null, effectiveMode: null, alarmType: null, sensorOpen: null, eventId: null,
  });
});

test("reduces structured AI fields to privacy-safe detection kinds", () => {
  const person = parsePushEvent({
    device_sn: "camera",
    a: 1,
    person_count: 1,
    ai_faces: [{ face_id: 42, confidence: 99 }],
    objects: ["person", "car", "dog"],
    crying: true,
    sound_detection: 1,
  });
  const motion = parsePushEvent({
    device_sn: "camera",
    a: 1,
    person: 0,
    person_count: 0,
    face_ids: [],
  });

  assert.deepEqual(person?.detectionEvidence, ["person", "vehicle", "dog", "crying", "sound"]);
  assert.deepEqual(motion?.detectionEvidence, []);
  assert.equal(JSON.stringify(person).includes("confidence"), false);
  assert.equal(JSON.stringify(person).includes("42"), false);
});

test("normalizes contact state without retaining the raw push", () => {
  assert.equal(parsePushEvent({ device_sn: "entry", a: 3, e: "1" })?.sensorOpen, true);
  assert.equal(parsePushEvent({ device_sn: "entry", a: 3, e: "0" })?.sensorOpen, false);
  assert.equal(parsePushEvent({ device_sn: "entry", a: 3 })?.sensorOpen, null);
});

test("normalizes a direct Android MCS camera payload", () => {
  const result = parsePushEvent({
    device_sn: "camera",
    station_sn: "station",
    a: 3101,
    name: "Test camera",
    pic_url: "https://example.invalid/image",
    account_email: "private@example.invalid",
  });
  assert.equal(result?.cameraSerial, "camera");
  assert.equal(result?.stationSerial, "station");
  assert.equal(result?.eventType, 3101);
  assert.equal(result?.pictureUrl, "https://example.invalid/image");
  assert.equal(JSON.stringify(result).includes("private@example.invalid"), false);
});

test("rejects notifications without a device identity", () => {
  assert.equal(parsePushEvent({ payload: "{}" }), null);
  assert.equal(
    safeUnparsedShape({ payload: JSON.stringify({ content: "private message", pic_url: "https://example.invalid/private" }) }),
    "data_record=true outer_payload=true inner_payload=false device_field=false station_field=false notification_field=false",
  );
});

test("normalizes HomeBase guard and alarm push state without retaining unrelated data", () => {
  const result = parsePushEvent({ payload: JSON.stringify({
    station_sn: "station",
    event_type: 9,
    station_guard_mode: 2,
    current_mode: 1,
    alarm_type: 3,
    account_email: "private@example.invalid",
  }) });

  assert.equal(result?.guardMode, 2);
  assert.equal(result?.effectiveMode, 1);
  assert.equal(result?.alarmType, 3);
  assert.equal(JSON.stringify(result).includes("private@example.invalid"), false);
});
