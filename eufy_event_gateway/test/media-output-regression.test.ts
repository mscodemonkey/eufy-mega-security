/**
 * Checks actual FFmpeg clip timing and bounded browser conversion.
 * Tests own synthetic media and local processes. No camera, network or account
 * input crosses this boundary. CI must provide FFmpeg, ffprobe and the encoders.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { h265ViewerTranscoderArguments, remuxVideoToMp4 } from "../src/stream/live-stream-manager.js";

function hevc(noisy = false): Buffer {
  return execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "testsrc2=size=640x360:rate=20", ...(noisy ? ["-vf", "noise=alls=100:allf=u:all_seed=1"] : []),
    "-frames:v", noisy ? "80" : "40", "-c:v", "libx265", "-preset", "ultrafast", "-crf", "14",
    "-x265-params", "log-level=error:pools=1:bframes=0:keyint=20", "-f", "hevc", "pipe:1"],
  { maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] });
}

interface Probe {
  streams: { codec_type: string; width?: number; height?: number }[];
  packets: { codec_type: string; pts_time?: string; duration_time?: string; size: string; flags: string }[];
}

function probe(bytes: Buffer): Probe {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_packets", "-of", "json", "pipe:0"],
    { input: bytes, maxBuffer: 16 * 1024 * 1024 }).toString());
}

for (const rate of [undefined, 10, 15]) test(`HEVC timing overrides false SPS timing only for explicit rate ${rate}`, async () => {
  const packets = probe(await remuxVideoToMp4(hevc(), "h265", undefined, undefined, rate)).packets.filter(packet => packet.codec_type === "video");
  assert.equal(packets.length, 40);
  const span = Number(packets.at(-1)!.pts_time) - Number(packets[0]!.pts_time);
  assert.ok(Math.abs(span - 39 / (rate ?? 20)) < 0.02, `Unexpected packet span ${span}`);
});

test("explicit cadence keeps recorded audio aligned and abort reaps the process", async () => {
  const audio = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "sine=frequency=440:sample_rate=48000", "-t", "4", "-c:a", "aac", "-f", "adts", "pipe:1"]);
  const video = hevc();
  const packets = probe(await remuxVideoToMp4(video, "h265", audio, undefined, 10)).packets;
  const end = (kind: string): number => Math.max(...packets.filter(packet => packet.codec_type === kind)
    .map(packet => Number(packet.pts_time) + Number(packet.duration_time ?? 0)));
  assert.ok(Math.abs(end("audio") - end("video")) < 0.15);
  for (const rate of [0.99, 61, NaN, Infinity]) await assert.rejects(remuxVideoToMp4(video, "h265", undefined, undefined, rate), /Invalid recorded frame rate/);
  const controller = new AbortController();
  const pending = remuxVideoToMp4(video, "h265", undefined, controller.signal, 10);
  controller.abort();
  await assert.rejects(pending, /cancel/i);
});

for (const fixed of [false, true]) test(`browser conversion decodes with bounded bitrate, fixed resolution ${fixed}`, () => {
  const args = h265ViewerTranscoderArguments(fixed);
  for (const [option, value] of [["-crf", "26"], ["-maxrate", "3M"], ["-bufsize", "1.5M"], ["-preset", "ultrafast"]]) {
    assert.equal(args[args.indexOf(option!) + 1], value);
  }
  const output = execFileSync("ffmpeg", args, { input: hevc(true), maxBuffer: 16 * 1024 * 1024 });
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "h264", "-i", "pipe:0", "-f", "null", "-"], { input: output });
  const decoded = probe(output), stream = decoded.streams.find(stream => stream.codec_type === "video")!;
  assert.equal(stream.width, fixed ? 1920 : 640);
  assert.equal(stream.height, fixed ? 1080 : 360);
  const packets = decoded.packets.filter(packet => packet.codec_type === "video");
  assert.equal(packets.length, 80);
  const keys = packets.flatMap((packet, index) => packet.flags.includes("K") ? [index] : []);
  assert.equal(keys[0], 0);
  assert.ok(keys.length >= 2);
  for (let index = 1; index < keys.length; index++) assert.ok(keys[index]! - keys[index - 1]! <= 50);
  for (let index = 0; index <= packets.length - 40; index += 10) {
    const bits = packets.slice(index, index + 40).reduce((sum, packet) => sum + Number(packet.size) * 8, 0);
    assert.ok(bits / 2 <= 3_000_000 * 1.25, `Two-second output exceeded VBV tolerance: ${bits / 2}`);
  }
});
