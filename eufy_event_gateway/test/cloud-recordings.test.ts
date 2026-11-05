/**
 * Verifies cloud media using independently generated video and authenticated
 * synthetic v8 frames. Fixtures own all keys and bytes, contact no cloud account
 * and never contain reporter recordings. The parser remains hardware unconfirmed.
 */
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseCloudV8, prepareCloudRecording, CloudRecordingError } from "../src/stream/cloud-recordings.js";

const key = Buffer.alloc(32, 7);

/** Build one frame from the source-defined metadata layout, with independent GCM encryption. */
function frame(payload: Buffer, options: { audio?: boolean; plain?: boolean; timestamp?: bigint; width?: number; height?: number } = {}): Buffer {
  const metadata = options.audio ? 0x3c : 0xc3;
  const result = Buffer.alloc(metadata + payload.length);
  result.writeUInt32LE(0x11223344, 0); result.writeUInt16LE(options.audio ? 1301 : 1300, 4);
  result.writeUInt32LE(result.length - 16, 6); result[10] = 8; result[12] = 3; result[13] = options.plain ? 0 : 1;
  result.writeUInt32LE(payload.length, 16);
  result.writeBigUInt64LE(options.timestamp ?? 0x010002000300n, options.audio ? 24 : 30);
  if (!options.audio) {
    result.writeUInt16LE(10, 24); result.writeUInt16LE(options.width ?? 320, 26); result.writeUInt16LE(options.height ?? 180, 28);
  }
  const iv = Buffer.alloc(12, options.audio ? 2 : 3); iv.copy(result, options.audio ? 0x30 : 0xb7);
  if (options.plain) payload.copy(result, metadata);
  else {
    const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from("eufy security"));
    Buffer.concat([cipher.update(payload), cipher.final()]).copy(result, metadata);
    cipher.getAuthTag().copy(result, options.audio ? 0x20 : 0xa7);
  }
  return result;
}

/** Generate Annex-B access units with repeat headers and no dependency on vendor files. */
function video(width: number, height: number): Buffer[] {
  const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=10`,
    "-t", "0.5", "-c:v", "libx264", "-preset", "ultrafast", "-x264-params", "aud=1:repeat-headers=1:keyint=1", "-f", "h264", "pipe:1"]);
  assert.equal(generated.status, 0);
  const starts = [...generated.stdout.toString("hex").matchAll(/0000000109/g)].map(match => match.index! / 2);
  assert.equal(starts.length, 5);
  return starts.map((start, index) => generated.stdout.subarray(start, starts[index + 1] ?? generated.stdout.length));
}

test("cloud v8 preserves zero timestamp bytes, authenticates both tracks and copies payloads", () => {
  const payload = Buffer.from([0, 0, 0, 1, 0x65, 1]);
  const media = Buffer.concat([frame(payload), frame(Buffer.from([1, 2]), { audio: true })]);
  const rows = parseCloudV8(media, key);
  assert.equal(rows.length, 1); assert.equal(rows[0]!.timestamp, Number(0x010002000300n));
  assert.deepEqual(rows[0]!.payload, payload);
  media.fill(0); assert.deepEqual(rows[0]!.payload, payload);
  assert.deepEqual(parseCloudV8(frame(payload, { plain: true }), null)[0]!.payload, payload);
});

test("cloud v8 rejects wrong keys, tampered tags, ciphertext and unauthenticated audio", () => {
  const media = frame(Buffer.from([0, 0, 0, 1, 0x65, 1]));
  for (const index of [0xa7, media.length - 1]) {
    const corrupt = Buffer.from(media); corrupt[index] = corrupt[index]! ^ 1;
    assert.throws(() => parseCloudV8(corrupt, key), error => error instanceof CloudRecordingError && error.stage === "authentication");
  }
  assert.throws(() => parseCloudV8(media, Buffer.alloc(32, 8)), /authentication/);
  assert.throws(() => parseCloudV8(media, null), /key/);
  const audio = frame(Buffer.from([1, 2]), { audio: true }); audio[0x20] = audio[0x20]! ^ 1;
  assert.throws(() => parseCloudV8(Buffer.concat([media, audio]), key), /authentication/);
});

test("cloud framing rejects truncation, legacy formats, unknown commands and mismatched channels", () => {
  const valid = frame(Buffer.from([0, 0, 0, 1, 0x65, 1]));
  for (let length = 0; length < valid.length; length++) assert.throws(() => parseCloudV8(valid.subarray(0, length), key));
  for (const [offset, value] of [[10, 1], [10, 5], [10, 9], [4, 0], [6, 255], [16, 0]]) {
    const invalid = Buffer.from(valid); invalid[offset!] = value!;
    assert.throws(() => parseCloudV8(invalid, key));
  }
  const other = Buffer.from(valid); other[12] = 4;
  assert.throws(() => parseCloudV8(Buffer.concat([valid, other]), key), /ownership/);
  const unsafe = frame(Buffer.from([1]), { timestamp: BigInt(Number.MAX_SAFE_INTEGER) + 1n });
  assert.throws(() => parseCloudV8(unsafe, key), /framing/);
  assert.throws(() => parseCloudV8(Buffer.concat([valid, frame(Buffer.from([1]), { timestamp: 1n })]), key), /framing/);
  assert.throws(() => parseCloudV8(frame(Buffer.from([1]), { width: 65535, height: 65535 }), key), /framing/);
  assert.throws(() => parseCloudV8(frame(Buffer.from([1]), { audio: true }), key), /video/);
});

test("cloud v8 resolution changes yield a fully decoded fixed-size MP4", { timeout: 15_000 }, async () => {
  const units = [...video(320, 180), ...video(640, 360)];
  const media = Buffer.concat(units.map((unit, index) => frame(unit, {
    timestamp: BigInt(index * 100), width: index < 5 ? 320 : 640, height: index < 5 ? 180 : 360,
  })));
  const clip = await prepareCloudRecording(media, key, new AbortController().signal);
  const decoded = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", "pipe:0"], { input: clip });
  assert.equal(decoded.status, 0);
  const streams = JSON.parse(decoded.stdout.toString()).streams;
  assert.equal(streams.length, 1); assert.equal(streams[0].codec_name, "h264");
  assert.equal(streams[0].width, 1280); assert.equal(streams[0].height, 720);
});

test("plain cloud MP4 drops audio and cancellation fails with a fixed stage", { timeout: 15_000 }, async () => {
  const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10", "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "0.5", "-c:v", "libx264", "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"]);
  assert.equal(generated.status, 0);
  const clip = await prepareCloudRecording(generated.stdout, null, new AbortController().signal);
  const probed = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", "pipe:0"], { input: clip });
  assert.equal(JSON.parse(probed.stdout.toString()).streams.length, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareCloudRecording(generated.stdout, null, controller.signal), /cancelled/);
  const bad = Buffer.alloc(20); bad.write("ftyp", 4);
  await assert.rejects(prepareCloudRecording(bad, null, new AbortController().signal), /video/);
});
