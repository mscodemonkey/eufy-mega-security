/**
 * Verifies that delayed recognition enriches an owned detection without a pulse.
 * Each state fixture owns its timers and private source identity. No transport,
 * person roster or event-history lookup participates in these tests.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { GatewayEvent } from "../src/domain/types.js";

const camera = { serial: "synthetic-camera", name: "Fixture camera", model: "T8210",
  stationSerial: "synthetic-station", streamSupported: false, doorbellSupported: true };

test("a late name preserves the original event and does not restart an expired detection", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const state = new GatewayState(1_000), events: GatewayEvent[] = [];
  state.registerCamera(camera); state.on("event", event => events.push(event));
  try {
    state.recordPerson(camera.serial, true, null, new Date("2026-01-01T00:00:00Z"), "private-visit");
    const original = state.getCamera(camera.serial).lastDetection!;
    context.mock.timers.tick(1_000);
    state.enrichPersonName(camera.serial, "private-visit", "Fixture Person");
    const updated = state.getCamera(camera.serial);
    assert.deepEqual(updated.lastDetection, { ...original, personName: "Fixture Person", recognized: true });
    assert.equal(updated.personDetected, false); assert.equal(updated.motionDetected, false);
    assert.equal(events.filter(event => event.type === "detection").length, 1);
    assert.doesNotMatch(JSON.stringify([updated, events]), /private-visit|personEventIdentity/);
  } finally { state.close(); }
});

test("enrichment before expiry does not extend the original detection hold", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const state = new GatewayState(1_000); state.registerCamera(camera);
  try {
    state.recordPerson(camera.serial, true, null, new Date(), "visit");
    context.mock.timers.tick(500); state.enrichPersonName(camera.serial, "visit", "Fixture Person");
    context.mock.timers.tick(500); assert.equal(state.getCamera(camera.serial).personDetected, false);
  } finally { state.close(); }
});

for (const reason of ["new-visit", "wrong-identity", "unidentified", "changed-binding", "other-kind", "generic-name", "already-named"] as const) {
  test(`name enrichment refuses ${reason}`, () => {
    const state = new GatewayState(); state.registerCamera(camera);
    try {
      state.recordPerson(camera.serial, true, reason === "already-named" ? "Original Person" : null,
        new Date(), reason === "unidentified" ? null : "visit");
      if (reason === "new-visit") state.recordPerson(camera.serial, true, null, new Date(), "new-visit");
      if (reason === "changed-binding") state.registerCamera({ ...camera, stationSerial: "replacement-station" });
      if (reason === "other-kind") state.recordDetection(camera.serial, "vehicle", true);
      const before = state.getCamera(camera.serial);
      state.enrichPersonName(camera.serial, reason === "wrong-identity" ? "other" : "visit",
        reason === "generic-name" ? "Unknown person" : "Fixture Person");
      assert.deepEqual(state.getCamera(camera.serial), before);
    } finally { state.close(); }
  });
}
