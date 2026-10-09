/**
 * Checks actual FFmpeg live multiplexing, muted-camera fallback and viewer cleanup.
 * These tests own synthetic video/audio and temporary processes. No camera,
 * filesystem media or account state enters the transport boundary.
 */
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

function media(audio: boolean): Buffer {
  const args = audio
    ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "6", "-ac", "1", "-c:a", "aac", "-f", "adts", "pipe:1"]
    : ["-f", "lavfi", "-i", "testsrc=size=96x64:rate=15", "-t", "6", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-f", "h264", "pipe:1"];
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
