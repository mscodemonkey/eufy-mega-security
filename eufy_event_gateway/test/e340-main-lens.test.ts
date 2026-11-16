/**
 * Verify E340 crops with generated media, never reporter images or a camera.
 * The fixture owns process input and bounded outputs. The production crop
 * rejects unknown geometry and publishes only a separately decoded main image.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { decode } from "jpeg-js";
import { e340MainLensArguments, e340MainLensSnapshot, isE340StackedJpeg } from "../src/stream/e340-main-lens.js";

/** Produce a labelled synthetic stack using a bounded single-thread encoder. */
function image(height: number, format: "mjpeg" | "h264"): Buffer {
  return execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    `color=red:size=1600x${height},drawbox=x=0:y=${height / 2}:w=iw:h=${height / 2}:color=blue:t=fill`,
    "-frames:v", "1", "-threads", "1", "-c:v", format === "mjpeg" ? "mjpeg" : "libx264",
    "-f", format === "mjpeg" ? "image2pipe" : "h264", "pipe:1"], { maxBuffer: 8 * 1024 * 1024 });
}

test("exact retained E340 geometry yields the main picture and rejects other stills", async () => {
  const jpeg = image(2200, "mjpeg");
  assert.equal(isE340StackedJpeg(jpeg), true);
  const cropped = await e340MainLensSnapshot(jpeg);
  assert.ok(cropped);
  const decoded = decode(cropped);
  assert.deepEqual([decoded.width, decoded.height], [1600, 1100]);
  const pixel = (550 * 1600 + 800) * 4;
  assert.ok(decoded.data[pixel]! > 200);
  assert.ok(decoded.data[pixel + 2]! < 40);
  assert.equal(await e340MainLensSnapshot(image(1100, "mjpeg")), null);
  for (const invalid of [Buffer.alloc(0), Buffer.from([0xff, 0xd8, 0xff, 0xc0]), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
    assert.equal(isE340StackedJpeg(invalid), false);
  }
});

test("live crop decodes as main-only H264 and rejects a different video layout", () => {
  const result = spawnSync("ffmpeg", e340MainLensArguments("h264"), { input: image(2200, "h264"), maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-f", "h264", "-show_entries", "stream=width,height", "-of", "json", "pipe:0"], { input: result.stdout }).toString());
  assert.deepEqual(probe.streams.map((stream: { width: number; height: number }) => [stream.width, stream.height]), [[1600, 1100]]);
  const refused = spawnSync("ffmpeg", e340MainLensArguments("h264"), { input: image(1100, "h264"), maxBuffer: 8 * 1024 * 1024 });
  assert.notEqual(refused.status, 0);
  assert.equal(refused.stdout.length, 0);
});
