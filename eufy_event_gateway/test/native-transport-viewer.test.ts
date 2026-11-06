/**
 * Runs a native transport viewer through the real stream manager: one camera
 * source with H.265 and AAC reaches the viewer as MPEG-TS, with no conversion
 * process, and a muted source still starts. Synthetic media only.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import { splitAccessUnits } from "../src/stream/annexb-access-units.js";
import { LiveStreamManager } from "../src/stream/live-stream-manager.js";
import type { NativeTransportSummary } from "../src/stream/live-native-transport.js";

function encode(args: string[]): Buffer {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args, "pipe:1"], { maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

function response(): { sink: ServerResponse; bytes: Buffer[]; headers: string[] } {
  const sink = new PassThrough() as unknown as ServerResponse;
  const bytes: Buffer[] = [], headers: string[] = [];
  sink.on("data", (chunk: Buffer) => bytes.push(Buffer.from(chunk)));
  sink.on("error", () => {});
  sink.writeHead = ((_status: number, values: Record<string, string>) => {
    headers.push(values["Content-Type"]!);
    Object.defineProperty(sink, "headersSent", { configurable: true, value: true });
    return sink;
  }) as ServerResponse["writeHead"];
  return { sink, bytes, headers };
}

function fixture(withAudio: boolean) {
  const state = new GatewayState();
  state.registerCamera({ serial: "fixture", name: "Synthetic", model: "T8416", stationSerial: "nvr",
    streamSupported: true, doorbellSupported: false, liveAudioSupported: true });
  const video = new PassThrough(), audio = new PassThrough();
  let conversions = 0;
  const snapshot = (): ChildProcessWithoutNullStreams => Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  const manager = new LiveStreamManager(state, {} as never, {
    async startStream() { manager.attachSource("fixture", video, () => "h265", withAudio ? audio : undefined); },
    async stopStream() { video.end(); audio.end(); },
  }, 5, undefined, () => { conversions++; throw new Error("no conversion expected"); }, snapshot);
  manager.on("warning", () => {});
  return { manager, video, audio, get conversions() { return conversions; } };
}

for (const withAudio of [true, false]) test(`native transport viewer ${withAudio ? "carries H.265 and AAC" : "starts muted"} without conversion`, { timeout: 20_000 }, async () => {
  const f = fixture(withAudio), viewer = response();
  const summaries: NativeTransportSummary[] = [];
  f.manager.on("native-transport-closed", summary => summaries.push(summary));
  const hevc = encode(["-f", "lavfi", "-i", "testsrc=size=128x96:rate=15", "-frames:v", "30", "-pix_fmt", "yuv420p",
    "-c:v", "libx265", "-x265-params", "log-level=none:bframes=0:keyint=15", "-f", "hevc"]);
  const aac = encode(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", "2", "-ac", "1", "-c:a", "aac", "-f", "adts"]);
  try {
    await f.manager.addTransportClient("fixture", viewer.sink, "native", "fixture-view-mark-0001");

    // Camera routes write one whole picture per chunk.
    const pictures = splitAccessUnits(hevc, "h265").units;
    assert.equal(pictures.length, 30);
    for (const [index, picture] of pictures.entries()) {
      f.video.write(picture);
      if (withAudio && index === 0) f.audio.write(aac);
      await delay(5);
    }
    for (let attempt = 0; attempt < 400 && viewer.headers.length === 0; attempt++) await delay(10);
    viewer.sink.emit("close");
    await delay(20);
    assert.deepEqual(viewer.headers, ["video/mp2t"]);
    const output = Buffer.concat(viewer.bytes);
    const probe = spawnSync("ffprobe", ["-v", "error", "-f", "mpegts", "-show_entries", "stream=codec_name", "-of", "json", "pipe:0"], { input: output });
    assert.equal(probe.status, 0, probe.stderr.toString());
    const codecs = (JSON.parse(probe.stdout.toString()).streams as { codec_name: string }[]).map(stream => stream.codec_name).sort();
    assert.deepEqual(codecs, withAudio ? ["aac", "hevc"] : ["hevc"]);
    assert.equal(f.conversions, 0);
    assert.equal(summaries[0]?.codec, "h265");
    assert.equal(summaries[0]?.audio, withAudio);
  } finally { await f.manager.close(); }
});
