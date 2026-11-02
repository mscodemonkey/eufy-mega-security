/**
 * Checks history-name ownership and finite response handling with invented rows.
 * Fixtures own identities and names. No account, camera or real recording is read.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventNameHistoryReader, eventHistoryCursor, eventHistoryId, nextEventHistoryDate, projectEventNameHistorySummary, summarizeEventNameHistory } from "../src/stream/homebase-event-names.js";
import { supportsEventNameHistory, type MegaInventoryDevice } from "../src/provider/eufy-provider.js";

const serial = "invented-child", station = "invented-parent", date = "2026-10-31";
const history = { record_id: 123, device_sn: serial, station_sn: station, device_type: 7, start_time: `${date} 09:23:00`, time_zone: "+1000" };
const crop = { record_id: 123, crop_id: 456, person_id: 9, detection_type: 1 };
const person = { person_id: 9, group_id: 0, name: "Invented Person" };
const expected = { scope: "one_history_page", records: 1, personCrops: 1, recordsWithFamiliarNames: 1, unresolvedPersonCrops: 0 };

/** Build the observed table shape without any private source values. */
function page(records = [history], crops = [crop], people = [person]) {
  return { cmd: 10011, table: "history_record_info", transaction: "test", mIntRet: 0, data: [
    { table_name: "history_record_info", payload: records },
    { table_name: "record_crop_picture_info", payload: crops },
    { table_name: "person_basic_info", payload: people },
  ] };
}

test("one exact camera record joins its person while sibling and adjacent-day rows stay separate", () => {
  const value = page([history, { ...history, record_id: 124, device_sn: "sibling" },
    { ...history, record_id: 125, start_time: "2026-11-01 09:23:00" }], [crop,
    { ...crop, crop_id: 457, record_id: 124 }, { ...crop, crop_id: 458, record_id: 125 }]);
  assert.deepEqual(summarizeEventNameHistory(value, serial, station, date), expected);
  assert.doesNotMatch(JSON.stringify(expected), /Invented Person|invented-child|123/);
});

test("conflicting ownership, duplicate record IDs and ambiguous roster entries reject the page", () => {
  for (const value of [page([{ ...history, station_sn: "foreign" }]), page([{ ...history, device_type: 8 }]),
    page([history, { ...history, device_sn: "sibling" }]), page([history], [crop], [person, person]),
    page([history], [crop, crop]), page([{ ...history, record_id: Number.MAX_SAFE_INTEGER + 1 }])]) {
    assert.throws(() => summarizeEventNameHistory(value, serial, station, date), /invalid_response/);
  }
  const duplicated = page(); duplicated.data.push(duplicated.data[0]!);
  assert.throws(() => summarizeEventNameHistory(duplicated, serial, station, date), /invalid_response/);
});

test("missing names remain unresolved and the SDK stranger group never counts as familiar", () => {
  for (const people of [[], [{ ...person, name: "" }], [{ ...person, name: "bad\nname" }]]) {
    assert.deepEqual(summarizeEventNameHistory(page([history], [crop], people), serial, station, date),
      { ...expected, recordsWithFamiliarNames: 0, unresolvedPersonCrops: 1 });
  }
  assert.equal(summarizeEventNameHistory(page([history], [crop], [{ ...person, group_id: 255 }]), serial, station, date).recordsWithFamiliarNames, 0);
  assert.deepEqual(summarizeEventNameHistory(page([], [], []), serial, station, date),
    { scope: "one_history_page", records: 0, personCrops: 0, recordsWithFamiliarNames: 0, unresolvedPersonCrops: 0 });
});

test("opaque IDs keep their exact value and wire cursors cannot round beyond JSON precision", () => {
  assert.equal(eventHistoryId("9223372036854775807"), "9223372036854775807");
  assert.throws(() => eventHistoryCursor("9007199254740992"), /invalid_request/);
  for (const value of ["01", "-1", "1.0", "1e3", "9223372036854775808", Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => eventHistoryId(value), /invalid_request/);
  assert.equal(nextEventHistoryDate("2026-12-31"), "20270101");
  assert.equal(nextEventHistoryDate("2028-02-28"), "20280229");
});

test("the HTTP projection strips additions and rejects private text in count fields", () => {
  assert.deepEqual(projectEventNameHistorySummary({ ...expected, privateName: "PRIVATE-CANARY" }), expected);
  for (const value of [{ ...expected, records: "PRIVATE-CANARY" }, { ...expected, records: 51 },
    { ...expected, recordsWithFamiliarNames: 2 }, { ...expected, unresolvedPersonCrops: 2 }]) assert.throws(() => projectEventNameHistorySummary(value), /invalid_response/);
});

test("history admission does not extend standalone, HomeBase 2 or another device type", () => {
  const peer = { serial: station, model: "T8030", deviceType: 18, category: "eufy_security", adminUserId: "invented-owner" } as MegaInventoryDevice;
  const device = { serial, model: "T8210", deviceType: 7, category: "eufy_security", parentSerial: station, channel: 2, adminUserId: "invented-owner" };
  assert.equal(supportsEventNameHistory(device, { peer, homeBaseAttached: true }, true), true);
  for (const changed of [{ ...device, deviceType: 5 }, { ...device, model: "T8214" },
    { ...device, parentSerial: "other" }, { ...device, adminUserId: "other" }, { ...device, channel: 255 }]) {
    assert.equal(supportsEventNameHistory(changed, { peer, homeBaseAttached: true }, true), false);
  }
  assert.equal(supportsEventNameHistory(device, { peer: { ...peer, model: "T8010" }, homeBaseAttached: true }, true), false);
  assert.equal(supportsEventNameHistory(device, { peer, homeBaseAttached: false }, true), false);
  assert.equal(supportsEventNameHistory(device, { peer, homeBaseAttached: true }, false), false);
});

test("only the exact transaction and station channel settle a read, which never retries", async () => {
  let transaction = "", calls = 0;
  const reader = new EventNameHistoryReader({ serial, stationSerial: station,
    query: id => { transaction = id; calls++; }, decodeReply: payload => payload });
  const pending = reader.read(date);
  const header = Buffer.alloc(16); header.writeUInt16LE(1306, 4); header[12] = 255;
  assert.equal(reader.handleFrame(header, Buffer.from(JSON.stringify(page()))), false);
  header[12] = 2;
  assert.equal(reader.handleFrame(header, Buffer.from(JSON.stringify({ ...page(), transaction }))), false);
  header[12] = 255;
  assert.equal(reader.handleFrame(header, Buffer.from(JSON.stringify({ ...page(), transaction }) + "\0\0")), true);
  assert.deepEqual(await pending, expected); assert.equal(calls, 1);
  await assert.rejects(reader.read(date), /unavailable/);
  assert.equal(calls, 1); reader.close();
});

for (const mode of ["abort", "close", "timeout", "authentication"] as const) test(`a failed ${mode} read releases its pending operation`, async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const controller = new AbortController();
  const reader = new EventNameHistoryReader({ serial, stationSerial: station, query: () => { calls++; }, decodeReply: () => null });
  const pending = assert.rejects(reader.read(date, "0", controller.signal), /cancelled|timeout|invalid_response/);
  if (mode === "abort") controller.abort();
  else if (mode === "close") reader.close();
  else if (mode === "timeout") context.mock.timers.tick(20_001);
  else { const header = Buffer.alloc(16); header.writeUInt16LE(1306, 4); header[12] = 255; reader.handleFrame(header, Buffer.alloc(1)); }
  await pending; assert.equal(calls, 1); reader.close();
});
