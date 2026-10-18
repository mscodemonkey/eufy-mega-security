/**
 * Exercises private schedule interpretation with fixed instants and synthetic
 * slots. These tests own all bytes and clocks and never contact an NVR.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { nvrGuardSchedule, nvrGuardTimeZone } from "../src/provider/nvr-guard-schedule.js";
import { NvrGuardError } from "../src/provider/nvr-guard-trial.js";

const noon = Date.UTC(2026, 9, 18, 12);
const slot = { week: 0, start_h: 0, start_m: 0, end_h: 23, end_m: 59, mode_id: 0 };
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
const valid = encode({ schedules: [slot] });

test("schedule uses Sunday zero and accepts a stable supported mode", () => {
  assert.equal(nvrGuardSchedule(valid, "UTC", noon), 0);
  assert.equal(nvrGuardSchedule(encode({ schedules: [slot, { ...slot, week: 1, mode_id: 1 }] }), "UTC", noon), 0);
  assert.equal(nvrGuardTimeZone("Europe/London"), "Europe/London");
});

for (const zone of [undefined, "", "+10:00", "10", "Etc/GMT+5", "GMT+5", "UTC-5", "Wrong/PRIVATE-CANARY", "a".repeat(65)]) {
  test(`timezone refuses invalid input ${String(zone).length}`, () => {
    assert.throws(() => nvrGuardTimeZone(zone), error => error instanceof NvrGuardError
      && error.stage === "admission" && !error.message.includes("PRIVATE-CANARY"));
  });
}

const malformed = ["", "not base64", valid + "\n", "a".repeat(65_537), Buffer.from([255]).toString("base64"),
  Buffer.from('\ufeff{"schedules":[]}').toString("base64"), encode({ schedules: [] }),
  encode({ schedules: [{ ...slot, mode_id: 1 }] }), encode({ schedules: [{ ...slot, mode_id: 63 }] }),
  encode({ schedules: [{ ...slot, unknown: 1 }] }), encode({ schedules: [slot, slot] }),
  encode({ schedules: [{ ...slot, week: 7 }] }), encode({ schedules: [{ ...slot, start_h: 20, end_h: 10 }] }),
  encode({ schedules: [{ ...slot, start_h: 23, start_m: 59 }] }),
  encode({ schedules: [{ ...slot, start_h: 13 }] }),
  Buffer.from('{"schedules":[],"sched\\u0075les":[]}').toString("base64"),
  Buffer.from('{"schedules":[{"week":-0,"start_h":0,"start_m":0,"end_h":23,"end_m":59,"mode_id":0}]}').toString("base64")];
for (const [index, value] of malformed.entries()) {
  test(`schedule refuses malformed or unsafe input ${index}`, () => {
    assert.throws(() => nvrGuardSchedule(value, "UTC", noon), error => error instanceof NvrGuardError
      && error.stage === "baseline" && error.message === "baseline");
  });
}

test("schedule rejects midnight, equal-mode slot boundaries and DST jumps", () => {
  const week = encode({ schedules: Array.from({ length: 7 }, (_, day) => ({ ...slot, week: day })) });
  assert.throws(() => nvrGuardSchedule(week, "UTC", Date.UTC(2026, 9, 18, 23, 58)), NvrGuardError);
  const split = encode({ schedules: [{ ...slot, end_h: 12, end_m: 2 }, { ...slot, start_h: 12, start_m: 2 }] });
  assert.throws(() => nvrGuardSchedule(split, "UTC", noon), NvrGuardError);
  assert.throws(() => nvrGuardSchedule(week, "Europe/London", Date.UTC(2026, 9, 25, 0, 58)), NvrGuardError);
  assert.equal(nvrGuardSchedule(week, "UTC", Date.UTC(2026, 9, 18, 23, 50)), 0);
});

test("all weekdays use the calendar date independently of localized names", () => {
  for (let week = 0; week < 7; week++) {
    const value = encode({ schedules: [{ ...slot, week }] });
    assert.equal(nvrGuardSchedule(value, "UTC", noon + week * 86_400_000), 0);
  }
});

test("recovery does not extend the baseline's five-minute look-ahead", () => {
  const value = encode({ schedules: [{ ...slot, end_h: 12, end_m: 7 }, { ...slot, start_h: 12, start_m: 7, mode_id: 3 }] });
  assert.equal(nvrGuardSchedule(value, "UTC", noon), 0);
  assert.equal(nvrGuardSchedule(value, "UTC", noon + 120_000, true), 0);
  assert.throws(() => nvrGuardSchedule(value, "UTC", noon + 120_000), NvrGuardError);
});

test("spring-forward and fractional or exponent number spellings fail closed", () => {
  const week = encode({ schedules: Array.from({ length: 7 }, (_, day) => ({ ...slot, week: day })) });
  assert.throws(() => nvrGuardSchedule(week, "Europe/London", Date.UTC(2026, 2, 29, 0, 58)), NvrGuardError);
  for (const spelling of ["0.0", "0e0"]) {
    const text = JSON.stringify({ schedules: [slot] }).replace('"week":0', '"week":' + spelling);
    assert.throws(() => nvrGuardSchedule(Buffer.from(text).toString("base64"), "UTC", noon), NvrGuardError);
  }
});
