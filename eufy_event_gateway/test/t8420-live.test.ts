/**
 * Checks the exact T8420 trial admission and captured request shape.
 * Test-owned route facts and RSA placeholders contain no real account data.
 * The UDP session tests separately exercise negotiation, dispatch and cleanup.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { t8420ClearLiveRoute, t8420ClearLiveStart, type T8420LiveRoute } from "../src/stream/t8420-live.js";

const route: T8420LiveRoute = { enabled: true, model: "T8420", deviceType: 3, stationModel: "T8420",
  channel: 0, attached: false, purpose: "media", accountId: "synthetic-account" };

test("the T8420 trial excludes unknown identities, other topologies and non-media work", () => {
  assert.equal(t8420ClearLiveRoute(route), true);
  for (const changed of [{ enabled: false }, { enabled: undefined }, { model: "T8420X" }, { deviceType: undefined },
    { deviceType: 37 }, { stationModel: "T8030" }, { stationModel: undefined }, { channel: 1 }, { attached: true },
    { attached: undefined }, { purpose: "control" }, { purpose: "passive" }, { accountId: null }, { accountId: "" }]) {
    assert.equal(t8420ClearLiveRoute({ ...route, ...changed } as T8420LiveRoute), false, JSON.stringify(changed));
  }
});

test("the start has the observed request fields without a HomeBase child wrapper", () => {
  const value = JSON.parse(t8420ClearLiveStart("synthetic-account", "a".repeat(256), 123456));
  assert.deepEqual(value, { cmd: 1003, payload: { ClientOS: "IOS", key: "a".repeat(256), entrytype: 0,
    timestamp: 123456, msg_id: 2, streamtype: 2 }, account_id: "synthetic-account" });
  for (const args of [["", "a".repeat(256), 1], ["synthetic", "not-a-modulus", 1],
    ["synthetic", "a".repeat(256), -1], ["synthetic", "a".repeat(256), 1.5]] as const) {
    assert.throws(() => t8420ClearLiveStart(args[0], args[1], args[2]));
  }
});
