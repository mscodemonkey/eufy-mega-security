/**
 * Checks native MPEG-TS delivery: unconverted H.265 or H.264 with AAC, start
 * admission, the audio clock and viewer cleanup. Tests own synthetic media,
 * a fake clock and finite FFmpeg children. No camera or recording is used.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { splitAccessUnits } from "../src/stream/annexb-access-units.js";
import { NativeTransportMuxer, type NativeTransportSummary } from "../src/stream/live-native-transport.js";
import { parseAdtsAccessUnits } from "../src/stream/ppcs-audio.js";

/** Collects one synthetic HTTP response while the test owns its disconnect. */
class Response extends PassThrough {
  headers: OutgoingHttpHeaders = {};
  headersSent = false;

  writeHead(_status: number, headers: OutgoingHttpHeaders): this {
    this.headers = headers;
    this.headersSent = true;
    return this;
  }
}

/** Encode finite synthetic camera-like video (no B-frames) as access units. */
function video(codec: "h264" | "h265", frames = 30): Buffer[] {
  const encoder = codec === "h265"
    ? ["-c:v", "libx265", "-x265-params", "log-level=none:bframes=0:keyint=15", "-f", "hevc"]
    : ["-c:v", "libx264", "-bf", "0", "-g", "15", "-f", "h264"];
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=128x96:rate=15",
    "-frames:v", String(frames), "-pix_fmt", "yuv420p", ...encoder, "pipe:1"], { maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  return splitAccessUnits(result.stdout, codec).units;
}

/** Encode 16 kHz mono AAC, returned one ADTS frame per element (64 ms each). */
function audio(seconds = 2): Buffer[] {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000",
    "-t", String(seconds), "-ac", "1", "-c:a", "aac", "-f", "adts", "pipe:1"], { maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset < result.stdout.length) {
    const size = ((result.stdout[offset + 3]! & 3) << 11) | (result.stdout[offset + 4]! << 3) | (result.stdout[offset + 5]! >> 5);
    frames.push(result.stdout.subarray(offset, offset + size));
    offset += size;
  }
  assert.ok(parseAdtsAccessUnits(frames[0]!));
  return frames;
}

/** Read stream codecs and per-packet times with an independent demuxer. */
function probe(data: Buffer): { streams: { codec_type: string; codec_name: string }[]; packets: { codec_type: string; pts_time: string }[] } {
  const result = spawnSync("ffprobe", ["-v", "error", "-f", "mpegts", "-show_packets", "-show_entries",
    "stream=codec_type,codec_name:packet=codec_type,pts_time", "-of", "json", "pipe:0"], { input: data, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  return JSON.parse(result.stdout.toString());
}

/** Decode every packet, failing on any decoder error. */
function decodes(data: Buffer): void {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-xerror", "-f", "mpegts", "-i", "pipe:0", "-f", "null", "-"],
    { input: data, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stderr.length, 0, result.stderr.toString());
}

interface Harness {
  muxer: NativeTransportMuxer;
  response: Response;
  output: () => Buffer;
  clock: { now: number };
  closes: () => number;
  failures: string[];
  summaries: NativeTransportSummary[];
}

function harness(codec: "h264" | "h265", audioWait = 1_000): Harness {
  const response = new Response();
  const chunks: Buffer[] = [];
  response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const clock = { now: 50_000 };
  let closed = 0;
  const failures: string[] = [], summaries: NativeTransportSummary[] = [];
  const muxer = new NativeTransportMuxer(response as unknown as ServerResponse, () => closed++, audioWait,
    reason => failures.push(reason), summary => summaries.push(summary), () => clock.now);
  muxer.videoInput.writeHead(200, { "Content-Type": codec === "h265" ? "video/h265" : "video/h264" });
  return { muxer, response, output: () => Buffer.concat(chunks), clock, closes: () => closed, failures, summaries };
}

/** Deliver video at 15 fps and AAC every 64 ms on the fake clock, in arrival order. */
async function play(h: Harness, frames: Buffer[], sound: Buffer[] | null, audioLeadMilliseconds = 40): Promise<void> {
  const events: { at: number; act: () => void }[] = [];
  frames.forEach((frame, index) => events.push({ at: index * 1_000 / 15, act: () => h.muxer.videoInput.write(frame) }));
  sound?.forEach((frame, index) => events.push({ at: audioLeadMilliseconds + index * 64, act: () => h.muxer.acceptAudio(frame) }));
  const start = h.clock.now;
  for (const event of events.sort((left, right) => left.at - right.at)) {
    h.clock.now = start + event.at;
    event.act();
    await delay(0);
  }
}

for (const codec of ["h265", "h264"] as const) {
  test(`native ${codec} and AAC arrive as decodable MPEG-TS with both clocks increasing`, async () => {
    const h = harness(codec);
    const frames = video(codec), sound = audio();
    await play(h, frames, sound);
    h.muxer.close();
    const data = h.output();
    assert.equal(h.response.headers["Content-Type"], "video/mp2t");
    assert.equal(data.length % 188, 0);
    const result = probe(data);
    assert.deepEqual(result.streams.map(stream => stream.codec_name).sort(), ["aac", codec === "h265" ? "hevc" : "h264"]);
    const videoTimes = result.packets.filter(packet => packet.codec_type === "video").map(packet => Number(packet.pts_time));
    const audioTimes = result.packets.filter(packet => packet.codec_type === "audio").map(packet => Number(packet.pts_time));
    assert.equal(videoTimes.length, frames.length);
    assert.ok(audioTimes.length >= sound.length - 1);
    for (const times of [videoTimes, audioTimes]) assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]!));

    // Video keeps its arrival cadence; audio its sample clock, both on one clock.
    assert.ok(Math.abs(videoTimes.at(-1)! - videoTimes[0]! - (frames.length - 1) / 15) < 0.002);
    assert.ok(Math.abs(audioTimes[1]! - audioTimes[0]! - 0.064) < 0.002);
    assert.ok(Math.abs(audioTimes[0]! - videoTimes[0]! - 0.04) < 0.002);
    decodes(data);
    assert.equal(h.summaries[0]?.audio, true);
    assert.equal(h.summaries[0]?.startWaitMilliseconds, 40);
  });
}

