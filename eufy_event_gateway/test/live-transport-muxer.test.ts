/**
 * Checks actual FFmpeg live multiplexing, muted-camera fallback and viewer cleanup.
 * These tests own synthetic video/audio and temporary processes. No camera,
 * filesystem media or account state enters the transport boundary.
 */
import { markS340LiveFrameClock } from "../src/stream/live-frame-clock.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { LiveTransportMuxer } from "../src/stream/live-transport-muxer.js";

/** Collects one synthetic HTTP response while the test owns its disconnect. */
class Response extends PassThrough {
  headers: OutgoingHttpHeaders = {};
  headersSent = false;

  /** Capture the muxer's MIME type without opening an HTTP socket. */
  writeHead(_status: number, headers: OutgoingHttpHeaders): this {
    this.headers = headers;
    this.headersSent = true;
    return this;
  }
}

/** Encode finite synthetic media, optionally delimiting complete video access units. */
function media(audio: boolean, delimitUnits = false): Buffer {
  const args = audio
    ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "6", "-ac", "1", "-c:a", "aac", "-f", "adts", "pipe:1"]
    : ["-f", "lavfi", "-i", "testsrc=size=96x64:rate=15", "-t", "6", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", ...(delimitUnits ? ["-x264-params", "aud=1"] : []), "-f", "h264", "pipe:1"];
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

for (const [audio, delayed] of [[true, false], [false, false], [true, true]] as const) {
  test(`live transport delivers decodable video ${audio ? (delayed ? "with delayed HomeBase AAC" : "with AAC") : "when no audio arrives"}`, { timeout: 15_000 }, async () => {
    const response = new Response();
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    let closed = 0;
    const muxer = new LiveTransportMuxer(response as unknown as ServerResponse, () => closed++, delayed ? 12_000 : 20);
    try {
      const video = media(false);
      const sound = audio ? media(true) : null;
      if (sound && !delayed) muxer.acceptAudio(sound);
      muxer.videoInput.write(video);
      if (sound && delayed) {
        await delay(2_100);
        assert.equal(response.headersSent, false);
        muxer.acceptAudio(sound);
      }
      if (sound) {
        for (let repeat = 0; repeat < 60; repeat++) {
          await delay(100);
          const start = Math.floor(repeat * video.length / 60);
          const end = Math.floor((repeat + 1) * video.length / 60);
          muxer.videoInput.write(video.subarray(start, end));
        }
      }
      for (let attempt = 0; attempt < 300; attempt++) await delay(10);
      const output = Buffer.concat(chunks);
      assert.ok(output.length >= 10_000, `The live viewer stalled with ${output.length} bytes and ${closed} closes`);
      assert.equal(response.headers["Content-Type"], "video/mp2t");
      const probe = spawnSync("ffprobe", ["-v", "error", "-count_packets", "-show_entries", "stream=codec_type,codec_name,nb_read_packets", "-of", "json", "-i", "pipe:0"], { input: output });
      assert.equal(probe.status, 0, probe.stderr.toString());
      const streams = JSON.parse(probe.stdout.toString()).streams as { codec_type: string; codec_name: string; nb_read_packets: string }[];
      assert.ok(streams.some((row) => row.codec_type === "video" && row.codec_name === "h264"));
      assert.equal(streams.some((row) => row.codec_type === "audio" && row.codec_name === "aac"), audio);
      if (audio) assert.ok(Number(streams.find((row) => row.codec_type === "audio")?.nb_read_packets) >= 50, `AAC must continue beyond its first packet: ${JSON.stringify(streams)}`);
      if (audio) {
        const videoPackets = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_packets", "-show_entries", "packet=dts,duration", "-of", "json", "-i", "pipe:0"], { input: output });
        assert.equal(videoPackets.status, 0, videoPackets.stderr.toString());
        const opening = JSON.parse(videoPackets.stdout.toString()).packets as { dts: number; duration: number }[];
        assert.ok(opening.length >= 2);

        // HA rewrites its first video DTS this way before segmenting. Negative
        // results shift the first segment's AAC differently from later ones.
        assert.ok(opening[1]!.dts - (opening[1]!.duration || 1) >= 0);
        const packets = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_packets", "-show_entries", "packet=dts,duration", "-of", "json", "-i", "pipe:0"], { input: output });
        assert.equal(packets.status, 0, packets.stderr.toString());
        const rows = JSON.parse(packets.stdout.toString()).packets as { dts: number; duration: number }[];
        for (let index = 1; index < rows.length; index++) {
          const previous = rows[index - 1]!;
          assert.ok(rows[index]!.dts >= previous.dts + previous.duration,
            `Audio packet ${index} overlaps its predecessor: ${JSON.stringify(rows.slice(0, 4))}`);
        }
      }
      const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-map", "0", "-f", "null", "-"], { input: output });
      assert.equal(decoded.status, 0, decoded.stderr.toString());
      response.destroy();
      await delay(10);
      assert.equal(muxer.videoInput.destroyed, true);
      assert.equal(closed, 1);
      muxer.close();
      assert.equal(closed, 1);
    } finally {
      muxer.close();
    }
  });
}

test("a disconnected viewer drops startup data before its audio wait expires", async () => {
  const response = new Response();
  let closed = 0;
  const muxer = new LiveTransportMuxer(response as unknown as ServerResponse, () => closed++, 50);
  muxer.videoInput.write(Buffer.from([0, 0, 0, 1]));
  response.destroy();
  await delay(80);
  assert.equal(closed, 1);
  assert.equal(response.headersSent, false);
  assert.equal(muxer.videoInput.destroyed, true);
});


test("oversized startup releases the viewer and reports one bounded failure code", () => {
  const response = new Response();
  const failures: string[] = [];
  let closed = 0;
  const muxer = new LiveTransportMuxer(response as unknown as ServerResponse, () => closed++, 12_000,
    (reason) => failures.push(reason));
  muxer.videoInput.write(Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.deepEqual(failures, ["startup_input_limit"]);
  assert.equal(muxer.videoInput.destroyed, true);
  assert.equal(response.writableEnded, true);
  assert.equal(closed, 1);
  muxer.close();
  assert.equal(failures.length, 1);
});

test("the admitted transport drains original paced video and AAC through real FFmpeg", { timeout: 20_000 }, async () => {
  const response = new Response(), chunks: Buffer[] = [];
  response.on("data", (data: Buffer) => chunks.push(Buffer.from(data)));
  const epoch = Symbol();
  let summary: { videoPackets: number; audioPackets: number; latePackets: number } | undefined;
  const muxer = new LiveTransportMuxer(response as unknown as ServerResponse, () => undefined, 20,
    reason => assert.fail(reason), () => true, value => { summary = value; });
  try {
    const video = media(false, true), sound = media(true);
    const starts: number[] = [];
    for (let index = 0; index + 5 < video.length; index++) {
      if (video[index] === 0 && video[index + 1] === 0 && video[index + 2] === 0
          && video[index + 3] === 1 && (video[index + 4]! & 31) === 9) starts.push(index);
    }
    assert.equal(starts.length, 90);
    starts.push(video.length);
    for (let index = 0; index < 90; index++) {
      const unit = video.subarray(starts[index], starts[index + 1]);
      markS340LiveFrameClock(unit, Math.round(index * 1_000 / 15), epoch);
      muxer.videoInput.write(unit);
    }
    muxer.acceptAudio(sound);
    await delay(12_800);
    assert.equal(response.headersSent, true);
    const output = Buffer.concat(chunks);
    assert.ok(output.length > 10_000);
    const probe = spawnSync("ffprobe", ["-v", "error", "-count_packets", "-show_entries", "stream=codec_type,codec_name,nb_read_packets", "-of", "json", "-i", "pipe:0"], { input: output });
    assert.equal(probe.status, 0, probe.stderr.toString());
    const streams = JSON.parse(probe.stdout.toString()).streams as { codec_type: string; codec_name: string; nb_read_packets: string }[];
    assert.ok(streams.some(row => row.codec_type === "video" && Number(row.nb_read_packets) >= 60));
    assert.ok(streams.some(row => row.codec_type === "audio" && Number(row.nb_read_packets) >= 50));
  } finally { muxer.close(); }
  assert.deepEqual(summary && { video: summary.videoPackets, audio: summary.audioPackets, late: summary.latePackets }, { video: 90, audio: 1, late: 0 });
});

test("a disconnected paced viewer cancels retained data before publishing headers", async () => {
  const response = new Response();
  let closed = 0;
  const muxer = new LiveTransportMuxer(response as unknown as ServerResponse, () => closed++, 20,
    () => undefined, () => true, () => { throw new Error("synthetic diagnostic failure"); });
  const bytes = Buffer.from([1]);
  markS340LiveFrameClock(bytes, 0, Symbol());
  muxer.videoInput.write(bytes);
  response.destroy();
  await delay(20);
  assert.equal(closed, 1);
  assert.equal(muxer.videoInput.destroyed, true);
  assert.equal(response.headersSent, false);
});
