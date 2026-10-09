/**
 * Exercises the gateway's FFmpeg remux contract for recorded clips.
 *
 * The fixture supplies deterministic H.264 bytes and verifies that the
 * resulting fragmented MP4 is usable without involving Mega or a camera.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { remuxH264ToMp4, remuxVideoToMp4 } from "../src/stream/live-stream-manager.js";

const execFileAsync = promisify(execFile);

test("packages an Annex B H.264 camera stream as a fragmented MP4", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-clip-test-"));
  const source = join(directory, "source.h264");
  try {
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=160x90:rate=10",
      "-t",
      "0.5",
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      "-f",
      "h264",
      source,
    ]);
    const mp4 = await remuxH264ToMp4(await readFile(source));
    assert.equal(mp4.subarray(4, 8).toString("ascii"), "ftyp");
    assert.ok(mp4.includes(Buffer.from("moov")));
    assert.ok(mp4.includes(Buffer.from("moof")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves independently piped AAC alongside video in a decodable MP4", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-audio-clip-test-"));
  try {
    const video = join(directory, "video.h264");
    const audio = join(directory, "audio.aac");
    await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=25", "-t", "1", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-f", "h264", video]);
    await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "1", "-ac", "1", "-c:a", "aac", "-f", "adts", audio]);
    const mp4 = await remuxVideoToMp4(await readFile(video), "h264", await readFile(audio));
    const target = join(directory, "clip.mp4");
    await writeFile(target, mp4);
    const probe = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,codec_type,sample_rate,channels", "-of", "json", target]);
    const streams = JSON.parse(probe.stdout).streams;
    assert.equal(streams.find((stream: { codec_type: string }) => stream.codec_type === "audio")?.codec_name, "aac");
    assert.equal(streams.find((stream: { codec_type: string }) => stream.codec_type === "video")?.codec_name, "h264");
    await execFileAsync("ffmpeg", ["-v", "error", "-i", target, "-f", "null", "-"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
