/**
 * Check C31 talkback account admission against synthetic inventory membership.
 * The provider separately qualifies model, route, feature opt-in and speaker state.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { supportsC31LiveTalkbackAccount } from "../src/provider/eufy-provider.js";

test("C31 talkback accepts only its owner or signed-in type-1 member", () => {
  const device = { adminUserId: "owner", memberType: 1, memberUserId: "member" };
  assert.equal(supportsC31LiveTalkbackAccount(device, id => id === "owner"), true);
  assert.equal(supportsC31LiveTalkbackAccount(device, id => id === "member"), true);
  assert.equal(supportsC31LiveTalkbackAccount(device, id => id === "other"), false);
  assert.equal(supportsC31LiveTalkbackAccount(device, () => false), false);
  for (const changes of [{ memberType: null }, { memberType: 2 }, { memberType: 0 }, { memberUserId: null }, { adminUserId: null }]) {
    assert.equal(supportsC31LiveTalkbackAccount({ ...device, ...changes }, id => id === "member"), false);
  }
});
