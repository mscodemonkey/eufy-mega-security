/**
 * Checks the source-derived S100 contract using synthetic routes. Tests own
 * their buffers and never open a transport or establish hardware success.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildS100SirenCommand, type S100SirenRoute } from "../src/stream/s100-siren-command.js";

const route: S100SirenRoute = Object.freeze({ model: "T84A1", deviceType: 151, peerModel: "T84A1",
  selfPeer: true, homeBaseAttached: false, channel: 0 });

test("S100 primary command matches native binary geometry and owns its bytes", () => {
  for (const [enabled, hex] of [[true, "040000001e000000"], [false, "0400000000000000"]] as const) {
    const frame = buildS100SirenCommand(route, enabled);
    assert.equal(frame.command, 1201);
    assert.equal(frame.wireChannel, 255);
    assert.equal(Buffer.from(frame.body).toString("hex"), hex);
    assert.equal(frame.body.byteLength, 8);
    assert.equal(frame.body.byteOffset, 0);
    assert.equal(frame.body.buffer.byteLength, 8);
  }
  const first = buildS100SirenCommand(route, true), second = buildS100SirenCommand(route, true);
  assert.notEqual(first, second);
  assert.notEqual(first.body, second.body);
  assert.notEqual(first.body.buffer, second.body.buffer);
  first.body.fill(255);
  assert.equal(Buffer.from(second.body).toString("hex"), "040000001e000000");
  assert.equal(route.channel, 0);
  assert.equal(buildS100SirenCommand({ ...route, channel: -0 }, true).wireChannel, 255);
  assert.equal(buildS100SirenCommand(Object.assign(Object.create(null), route), true).wireChannel, 255);
  const extra = buildS100SirenCommand as unknown as (r: S100SirenRoute, e: boolean, duration: number) => ReturnType<typeof buildS100SirenCommand>;
  assert.equal(Buffer.from(extra(route, true, 999).body).toString("hex"), "040000001e000000");
});

test("S100 rejects lookalikes, attached cameras and coerced route fields", () => {
  const invalid: Record<string, readonly unknown[]> = {
    model: ["T84A1X", "t84a1", "T84A1 ", "T8423", 151, new String("T84A1")],
    deviceType: [150, "151", 151.5, NaN, null, undefined], peerModel: ["", "T8423", 151],
    selfPeer: [false, "true", 1, undefined], homeBaseAttached: [true, 0, undefined],
    channel: [1, 255, -1, 0.5, NaN, null, "0", undefined],
  };
  for (const [field, values] of Object.entries(invalid)) {
    for (const value of values) {
      const expected = typeof value === typeof route[field as keyof S100SirenRoute] ? RangeError : TypeError;
      assert.throws(() => buildS100SirenCommand({ ...route, [field]: value } as S100SirenRoute, true), expected);
    }
  }
});

test("S100 rejects unsafe shapes and states without invoking accessors or proxies", () => {
  const missing: Record<string, unknown> = { ...route };
  delete missing.channel;
  const accessor = Object.defineProperty({ ...route }, "channel", { get() { throw new Error("getter invoked"); } });
  const proxy = new Proxy({ ...route }, { getPrototypeOf() { throw new Error("proxy invoked"); } });
  for (const value of [null, undefined, [], "private-marker", missing, { ...route, extra: 1 }, accessor, proxy,
    Object.defineProperty({ ...route }, "channel", { enumerable: false }), { ...route, [Symbol("extra")]: true }]) {
    assert.throws(() => buildS100SirenCommand(value as S100SirenRoute, true), TypeError);
  }
  for (const value of [1, 0, "private-marker", null, undefined, {}, new Boolean(true), { valueOf() { return true; } }]) {
    assert.throws(() => buildS100SirenCommand(route, value as boolean), (error: unknown) =>
      error instanceof TypeError && error.message === "Invalid S100 siren state");
  }
  assert.throws(() => buildS100SirenCommand({ ...route, model: "private-marker" }, true), (error: unknown) =>
    error instanceof RangeError && error.message === "Unsupported S100 route");
});
