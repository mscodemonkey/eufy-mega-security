/**
 * Derive the reported E340 main lens without changing the combined camera source.
 * The stream manager owns live decoding and the server owns retained JPEG jobs.
 * Exact geometry checks reject other layouts before publishing a labelled crop.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { setPriority } from "node:os";
import type { VideoCodec } from "../domain/types.js";

/**
 * Build a video-only crop for the reported 1600x2200 stacked layout.
 * Unknown or changed geometry fails instead of labelling another picture as
 * the main lens. No camera setting, audio track or independent call is added.
 */
export function e340MainLensArguments(codec: VideoCodec): string[] {
  return ["-hide_banner", "-loglevel", "error", "-probesize", "2048", "-analyzeduration", "1", "-fpsprobesize", "0",
    "-f", codec === "h265" ? "hevc" : "h264", "-i", "pipe:0", "-an", "-vf",
    "crop=w='if(eq(iw,1600)*eq(ih,2200),1600,0)':h=1100:x=0:y=0", "-c:v", "libx264",
    "-threads", "1", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "26", "-maxrate", "3M", "-bufsize", "1.5M",
    "-x264-params", "repeat-headers=1:keyint=10", "-f", "h264", "pipe:1"];
}

/** Start one low-priority crop process, with the unused sibling pipe left drained. */
export function spawnE340MainLensConverter(codec: VideoCodec): ChildProcess {
  const child = spawn("ffmpeg", e340MainLensArguments(codec), { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  if (child.pid) { try { setPriority(child.pid, 10); } catch {} }
  return child;
}

/**
 * Crop a retained exact-layout JPEG with finite bytes, process time and output.
 * Invalid images and other dimensions return no crop. The caller must retain
 * a main-lens placeholder rather than falling back to the combined image.
 */
export async function e340MainLensSnapshot(data: Buffer): Promise<Buffer | null> {
  if (!isE340StackedJpeg(data)) return null;
  return await new Promise(resolve => {
    const child = execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-threads", "1", "-f", "image2pipe", "-i", "pipe:0",
      "-vf", "crop=w='if(eq(iw,1600)*eq(ih,2200),1600,0)':h=1100:x=0:y=0", "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"],
    { encoding: "buffer", timeout: 3_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 },
    (error, output) => resolve(!error && output.length > 2 ? output : null));
    if (child.pid) { try { setPriority(child.pid, 10); } catch {} }
    child.stdin?.on("error", () => {}); child.stdin?.end(data);
  });
}

/** Reject unqualified geometry from bounded JPEG headers before spawning a decoder. */
export function isE340StackedJpeg(data: Buffer): boolean {
  if (data.length < 4 || data.length > 8 * 1024 * 1024 || data.readUInt16BE(0) !== 0xffd8) return false;
  let offset = 2;
  for (let count = 0; count < 256 && offset + 4 <= data.length; count++) {
    if (data[offset++] !== 0xff) return false;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9 || offset + 2 > data.length) return false;
    const size = data.readUInt16BE(offset);
    if (size < 2 || offset + size > data.length) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return size >= 8 && data.readUInt16BE(offset + 3) === 2200 && data.readUInt16BE(offset + 5) === 1600;
    }
    offset += size;
  }
  return false;
}
