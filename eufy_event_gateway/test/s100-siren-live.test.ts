/**
 * Exercises synthetic S100 encrypted frames and pulse failure lifecycles.
 * Tests own keys, timers and callbacks. Round trips establish gateway envelope
 * consistency, not native encryption parity or audible hardware success.
 */

import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import test from "node:test";
import { buildS100SirenTrialFrames, dispatchS100SirenStops, decodeModelControlTrialAcknowledgement } from "../src/stream/first-party-ppcs.js";
import { modelControlTrialActions, modelControlTrialCommand, parseModelControlTrial, runModelControlTrial } from "../src/provider/model-control-trials.js";
import { runS100SirenTrial, S100SirenTrialError } from "../src/provider/s100-siren-trial.js";

const route = { model: "T84A1", deviceType: 151, peerModel: "T84A1", selfPeer: true, homeBaseAttached: false, channel: 0 };
const key = Buffer.alloc(32, 7);

function clear(payload: Buffer): string {
  const value = payload.subarray(10);
  const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(16, 28));
  cipher.setAAD(Buffer.from("eufy security"));
  cipher.setAuthTag(value.subarray(0, 16));
  return Buffer.concat([cipher.update(value.subarray(32)), cipher.final()]).toString("hex");
}

test("S100 trial admission is exact and never reaches generic or legacy commands", () => {
  assert.deepEqual(modelControlTrialActions(route), ["motion", "siren", "sirenConnection"]);
  for (const patch of [{ model: "T84A1X" }, { deviceType: 150 }, { peerModel: "T8423" }, { selfPeer: false },
    { channel: 1 }, { channel: null }, { homeBaseAttached: true }]) {
    assert.equal(modelControlTrialActions({ ...route, ...patch }).includes("siren"), false);
    assert.throws(() => buildS100SirenTrialFrames({ ...route, ...patch }, true, key, 0));
  }
  assert.deepEqual(parseModelControlTrial({ action: "siren", enabled: false }), { action: "siren", enabled: false });
  for (const value of [{ action: "siren", enabled: "true" }, { action: "siren", enabled: true, duration: 900 }, null]) {
    assert.throws(() => parseModelControlTrial(value), SyntaxError);
  }
  assert.throws(() => modelControlTrialCommand({ action: "siren", enabled: true }, route, "synthetic", 1800000000000), /dedicated/);
});

test("S100 seals start and ordered stops with distinct reserved counters and exact channels", () => {
  const frames = buildS100SirenTrialFrames(route, true, key, 253);
  assert.deepEqual(frames.map(f => [f.command, f.wireChannel, clear(f.payload)]), [
    [1201, 255, "040000001e000000"], [1201, 255, "0400000000000000"], [1202, 0, "0000000000000000"],
  ]);
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    assert.equal(frame.payload[6], frame.wireChannel);
    assert.equal(frame.payload[7], 8);
    assert.equal(frame.payload[8], 0);
    assert.deepEqual([...frame.payload.subarray(4, 6)], [8, 0]);
    assert.deepEqual([...frame.payload.subarray(38, 42)], [253 + i, 3, 2, 1]);
  }
  assert.deepEqual(buildS100SirenTrialFrames(route, false, key, 254).map(f => f.command), [1201, 1202]);
  for (const sequence of [-1, 1.5, NaN, 256, 65536]) assert.throws(() => buildS100SirenTrialFrames(route, false, key, sequence));
  assert.throws(() => buildS100SirenTrialFrames(route, true, key, 254));
  assert.throws(() => buildS100SirenTrialFrames(route, false, key, 255));
  for (const invalid of [null, Buffer.alloc(16), Buffer.alloc(0)]) assert.throws(() => buildS100SirenTrialFrames(route, true, invalid, 0));
});

test("S100 stop dispatcher attempts secondary after primary rejection without leaking errors", async () => {
  const stages: string[] = [];
  await assert.rejects(dispatchS100SirenStops(buildS100SirenTrialFrames(route, false, key, 0), async frame => {
    stages.push(frame.stage);
    throw Error("private-transport-detail");
  }), (error: unknown) => error instanceof S100SirenTrialError
    && error.stages.join() === "primary_stop,secondary_stop" && !error.message.includes("private-transport"));
  assert.deepEqual(stages, ["primary_stop", "secondary_stop"]);
});

test("S100 acknowledgement ignores other channels and commands and retains nonzero rejection scalar", () => {
  const header = Buffer.alloc(16); header.write("XZYH"); header.writeUInt16LE(1201, 4); header[12] = 255; header[14] = 1;
  const payload = Buffer.alloc(4); payload.writeInt32LE(-1);
  assert.equal(decodeModelControlTrialAcknowledgement(header, payload, 1201, 255, Buffer.alloc(16), key), -1);
  assert.equal(decodeModelControlTrialAcknowledgement(header, payload, 1202, 255, Buffer.alloc(16), key), null);
  assert.equal(decodeModelControlTrialAcknowledgement(header, payload, 1201, 0, Buffer.alloc(16), key), null);
});

test("S100 setup failures expose only the closed privacy-safe stage vocabulary", () => {
  for (const stage of ["session_key", "session_connect", "session_prepare"] as const) {
    const error = new S100SirenTrialError([stage]);
    assert.deepEqual(error.stages, [stage]);
    assert.equal(error.message.includes("private"), false);
  }
});

