/**
 * Exercises background NVR ownership with fake sessions and a controlled clock.
 * Fixtures own all effects. Tests cover cancellation, bounded retries and late
 * results without contacting a device or changing household security state.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { NvrModeObserver, type NvrModeObserverTarget } from "../src/provider/nvr-mode-observer.js";
import { NvrTrialError } from "../src/stream/nvr-protocol.js";
import type { NvrRtcSession } from "../src/stream/nvr-rtc-session.js";
import type { NvrEffectiveModeObservation } from "../src/stream/nvr-effective-mode.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** Own one offline output and idempotent close, with an optional held cleanup boundary. */
class Session {
  readonly output = new PassThrough();
  starts = 0;
  closes = 0;
  failure = false;
  held: Promise<void> | null = null;
  #closing: Promise<void> | null = null;

  constructor(readonly report: (value: NvrEffectiveModeObservation | null) => void) {}

  async observeEffectiveMode(): Promise<void> { this.starts++; }

  close(): Promise<void> {
    return this.#closing ??= (async () => {
      this.closes++;
      if (this.held) await this.held;
      if (this.failure) throw Error("PRIVATE_FAILURE");
      this.report(null);
      this.output.end();
    })();
  }
}

function fixture() {
  const sessions: Session[] = [], reports: (NvrEffectiveModeObservation | null)[] = [];
  const states: { state: string; retry: number | null; reason: string | null }[] = [];
  let now = 0, eligible = true;
  const owner = new NvrModeObserver((state, retry, reason) => states.push({ state, retry, reason }), () => now);
  const target = (key = "private-binding"): NvrModeObserverTarget => ({ key, current: () => eligible,
    create: async (_signal, _current, report) => {
      const session = new Session(report); sessions.push(session); return session as unknown as NvrRtcSession;
    }, report: (_session, value) => reports.push(value) });
  return { owner, target, sessions, reports, states, now: (value: number) => { now = value; },
    eligible: (value: boolean) => { eligible = value; } };
}

test("a stable target reuses its connection and retirement rejects late mode callbacks", async () => {
  const f = fixture();
  f.owner.setTarget(f.target()); await tick();
  f.owner.setTarget(f.target()); await tick();
  assert.equal(f.sessions.length, 1); assert.equal(f.sessions[0]!.starts, 1);
  f.sessions[0]!.report({ mode: 3 });
  assert.deepEqual(f.reports, [{ mode: 3 }]);
  await f.owner.close();
  f.sessions[0]!.report({ mode: 1 });
  assert.deepEqual(f.reports, [{ mode: 3 }, null]);
  assert.equal(f.sessions[0]!.closes, 1); assert.equal(f.owner.active, false);
});

test("replacement waits for cleanup before opening another connection", async () => {
  const f = fixture(); f.owner.setTarget(f.target()); await tick();
  let finish!: () => void;
  f.sessions[0]!.held = new Promise(resolve => { finish = resolve; });
  f.owner.setTarget(f.target("replacement")); await tick();
  assert.equal(f.sessions.length, 1);
  finish(); await tick();
  assert.equal(f.sessions.length, 2); assert.equal(f.sessions[0]!.closes, 1);
  await f.owner.close();
});

test("cancelled credential work cannot open a late session", async () => {
  const f = fixture(); let complete!: (value: NvrRtcSession) => void, calls = 0;
  const target = { ...f.target(), create: () => { calls++; return new Promise<NvrRtcSession>(resolve => { complete = resolve; }); } };
  f.owner.setTarget(target); await tick(); await f.owner.close();
  const late = new Session(() => {}); complete(late as unknown as NvrRtcSession); await tick();
  assert.equal(calls, 1); assert.equal(late.starts, 0); assert.equal(late.closes, 1);
});

test("retries back off without reset on inventory polls and stable sessions restore the minimum", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); f.owner.setTarget(f.target()); await tick();
  for (const [index, delay] of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000].entries()) {
    f.sessions[index]!.output.destroy(new Error("PRIVATE_FAILURE")); await tick();
    assert.equal(f.states.at(-1)!.retry, delay);
    f.owner.setTarget(f.target());
    context.mock.timers.tick(delay - 1); await tick();
    assert.equal(f.sessions.length, index + 1);
    context.mock.timers.tick(1); await tick();
    assert.equal(f.sessions.length, index + 2);
  }
  f.now(60_000); f.sessions.at(-1)!.output.end(); await tick();
  assert.equal(f.states.at(-1)!.retry, 30_000);
  await f.owner.close(); context.mock.timers.tick(300_000); await tick();
  assert.equal(f.sessions.length, 7);
  assert.doesNotMatch(JSON.stringify(f.states), /PRIVATE|private-binding/);
});

test("an authorization rejection blocks retries until the target binding changes", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); let calls = 0;
  const target = (key = "auth-binding") => ({ ...f.target(key), create: async () => {
    calls++; throw new NvrTrialError("region_or_authorization_rejected");
  } });
  f.owner.setTarget(target()); await tick();
  assert.equal(f.states.at(-1)!.state, "blocked");
  assert.equal(f.states.at(-1)!.reason, "authorization");
  f.owner.setTarget(target()); context.mock.timers.tick(3_600_000); await tick();
  assert.equal(calls, 1);
  f.owner.setTarget(target("new-account-generation")); await tick(); assert.equal(calls, 2);
  await f.owner.close();
});

test("a failed cleanup blocks replacement instead of overlapping uncertain resources", async () => {
  const f = fixture(); f.owner.setTarget(f.target()); await tick();
  f.sessions[0]!.failure = true;
  f.owner.setTarget(f.target("replacement")); await tick();
  assert.equal(f.sessions.length, 1); assert.equal(f.states.at(-1)!.state, "blocked");
  assert.equal(f.states.at(-1)!.reason, "cleanup");
  await assert.rejects(f.owner.close(), { stage: "stop" });
});

test("an ineligible binding waits for an eligible refresh without a reconnect loop", async () => {
  const f = fixture(); f.eligible(false); f.owner.setTarget(f.target()); await tick();
  assert.equal(f.sessions.length, 0);
  f.eligible(true); f.owner.setTarget(f.target()); await tick(); assert.equal(f.sessions.length, 1);
  f.eligible(false); f.sessions[0]!.output.end(); await tick();
  assert.equal(f.states.at(-1)!.state, "idle"); await f.owner.close();
});
