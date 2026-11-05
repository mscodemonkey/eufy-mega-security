/**
 * Protects cloud recording selection, renewal and key-map correlation using
 * synthetic records. The Mega client owns these private values for one request,
 * while the normal history API returns only its existing safe projection.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { selectCloudRecording, cloudRecordingKey, cloudRecordingUrl } from "../src/mega/cloud-history.js";

const query = { startTime: 90, endTime: 130 };
const row = { monitor_id: "record", device_sn: "camera", station_sn: "station", start_time: 100, end_time: 120,
  cipher_user_id: "record-owner", member: { action_user_id: "key-owner" }, cipher_id: 7,
  extra: Buffer.from('{"aes_key":"encrypted-key"}').toString("base64url") };

test("selects one exact record and separates renewal ownership from shared key ownership", () => {
  const selected = selectCloudRecording([row], "camera", "station", "record", query);
  assert.deepEqual(selected, { monitorId: "record", cipherOwner: "record-owner", keyOwner: "key-owner", cipherId: 7, encryptedKey: "encrypted-key" });
  assert.equal(selectCloudRecording([{ ...row, member: { action_user_id: "" } }], "camera", "station", "record", query).keyOwner, "record-owner");
  assert.equal(selectCloudRecording([{ ...row, cipher_id: "7" }], "camera", "station", "record", query).cipherId, "7");
  assert.equal(cloudRecordingUrl([{ monitor_id: "record", cloud_path: "private-url" }], selected), "private-url");
  for (const values of [[row, row], [{ ...row, device_sn: "other" }], [{ ...row, station_sn: "other" }],
    [{ ...row, cipher_user_id: "" }], [{ ...row, start_time: 140, end_time: 150 }], [{ ...row, extra: "invalid" }],
    [{ ...row, extra: Buffer.from('{"aes_key":5}').toString("base64url") }]]) {
    assert.throws(() => selectCloudRecording(values, "camera", "station", "record", query));
  }
  assert.throws(() => cloudRecordingUrl([{ monitor_id: "other", cloud_path: "private-url" }], selected));
  assert.throws(() => cloudRecordingUrl([{ cloud_path: "private-url" }, { cloud_path: "other-url" }], selected));
});

test("requires an exact unique cipher and fresh map entry with canonical 32-byte key data", () => {
  const key = Buffer.alloc(32, 255), label = "fresh-label";
  const valid = { cipher_id: 7, aes_keys: { [label]: key.toString("base64url") } };
  assert.deepEqual(cloudRecordingKey({ cipher_keys: [valid] }, 7, label), key);
  assert.deepEqual(cloudRecordingKey({ cipher_keys: [{ ...valid, cipher_id: "7" }] }, "7", label), key);
  assert.throws(() => cloudRecordingKey({ cipher_keys: [valid] }, "7", label));
  assert.deepEqual(cloudRecordingKey({ cipher_keys: [{ ...valid, aes_keys: { [label]: key.toString("base64") } }] }, 7, label), key);
  for (const value of [{ cipher_keys: [valid, valid] }, { cipher_keys: [{ ...valid, cipher_id: 8 }] },
    { cipher_keys: [{ ...valid, aes_keys: { old: key.toString("base64url") } }] },
    { cipher_keys: [{ ...valid, aes_keys: { [label]: Buffer.alloc(31).toString("base64url") } }] },
    { cipher_keys: [{ ...valid, aes_keys: { [label]: "private-not-a-key" } }] }]) {
    assert.throws(() => cloudRecordingKey(value, 7, label));
  }
});
