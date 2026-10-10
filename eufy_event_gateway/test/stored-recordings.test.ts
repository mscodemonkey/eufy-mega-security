/**
 * Exercises owned history correlation, native stored encryption and complete MP4
 * decoding using synthetic identities. No test contacts Eufy or physical hardware.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createCipheriv } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { imageKey } from "../src/mega/image.js";
import { SoloCamRecordingReader, parseStoredRecordings, validateRecordingDate, decodeStoredVideo } from "../src/stream/stored-recordings.js";
import { RecordingCache, recordingByteRange } from "../src/storage/recording-cache.js";

const run = promisify(execFile);
const serial = "SYNTHETIC", did = "SYNTHETIC-DID", timestamp = "1791500754";
const path = "/media/mmcblk0p1/Camera00/event/202610/20261009/20261009090554.zxvideo";
const row = { device_sn: serial, device_type: 88, storage_type: 1, storage_cloud: 0, write_status: 1,
  storage_path: path, start_time: "2026-10-09 09:05:54", end_time: "2026-10-09 09:06:09", time_zone: "+1000" };
const history = { mIntRet: 0, data: [{ table_name: "history_record_info", payload: [row] }] };
const record = parseStoredRecordings(history, serial)[0]!;

function header(command: number, channel = 0, sign = 0): Buffer {
  const value = Buffer.alloc(16); value.writeUInt16LE(command, 4); value[12] = channel; value[13] = sign; return value;
}

function videoPayload(video: Buffer): Buffer {
  const value = Buffer.alloc(22); value.writeUInt32LE(video.length); value[5] = 1; value[10] = 3;
  return Buffer.concat([value, video]);
}

test("history accepts only owned completed local event files and canonical dates", () => {
  assert.equal(record.startTime, "2026-10-08T23:05:54.000Z");
  assert.throws(() => validateRecordingDate("2026-02-30"));
  assert.throws(() => validateRecordingDate("2026-2-03"));
  validateRecordingDate("2024-02-29");
  assert.throws(() => parseStoredRecordings({ ...history, data: [{ table_name: "history_record_info", payload: [{ ...row, device_sn: "OTHER" }] }] }, serial), /ownership/);
  assert.throws(() => parseStoredRecordings({ ...history, data: [{ table_name: "history_record_info", payload: [{ ...row, device_type: 48 }] }] }, serial), /ownership/);
  for (const change of [{ storage_cloud: 1 }, { write_status: 0 }, { storage_path: "/etc/passwd" }]) {
    assert.equal(parseStoredRecordings({ ...history, data: [{ table_name: "history_record_info", payload: [{ ...row, ...change }] }] }, serial).length, 0);
  }
});

test("C31 history retains its exact SD layout and rejects other models and path roots", () => {
  const c31Path = path.replace("/media/mmcblk0p1", "/mnt/sdcard");
  const c31Row = { ...row, device_type: 10_031, storage_path: c31Path };
  const c31History = { ...history, data: [{ table_name: "history_record_info", payload: [c31Row] }] };
  assert.equal(parseStoredRecordings(c31History, serial, 10_031)[0]?.storagePath, c31Path);
  assert.throws(() => parseStoredRecordings(c31History, serial), /ownership/);
  assert.throws(() => parseStoredRecordings(history, serial, 10_031), /ownership/);
  assert.throws(() => parseStoredRecordings(c31History, "foreign", 10_031), /ownership/);
  for (const storagePath of [path, c31Path.replace("Camera00", "Camera01"), c31Path.replace("/event/", "/continuous/"), c31Path.replace("/Camera00/", "/../Camera00/")]) {
    const invalid = { ...c31History, data: [{ table_name: "history_record_info", payload: [{ ...c31Row, storage_path: storagePath }] }] };
    assert.equal(parseStoredRecordings(invalid, serial, 10_031).length, 0);
  }
});

test("C31's native empty-day reply is empty history only after a successful result", () => {
  assert.deepEqual(parseStoredRecordings({ mIntRet: 0, data: "[]" }, serial, 10_031), []);
  assert.throws(() => parseStoredRecordings({ mIntRet: 1, data: "[]" }, serial, 10_031), /accepted/);
  assert.throws(() => parseStoredRecordings({ mIntRet: 0, data: "{}" }, serial, 10_031), /accepted/);
  assert.throws(() => parseStoredRecordings({ mIntRet: 0, data: "[]" }, serial), /accepted/);
});

test("C31 saved-frame metadata is admitted only by its storage profile", async () => {
  const c31Record = { ...record, storagePath: path.replace("/media/mmcblk0p1", "/mnt/sdcard") };
  for (const deviceType of [88, 10_031] as const) {
    const controller = new AbortController();
    const reader = new SoloCamRecordingReader({ serial, p2pDid: did, deviceType, query: () => {}, download: () => {}, decodeReply: (bytes) => bytes });
    const pending = reader.download(deviceType === 88 ? record : c31Record, controller.signal);
    const payload = videoPayload(Buffer.alloc(200));
    payload[10] = 128;
    assert.equal(reader.handleFrame(header(1300, 101, 1), payload, 3), true);
    if (deviceType === 88) {
      await assert.rejects(pending, /framing/);
    } else {
      controller.abort();
      await assert.rejects(pending, /cancelled/);
    }
    reader.close();
  }
  const reader = new SoloCamRecordingReader({ serial, p2pDid: did, deviceType: 10_031, query: () => {}, download: () => {}, decodeReply: (bytes) => bytes });
  await assert.rejects(reader.download(record), /reference/);
  reader.close();
});

test("a stale history transaction cannot complete a current query; shutdown rejects it", async () => {
  let transaction = "";
  const reader = new SoloCamRecordingReader({ serial, p2pDid: did, query: (id) => { transaction = id; }, download: () => {}, decodeReply: (bytes) => bytes });
  const pending = reader.list("2026-10-09");
  const reply = { ...history, cmd: 10017, table: "history_record_info", transaction: "stale" };
  reader.handleFrame(header(1306), Buffer.from(JSON.stringify(reply)), 0);
  assert.equal(transaction.length, 13);
  reader.handleFrame(header(1306), Buffer.from(JSON.stringify({ ...reply, transaction })), 0);
  assert.deepEqual(await pending, [record]);
  const next = reader.list("2026-10-09"); reader.close();
  await assert.rejects(next, /closed/);
});

test("EOF without a valid execution timestamp and foreign media never produce a clip", async () => {
  const controller = new AbortController();
  const reader = new SoloCamRecordingReader({ serial, p2pDid: did, query: () => {}, download: () => {}, decodeReply: (bytes) => bytes });
  const pending = reader.download(record, controller.signal);
  assert.equal(reader.handleFrame(header(1300, 101), videoPayload(Buffer.alloc(200)), 2), false);
  assert.equal(reader.handleFrame(header(1300, 1), videoPayload(Buffer.alloc(200)), 3), false);
  reader.handleFrame(header(1304), Buffer.alloc(0), 3);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(reader.downloading, false);
  const rejected = reader.download(record);
  reader.handleFrame(header(1024, 255, 8), Buffer.alloc(36, 1), 0);
  await assert.rejects(rejected, /timestamp/);
});

test("native first-block encryption uses the execution timestamp, independent of frame metadata", () => {
  const raw = Buffer.alloc(200, 5); Buffer.from([0, 0, 0, 1, 0x67]).copy(raw);
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(imageKey(serial, did, timestamp), "ascii").subarray(0, 16), null); cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(raw.subarray(0, 128)), cipher.final(), raw.subarray(128)]);
  assert.deepEqual(decodeStoredVideo([{ frame: videoPayload(encrypted), sign: 1 }], serial, did, timestamp), raw);
  assert.deepEqual(decodeStoredVideo([{ frame: videoPayload(raw), sign: 0 }], serial, did, timestamp), raw);
  assert.throws(() => decodeStoredVideo([{ frame: videoPayload(encrypted), sign: 1 }], serial, did, "1791500755"), /decrypted/);
});

test("owned stored downloads fully decode both audio and silent recordings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-stored-test-"));
  try {
    const source = join(directory, "video.h264"), audioPath = join(directory, "audio.aac");
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=15", "-t", "3", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-g", "15", "-f", "h264", source]);
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "3", "-ac", "1", "-c:a", "aac", "-f", "adts", audioPath]);
    const video = await readFile(source), audio = await readFile(audioPath);
    const cipher = createCipheriv("aes-128-ecb", Buffer.from(imageKey(serial, did, timestamp), "ascii").subarray(0, 16), null); cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(video.subarray(0, 128)), cipher.final(), video.subarray(128)]);
    for (const [deviceType, hasAudio] of [[88, true], [88, false], [10_031, true], [10_031, false]] as const) {
      const reader = new SoloCamRecordingReader({ serial, p2pDid: did, deviceType, query: () => {}, decodeReply: (bytes) => bytes, download: () => {
        const reply = Buffer.alloc(36); reply.write(timestamp, 4, "ascii");
        reader.handleFrame(header(1024, 255, 8), reply, 0);
        const payload = videoPayload(encrypted); payload[10] = deviceType === 10_031 ? 128 : 0;
        reader.handleFrame(header(1300, 101, 1), payload, 3);
        if (hasAudio) {
          const metadata = Buffer.alloc(16); metadata.writeUInt32LE(audio.length); metadata[5] = 1;
          reader.handleFrame(header(1301, 101), Buffer.concat([metadata, audio]), 3);
        }
        reader.handleFrame(header(1304), Buffer.alloc(0), 3);
      } });
      const selectedRecord = deviceType === 10_031
        ? { ...record, storagePath: path.replace("/media/mmcblk0p1", "/mnt/sdcard") } : record;
      const mp4 = await reader.download(selectedRecord);
      const target = join(directory, `${deviceType}-${hasAudio}.mp4`); await writeFile(target, mp4);
      const probe = JSON.parse((await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", target])).stdout);
      assert.equal(probe.streams.some((track: { codec_type: string }) => track.codec_type === "audio"), hasAudio);
      assert.ok(Number(probe.format.duration) >= 2.9);
      assert.ok(mp4.indexOf(Buffer.from("moov")) < mp4.indexOf(Buffer.from("mdat")));
      assert.equal(reader.downloading, false);
      reader.close();
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("recording cache expiry, eviction and single byte ranges are bounded", () => {
  let clock = 0;
  const cache = new RecordingCache(() => clock);
  cache.put("first", Buffer.from("abc")); clock = 600_000;
  assert.equal(cache.get("first"), null);
  for (let i = 0; i < 5; i++) cache.put(String(i), Buffer.from("abc"));
  assert.equal(cache.get("0"), null);
  assert.deepEqual(recordingByteRange("bytes=1-99", 10), { start: 1, end: 9 });
  assert.deepEqual(recordingByteRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(recordingByteRange("bytes=4-", 10), { start: 4, end: 9 });
  for (const value of ["bytes=10-", "bytes=3-2", "bytes=-0", "bytes=0-1,3-4", "bytes=-", "bytes=999999999999999999-"]) assert.equal(recordingByteRange(value, 10), null);
  cache.clear(); assert.equal(cache.get("4"), null);
});

test("timestamp and clear media without EOF are cancelled rather than served", async () => {
  const controller = new AbortController();
  const reader = new SoloCamRecordingReader({ serial, p2pDid: did, query: () => {}, download: () => {}, decodeReply: (bytes) => bytes });
  const pending = reader.download(record, controller.signal);
  const reply = Buffer.alloc(36); reply.write(timestamp, 4, "ascii");
  reader.handleFrame(header(1024, 255, 8), reply, 0);
  const media = Buffer.alloc(200); Buffer.from([0, 0, 0, 1, 0x67]).copy(media);
  reader.handleFrame(header(1300, 101), videoPayload(media), 3);
  await Promise.resolve(); assert.equal(reader.downloading, true);
  controller.abort(); await assert.rejects(pending, /cancelled/);
});

test("unsupported protection and cumulative oversize transfers fail before packaging", async () => {
  for (const oversized of [false, true]) {
    const reader = new SoloCamRecordingReader({ serial, p2pDid: did, query: () => {}, download: () => {}, decodeReply: (bytes) => bytes });
    const pending = reader.download(record);
    const payload = videoPayload(Buffer.alloc(2 * 1024 * 1024));
    if (oversized) {
      for (let i = 0; i < 17; i++) reader.handleFrame(header(1300, 101), payload, 3);
    } else {
      payload[10] = 8; reader.handleFrame(header(1300, 101, 1), payload, 3);
    }
    await assert.rejects(pending, oversized ? /limit/ : /unsupported/);
    assert.equal(reader.downloading, false); reader.close();
  }
});
