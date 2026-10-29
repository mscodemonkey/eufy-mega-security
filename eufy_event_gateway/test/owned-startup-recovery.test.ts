/**
 * Tests observation of a silent, owned startup without draining viewer bytes.
 * Test-owned streams, cancellation and fake time isolate the provider's
 * replacement decision from physical cameras and network state.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { acknowledgedStartupIsSilent, observeOwnedStartup, type OwnedStartupFacts } from "../src/stream/owned-startup-recovery.js";

/** Create independent delivered-start facts with no application or media progress. */
function facts(): OwnedStartupFacts {
  return { camId: 1, mediaStartAcknowledged: 1, videoFrames: 0, videoOutputFrames: 0,
    commands: [1100], closeReason: "open" };
}

test("recovery requires acknowledged delivery and complete application silence", () => {
  assert.equal(acknowledgedStartupIsSilent(facts()), true);
  for (const change of [{ camId: 0 }, { mediaStartAcknowledged: 0 }, { videoFrames: 1 },
    { videoOutputFrames: 1 }, { commands: [1100, 1350] }, { commands: [1100, 1301] },
    { closeReason: "client_stop" }]) {
    assert.equal(acknowledgedStartupIsSilent({ ...facts(), ...change }), false);
  }
});

for (const acknowledged of [0, 1]) test(`observation waits for silence threshold, acknowledged=${acknowledged}`, async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const source = new PassThrough();
  const result = observeOwnedStartup(source, { ...facts(), mediaStartAcknowledged: acknowledged }, 6000, new AbortController().signal);
  let settled = false;
  void result.then(() => { settled = true; });
  context.mock.timers.tick(5999);
  await Promise.resolve();
  assert.equal(settled, false);
  context.mock.timers.tick(1);
  assert.equal(await result, acknowledged ? "silent" : "unconfirmed");
  assert.equal(source.listenerCount("end"), 0);
  assert.equal(source.listenerCount("close"), 0);
  source.destroy();
});

test("progress leaves the first media bytes buffered for the viewer", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const source = new PassThrough();
  const state = { ...facts() };
  const result = observeOwnedStartup(source, state, 6000, new AbortController().signal);
  source.write(Buffer.from("first-media-unit"));
  state.videoFrames = 10;
  state.videoOutputFrames = 10;
  context.mock.timers.tick(50);
  assert.equal(await result, "progress");
  assert.equal(source.read().toString(), "first-media-unit");
  source.destroy();
});

test("application replies without media do not authorize silent-peer replacement", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const source = new PassThrough();
  const state = { ...facts(), commands: [1100] };
  const result = observeOwnedStartup(source, state, 6000, new AbortController().signal);
  state.commands.push(1350);
  context.mock.timers.tick(6000);
  assert.equal(await result, "unconfirmed");
  source.destroy();
});

for (const retirement of ["abort", "logical-close", "stream-close"] as const) test(`retirement cancels observation: ${retirement}`, async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const source = new PassThrough();
  const controller = new AbortController();
  const state = { ...facts() };
  const result = assert.rejects(observeOwnedStartup(source, state, 6000, controller.signal), /cancelled|ended/);
  if (retirement === "abort") controller.abort();
  if (retirement === "logical-close") state.closeReason = "replaced";
  if (retirement === "stream-close") source.destroy();
  context.mock.timers.tick(50);
  await result;
  assert.equal(source.listenerCount("end"), 0);
  assert.equal(source.listenerCount("close"), 0);
  context.mock.timers.tick(6000);
  source.destroy();
});

for (const advancing of [false, true]) test(`short startup media is distinguished from a slow progressing stream: ${advancing}`, async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1800000000000 });
  context.mock.method(performance, "now", () => Date.now());
  const source = new PassThrough();
  const state = { ...facts(), videoFrames: 3, videoOutputFrames: 3, commands: [1100, 1350, 1300] };
  const result = observeOwnedStartup(source, state, 6000, new AbortController().signal);
  context.mock.timers.tick(5000);
  if (advancing) state.videoOutputFrames++;
  context.mock.timers.tick(1000);
  assert.equal(await result, advancing ? "progress" : "stalled");
  source.destroy();
});
