/** Exercise consent, interval ownership and cleanup with synthetic media decoded by FFmpeg. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { C31ContinuousReader, parseC31ContinuousRequest, requireC31ContinuousInterval } from "../src/stream/c31-continuous-recording.js";

function header(command: number, channel: number, sign = 0): Buffer {
  const h = Buffer.alloc(16); h.writeUInt16LE(command, 4); h[12] = channel; h[13] = sign; return h;
}

function frame(data: Buffer, clock: number): Buffer {
  const h = Buffer.alloc(22); h.writeUInt32LE(data.length); h[4] = 1; h[5] = 1;
  h.writeUInt16LE(160, 10); h.writeUInt16LE(90, 12); h.writeUInt32LE(clock, 14); return Buffer.concat([h, data]);
}

function timestamp(): Buffer { const result = Buffer.alloc(128); result.write("1791500754"); return result; }

test("continuous consent accepts only an explicit recent time with private-media permission", () => {
  const now = 1_800_000_000;
  assert.deepEqual(parseC31ContinuousRequest({ consentPrivateMedia: true, beginTime: now - 100 }, now), { beginTime: now - 100 });
  for (const value of [null, {}, { consentPrivateMedia: false, beginTime: now - 100 },
    { consentPrivateMedia: true, beginTime: now - 100, path: "/private" },
    ...[now - 86401, now, now - 5, (now - 100) * 1000, NaN, now - 100.5].map(beginTime => ({ consentPrivateMedia: true, beginTime }))]) assert.throws(() => parseC31ContinuousRequest(value, now));
});

test("a fresh index must contain the whole clip exactly once with matching account and window", () => {
  const begin = 1_800_000_000 - 100, record = { start_time: begin - 5, stop_time: begin + 30, cipher_id: 1 };
  const reply = { begin_time: begin, end_time: begin + 10, id: 1, account: "synthetic", videos: [record] };
  requireC31ContinuousInterval(reply, begin, "synthetic");
  for (const change of [{ account: "foreign" }, { videos: [] }, { videos: [record, record] },
    { videos: [{ ...record, stop_time: begin + 5 }] }, { videos: [{ ...record, start_time: begin + 1 }] },
    { videos: [record, {}] }, { begin_time: begin - 1 }]) assert.throws(() => requireC31ContinuousInterval({ ...reply, ...change }, begin, "synthetic"));
});

for (const mode of ["receipt", "foreign", "gap", "cancel", "short", "protected-audio", "stop-error"]) {
  test(`continuous reader fails closed and sends its stop once: ${mode}`, async () => {
    let stops = 0, starts = 0;
    const controller = new AbortController();
    const reader = new C31ContinuousReader({ serial: "SYNTHETIC", did: "SYNTHETIC-DID",
      start: () => { starts++; }, stop: () => { stops++; if (mode === "stop-error") throw Error("stop unavailable"); },
      decodeReply: () => mode === "receipt" ? Buffer.alloc(128, 1) : timestamp() });
    const work = reader.read(controller.signal), rejected = assert.rejects(work);
    if (mode === "foreign") {
      reader.handleFrame(header(6001, 1, 2), Buffer.alloc(156), 2);
      reader.handleFrame(header(1300, 100), frame(Buffer.from([0, 0, 0, 1, 101]), 0), 1); controller.abort();
    } else if (mode === "cancel" || mode === "stop-error") controller.abort();
    else {
      reader.handleFrame(header(6001, 0, 2), Buffer.alloc(156), 2);
      if (mode !== "receipt") reader.handleFrame(header(1300, 101), frame(Buffer.from([0, 0, 0, 1, 101]), 0), 1);
      if (mode === "gap") reader.handleFrame(header(1300, 101), frame(Buffer.from([0, 0, 0, 1, 101]), 3000), 1);
      if (mode === "short") reader.handleFrame(header(1300, 101), Buffer.alloc(10), 1);
      if (mode === "protected-audio") reader.handleFrame(header(1301, 101, 1), Buffer.alloc(23), 1);
    }
    await rejected; assert.equal(starts, 1); assert.equal(stops, 1); reader.close(); assert.equal(stops, 1);
  });
}

test("continuous preview fully decodes ten source seconds and rejects reader reuse", async () => {
  const { stdout } = await promisify(execFile)("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=size=160x90:rate=1", "-frames:v", "1", "-c:v", "libx264", "-f", "h264", "pipe:1"], { encoding: "buffer" });
  let stops = 0;
  const reader = new C31ContinuousReader({ serial: "SYNTHETIC", did: "SYNTHETIC-DID", decodeReply: () => timestamp(),
    start: () => queueMicrotask(() => {
      reader.handleFrame(header(6001, 0, 2), Buffer.alloc(156), 2);
      for (let i = 0; i <= 10; i++) reader.handleFrame(header(1300, 101), frame(stdout, i * 1000), 1);
    }), stop: () => { stops++; } });
  const media = await reader.read(new AbortController().signal);
  assert.ok(media.length > 100); assert.equal(stops, 1); await assert.rejects(reader.read(new AbortController().signal));
});
