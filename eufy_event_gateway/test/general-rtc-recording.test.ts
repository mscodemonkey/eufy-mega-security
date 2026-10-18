/**
 * Exercises the real disposable media manager with generated H.264 and fake
 * provider leases. Tests own media processes and timers, verify decoded MP4,
 * and ensure no retained image store or shared event boundary is used.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import type { GeneralRtcTrialLease } from "../src/provider/general-rtc-trial.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import { recordGeneralRtcClip, type GeneralRtcRecordingDependencies } from "../src/stream/general-rtc-recording.js";
import { GeneralRtcError } from "../src/stream/general-rtc-protocol.js";
import { remuxVideoToMp4 } from "../src/stream/live-stream-manager.js";
import { validateStoredMedia } from "../src/stream/stored-recordings.js";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=32x32:rate=10", "-t", "0.2",
  "-c:v", "libx264", "-x264-params", "repeat-headers=1:aud=1", "-f", "h264", "pipe:1"]);
assert.equal(generated.status, 0);

/** Create a real recording invocation with a controllable private producer. */
function fixture(context: TestContext, dependencies?: GeneralRtcRecordingDependencies, prepareGate = Promise.resolve(), flood = false) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const writes = context.mock.method(SnapshotStore.prototype, "write"), eventWrites = context.mock.method(SnapshotStore.prototype, "writeEvent");
  const output = new PassThrough(); output.on("error", () => undefined);
  const calls: string[] = []; let release = 0, started!: () => void;
  const starting = new Promise<void>(resolve => { started = resolve; });
  const lease: GeneralRtcTrialLease = {
    prepare: async () => {
      calls.push("prepare"); await prepareGate;
      return { stop: async () => { calls.push("stop"); output.end(); }, verify: async () => { calls.push("verify"); } };
    }, start: async ready => {
      calls.push("start"); ready(output); output.write(generated.stdout);
      if (flood) for (let i = 0; i < 8; i++) output.write(Buffer.alloc(4 * 1024 * 1024));
      started();
    }, release: async () => { release++; output.destroy(); },
  };
  const pending = recordGeneralRtcClip(lease, "synthetic-pin", new AbortController().signal, dependencies);
  void pending.catch(() => undefined);
  context.after(async () => { await lease.release(); assert.equal(writes.mock.callCount(), 0); assert.equal(eventWrites.mock.callCount(), 0); });
  return { pending, starting, calls, output, releases: () => release };
}

test("real private manager remuxes and fully decodes local video before recheck without retained images", async context => {
  let mediaSignal: AbortSignal | undefined;
  const f = fixture(context, {
    remux: async (...args) => { mediaSignal = args[3]; return remuxVideoToMp4(...args); },
    validate: async (...args) => { assert.equal(args[1], mediaSignal); assert.equal(args[2], 4096 * 2160); await validateStoredMedia(...args); },
  });
  await f.starting; context.mock.timers.tick(10_000);
  const clip = await f.pending;
  assert.ok(clip.length > 0); assert.match(clip.toString("ascii", 4, 8), /ftyp/);
  assert.deepEqual(f.calls, ["prepare", "start", "stop", "verify"]); assert.equal(f.releases(), 0);
});

test("preparation does not consume the recorder's forty-second startup window", async context => {
  let ready!: () => void; const gate = new Promise<void>(resolve => { ready = resolve; });
  const f = fixture(context, { remux: async () => Buffer.from("synthetic"), validate: async () => {} }, gate);
  context.mock.timers.tick(45_000); await flush(); assert.deepEqual(f.calls, ["prepare"]);
  ready(); await f.starting; context.mock.timers.tick(10_000);
  assert.equal((await f.pending).toString(), "synthetic"); assert.equal(f.calls.at(-1), "verify");
});

test("private raw recording stops at 32 MiB and never reaches remux or recheck", async context => {
  let remux = 0;
  const f = fixture(context, { remux: async () => { remux++; return Buffer.alloc(0); }, validate: async () => {} }, Promise.resolve(), true);
  await f.starting; await assert.rejects(f.pending, (error: unknown) => error instanceof GeneralRtcError && error.stage === "video");
  assert.equal(remux, 0); assert.equal(f.calls.includes("verify"), false);
});

test("oversized MP4 is rejected before decode or ownership recheck", async context => {
  let validated = 0;
  const f = fixture(context, { remux: async () => Buffer.alloc(32 * 1024 * 1024 + 1), validate: async () => { validated++; } });
  await f.starting; context.mock.timers.tick(10_000);
  await assert.rejects(f.pending, GeneralRtcError); assert.equal(validated, 0); assert.equal(f.calls.includes("verify"), false);
});

for (const stalled of ["remux", "validate"] as const) test(`one thirty-second media signal bounds a stalled ${stalled}`, async context => {
  const controller = new AbortController(); let entered!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => { assert.equal(milliseconds, 30_000); return controller.signal; });
  const wait = async (): Promise<never> => { entered(); return await new Promise<never>(() => {}); };
  const f = fixture(context, { remux: stalled === "remux" ? wait : async () => Buffer.from("synthetic"), validate: stalled === "validate" ? wait : async () => {} });
  await f.starting; context.mock.timers.tick(10_000); await entering; controller.abort();
  await assert.rejects(f.pending, (error: unknown) => error instanceof GeneralRtcError && error.stage === "video");
  assert.equal(f.calls.includes("verify"), false);
});
