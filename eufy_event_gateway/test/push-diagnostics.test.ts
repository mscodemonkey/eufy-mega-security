/**
 * Protects the safe diagnostic projection of incoming push events.
 *
 * The tests ensure useful presence/type flags survive while raw notification
 * bodies, tokens, URLs, and unrelated account fields do not reach diagnostics.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { GatewayState } from "../src/domain/gateway-state.js";
import type { PushDiagnostic } from "../src/domain/types.js";
import { describeCameraCapabilities } from "../src/provider/device-capabilities-core.js";

test("push diagnostics are bounded to the latest 50 whitelisted records", () => {
  const state = new GatewayState();
  for (let index = 0; index < 55; index += 1) {
    const diagnostic: PushDiagnostic = {
      receivedAt: new Date(index * 1_000).toISOString(),
      cameraSerial: `camera-${index}`,
      cameraName: `Camera ${index}`,
      type: 1,
      eventType: 2,
      messageType: 3,
      notificationStyle: 1,
      personName: null,
      hasPersonName: false,
      hasPictureUrl: true,
      hasFilePath: false,
      hasFetchId: false,
      hasSenseId: false,
    };
    state.recordPushDiagnostic(diagnostic);
  }

  const diagnostics = state.listPushDiagnostics();
  assert.equal(diagnostics.length, 50);
  assert.equal(diagnostics[0]?.cameraSerial, "camera-5");
  assert.equal(diagnostics[49]?.cameraSerial, "camera-54");
});

test("event delivery diagnostics count transport outcomes without payloads", () => {
  const state = new GatewayState();
  state.recordEventReceiverState("starting");
  state.recordEventReceiverState("connected");
  state.recordEventDelivery("parsed", 0);
  state.recordEventDelivery("unparsed", 60_000);
  state.recordEventDelivery("empty", 120_000);
  state.recordEventReceiverState("disconnected");

  assert.deepEqual(state.eventDeliveryDiagnostic(180_000), {
    receiverState: "disconnected",
    connectionCount: 1,
    disconnectionCount: 1,
    deliveryCount: 3,
    parsedCount: 1,
    emptyCount: 1,
    unparsedCount: 1,
    lastDeliveryAge: "one_to_five_minutes",
  });
});

test("catalogue evidence removes local identities while retaining test facts", () => {
  const state = new GatewayState();
  state.updateInventoryDiagnostics([{
    serial: "PRIVATE-SERIAL",
    name: "Private camera name",
    model: "T8140-R",
    sources: ["mega"],
    upstreamIsCamera: false,
    acceptedAsCamera: true,
    megaDeviceType: 14,
    category: "eufy_security",
  }]);
  state.updateCameraCapabilities([describeCameraCapabilities({
    serial: "PRIVATE-SERIAL",
    model: "T8140-R",
    category: "eufy_security",
    deviceType: 14,
    paramTypes: [1101],
  }, { doorbellSupported: false, streamSupported: true })]);
  state.recordPushDiagnostic({
    receivedAt: "2026-09-21T12:00:00.000Z",
    cameraSerial: "PRIVATE-SERIAL",
    cameraName: "Private camera name",
    type: 1,
    eventType: 3102,
    messageType: 0,
    notificationStyle: 1,
    personName: "Private person name",
    hasPersonName: true,
    hasPictureUrl: true,
    hasFilePath: false,
    hasFetchId: false,
    hasSenseId: true,
  });

  const evidence = state.catalogueEvidence();
  assert.equal(evidence.schema, 1);
  assert.equal(evidence.inventory[0]?.model, "T8140-R");
  assert.equal(evidence.cameras[0]?.peerRouteReady, true);
  assert.deepEqual(evidence.events[0], {
    observedOn: "2026-09-21",
    model: "T8140-R",
    deviceType: 14,
    type: 1,
    eventType: 3102,
    messageType: 0,
    notificationStyle: 1,
    hasPersonName: true,
    hasPictureUrl: true,
    hasFilePath: false,
    hasFetchId: false,
    hasSenseId: true,
  });
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes("PRIVATE-SERIAL"), false);
  assert.equal(serialized.includes("Private camera name"), false);
  assert.equal(serialized.includes("Private person name"), false);
});
