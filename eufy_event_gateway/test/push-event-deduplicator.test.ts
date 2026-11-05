/**
 * Verifies two-stage Eufy push delivery handling without network or device state.
 *
 * These cases protect the provider boundary from repeating entity pulses while
 * allowing a thumbnail that follows the first notification to reach storage.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { PushEventDeduplicator } from "../src/provider/push-event-deduplicator.js";

test("retains a picture from the second delivery without repeating state", () => {
  const deduplicator = new PushEventDeduplicator();

  assert.deepEqual(deduplicator.observe("camera", "event", 3103, false, 1), {
    handleState: true,
    retainPicture: false,
  });
  assert.deepEqual(deduplicator.observe("camera", "event", 3103, true, 2), {
    handleState: false,
    retainPicture: true,
  });
  assert.deepEqual(deduplicator.observe("camera", "event", 3103, true, 3), {
    handleState: false,
    retainPicture: false,
  });
});

test("treats an expired identity and unidentified deliveries as new events", () => {
  const deduplicator = new PushEventDeduplicator(10);

  deduplicator.observe("camera", "event", 3103, true, 1);
  assert.equal(deduplicator.observe("camera", "event", 3103, false, 12).handleState, true);
  assert.deepEqual(deduplicator.observe("camera", null, 3103, true, 13), {
    handleState: true,
    retainPicture: true,
  });
});

test("keeps different semantic event types independent when Eufy reuses an identity", () => {
  const deduplicator = new PushEventDeduplicator();

  assert.equal(deduplicator.observe("camera", "shared", 3111, false, 1).handleState, true);
  assert.equal(deduplicator.observe("camera", "shared", 3103, false, 2).handleState, true);
  assert.equal(deduplicator.observe("camera", "shared", 3103, false, 3).handleState, false);
});
