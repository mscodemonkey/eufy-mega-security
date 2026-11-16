/**
 * Exercise receive-only HB2 admission without credentials or appliance traffic.
 * Fixtures own the inventory and media-channel decisions. The provider exposes
 * a default-off trial, while the transport retains clear AAC validation and
 * exclusive ownership of the original video session.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { supportsCameraLiveAudio, supportsExperimentalHb2LiveAudio } from "../src/provider/eufy-provider.js";
import type { MegaInventoryDevice } from "../src/provider/eufy-provider.js";
import { acceptsSoloCamAudio } from "../src/stream/first-party-ppcs.js";

const peer = { serial: "fixture-base", model: "T8010", deviceType: 0, adminUserId: "fixture-admin" } as MegaInventoryDevice;
const route = { homeBaseAttached: true, peer };

for (const [model, deviceType] of [["T8210", 7], ["T8140-Z", 14]] as const) {
  test(`${model} receive-only trial requires a ready exact HB2 route and matching ownership`, () => {
    const device = { serial: "fixture-child", model, deviceType, channel: 3, adminUserId: "fixture-admin" };
    assert.equal(supportsExperimentalHb2LiveAudio(device, route, true), true);
    assert.equal(supportsCameraLiveAudio(device, route, true), true);
    assert.equal(supportsExperimentalHb2LiveAudio(device, route, false), false);
    assert.equal(supportsExperimentalHb2LiveAudio(device, null, true), false);
    for (const changed of [{ model: model + "X" }, { deviceType: -1 }, { channel: -1 }, { channel: 32 }, { channel: 1.5 }, { channel: null }, { adminUserId: null }]) {
      assert.equal(supportsExperimentalHb2LiveAudio({ ...device, ...changed }, route, true), false);
    }
    for (const changed of [{ model: "T8030" }, { deviceType: 18 }, { adminUserId: "other-admin" }, { adminUserId: null }]) {
      assert.equal(supportsExperimentalHb2LiveAudio(device, { ...route, peer: { ...peer, ...changed } }, true), false);
    }
    assert.equal(supportsExperimentalHb2LiveAudio(device, { ...route, homeBaseAttached: false }, true), false);
  });

  test(`${model} audio stays on its requested media channel and never enters control sessions`, () => {
    assert.equal(acceptsSoloCamAudio(model, true, 3, 3, "media", deviceType, "T8010", 0), true);
    for (const purpose of ["control", "passive", "unexpected"]) {
      assert.equal(acceptsSoloCamAudio(model, true, 3, 3, purpose, deviceType, "T8010", 0), false);
    }
    assert.equal(acceptsSoloCamAudio(model, true, 3, 4, "media", deviceType, "T8010", 0), false);
    assert.equal(acceptsSoloCamAudio(model, true, 32, 32, "media", deviceType, "T8010", 0), false);
    assert.equal(acceptsSoloCamAudio(model, true, 3, 3, "media", deviceType, "T8010", 18), false);
    assert.equal(acceptsSoloCamAudio(model, false, 0, 0, "media", deviceType, "T8010", 0), false);
    assert.equal(acceptsSoloCamAudio(model, true, 3, 3, "media", deviceType + 1, "T8010", 0), false);
  });
}
