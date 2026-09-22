/**
 * Tests HomeBase PPCS request framing and privacy-safe state normalization.
 *
 * These cases lock down the discovery headers and generation-specific station
 * parameters without opening a socket or retaining disk paths and serial
 * numbers from the device response.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHomeBaseGuardModeValue,
  HOMEBASE_PPCS_REQUEST_HEADERS,
  isHomeBaseResultFrame,
  parseHomeBaseState,
} from "../src/stream/homebase-ppcs.js";

test("builds the current HomeBase guard-mode payload", () => {
  assert.deepEqual(JSON.parse(buildHomeBaseGuardModeValue("account", "Home Assistant", 1)), {
    account_id: "account",
    cmd: 1224,
    mValue3: 0,
    payload: { mode_type: 1, user_name: "Home Assistant" },
  });
});

test("uses PPCS local-lookup and camera-check request headers", () => {
  assert.equal(HOMEBASE_PPCS_REQUEST_HEADERS.localLookup.toString("hex"), "f130");
  assert.equal(HOMEBASE_PPCS_REQUEST_HEADERS.check.toString("hex"), "f141");
});

test("reads the command-result flag from the inner frame type byte", () => {
  const frame = Buffer.alloc(16);
  frame[10] = 1;
  assert.equal(isHomeBaseResultFrame(frame, 16), false);
  frame[14] = 1;
  assert.equal(isHomeBaseResultFrame(frame, 16), true);
});

test("accepts an untyped four-byte HomeBase command result", () => {
  const frame = Buffer.alloc(16);
  assert.equal(isHomeBaseResultFrame(frame, 4), true);
  assert.equal(isHomeBaseResultFrame(frame, 5), false);
});

test("normalizes HomeBase state and separate physical storage devices", () => {
  const result = parseHomeBaseState({
    main_sw_version: "3.6.0.1",
    params: [
      { dev_type: 255, param_type: 1224, param_value: "2" },
      { dev_type: 255, param_type: 1151, param_value: 1 },
      { dev_type: 255, param_type: 1235, param_value: 20 },
      { dev_type: 255, param_type: 1292, param_value: 10 },
      { dev_type: 255, param_type: 1281, param_value: 2 },
      { dev_type: 1, param_type: 1224, param_value: 63 },
      { dev_type: 1, param_type: 1101, param_value: "73" },
      { dev_type: 1, param_type: 1013, param_value: 0 },
      { dev_type: 1, param_type: 1277, param_value: 1 },
      { dev_type: 1, param_type: 9999, param_value: "private" },
    ],
  }, {
    emmc_info: { disk_size: 1_000, disk_used: 250, work_status: 0, disk_path: "/private/emmc" },
    hdd_info: {
      disk_size: 10_000,
      disk_used: 4_000,
      work_status: 1,
      serial_number: "private-drive-serial",
    },
  });

  assert.deepEqual(result, {
    firmware: "3.6.0.1",
    guardMode: 2,
    effectiveMode: 1,
    alarmVolume: 20,
    promptVolume: 10,
    alarmTone: 2,
    storage: {
      emmc: { status: "normal", totalBytes: 1_048_576_000, freeBytes: 786_432_000 },
      hdd: { status: "non_original", totalBytes: 10_485_760_000, freeBytes: 6_291_456_000 },
    },
    storageDiagnostic: {
      present: true,
      numericFields: ["disk_size:10000", "disk_used:4000", "work_status:1"],
      booleanFields: [],
      textFieldLengths: ["serial_number:20"],
      structuredFields: [],
    },
    childParams: [
      { channel: 1, type: 1101, value: "73" },
      { channel: 1, type: 1013, value: 0 },
      { channel: 1, type: 1277, value: 1 },
    ],
  });
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("accepts a JSON-encoded storage body and rejects unsupported values", () => {
  const result = parseHomeBaseState({
    params: [
      { dev_type: 255, param_type: 1224, param_value: 99 },
      { dev_type: 255, param_type: 1235, param_value: 0 },
    ],
  }, JSON.stringify({ emmc_info: { disk_size: 100, disk_used: 200 } }));

  assert.equal(result.guardMode, null);
  assert.equal(result.alarmVolume, null);
  assert.deepEqual(result.storage?.emmc, { status: "reported", totalBytes: 104_857_600, freeBytes: 0 });
  assert.equal(result.storage?.hdd, null);
  assert.deepEqual(result.storageDiagnostic, {
    present: false,
    numericFields: [],
    booleanFields: [],
    textFieldLengths: [],
    structuredFields: [],
  });
});

test("uses the HomeBase 3 usable capacity and unused video partition", () => {
  const result = parseHomeBaseState({}, {
    hdd_info: {
      disk_size: 491_520,
      disk_size_1024: 457_862,
      disk_used: 67_627,
      system_size: 7_793,
      system_size_data: 18_183,
      video_size: 431_885,
      video_used: 67_002,
      work_status: 0,
    },
  });

  assert.deepEqual(result.storage?.hdd, {
    status: "normal",
    totalBytes: 447_130_859_375,
    freeBytes: 356_331_054_688,
  });
  assert.deepEqual(result.storageDiagnostic, {
    present: true,
    numericFields: [
      "disk_size:491520",
      "disk_size_1024:457862",
      "disk_used:67627",
      "system_size:7793",
      "system_size_data:18183",
      "video_size:431885",
      "video_used:67002",
      "work_status:0",
    ],
    booleanFields: [],
    textFieldLengths: [],
    structuredFields: [],
  });
});

test("summarizes unknown HDD fields without retaining text values", () => {
  const result = parseHomeBaseState({}, {
    hdd_info: {
      disk_size: 480_000,
      mounted: true,
      disk_path: "/private/storage/path",
      partitions: [{ name: "private" }],
      reserved: null,
      storage_id: 42,
      "unsafe key": 7,
    },
  });

  assert.deepEqual(result.storageDiagnostic, {
    present: true,
    numericFields: ["disk_size:480000", "storage_id:42", "unsafe-key:7"],
    booleanFields: ["mounted:true"],
    textFieldLengths: ["disk_path:21"],
    structuredFields: ["partitions:array", "reserved:null"],
  });
  assert.equal(JSON.stringify(result).includes("private"), false);
});
