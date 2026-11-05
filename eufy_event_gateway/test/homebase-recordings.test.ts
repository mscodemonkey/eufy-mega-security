/**
 * Tests HomeBase recording ownership, isolated reception and recipient-key media.
 * Synthetic protocol frames and generated codec samples stay inside this test.
 * No Eufy account, network peer or physical camera is contacted.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createCipheriv, createECDH, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { HomeBaseRecordingReader, isHomeBaseRecordingPath, parseHomeBaseRecordings, type HomeBaseRecordingTransport } from "../src/stream/homebase-recordings.js";
import { PpcsVideoFrameDecoder } from "../src/stream/first-party-ppcs.js";

const run = promisify(execFile), serial = "SYNTHETIC-CHILD", stationSerial = "SYNTHETIC-STATION";
const path = "/test/storage/Camera01/202610/20261009114516/20261009114516.zxvideo";
const row = { device_sn: serial, station_sn: stationSerial, device_type: 88, storage_type: 2, storage_cloud: 0, write_status: 1,
  storage_path: path, start_time: "2026-10-09 11:45:16", end_time: "2026-10-09 11:45:18", time_zone: "+1000" };
const history = { mIntRet: 0, data: [{ table_name: "history_record_info", payload: [row] }] };
const record = parseHomeBaseRecordings(history, serial, stationSerial)[0]!;
const mediaKey = Buffer.alloc(32, 9);

function header(command: number, channel = 1, sign = 0, stream = 25): Buffer {
  const result = Buffer.alloc(16); result.writeUInt16LE(command, 4); result[12] = channel; result[13] = sign; result[14] = stream; return result;
}

function transport(overrides: Partial<HomeBaseRecordingTransport> = {}): HomeBaseRecordingTransport {
  return { serial, stationSerial, channel: 1, query: () => {}, download: () => {}, decodeReply: (payload) => payload,
    decoder: (privateKey) => {
      assert.match(privateKey, /^[0-9a-f]{64}$/, "recipient scalar retains leading zeroes");
      const decoder = new PpcsVideoFrameDecoder(() => undefined); decoder.setEccPrivateKey(privateKey);
      return { video: (payload, sign) => decoder.decode(payload, sign), audio: (payload) => decoder.decodeRecordingAudio(payload), close: () => decoder.setEccPrivateKey("") };
    }, ...overrides };
}

function videoFrame(publicKey: Buffer, data: Buffer, index: number): Buffer {
  const keyframe = index % 15 === 0, stamp = Math.round(index * 1000 / 15);
  if (!keyframe) {
    const result = Buffer.alloc(22); result.writeUInt32LE(data.length); result[5] = 1; result.writeUIntLE(stamp, 14, 6);
    return Buffer.concat([result, data]);
  }
  const ephemeral = createECDH("prime256v1"); ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(publicKey), label = Buffer.from("ECIES");
  const hmac = (key: Buffer, value: Buffer): Buffer => createHmac("sha256", key).update(value).digest();
  let previous: Buffer<ArrayBufferLike> = label, derived: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (derived.length < 48) { previous = hmac(shared, previous); derived = Buffer.concat([derived, hmac(shared, Buffer.concat([previous, label]))]); }
  const envelope = Buffer.alloc(129); ephemeral.getPublicKey(undefined, "compressed").copy(envelope);
  const iv = Buffer.alloc(16, 3); iv.copy(envelope, 33);
  const wrap = createCipheriv("aes-128-cbc", derived.subarray(0, 16), iv);
  Buffer.concat([wrap.update(mediaKey), wrap.final()]).copy(envelope, 49);
  hmac(derived.subarray(16, 48), envelope.subarray(33, 97)).copy(envelope, 97);
  const nonce = Buffer.alloc(12); nonce.writeUInt32LE(index);
  const cipher = createCipheriv("aes-256-gcm", mediaKey, nonce); cipher.setAAD(Buffer.from("eufy security"));
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  const result = Buffer.alloc(179); result.writeUInt32LE(data.length); result[4] = 1; result[5] = 1; result.writeUIntLE(stamp, 14, 6);
  envelope.copy(result, 22); cipher.getAuthTag().copy(result, 151); nonce.copy(result, 167);
  return Buffer.concat([result, body]);
}

function audioFrame(data: Buffer, index: number): Buffer {
  const nonce = Buffer.alloc(12); nonce.writeUInt32LE(index + 10000);
  const cipher = createCipheriv("aes-256-gcm", mediaKey, nonce); cipher.setAAD(Buffer.from("eufy security"));
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  const result = Buffer.alloc(44); result.writeUInt32LE(data.length); cipher.getAuthTag().copy(result, 16); nonce.copy(result, 32);
  return Buffer.concat([result, body]);
}

test("station rows create references only for exact owned completed type88 HomeBase files", () => {
  assert.equal(record.startTime, "2026-10-09T01:45:16.000Z");
  assert.deepEqual(parseHomeBaseRecordings({ ...history, data: [{ table_name: "history_record_info", payload: [{ ...row, device_sn: "SIBLING" }, row] }] }, serial, stationSerial), [record]);
  for (const change of [{ station_sn: "FOREIGN" }, { device_type: 48 }]) {
    assert.throws(() => parseHomeBaseRecordings({ ...history, data: [{ table_name: "history_record_info", payload: [{ ...row, ...change }] }] }, serial, stationSerial), /ownership/);
  }
  for (const change of [{ storage_type: 1 }, { storage_cloud: 1 }, { write_status: 0 }, { end_time: "" }, { storage_path: "/etc/passwd" }]) {
    assert.equal(parseHomeBaseRecordings({ ...history, data: [{ table_name: "history_record_info", payload: [{ ...row, ...change }] }] }, serial, stationSerial).length, 0);
  }
  for (const invalid of [path.replace("/test/", "/../"), path.replace("20261009114516.zxvideo", "20261009114517.zxvideo"), path + "\0", path.replace("202610/", "202609/")]) assert.equal(isHomeBaseRecordingPath(invalid), false);
});

test("history requires parent channel, exact command/table and current transaction; close rejects pending work", async () => {
  let transaction = "";
  const reader = new HomeBaseRecordingReader(transport({ query: (id) => { transaction = id; } }));
  const pending = reader.list("2026-10-09");
  const reply = { ...history, cmd: 10011, table: "history_record_info", transaction };
  assert.equal(reader.handleFrame(header(1306, 1), Buffer.from(JSON.stringify(reply)), 2), false);
  reader.handleFrame(header(1306, 255), Buffer.from(JSON.stringify({ ...reply, transaction: "stale" })), 2);
  reader.handleFrame(header(1306, 255), Buffer.from(JSON.stringify({ ...reply, cmd: 10017 })), 2);
  reader.handleFrame(header(1306, 255), Buffer.from(JSON.stringify(reply)), 2);
  assert.deepEqual(await pending, [record]);
  const next = reader.list("2026-10-09"); reader.close(); await assert.rejects(next, /closed/);
});

test("foreign streams and early EOF cannot complete a download, abort releases keys and binary reception", async () => {
  let released = false;
  const reader = new HomeBaseRecordingReader(transport({ decoder: () => ({ video: () => undefined, audio: () => null, close: () => { released = true; } }) }));
  const controller = new AbortController(), pending = reader.download(record, controller.signal);
  assert.equal(reader.handleFrame(header(1300, 2), Buffer.alloc(22), 3), false);
  assert.equal(reader.handleFrame(header(1300, 1, 0, 0), Buffer.alloc(22), 3), false);
  assert.equal(reader.handleFrame(header(1304, 255, 0, 0), Buffer.alloc(0), 3), false);
  controller.abort(); await assert.rejects(pending, /cancelled/);
  assert.equal(reader.downloading, false); assert.equal(released, true);
});

test("unsupported signed media and cumulative size limits reject before packaging", async () => {
  for (const oversized of [false, true]) {
    const reader = new HomeBaseRecordingReader(transport());
    const pending = reader.download(record);
    if (oversized) {
      const payload = Buffer.alloc(17 * 1024 * 1024); payload.writeUInt32LE(payload.length - 22); payload[5] = 1;
      reader.handleFrame(header(1300), payload, 3); reader.handleFrame(header(1300), payload, 3);
    } else reader.handleFrame(header(1301, 1, 0), Buffer.alloc(44), 3);
    await assert.rejects(pending, oversized ? /limit/ : /framing/); assert.equal(reader.downloading, false);
  }
});

test("fresh recipient downloads fully decode audio and silent clips, preserve timing, and reject changed audio tags", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-homebase-test-"));
  try {
    const v = join(directory, "source.h264"), a = join(directory, "source.aac");
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=15", "-t", "2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-g", "15", "-x264-params", "aud=1", "-f", "h264", v]);
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "2", "-ac", "1", "-c:a", "aac", "-f", "adts", a]);
    const video = await readFile(v), audio = await readFile(a), starts: number[] = [];
    for (let i = 0; i < video.length - 5; i++) {
      if (video[i] === 0 && video[i + 1] === 0 && video[i + 2] === 0 && video[i + 3] === 1 && (video[i + 4]! & 31) === 9) starts.push(i);
    }
    assert.equal(starts.length, 30);
    const publicKeys = new Set<string>();
    for (const kind of ["audio", "silent", "tampered"]) {
      const reader = new HomeBaseRecordingReader(transport({ download: (_path, key) => {
        assert.equal(publicKeys.has(key), false); publicKeys.add(key);
        const publicKey = Buffer.from("04" + key, "hex");
        for (let i = 0; i < starts.length; i++) {
          const data = video.subarray(starts[i]!, starts[i + 1] ?? video.length);
          reader.handleFrame(header(1300, 1, i % 15 === 0 ? 1 : 0), videoFrame(publicKey, data, i), 3);
        }
        if (kind !== "silent") {
          let position = 0, index = 0;
          while (position < audio.length) {
            const length = ((audio[position + 3]! & 3) << 11) | (audio[position + 4]! << 3) | (audio[position + 5]! >> 5);
            const payload = audioFrame(audio.subarray(position, position + length), index++);
            if (kind === "tampered") payload[16] = payload[16]! ^ 1;
            reader.handleFrame(header(1301, 1, 1), payload, 3); position += length;
          }
        }
        reader.handleFrame(header(1304, 255, 0, 0), Buffer.alloc(0), 3);
      } }));
      if (kind === "tampered") await assert.rejects(reader.download(record), /audio authentication/);
      else {
        const mp4 = await reader.download(record), target = join(directory, kind + ".mp4"); await writeFile(target, mp4);
        const probe = JSON.parse((await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", target])).stdout);
        assert.equal(probe.streams.some((stream: { codec_type: string }) => stream.codec_type === "audio"), kind === "audio");
        const videoDuration = Number(probe.streams.find((stream: { codec_type: string }) => stream.codec_type === "video").duration);
        assert.ok(videoDuration >= 1.9 && videoDuration < 2.1);
        assert.ok(Number(probe.format.duration) >= videoDuration && Number(probe.format.duration) < 2.4);
        assert.ok(mp4.indexOf(Buffer.from("moov")) < mp4.indexOf(Buffer.from("mdat")));
      }
      assert.equal(reader.downloading, false); reader.close();
    }
    assert.equal(publicKeys.size, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
