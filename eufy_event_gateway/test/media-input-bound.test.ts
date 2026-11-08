/**
 * Bounds the camera input an FFmpeg child has not read, with a fake pipe and
 * clock, then checks that real FFmpeg decodes what the bound writes when it
 * resumes. Synthetic media only; no camera, network or account.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

import { MAX_MEDIA_INPUT_AGE_MILLISECONDS, MediaInputBound } from "../src/stream/media-input-bound.js";

/** A pipe that holds whatever the test has not let the child read. */
class FakeInput {
  writable = true;
  writableLength = 0;
  readonly writes: Buffer[] = [];
  write(data: Buffer): boolean {
    this.writes.push(Buffer.from(data));
    this.writableLength += data.length;
    return true;
  }

  /** The child reads everything queued. */
  drain(): void {
    this.writableLength = 0;
  }
}

const chunk = (fill: number, length = 100): Buffer => Buffer.alloc(length, fill);

test("passes input straight through while the child keeps up", () => {
  let now = 0;
  const input = new FakeInput();
  const bound = new MediaInputBound(input, "h265", () => now);
  for (let index = 0; index < 50; index++) {
    assert.equal(bound.write(chunk(index)), 100);
    input.drain();
    now += 100;
  }
  assert.equal(input.writes.length, 50);
  assert.equal(bound.skips, 0);
  assert.equal(bound.maximumAgeMilliseconds, 0);
});

test("skips to the next keyframe once unread input is older than the limit, after the child has read what it holds", () => {
  let now = 0;
  const input = new FakeInput();
  const bound = new MediaInputBound(input, "h265", () => now);

  // The child reads nothing, so the first chunk ages until it passes the limit.
  for (; now <= MAX_MEDIA_INPUT_AGE_MILLISECONDS; now += 100) assert.equal(bound.write(chunk(1)), 100);
  assert.equal(bound.skipping, false);
  assert.equal(bound.write(chunk(2)), 0);
  assert.equal(bound.skipping, true);
  assert.equal(bound.skips, 1);

  // A keyframe while the old input is still queued would only queue behind it.
  const keyframe = chunk(9, 300);
  assert.equal(bound.write(chunk(3), keyframe), 0);
  input.drain();
  now += 100;

  // Caught up, but a picture between keyframes cannot start a decoder.
  assert.equal(bound.write(chunk(4)), 0);
  const sent = input.writes.length;
  assert.equal(bound.write(chunk(5), keyframe), 6 + 300);
  assert.deepEqual(input.writes.slice(sent), [Buffer.from([0, 0, 0, 1, 0x48, 0x01]), keyframe]);
  assert.equal(bound.skipping, false);
  assert.equal(bound.skippedBytes, 300);
  assert.ok(bound.maximumAgeMilliseconds > MAX_MEDIA_INPUT_AGE_MILLISECONDS);

  // Input written after the resume has its own age.
  input.drain();
  now += 100;
  assert.equal(bound.write(chunk(6)), 100);
});

test("an H.264 child resumes behind an H.264 end of sequence", () => {
  let now = 0;
  const input = new FakeInput();
  const bound = new MediaInputBound(input, "h264", () => now, 50);
  bound.write(chunk(1));
  now = 60;
  assert.equal(bound.write(chunk(2)), 0);
  input.drain();
  const sent = input.writes.length;
  bound.write(chunk(3), chunk(9));
  assert.deepEqual(input.writes[sent], Buffer.from([0, 0, 0, 1, 0x0a]));
});

test("attach starts a replacement process clean and keeps the consumer's counters", () => {
  let now = 0;
  const first = new FakeInput();
  const bound = new MediaInputBound(first, "h265", () => now, 50);
  bound.write(chunk(1));
  now = 60;
  bound.write(chunk(2));
  assert.equal(bound.skipping, true);
  const second = new FakeInput();
  bound.attach(second);
  assert.equal(bound.skipping, false);
  assert.equal(bound.write(chunk(3)), 100);
  assert.equal(bound.skips, 1);
  assert.equal(bound.skippedBytes, 100);
});

test("writes nothing to a closed pipe", () => {
  const input = new FakeInput();
  input.writable = false;
  const bound = new MediaInputBound(input, "h265", () => 0);
  assert.equal(bound.write(chunk(1)), 0);
  assert.equal(input.writes.length, 0);
});

test("FFmpeg resumes cleanly at an open-GOP keyframe from what the bound writes", () => {
  // Open GOP: each CRA keyframe is followed by pictures that also refer to the group before it.
  const stream = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=20",
    "-frames:v", "60", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params",
    "log-level=error:pools=1:keyint=20:min-keyint=20:scenecut=0:open-gop=1:bframes=3:aud=1", "-f", "hevc", "pipe:1"],
  { maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] });
  const delimiters = [...stream.toString("latin1").matchAll(/\x00\x00\x00\x01|\x00\x00\x01/g)]
    .filter(match => ((stream[match.index! + match[0].length]! >> 1) & 63) === 35).map(match => match.index!);
  const units = delimiters.map((start, index) => stream.subarray(start, delimiters[index + 1] ?? stream.length));
  const isKeyframe = (unit: Buffer): boolean => [...unit.toString("latin1").matchAll(/\x00\x00\x01/g)]
    .some(match => { const type = (unit[match.index! + 3]! >> 1) & 63; return type >= 16 && type <= 21; });
  assert.ok(units.length >= 50);

  // Ten pictures, then the child stalls past the limit; it catches up, and the bound resumes at the next keyframe.
  let now = 0;
  const input = new FakeInput();
  const bound = new MediaInputBound(input, "h265", () => now, 1000);
  units.slice(0, 10).forEach(unit => bound.write(unit));
  now = 1500;
  let resumed = -1;
  for (let index = 10; index < units.length; index++) {
    if (index === 30) input.drain();
    const unit = units[index]!;
    if (bound.write(unit, isKeyframe(unit) ? unit : null) > 0 && resumed < 0) resumed = index;
    if (resumed >= 0) input.drain();
  }
  assert.ok(resumed > 30 && isKeyframe(units[resumed]!), `resumed at ${resumed}`);

  const decoded = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "warning", "-f", "hevc", "-i", "pipe:0", "-f", "framemd5", "-"],
    { input: Buffer.concat(input.writes), maxBuffer: 16 * 1024 * 1024 });
  assert.equal(decoded.status, 0);
  assert.equal(decoded.stderr.toString().trim(), "", "no picture may refer to one the bound skipped");
  const frames = decoded.stdout.toString().split("\n").filter(line => line && !line.startsWith("#")).length;
  assert.ok(frames >= 20, `${frames} pictures decoded: those after the keyframe must be among them`);
});
