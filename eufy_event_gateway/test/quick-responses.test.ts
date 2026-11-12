/**
 * Guards saved-reply selection and exact topology admission with synthetic data.
 * The parser owns no transport. Invalid lists cannot select another recording
 * or expose storage locations to HTTP and HA.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isQuickResponseRoute, parseQuickResponseList, validQuickResponseId } from "../src/provider/quick-responses.js";

const route = { model: "T8210", deviceType: 7, homeBaseAttached: true, selfPeer: false,
  peerModel: "T8030", peerDeviceType: 18, channel: 4 };

test("custom replies retain their IDs and discard storage locations", () => {
  const replies = parseQuickResponseList({ voice_list: [{ voice_id: 100, voice_name: "Synthetic reply", voice_path: "/private/audio" }] });
  assert.equal(replies.length, 4);
  assert.deepEqual(replies[3], { id: 100, name: "Synthetic reply", custom: true });
  assert.doesNotMatch(JSON.stringify(replies), /private|voice_path/);
  for (const id of [true, "100", 0, 4, 99, 103, NaN, 100.5]) assert.equal(validQuickResponseId(id), false);
});

test("malformed, duplicate and oversized custom lists fail closed", () => {
  for (const voice_list of [undefined, null, {}, [null], [{ voice_id: 1, voice_name: "Wrong slot" }],
    [{ voice_id: 100, voice_name: "" }], [{ voice_id: 100, voice_name: "Bad\nlabel" }],
    [{ voice_id: 100, voice_name: "A" }, { voice_id: 100, voice_name: "B" }], Array(4).fill({ voice_id: 100, voice_name: "A" })]) {
    assert.throws(() => parseQuickResponseList({ voice_list }));
  }
  assert.equal(parseQuickResponseList({ voice_list: [] }).length, 3);
});

test("only the reviewed models, types, HomeBase and child channels are admitted", () => {
  assert.equal(isQuickResponseRoute(route), true);
  assert.equal(isQuickResponseRoute({ ...route, model: "T8214", deviceType: 94 }), true);
  for (const change of [{ model: "T8210C" }, { deviceType: 94 }, { homeBaseAttached: false }, { selfPeer: true },
    { peerModel: "T8010" }, { peerDeviceType: 0 }, { channel: 255 }, { channel: null }, { channel: 4.5 }]) {
    assert.equal(isQuickResponseRoute({ ...route, ...change }), false);
  }
});