test("S100 pulse waits exactly five seconds, sends one start and then one stop", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  context.mock.method(performance, "now", () => Date.now());
  const calls: string[] = [];
  const running = runS100SirenTrial({ start: async () => { calls.push("start"); }, stop: async () => { calls.push("stop"); } }, true, new AbortController().signal, () => {});
  await Promise.resolve();
  context.mock.timers.tick(4999); await Promise.resolve();
  assert.deepEqual(calls, ["start"]);
  context.mock.timers.tick(1);
  assert.deepEqual(await running, { outcome: "acknowledged", physicalConfirmationRequired: true, stoppedEarly: false });
  assert.deepEqual(calls, ["start", "stop"]);
});

test("S100 early cancellation ends the pulse and ownership loss still stops the original transport", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  context.mock.method(performance, "now", () => Date.now());
  for (const lostOwnership of [false, true]) {
    const controller = new AbortController();
    const calls: string[] = []; let changed = false;
    const running = runS100SirenTrial({ start: async () => { calls.push("start"); }, stop: async () => { calls.push("stop"); } }, true, controller.signal,
      () => { if (changed && lostOwnership) throw Error("private-binding-detail"); });
    await Promise.resolve(); changed = true;
    if (lostOwnership) context.mock.timers.tick(100); else controller.abort();
    if (lostOwnership) await assert.rejects(running, (e: unknown) => e instanceof S100SirenTrialError && e.stages[0] === "ownership");
    else assert.equal((await running).stoppedEarly, true);
    assert.deepEqual(calls, ["start", "stop"]);
  }
});

test("S100 lost start reply skips the pulse, preserves start and stop failures and never reads state", async () => {
  const calls: string[] = [];
  await assert.rejects(runS100SirenTrial({ start: async () => { calls.push("start"); throw new S100SirenTrialError(["start"]); },
    stop: async () => { calls.push("stop"); throw new S100SirenTrialError(["primary_stop"]); } }, true, new AbortController().signal, () => {}),
    (e: unknown) => e instanceof S100SirenTrialError && e.stages.join() === "start,primary_stop");
  assert.deepEqual(calls, ["start", "stop"]);
  calls.length = 0;
  await runS100SirenTrial({ start: async () => { assert.fail("stop-only must not start"); }, stop: async () => { calls.push("stop"); } }, false, new AbortController().signal, () => {});
  assert.deepEqual(calls, ["stop"]);
});


test("S100 pulse uses monotonic time when wall time jumps", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let monotonic = 0, stops = 0;
  context.mock.method(performance, "now", () => monotonic);
  const running = runS100SirenTrial({ start: async () => {}, stop: async () => { stops++; } }, true, new AbortController().signal, () => {});
  await Promise.resolve();
  context.mock.timers.setTime(9_000_000_000);
  monotonic = 4999; context.mock.timers.tick(100); await new Promise(resolve => setImmediate(resolve));
  assert.equal(stops, 0);
  monotonic = 5000; context.mock.timers.tick(100); await running;
  assert.equal(stops, 1);
});


test("connection request is strict and can never enter a generic writer", async () => {
  const request = { action: "sirenConnection", enabled: false } as const;
  assert.deepEqual(parseModelControlTrial(request), request);
  for (const value of [true, "false", 0, null, undefined]) assert.throws(() => parseModelControlTrial({ action: request.action, enabled: value }));
  for (const value of [{ ...request, direction: "left" }, { ...request, raw: 1201 }, [request], { action: request.action }]) assert.throws(() => parseModelControlTrial(value));
  for (const patch of [{ model: "T84A1X" }, { deviceType: 150 }, { peerModel: "T8423" }, { selfPeer: false }, { channel: 1 }, { channel: null }, { homeBaseAttached: true }]) {
    assert.equal(modelControlTrialActions({ ...route, ...patch }).includes("sirenConnection"), false);
  }
  assert.throws(() => modelControlTrialCommand(request, route, "", 0), /cannot dispatch/);
  await assert.rejects(runModelControlTrial({ read: async () => { assert.fail("read forbidden"); }, write: async () => { assert.fail("write forbidden"); } }, request, () => { assert.fail("ownership must not be checked"); }), /cannot dispatch/);
});

test("preparation stages preserve route, key and counter precedence", () => {
  const stage = (run: () => unknown, expected: string) => assert.throws(run, (error: unknown) => error instanceof S100SirenTrialError && error.stages.join() === expected);
  stage(() => buildS100SirenTrialFrames({ ...route, channel: 1 }, false, null, -1), "session_identity");
  for (const invalid of [null, Buffer.alloc(0), Buffer.alloc(16)]) stage(() => buildS100SirenTrialFrames(route, false, invalid, -1), "session_cipher");
  for (const sequence of [-1, 1.5, NaN, 255, 65536]) stage(() => buildS100SirenTrialFrames(route, false, key, sequence), "session_counter");
  for (const stageName of ["session_identity", "session_gateway", "session_cipher", "session_counter"] as const) {
    assert.equal(new S100SirenTrialError([stageName], true).message, `S100 connection check failed: ${stageName}. No siren command was sent.`);
  }
});
