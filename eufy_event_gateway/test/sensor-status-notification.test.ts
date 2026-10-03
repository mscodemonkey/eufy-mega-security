/**
 * Tests the bounded passive-contact decoder without a vendor connection.
 *
 * Synthetic clear notifications establish accepted fields, channel conflicts
 * and input budgets. Provider tests separately check identity matching and
 * gateway publication, while the PPCS session owns decryption and lifetime.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { decodeSensorContactNotification } from "../src/stream/sensor-status-notification.js";

const notification = (params: unknown[]) => Buffer.from(JSON.stringify({ cmd: 1829, payload: { params } }));

test("passive contact rows retain only explicit open and closed values", () => {
  assert.deepEqual(decodeSensorContactNotification(notification([
    { dev_type: 3, param_type: 1550, param_value: "0", private: "omit" },
    { dev_type: "4", param_type: "1550", param_value: "1" },
    { dev_type: 5, param_type: 1141, param_value: "-58" },
  ])), [{ channel: 3, open: false }, { channel: 4, open: true }]);
  for (const invalid of [true, null, "", "unknown", 2, {}, []]) {
    assert.deepEqual(decodeSensorContactNotification(notification([
      { dev_type: 3, param_type: 1550, param_value: invalid },
    ])), []);
  }
});

test("duplicate rows are deduplicated and contradictory channels remain unknown", () => {
  const row = { dev_type: 3, param_type: 1550, param_value: "1" };
  assert.deepEqual(decodeSensorContactNotification(notification([row, row])), [{ channel: 3, open: true }]);
  assert.deepEqual(decodeSensorContactNotification(notification([
    row, { ...row, param_value: "0" }, row,
  ])), []);
});

test("wrong commands, invalid channels and oversized notifications are ignored", () => {
  for (const channel of [-1, 255, 1.5, true, "station", null]) {
    assert.deepEqual(decodeSensorContactNotification(notification([
      { dev_type: channel, param_type: 1550, param_value: "1" },
    ])), []);
  }
  for (const clear of [Buffer.from("broken"), Buffer.alloc(65_537), notification(Array(257).fill({})),
    Buffer.from(JSON.stringify({ cmd: 1103, payload: { params: [] } })), Buffer.from("null")]) {
    assert.deepEqual(decodeSensorContactNotification(clear), []);
  }
});
