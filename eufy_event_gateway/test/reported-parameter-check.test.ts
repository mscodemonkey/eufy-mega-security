/**
 * Exercises the diagnostic's closed data boundary using synthetic parameters.
 * Tests own every response and protect the browser and logging consumers from
 * raw fields, ambiguous observations and unsupported device-freshness claims.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ParameterCheckError, parameterCheckLog, projectReportedParameters, validateParameterSummary } from "../src/provider/reported-parameter-check.js";

for (const model of ["T8410", "T8417", "T8030"] as const) {
  test(`${model} drops private fields and projects only fixed candidates`, () => {
    const result = projectReportedParameters(model, { private: "SENTINEL", params: [
      { param_type: 1035, param_value: "0", update_time: "SENTINEL" }, { param_type: "2001", param_value: 1 },
      { param_type: 6250, param_value: true }, { param_type: 6271, param_value: "01" },
      { param_type: 1235, param_value: "26" }, { param_type: 9999, param_value: "SENTINEL" },
    ] });
    assert.equal(validateParameterSummary(result).model, model);
    assert.doesNotMatch(JSON.stringify(result), /SENTINEL|update_time|9999|26/);
    assert.equal(result.observations[model === "T8030" ? "1235" : "1035"], model === "T8030" ? "valid" : "zero");
    const log = parameterCheckLog(result);
    assert.doesNotMatch(log, /zero|one|SENTINEL/);
    assert.match(log, /outcome=read/);
  });
}

test("bounds and normalises candidate rows before detecting conflicts", () => {
  for (const malformed of [null, [], {}, { params: null }, { params: Array(4097).fill(null) }]) assert.throws(() => projectReportedParameters("T8410", malformed), ParameterCheckError);
  const result = projectReportedParameters("T8417", { params: [null, { param_type: {}, param_value: "SENTINEL" },
    { param_type: "01035", param_value: 1 }, { param_type: 1035, param_value: 1 }, { param_type: "1035", param_value: 1 },
    { param_type: 2001, param_value: "1" }, { param_type: 2001, param_value: 0 }] });
  assert.deepEqual(result.observations, { 1035: "conflicting", 2001: "conflicting", 6250: "missing", 6271: "missing" });
  assert.equal(projectReportedParameters("T8410", { params: Array(4096).fill(null) }).observations[1035], "missing");
});

test("does not coerce binary or volume scalars or use child volume rows", () => {
  for (const value of [true, false, null, {}, [], "", " 1", "1.0", "01", "1e0", 1.5, 2, -1]) {
    assert.equal(projectReportedParameters("T8410", { params: [{ param_type: 1035, param_value: value }] }).observations[1035], "invalid");
  }
  for (const value of [0, 27, -1, 1.1, "01", "1.0", {}, true]) assert.equal(projectReportedParameters("T8030", { params: [{ param_type: 1235, param_value: value }] }).observations[1235], "invalid");
  for (const value of [1, "1", 26, "26"]) assert.equal(projectReportedParameters("T8030", { params: [{ param_type: 1235, param_value: value }] }).observations[1235], "valid");
  for (const key of ["channel", "dev_type"]) {
    assert.equal(projectReportedParameters("T8030", { params: [{ param_type: 1235, param_value: 2, [key]: 1 }] }).observations[1235], "missing");
  }
  assert.equal(projectReportedParameters("T8030", { params: [{ param_type: 1235, param_value: 2, channel: 1 }, { param_type: 1235, param_value: 3, channel: 255 }] }).observations[1235], "valid");
});

test("HTTP DTO validation refuses all additional, mixed-profile and malicious fields", () => {
  const good = projectReportedParameters("T8410", { params: [] });
  for (const value of [null, {}, { ...good, raw: "SENTINEL" }, { ...good, model: "T8410-alias" },
    { ...good, profile: "privacy_candidates" }, { ...good, observations: { ...good.observations, private: "SENTINEL" } },
    { ...good, observations: { 1035: "SENTINEL", 2001: "missing" } }, { ...good, observations: { 1035: "valid", 2001: "missing" } },
    { ...good, observations: { 1035: "recent", 2001: "missing" } }]) {
    assert.throws(() => validateParameterSummary(value), ParameterCheckError);
    assert.throws(() => parameterCheckLog(value), ParameterCheckError);
  }
});

test("T8910 reports only cached timestamp age classes in either established unit", () => {
  const now = 1_800_000_000_000;
  for (const value of [now / 1_000, String(now / 1_000), now, String(now)]) {
    const result = projectReportedParameters("T8910", { device_sn: "PRIVATE_SENTINEL", params: [
      { param_type: 1605, param_value: value, update_time: "PRIVATE_SENTINEL" },
      { param_type: 1101, param_value: 90 },
    ] }, now);
    assert.deepEqual(result, { model: "T8910", profile: "motion_time_candidate", observations: { 1605: "recent" } });
    assert.deepEqual(validateParameterSummary(result), result);
    assert.equal(parameterCheckLog(result), "model=T8910 outcome=read 1605=recent");
    assert.doesNotMatch(JSON.stringify(result), /1800000000|PRIVATE_SENTINEL|update_time|1101|device_sn/);
  }
});

test("T8910 distinguishes absent, unset, old and future cache values without inferring motion", () => {
  const now = 1_800_000_000_000;
  const classify = (value: unknown) => projectReportedParameters("T8910", { params: [{ param_type: 1605, param_value: value }] }, now).observations[1605];
  assert.equal(projectReportedParameters("T8910", { params: [] }, now).observations[1605], "missing");
  for (const value of [0, "0"]) assert.equal(classify(value), "unset");
  assert.equal(classify(now - 60_000), "recent");
  assert.equal(classify(now - 60_001), "older");
  assert.equal(classify(now + 2_000), "recent");
  assert.equal(classify(now + 2_001), "future");
  for (const value of [null, true, {}, [], "", "01", "1e9", " 1800000000", 1.5, -1, NaN, Infinity, 1_000, 4_102_444_800_000]) assert.equal(classify(value), "invalid");
  const duplicate = projectReportedParameters("T8910", { params: [
    { param_type: 1605, param_value: now }, { param_type: "1605", param_value: now },
  ] }, now);
  assert.equal(duplicate.observations[1605], "conflicting");
  const good = projectReportedParameters("T8910", { params: [] }, now);
  for (const value of ["one", "zero", "valid", "PRIVATE_SENTINEL"]) {
    assert.throws(() => validateParameterSummary({ ...good, observations: { 1605: value } }), ParameterCheckError);
  }
  for (const clock of [NaN, Infinity, -1]) assert.throws(() => projectReportedParameters("T8910", { params: [] }, clock), ParameterCheckError);
});
