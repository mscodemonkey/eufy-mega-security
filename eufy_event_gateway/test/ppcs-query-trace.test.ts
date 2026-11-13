/**
 * Checks that read-query observations stay finite and omit private context.
 * Tests own all synthetic inputs and never open a socket or issue a command.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PpcsQueryTrace, ppcsQueryEvidenceSummary } from "../src/stream/ppcs-query-trace.js";

test("query evidence separates transport receipt, selected notifications and command matching", () => {
  const trace = new PpcsQueryTrace(3);
  trace.acknowledge(0); assert.equal(trace.snapshot().acknowledged, false);
  trace.sent(0); trace.acknowledge(1); assert.equal(trace.snapshot().acknowledged, false);
  trace.acknowledge(0);
  trace.notification(4, true, true); trace.notification(3, false, false);
  trace.notification(3, true, false); trace.notification(3, true, true);
  const snapshot = trace.snapshot();
  assert.deepEqual(snapshot, { sent: true, acknowledged: true, notifications: 4,
    selectedNotifications: 3, authenticatedNotifications: 2, matchingNotifications: 1 });
  trace.notification(3, true, true); assert.equal(snapshot.notifications, 4);
  assert.match(ppcsQueryEvidenceSummary(snapshot), /query_sent=true query_acked=true notify_frames=4/);
  assert.equal(ppcsQueryEvidenceSummary(undefined), "");
  const unexpected = { ...snapshot, notifications: Infinity, privateValue: "do-not-log" };
  assert.doesNotMatch(ppcsQueryEvidenceSummary(unexpected), /Infinity|do-not-log/);
  for (let index = 0; index < 70_000; index++) trace.notification(3, true, true);
  assert.equal(trace.snapshot().notifications, 65_535);
});

test("decode counters retain only selected fixed outcomes in immutable private-safe summaries", () => {
  const trace = new PpcsQueryTrace(2);
  trace.notification(3, false, false, "authentication_failed");
  trace.notification(2, false, false, "authenticated_unreadable");
  const snapshot = trace.snapshot();
  trace.notification(2, false, false, "authenticated_unreadable");
  assert.deepEqual(snapshot.decodeOutcomes, { authenticated_unreadable: 1 });
  const summary = ppcsQueryEvidenceSummary({ ...snapshot,
    decodeOutcomes: { ...snapshot.decodeOutcomes, legacy: Infinity, ...{ privatePayload: "do-not-log" } } });
  assert.match(summary, /notify_decode_authenticated_unreadable=1/);
  assert.match(summary, /notify_decode_authentication_failed=0/);
  assert.doesNotMatch(summary, /Infinity|privatePayload|do-not-log/);
});
