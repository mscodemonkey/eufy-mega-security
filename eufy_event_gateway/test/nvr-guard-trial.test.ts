/**
 * Exercises Schedule-to-Home recovery using a synthetic private inventory.
 * The fixture owns modes, schedule bytes, clocks, and write outcomes. No cloud,
 * station, or physical alarm is contacted by these tests.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { NvrGuardError, runNvrGuardTrial, type NvrGuardTransport } from "../src/provider/nvr-guard-trial.js";
import { nvrGuardModeCommand } from "../src/stream/nvr-protocol.js";

function fixture(mode: string) {
  let restoreReads = 0, validations = 0;
  const dispatchTimes: number[] = [], readTimes: number[] = [];
  let guard = 2, schedule = Buffer.from(JSON.stringify({ schedules: Array.from({ length: 7 }, (_, week) => ({ week, start_h: 0, start_m: 0, end_h: 23, end_m: 59, mode_id: 0 })) })).toString("base64"), now = 0, recovering = false, restoreAttempts = 0, closed = 0;
  const writes: number[] = [];
  const caller = new AbortController();
  const transport: NvrGuardTransport = {
    prepare: async () => undefined,
    validate: async recovery => {
      recovering = recovery;
      if (recovery && mode === "identity-before-restore") throw new NvrGuardError("identity");
      if (recovery && mode === "transient-auth" && ++validations === 1) throw new NvrGuardError("inventory");
    },
    read: async () => {
      if (recovering) readTimes.push(now);
      if (recovering && mode === "restore-read-timeout" && ++restoreReads === 1) throw new NvrGuardError("inventory");
      if (recovering && mode === "unknown-restore") return { mode: null, schedule };
      if (recovering && mode === "identity-change") throw new NvrGuardError("identity");
      if (!writes.length && mode === "wrong-baseline") return { mode: 1, schedule };
      if (!writes.length && mode === "missing-schedule") return { mode: 2, schedule: null };
      if (writes.length > 0 && !recovering && mode === "unknown-target") return { mode: null, schedule };
      if (recovering && mode === "schedule-changed") return { mode: guard, schedule: "changed" };
      return { mode: guard, schedule };
    },
    write: async (value, signal, mark) => {
      signal.throwIfAborted();
      if (recovering && mode === "never-dispatch") throw new NvrGuardError("send");
      mark(); writes.push(value); dispatchTimes.push(now);
      if (recovering) {
        restoreAttempts++;
        if (mode === "retry-restore" && restoreAttempts === 1) return;
      }
      guard = value;
      if (!recovering && mode === "receipt") throw new NvrGuardError("receipt");
      if (!recovering && mode === "cancel") caller.abort();
    },
    effective: async value => {
      if (writes.length > 0 && !recovering && mode === "missing-effective" || recovering && mode === "missing-restore-effective") {
        throw new NvrGuardError("readback");
      }
      assert.equal(value, writes.length > 0 && !recovering ? 1 : 0);
    },
    close: async () => { closed++; if (mode === "cleanup") throw Error("PRIVATE-CANARY"); },
  };
  return { caller, transport, writes, dispatchTimes, readTimes, state: () => ({ guard, schedule, closed, restoreAttempts }),
    runtime: { now: () => now, wallNow: () => Date.UTC(2026, 9, 18, 12) + now, sleep: async (milliseconds: number, signal: AbortSignal) => {
      signal.throwIfAborted(); now += milliseconds;
    } } };
}

for (const mode of ["valid", "receipt", "cancel", "unknown-target", "missing-effective", "retry-restore", "restore-read-timeout", "transient-auth"]) {
  test(`NVR guard trial restores Schedule: ${mode}`, async () => {
    const value = fixture(mode);
    const result = await runNvrGuardTrial(value.transport, { target: "home", timeZone: "UTC" }, value.caller.signal, value.runtime);
    assert.equal(result.restored, true);
    if (mode === "receipt") assert.equal(result.outcome, "home_unconfirmed_restored"); assert.equal(result.scheduleUnchanged, true);
    assert.equal(result.physicalConfirmationRequired, true); assert.equal(value.state().guard, 2);
    assert.deepEqual(value.writes, [1, 2, ...(mode === "retry-restore" ? [2] : [])]);
    assert.equal(value.state().closed, 1);
  });
}

for (const mode of ["wrong-baseline", "missing-schedule", "schedule-changed", "missing-restore-effective", "unknown-restore", "identity-change", "identity-before-restore", "never-dispatch", "cleanup"]) {
  test(`NVR guard trial fails closed: ${mode}`, async () => {
    const value = fixture(mode);
    await assert.rejects(runNvrGuardTrial(value.transport, { target: "home", timeZone: "UTC" }, value.caller.signal, value.runtime), error => {
      assert.ok(error instanceof NvrGuardError);
      assert.equal(error.manualRestoreRequired, ["schedule-changed", "missing-restore-effective", "unknown-restore", "identity-change", "identity-before-restore", "never-dispatch"].includes(mode));
      return true;
    });
    assert.equal(value.state().closed, 1);
  });
}

test("NVR guard trial rejects every target except Home", async () => {
  const value = fixture("valid");
  await assert.rejects(runNvrGuardTrial(value.transport, { target: "away" } as never,
    value.caller.signal, value.runtime), /admission/);
  assert.deepEqual(value.writes, []);
});

test("closed guard builder emits only the source-confirmed command shape", () => {
  const frame = nvrGuardModeCommand("synthetic-owner", "Synthetic", 7, 1);
  assert.equal(frame.subarray(0, 4).toString(), "XZYH"); assert.equal(frame.readUInt16LE(4), 1350);
  assert.equal(frame.readUInt32LE(6), frame.length - 16); assert.equal(frame[11], 7); assert.equal(frame[12], 255);
  assert.deepEqual(JSON.parse(frame.subarray(16).toString()), { account_id: "synthetic-owner", cmd: 1224, mValue3: 0,
    payload: { mode_type: 1, user_name: "Synthetic" } });
  for (const [segment, value] of [[0, 1], [255, 1], [7, 0], [7, 3]]) {
    assert.throws(() => nvrGuardModeCommand("synthetic-owner", "Synthetic", segment!, value as 1 | 2));
  }
});

test("unknown restoration never authorizes a second write", async () => {
  const value = fixture("unknown-restore");
  await assert.rejects(runNvrGuardTrial(value.transport, { target: "home", timeZone: "UTC" }, value.caller.signal, value.runtime));
  assert.deepEqual(value.writes, [1, 2]);
});

test("identity loss before recovery forbids a restore write", async () => {
  const value = fixture("identity-before-restore");
  await assert.rejects(runNvrGuardTrial(value.transport, { target: "home", timeZone: "UTC" }, value.caller.signal, value.runtime),
    error => error instanceof NvrGuardError && error.manualRestoreRequired);
  assert.deepEqual(value.writes, [1]);
});

test("retry waits at least fifteen seconds and final proof is separated", async () => {
  const value = fixture("retry-restore");
  await runNvrGuardTrial(value.transport, { target: "home", timeZone: "UTC" }, value.caller.signal, value.runtime);
  assert.ok(value.dispatchTimes[2]! - value.dispatchTimes[1]! >= 15_000);
  assert.ok(value.readTimes.at(-1)! - value.readTimes.at(-2)! >= 1_000);
});

test("already-Schedule readback verifies without rewriting", async () => {
  const value = fixture("valid");
  await runNvrGuardTrial(value.transport, { target: "home", timeZone: "UTC" }, value.caller.signal, value.runtime);
  assert.deepEqual(value.writes, [1, 2]);
  assert.equal(value.readTimes.length, 2);
  assert.ok(value.readTimes[1]! - value.readTimes[0]! >= 1_000);
});

test("all baseline failures perform zero writes", async () => {
  for (const mode of ["wrong-baseline", "missing-schedule"]) {
    const value = fixture(mode);
    await assert.rejects(runNvrGuardTrial(value.transport, { target: "home", timeZone: "UTC" }, value.caller.signal, value.runtime));
    assert.deepEqual(value.writes, []);
  }
});

test("normal preparation timeout closes without writing", async context => {
  const value = fixture("valid");
  value.transport.prepare = async () => new Promise<void>(() => undefined);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const operation = runNvrGuardTrial(value.transport, { target: "home", timeZone: "UTC" }, value.caller.signal, value.runtime);
  const rejected = assert.rejects(operation, error => error instanceof NvrGuardError && error.stage === "timeout" && !error.manualRestoreRequired);
  context.mock.timers.tick(40_000);
  await rejected;
  assert.deepEqual(value.writes, []);
  assert.equal(value.state().closed, 1);
});

test("recovery timeout requires manual restore and never retries an unknown read", async context => {
  const value = fixture("valid"), read = value.transport.read;
  value.transport.read = async signal => value.writes.length > 1 ? new Promise(() => undefined) : read(signal);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const operation = runNvrGuardTrial(value.transport, { target: "home", timeZone: "UTC" }, value.caller.signal, value.runtime);
  const rejected = assert.rejects(operation, error => error instanceof NvrGuardError && error.manualRestoreRequired);
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(value.writes, [1, 2]);
  context.mock.timers.tick(120_000);
  await rejected;
  assert.deepEqual(value.writes, [1, 2]);
  assert.equal(value.state().closed, 1);
});
