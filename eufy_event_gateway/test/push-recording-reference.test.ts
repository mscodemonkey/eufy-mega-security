/**
 * Exercises private recording identity admission using invented notification fields.
 * Fixtures own paths and clocks. The parser never contacts a camera or derives
 * a recording date from the opaque ID or the test process's timezone.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parsePushEvent } from "../src/mega/push.js";
import { pushRecordingReference, pushRecordingReferenceProblem, recordingPathDate } from "../src/mega/push-recording-reference.js";

const path = "/zx/hdd_data0/Camera00/202611/20261102090000/20261102092000.zxvideo";
const payload = { record_id: 42, file_path: path, trigger_time: 1_793_568_000_000 };

test("an opaque ID stays exact while the calendar date comes only from the recording path", () => {
  assert.deepEqual(pushRecordingReference(payload), { id: "42", storagePath: path, triggerMilliseconds: payload.trigger_time });
  assert.equal(recordingPathDate(path), "2026-11-02");
  assert.equal(pushRecordingReference({ ...payload, record_id: "9223372036854775807" })?.id, "9223372036854775807");
  assert.equal(Object.isFrozen(pushRecordingReference(payload)), true);
});

test("the innermost payload cannot borrow a recording ID or time from its parent", () => {
  const normalized = parsePushEvent({ ...payload, device_sn: "invented", payload: { event_type: 1, file_path: path } });
  assert.equal(normalized?.recording, undefined);
  assert.deepEqual(parsePushEvent({ device_sn: "invented", payload: JSON.stringify(payload) })?.recording, pushRecordingReference(payload));
});

test("invalid scalar identities never become rounded or partial recording references", () => {
  for (const change of [{ record_id: 9007199254740992 }, { record_id: "9223372036854775808" }, { record_id: "42e1" },
    { record_id: "0042" }, { record_id: 0 }, { trigger_time: "1793568000000" }, { trigger_time: NaN },
    { file_path: path + "?other=1" }, { file_path: path + "\u0000" }]) assert.equal(pushRecordingReference({ ...payload, ...change }), null);
});

test("calendar boundaries reject traversal, mismatched days and normalized invalid dates", () => {
  for (const value of [path.replace("202611/", "202610/"), path.replace("20261102092000", "20261103092000"),
    path.replace("20261102092000", "20261102250000"), path.replace("Camera00", "../Camera00"),
    "/zx/hdd_data0/Camera00/202602/20260230090000/20260230092000.zxvideo"]) assert.equal(recordingPathDate(value), null);
  assert.equal(recordingPathDate(path.replaceAll("20261102", "20261101")), "2026-11-01");
});


test("shape failures distinguish absent fields from unsupported values without borrowing outer data", () => {
  const cases = [
    [{ ...payload, record_id: undefined }, "id_absent"],
    [{ ...payload, record_id: "private-id" }, "id_invalid"],
    [{ ...payload, file_path: undefined }, "path_absent"],
    [{ ...payload, file_path: "private-path" }, "path_unsupported"],
    [{ ...payload, trigger_time: undefined }, "time_absent"],
    [{ ...payload, trigger_time: 1793568000 }, "time_invalid"],
  ] as const;
  assert.equal(pushRecordingReferenceProblem(payload), null);
  for (const [fields, reason] of cases) {
    assert.equal(pushRecordingReference(fields), null);
    assert.equal(pushRecordingReferenceProblem(fields), reason);
    const event = parsePushEvent({ ...payload, device_sn: "invented", payload: fields });
    assert.equal(event?.recording, undefined);
    assert.equal(event?.recordingReferenceProblem, reason);
  }
});


test("rejected references retain only bounded layout and independent clock categories", () => {
  const examples = [
    { path: "/zx/hdd_data0/Camera2/202611/20261102090000/20261102092000.zxvideo", clock: payload.trigger_time,
      shape: "absolute.zx.storage.camera1.digits6.digits14.video14", clockShape: "milliseconds" },
    { path: "/PRIVATE_ROOM/PRIVATE_CAMERA/PRIVATE_PERSON.zxvideo", clock: 1793568000,
      shape: "absolute.other.other.video_other", clockShape: "seconds" },
    { path: path.replace("202611/", "202610/"), clock: "PRIVATE_CLOCK",
      shape: "absolute.zx.storage.camera2.digits6.digits14.video14", clockShape: "invalid" },
    { path: "PRIVATE_PATH".repeat(200), clock: undefined, shape: "too_long", clockShape: "absent" },
    { path: "/other".repeat(20), clock: NaN, shape: "too_many_segments", clockShape: "invalid" },
    { path: { private: "PRIVATE_PATH" }, clock: payload.trigger_time, shape: "not_string", clockShape: "milliseconds" },
    { path: "PRIVATE_PATH\u0000", clock: payload.trigger_time, shape: "invalid_characters", clockShape: "milliseconds" },
  ];
  for (const example of examples) {
    const event = parsePushEvent({ ...payload, device_sn: "invented", payload: {
      ...payload, file_path: example.path, trigger_time: example.clock,
    } })!;
    assert.equal(event.recording, undefined);
    assert.equal(event.recordingReferenceProblem, "path_unsupported");
    assert.deepEqual(event.recordingReferenceShape, { pathShape: example.shape, calendar: "unsupported", clock: example.clockShape });
    assert.equal(/PRIVATE_|1793568000|202611/.test(JSON.stringify(event.recordingReferenceShape)), false);
    assert.equal(Object.isFrozen(event.recordingReferenceShape), true);
  }
  const nested = parsePushEvent({ ...payload, device_sn: "invented", payload: { file_path: "PRIVATE_PATH" } });
  assert.equal(nested?.recordingReferenceShape?.clock, "absent");
});


test("calendar extraction treats a safe storage directory as opaque without loosening the date layout", () => {
  for (const directory of ["volume_1", "storage-A", "hdd_data0"]) {
    const alternate = path.replace("hdd_data0", directory);
    assert.equal(recordingPathDate(alternate), "2026-11-02");
    assert.equal(pushRecordingReference({ ...payload, file_path: alternate })?.storagePath, alternate);
  }
  for (const directory of [".", "..", "a/b", "a%2fb", "a.b", "a b", "a\\b", "a".repeat(65)]) {
    assert.equal(recordingPathDate(path.replace("hdd_data0", directory)), null);
  }
  assert.equal(recordingPathDate(path.replace("hdd_data0", "volume_1").replace("202611/", "202610/")), null);
});
