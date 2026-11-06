/**
 * Checks access-unit boundaries on synthetic NAL units and real encoder output.
 * Tests own every byte; no camera or recording enters the splitter.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { splitAccessUnits } from "../src/stream/annexb-access-units.js";

const start4 = [0, 0, 0, 1], start3 = [0, 0, 1];

/** One NAL unit: H.265 headers are two bytes, and the payload's top bit is the first-slice flag. */
function hevc(type: number, firstSlice = true, start = start4): number[] {
  return [...start, type << 1, 1, firstSlice ? 0x80 : 0x00, 0xaa];
}

/** One H.264 NAL unit; a leading 1 bit in the slice header encodes first_mb_in_slice zero. */
function avc(type: number, firstSlice = true, start = start4): number[] {
  return [...start, 0x60 | type, firstSlice ? 0x88 : 0x44, 0xbb];
}

test("H.265 cuts at parameter sets and each new picture, keeping slices together", () => {
  const vps = hevc(32), sps = hevc(33), pps = hevc(34), sei = hevc(39);
  const idr1 = hevc(19, true), idr2 = hevc(19, false, start3), trail = hevc(1, true), trail2 = hevc(1, true, start3);
  const data = Buffer.from([...vps, ...sps, ...pps, ...sei, ...idr1, ...idr2, ...trail, ...trail2]);
  const result = splitAccessUnits(data, "h265");
  assert.equal(result.continuesPrevious, false);
  assert.deepEqual(result.units.map(unit => [...unit]), [
    [...vps, ...sps, ...pps, ...sei, ...idr1, ...idr2], [...trail], [...trail2]]);
});

test("H.265 suffix SEI stays with its picture and an AUD opens the next", () => {
  const trail = hevc(1), suffix = hevc(40), aud = hevc(35), next = hevc(1);
  const result = splitAccessUnits(Buffer.from([...trail, ...suffix, ...aud, ...next]), "h265");
  assert.deepEqual(result.units.map(unit => [...unit]), [[...trail, ...suffix], [...aud, ...next]]);
});

test("H.264 cuts at SPS, AUD and first slices, and reports a continued picture", () => {
  const sps = avc(7), pps = avc(8), idr = avc(5, true), idr2 = avc(5, false), aud = avc(9), p = avc(1, true);
  const result = splitAccessUnits(Buffer.from([...sps, ...pps, ...idr, ...idr2, ...aud, ...p]), "h264");
  assert.deepEqual(result.units.map(unit => [...unit]), [[...sps, ...pps, ...idr, ...idr2], [...aud, ...p]]);
  const continued = splitAccessUnits(Buffer.from([...avc(1, false), ...avc(1, true)]), "h264");
  assert.equal(continued.continuesPrevious, true);
  assert.equal(continued.units.length, 2);
});

test("a chunk without start codes stays one unit continuing the last, and an empty chunk has none", () => {
  const tail = splitAccessUnits(Buffer.from([1, 2, 3, 4, 5]), "h265");
  assert.deepEqual(tail.units.map(unit => [...unit]), [[1, 2, 3, 4, 5]]);
  assert.equal(tail.continuesPrevious, true);
  const split = splitAccessUnits(Buffer.from([9, 9, ...hevc(1)]), "h265");
  assert.deepEqual(split.units.map(unit => [...unit]), [[9, 9], hevc(1)]);
  assert.equal(split.continuesPrevious, true);
  assert.equal(splitAccessUnits(Buffer.alloc(0), "h264").units.length, 0);
});

for (const codec of ["h264", "h265"] as const) {
  test(`${codec} encoder output splits into exactly one unit per frame`, () => {
    const encoder = codec === "h265"
      ? ["-c:v", "libx265", "-x265-params", "log-level=none:bframes=0:keyint=10:slices=2", "-f", "hevc"]
      : ["-c:v", "libx264", "-bf", "0", "-g", "10", "-slices", "2", "-f", "h264"];
    const encoded = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=128x96:rate=15",
      "-frames:v", "25", "-pix_fmt", "yuv420p", ...encoder, "pipe:1"], { maxBuffer: 8 * 1024 * 1024 });
    assert.equal(encoded.status, 0, encoded.stderr.toString());
    const { units } = splitAccessUnits(encoded.stdout, codec);
    assert.equal(units.length, 25);
    assert.ok(Buffer.concat(units).equals(encoded.stdout));
  });
}
