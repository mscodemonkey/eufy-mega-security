/**
 * Validates raw T8417 field observations with synthetic, immutable inventory.
 * Tests own clocks and malformed objects. Only aggregate vocabulary is allowed
 * to cross the tracker boundary, and no camera or account is contacted.
 */
import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { T8417ReadShapeTracker } from "../src/provider/t8417-read-shape.js";

function camera(serial = "private-synthetic", changes: Record<string, unknown> = {}) {
  return { device_sn: serial, device_model: "T8417", device_type: 105, category: "eufy_security", ...changes };
}

function line(values = "p1035=missing p2001=missing p6250=missing p6271=missing", count = 1, topology = "direct") {
  return `model=T8417 ${values} topology=${topology} devices=${count}`;
}

test("exact identities, duplicate serials and own descriptors determine qualification", () => {
  for (const changes of [{ device_model: "T8417A" }, { device_model: " T8417" }, { device_type: 104 }, { category: "eufy_care" }, { device_sn: "" }]) {
    assert.deepEqual(new T8417ReadShapeTracker().observe([camera("private", changes)], 1, 0, true), []);
  }
  assert.deepEqual(new T8417ReadShapeTracker().observe([camera("private", { device_type: "105" })], 1, 0, true), [line()]);
  assert.deepEqual(new T8417ReadShapeTracker().observe([camera(), camera("private-synthetic", { device_model: "other" })], 1, 0, true), []);
  assert.deepEqual(new T8417ReadShapeTracker().observe([Object.create(camera())], 1, 0, true), []);
  let invoked = 0;
  const accessor = Object.defineProperty(camera(), "device_model", { get() { invoked++; throw Error("private"); } });
  assert.deepEqual(new T8417ReadShapeTracker().observe([accessor], 1, 0, true), []); assert.equal(invoked, 0);
  assert.deepEqual(new T8417ReadShapeTracker().observe([new Proxy({}, { getPrototypeOf() { throw Error("private"); } })], 1, 0, true), []);
});

const fields = [1035, 2001, 6250, 6271] as const;
const cases: readonly [unknown, string][] = [[0, "0"], [1, "1"], ["0", "0"], ["1", "1"], [2, "invalid"], ["01", "invalid"],
  [1.5, "invalid"], ["1.0", "invalid"], [true, "invalid"], [null, "invalid"], [{}, "invalid"], [-0, "invalid"], [undefined, "invalid"]];
for (const field of fields) for (const [value, expected] of cases) test(`field ${field} token for ${inspect(value)}`, () => {
  const values = fields.map(type => `p${type}=${type === field ? field === 6271 && value === 2 ? "unknown" : expected : "missing"}`).join(" ");
  const input = camera("private", { params: [{ param_type: field, param_value: value }] });
  assert.deepEqual(new T8417ReadShapeTracker().observe([input], 1, 0, true), [line(values)]);
});

for (const [value, expected] of [["2", "unknown"], [9_999_999_999, "unknown"], ["9999999999", "unknown"],
  [10_000_000_000, "invalid"], ["10000000000", "invalid"], [-1, "invalid"], [1.5, "invalid"]] as const) {
  test(`6271 buckets ${value} without echoing it`, () => {
    assert.deepEqual(new T8417ReadShapeTracker().observe([camera("private", { params: [{ param_type: "6271", param_value: value }] })], 1, 0, true),
      [line(`p1035=missing p2001=missing p6250=missing p6271=${expected}`)]);
  });
}

test("missing, duplicate, inherited and accessor parameters do not create defaults", () => {
  const tracker = new T8417ReadShapeTracker();
  assert.deepEqual(tracker.observe([camera("private", { params: {} })], 1, 0, true), [line()]);
  assert.deepEqual(tracker.observe([camera("private", { params: [{ param_type: 1035, param_value: 1 }, { param_type: "1035", param_value: 0 }] })], 1, 0, true),
    [line("p1035=duplicate p2001=missing p6250=missing p6271=missing")]);
  let invoked = 0;
  const row = Object.defineProperty({ param_type: 1035 }, "param_value", { get() { invoked++; return 1; } });
  assert.deepEqual(tracker.observe([camera("__proto__", { params: [row, Object.create({ param_type: 2001, param_value: 1 })] })], 1, 0, true),
    [line("p1035=invalid p2001=missing p6250=missing p6271=missing")]);
  assert.equal(invoked, 0);
});

