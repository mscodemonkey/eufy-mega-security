/**
 * Independently demux and decode explicit-clock transport with generated media.
 * Tests own synthetic bytes and finite FFmpeg children. No camera, account,
 * private recording or filesystem media enters these protocol regressions.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ClockedTransportWriter } from "../src/stream/clocked-transport.js";

/** Produce complete synthetic H.264 units or a multi-frame AAC batch in memory. */
function media(audio: boolean): Buffer[] {
  const args = audio
    ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "2", "-ac", "1", "-c:a", "aac", "-f", "adts", "pipe:1"]
    : ["-f", "lavfi", "-i", "testsrc=size=96x64:rate=15", "-t", "2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-x264-params", "aud=1:keyint=15", "-f", "h264", "pipe:1"];
  const encoded = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { maxBuffer: 4 * 1024 * 1024 });
  assert.equal(encoded.status, 0, encoded.stderr.toString());
  if (audio) return [encoded.stdout];
  const starts: number[] = [];
  const data = encoded.stdout;
  for (let index = 0; index + 5 < data.length; index++) {
    if (data.subarray(index, index + 5).equals(Buffer.from([0, 0, 0, 1, 9]))) starts.push(index);
  }
  starts.push(data.length);
  return starts.slice(0, -1).map((start, index) => data.subarray(start, starts[index + 1]));
}

/** Require an independent demuxer to preserve frame counts and media times. */
function inspect(data: Buffer): {
  streams: { codec_name: string; nb_read_frames: string }[];
  packets: { codec_type: string; pts_time: string }[];
} {
  const probe = spawnSync("ffprobe", ["-v", "error", "-f", "mpegts", "-count_frames", "-show_packets",
    "-show_entries", "stream=codec_name,nb_read_frames:packet=codec_type,pts_time", "-of", "json", "pipe:0"],
  { input: data, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(probe.status, 0, probe.stderr.toString());
  return JSON.parse(probe.stdout.toString());
}

for (const audioFirst of [false, true]) test(`explicit transport keeps both tracks and clocks, audio first=${audioFirst}`, () => {
  const output: Buffer[] = [];
  const writer = new ClockedTransportWriter(data => output.push(data), true);
  const video = media(false);
  const audio = media(true)[0]!;
  if (audioFirst) writer.audio(audio, 6_000);
  for (const [index, frame] of video.entries()) writer.video(frame, 6_000 + index * 1_000 / 15);
  if (!audioFirst) writer.audio(audio, 6_000);
  const data = Buffer.concat(output);
  assert.equal(data.length % 188, 0);
  const result = inspect(data);
  assert.equal(Number(result.streams.find(stream => stream.codec_name === "h264")?.nb_read_frames), 30);
  assert.ok(Number(result.streams.find(stream => stream.codec_name === "aac")?.nb_read_frames) >= 31);
  for (const kind of ["video", "audio"]) {
    const times = result.packets.filter(packet => packet.codec_type === kind).map(packet => Number(packet.pts_time));
    assert.equal(times[0], 6);
    assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]!));
    assert.ok(times.at(-1)! - times[0]! >= 1.9);
  }
  const decoded = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-xerror", "-f", "mpegts", "-i", "pipe:0",
    "-map", "0:v:0", "-map", "0:a:0", "-fps_mode:v", "passthrough", "-enc_time_base:v", "1:90000", "-f", "null", "-"],
  { input: data, maxBuffer: 1024 * 1024 });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  assert.equal(decoded.stderr.length, 0, decoded.stderr.toString());
});

test("muted admission declares video only and cannot later add audio", () => {
  const output: Buffer[] = [];
  const writer = new ClockedTransportWriter(data => output.push(data), false);
  for (const [index, frame] of media(false).entries()) writer.video(frame, 6_000 + index * 1_000 / 15);
  assert.deepEqual(inspect(Buffer.concat(output)).streams.map(stream => stream.codec_name), ["h264"]);
  const count = output.length;
  assert.throws(() => writer.audio(media(true)[0]!, 6_000));
  assert.equal(output.length, count);
});

test("invalid time, oversized media and malformed AAC publish no partial program", () => {
  const output: Buffer[] = [];
  const writer = new ClockedTransportWriter(data => output.push(data), true);
  for (const time of [-1, NaN, Infinity, 86_400_000]) assert.throws(() => writer.video(Buffer.from([1]), time));
  assert.throws(() => writer.video(Buffer.alloc(4 * 1024 * 1024 + 1), 1_000));
  assert.throws(() => writer.audio(Buffer.from([1]), 1_000));
  assert.deepEqual(output, []);
});

test("large units keep output chunks finite and packet counters independent through wrap", () => {
  const output: Buffer[] = [];
  const writer = new ClockedTransportWriter(data => output.push(data), false);
  writer.video(Buffer.alloc(4 * 1024 * 1024), 6_000);
  assert.ok(output.every(data => data.length <= 256 * 188 && data.length % 188 === 0));
  const counters = new Map<number, number>();
  let packets = 0;
  for (const data of output) {
    for (let offset = 0; offset < data.length; offset += 188) {
      const packet = data.subarray(offset, offset + 188);
      assert.equal(packet[0], 0x47);
      const pid = ((packet[1]! & 31) << 8) | packet[2]!;
      const counter = packet[3]! & 15;
      assert.equal(counter, counters.get(pid) ?? 0);
      if (packet[3]! & 0x10) counters.set(pid, (counter + 1) & 15);
      packets++;
    }
  }
  assert.ok(packets > 20_000);
  assert.deepEqual([...counters.keys()].sort((a, b) => a - b), [0, 256, 4096]);
});