test("a muted camera starts after the bound without an audio track, and later audio is ignored", async () => {
  const h = harness("h265", 30);
  const frames = video("h265");
  h.muxer.videoInput.write(frames[0]!);
  await delay(0);
  assert.equal(h.response.headersSent, false);
  await delay(60);
  assert.equal(h.response.headersSent, true);
  for (const frame of frames.slice(1)) { h.clock.now += 66; h.muxer.videoInput.write(frame); }
  for (const frame of audio(1)) h.muxer.acceptAudio(frame);
  await delay(0);
  h.muxer.close();
  assert.deepEqual(probe(h.output()).streams.map(stream => stream.codec_name), ["hevc"]);
  assert.equal(h.summaries[0]?.audio, false);
  assert.equal(h.summaries[0]?.audioBatches, 0);
});

test("audio arriving before video starts the program with the first picture", async () => {
  const h = harness("h265");
  const sound = audio(1);
  h.muxer.acceptAudio(sound[0]!);
  assert.equal(h.response.headersSent, false);
  h.clock.now += 20;
  h.muxer.videoInput.write(video("h265", 1)[0]!);
  await delay(0);
  assert.equal(h.response.headersSent, true);
  assert.equal(h.summaries.length, 0);
  h.muxer.close();
  assert.equal(h.summaries[0]?.startWaitMilliseconds, 0);
  assert.deepEqual(probe(h.output()).streams.map(stream => stream.codec_name).sort(), ["aac", "hevc"]);
});

test("late audio moves its clock up to arrival and early audio is dropped, keeping audio monotonic", async () => {
  const h = harness("h265");
  const frames = video("h265", 60), sound = audio(4);
  h.muxer.videoInput.write(frames[0]!);
  h.muxer.acceptAudio(sound[0]!);
  await delay(0);

  // A one-second stall, then a burst of ten frames at once (640 ms of audio in no time).
  let next = 1;
  h.clock.now += 1_000;
  for (let index = 0; index < 10; index++) h.muxer.acceptAudio(sound[next++]!);
  for (const frame of frames.slice(1, 30)) { h.clock.now += 66; h.muxer.videoInput.write(frame); h.muxer.acceptAudio(sound[next++]!); }
  h.muxer.close();
  const summary = h.summaries[0]!;
  assert.equal(summary.audioResyncs, 1);
  assert.ok(summary.audioDropped >= 1, JSON.stringify(summary));
  const result = probe(h.output());
  const audioTimes = result.packets.filter(packet => packet.codec_type === "audio").map(packet => Number(packet.pts_time));
  assert.ok(audioTimes.every((time, index) => index === 0 || time > audioTimes[index - 1]!));
  const videoTimes = result.packets.filter(packet => packet.codec_type === "video").map(packet => Number(packet.pts_time));
  assert.ok(Math.abs(audioTimes.at(-1)! - videoTimes.at(-1)!) < 0.4);
});

test("a joining viewer's burst of pictures becomes one packet per picture with increasing times", async () => {
  const h = harness("h265", 0);
  const frames = video("h265", 10);
  h.muxer.videoInput.write(Buffer.concat(frames));
  await delay(0);
  h.muxer.close();
  const times = probe(h.output()).packets.map(packet => Number(packet.pts_time));
  assert.equal(times.length, 10);
  assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]!));
  decodes(h.output());
});

test("an unknown codec, oversized startup or closed viewer releases the camera once", async () => {
  const unknown = new NativeTransportMuxer(new Response() as unknown as ServerResponse, () => undefined, 1_000);
  const failures: string[] = [];
  let closes = 0;
  const bare = new NativeTransportMuxer(new Response() as unknown as ServerResponse, () => closes++, 1_000, reason => failures.push(reason));
  bare.videoInput.write(Buffer.from([0, 0, 0, 1, 0x40, 1, 0x0c]));
  await delay(0);
  assert.deepEqual(failures, ["codec_unknown"]);
  assert.equal(closes, 1);
  unknown.close();

  const h = harness("h265", 60_000);
  h.muxer.videoInput.write(Buffer.concat([video("h265", 1)[0]!, Buffer.alloc(4 * 1024 * 1024)]));
  await delay(0);
  assert.deepEqual(h.failures, ["startup_input_limit"]);
  assert.equal(h.closes(), 1);

  const quiet = harness("h265");
  quiet.response.destroy();
  await delay(0);
  assert.equal(quiet.closes(), 1);
  quiet.muxer.close();
  assert.equal(quiet.closes(), 1);
  assert.equal(quiet.muxer.videoInput.destroyed, true);
});