for (const [changes, expected] of [[{}, "direct"], [{ parent_sn: "private" }, "direct"], [{ parent_sn: "other" }, "attached"],
  [{ parent_sn: "", station_sn: "other" }, "attached"], [{ parent_sn: null, station_sn: "private" }, "direct"],
  [{ parent_sn: 1, station_sn: "private" }, "unknown"], [{ station_sn: false }, "unknown"], [{ parent_sn: " " }, "attached"]] as const) {
  test(`topology descriptor ${JSON.stringify(changes)}`, () => {
    assert.deepEqual(new T8417ReadShapeTracker().observe([camera("private", changes)], 1, 0, true), [line(undefined, 1, expected)]);
  });
}

test("groups track membership changes, heartbeat and vanished devices", () => {
  const tracker = new T8417ReadShapeTracker(), one = camera("one"), two = camera("two");
  assert.deepEqual(tracker.observe([one, two], 1, 0, true), [line(undefined, 2)]);
  assert.deepEqual(tracker.observe([one, two], 1, 899_999, false), []);
  assert.deepEqual(tracker.observe([one, two], 1, 900_000, false), [line(undefined, 2)]);
  const changed = camera("two", { parent_sn: "other" });
  assert.deepEqual(tracker.observe([one, changed], 1, 900_001, false), [line(), line(undefined, 1, "attached")]);
  assert.deepEqual(tracker.observe([one], 1, 900_002, false), []);
  assert.deepEqual(tracker.observe([camera("other", { device_model: "other" })], 1, 900_003, false), []);
  assert.deepEqual(tracker.observe([one], 1, 900_004, false), [line()]);
});

test("invalid observations preserve state, reset and generation retirement clear it", () => {
  const tracker = new T8417ReadShapeTracker(), input = Object.freeze([Object.freeze(camera())]);
  assert.deepEqual(tracker.observe(input, 2, 100, true), [line()]);
  for (const [raw, generation, now] of [[null, 3, 100], [input, 1, 100], [input, 2.5, 100], [input, 2, NaN], [input, 2, -1], [Array(1025), 2, 100]] as const) {
    assert.deepEqual(tracker.observe(raw, generation, now, false), []);
  }
  assert.deepEqual(tracker.observe(input, 2, 0, false), []);
  assert.deepEqual(tracker.observe([], 2, 100, false), []);
  assert.deepEqual(tracker.observe(input, 2, 101, false), []);
  assert.deepEqual(tracker.observe(input, 3, 102, false), [line()]);
  tracker.reset(); assert.deepEqual(tracker.observe(input, 3, 103, false), [line()]);
  tracker.observe([], 3, 104, true); assert.deepEqual(tracker.observe(input, 3, 105, false), [line()]);
  assert.equal(JSON.stringify(tracker).includes("private-synthetic"), false);
  assert.equal(inspect(tracker).includes("private-synthetic"), false);
});

test("array bounds are exact and oversized params cannot echo values", () => {
  const tracker = new T8417ReadShapeTracker();
  assert.equal(tracker.observe(Array.from({ length: 1024 }, (_, i) => camera(String(i))), 1, 0, true)[0], line(undefined, 1024));
  assert.deepEqual(tracker.observe(Array.from({ length: 1025 }, (_, i) => camera(String(i))), 1, 0, true), []);
  const params = Array.from({ length: 1024 }, () => ({ param_type: 9, param_value: "private" }));
  assert.deepEqual(tracker.observe([camera("private", { params })], 1, 1, true), [line()]);
  assert.deepEqual(tracker.observe([camera("private", { params: [...params, {}] })], 1, 2, true),
    [line("p1035=invalid p2001=invalid p6250=invalid p6271=invalid")]);
});

test("losing a member re-emits its surviving group count and group heartbeat resets every member", () => {
  const tracker = new T8417ReadShapeTracker(), one = camera("one"), two = camera("two");
  assert.deepEqual(tracker.observe([one], 1, 0, true), [line()]);
  assert.deepEqual(tracker.observe([one, two], 1, 100, false), [line(undefined, 2)]);
  assert.deepEqual(tracker.observe([one, two], 1, 900_000, false), []);
  assert.deepEqual(tracker.observe([one, two], 1, 900_100, false), [line(undefined, 2)]);
  assert.deepEqual(tracker.observe([one], 1, 900_101, false), [line()]);
});

test("array element accessors are not invoked and failed proxy observations commit nothing", () => {
  const tracker = new T8417ReadShapeTracker(); let invoked = 0;
  const input = Object.defineProperty([camera()], "0", { get() { invoked++; return camera(); } });
  assert.deepEqual(tracker.observe(input, 1, 0, true), []); assert.equal(invoked, 0);
  const good = [camera()]; tracker.observe(good, 1, 0, true);
  const bad = new Proxy({}, { getOwnPropertyDescriptor() { throw Error("private"); } });
  assert.deepEqual(tracker.observe([camera(), bad], 2, 900_000, false), []);
  assert.deepEqual(tracker.observe(good, 1, 1, false), []);
});
