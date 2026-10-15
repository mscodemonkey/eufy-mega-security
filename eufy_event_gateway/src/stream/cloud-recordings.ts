/**
 * Decodes bounded cloud recording frames for a consented diagnostic download.
 * The Mega client owns record authorization, signed URLs and key recovery. This
 * boundary borrows media and a key for one operation, rejects unsupported legacy
 * formats and returns a fully decoded video-only MP4 without retaining secrets.
 */
import { spawn } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { validateStoredMedia } from "./stored-recordings.js";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 4096 * 2160;
const AAD = Buffer.from("eufy security", "utf8");

/** Fixed, content-free failures safe for the diagnostic API and logs. */
export type CloudRecordingStage = "admission" | "history" | "ownership" | "url" | "key"
  | "download" | "unsupported" | "framing" | "authentication" | "conversion" | "video" | "cancelled";

/** Carries a fixed stage only, never a URL, key, record, vendor response or footage. */
export class CloudRecordingError extends Error {
  constructor(readonly stage: CloudRecordingStage) {
    super(`Cloud recording test failed at ${stage}`);
  }
}

/** Checked private frame metadata consumed only by the video conversion owner. */
export interface CloudVideoFrame {
  readonly payload: Buffer;
  readonly timestamp: number;
  readonly frameRate: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Parse the source-defined v8 layout without resynchronizing damaged files.
 * Authenticate every encrypted frame, including audio that this video-only trial
 * discards. The caller owns and clears the borrowed key after the operation.
 */
export function parseCloudV8(media: Buffer, key: Buffer | null): readonly CloudVideoFrame[] {
  if (!media.length || media.length > MAX_BYTES || key !== null && key.length !== 32) throw new CloudRecordingError("framing");
  const frames: CloudVideoFrame[] = [];
  let offset = 0, count = 0, channel: number | null = null, tag: number | null = null;
  let videoTimestamp: number | null = null, audioTimestamp: number | null = null;
  try {
    while (offset < media.length) {
      if (++count > 12_000 || media.length - offset < 16) throw new CloudRecordingError("framing");
      const header = media.subarray(offset);
      const command = header.readUInt16LE(4), length = header.readUInt32LE(6);
      if (header[10] !== 8) throw new CloudRecordingError("unsupported");
      if (![1300, 1301].includes(command) || length > 4 * 1024 * 1024 || length + 16 > header.length) throw new CloudRecordingError("framing");
      const video = command === 1300, metadata = video ? 0xc3 : 0x3c;
      const end = 16 + length;
      if (end <= metadata) throw new CloudRecordingError("framing");
      if (channel === null) { channel = header[12]!; tag = header.readUInt32LE(0); }
      if (channel !== header[12] || tag !== header.readUInt32LE(0)) throw new CloudRecordingError("ownership");
      const frame = header.subarray(0, end), payload = frame.subarray(metadata);
      if (frame.readUInt32LE(16) !== payload.length) throw new CloudRecordingError("framing");
      const timestampBig = frame.readBigUInt64LE(video ? 30 : 24);
      if (timestampBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new CloudRecordingError("framing");
      const timestamp = Number(timestampBig), previous = video ? videoTimestamp : audioTimestamp;
      if (previous !== null && timestamp < previous) throw new CloudRecordingError("framing");
      if (video) videoTimestamp = timestamp; else audioTimestamp = timestamp;
      let decoded: Buffer;
      if (frame[13] !== 0) {
        if (!key) throw new CloudRecordingError("key");
        try {
          const decipher = createDecipheriv("aes-256-gcm", key, frame.subarray(video ? 0xb7 : 0x30, metadata));
          decipher.setAAD(AAD); decipher.setAuthTag(frame.subarray(video ? 0xa7 : 0x20, video ? 0xb7 : 0x30));
          decoded = Buffer.concat([decipher.update(payload), decipher.final()]);
        } catch { throw new CloudRecordingError("authentication"); }
      } else decoded = Buffer.from(payload);
      if (video) {
        const frameRate = frame.readUInt16LE(24), width = frame.readUInt16LE(26), height = frame.readUInt16LE(28);
        if (frameRate < 1 || frameRate > 60 || width < 16 || height < 16 || width * height > MAX_PIXELS
          || frames.length >= 3600 || frames.length && frameRate !== frames[0]!.frameRate
          || (frames.length + 1) / frameRate > 120
          || frames.length && timestamp - frames[0]!.timestamp > 120_000) {
          decoded.fill(0); throw new CloudRecordingError("framing");
        }
        frames.push({ payload: decoded, timestamp, frameRate, width, height });
      } else decoded.fill(0);
      offset += end;
    }
    if (!frames.length) throw new CloudRecordingError("video");
    return frames;
  } catch (error) {
    for (const frame of frames) frame.payload.fill(0);
    throw error;
  }
}

/**
 * Produce one video-only trial clip, with fixed-size output across resolution changes.
 * Plain MP4 is decoded before return. Framed input must be v8 H.264. Legacy v1/v5
 * and other codecs remain unavailable. Cancellation retires the owned converter.
 */
export async function prepareCloudRecording(media: Buffer, key: Buffer | null, signal: AbortSignal): Promise<Buffer> {
  if (signal.aborted) throw new CloudRecordingError("cancelled");
  if (!media.length || media.length > MAX_BYTES) throw new CloudRecordingError("download");
  if (media.length >= 12 && media.subarray(4, 8).toString("ascii") === "ftyp") {
    try { await validateStoredMedia(media, signal, MAX_PIXELS); }
    catch { throw new CloudRecordingError(signal.aborted ? "cancelled" : "video"); }
    const converted = await convert(media, null, signal);
    try { await validateStoredMedia(converted, signal, MAX_PIXELS); }
    catch { throw new CloudRecordingError(signal.aborted ? "cancelled" : "video"); }
    return converted;
  }
  const frames = parseCloudV8(media, key);
  try {
    const source = Buffer.concat(frames.map(frame => frame.payload));
    let result: Buffer;
    try { result = await convert(source, frames[0]!.frameRate, signal); }
    finally { source.fill(0); }
    try { await validateStoredMedia(result, signal, MAX_PIXELS); }
    catch { throw new CloudRecordingError(signal.aborted ? "cancelled" : "video"); }
    if (signal.aborted) throw new CloudRecordingError("cancelled");
    return result;
  } finally { for (const frame of frames) frame.payload.fill(0); }
}

async function convert(source: Buffer, rate: number | null, signal: AbortSignal): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-v", "error", "-xerror", "-err_detect", "explode", "-max_alloc", "67108864",
      "-max_pixels", String(MAX_PIXELS), "-f", rate === null ? "mp4" : "h264",
      ...(rate === null ? [] : ["-r", String(rate)]), "-i", "pipe:0", "-t", "120", "-map", "0:v:0", "-an", "-sn", "-dn",
      "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov",
      "-f", "mp4", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let bytes = 0, failed = false;
    const abort = (): void => { failed = true; child.kill("SIGKILL"); };
    const timer = setTimeout(abort, 30_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) abort(); else chunks.push(chunk);
    });
    child.stdin.on("error", () => undefined);
    child.once("error", () => { failed = true; });
    child.once("close", code => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (failed || code !== 0 || !bytes) reject(new CloudRecordingError(signal.aborted ? "cancelled" : "conversion"));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(source);
  });
}
