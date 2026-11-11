/**
 * Exercises viewer ownership diagnostics through the real manager and provider.
 * Synthetic inventories and byte streams own all state and cleanup. The cases
 * distinguish joining one camera from a different identity with the same model,
 * without relaxing a reservation or contacting a device.
 */
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { NvrRtcSession } from "../src/stream/nvr-rtc-session.js";
import { LiveStreamManager, type ViewerSourceRequestSummary, type ViewerClientSummary } from "../src/stream/live-stream-manager.js";

for (const throwingObserver of [false, true]) {
  test(`viewer correlation distinguishes identical models without replacing a working source, throwing=${throwingObserver}`, async () => {
    const state = new GatewayState();
    for (const serial of ["PRIVATE_CAMERA_A", "PRIVATE_CAMERA_B"]) state.registerCamera({ serial, model: "T8172",
      name: "PRIVATE_ROOM_NAME", stationSerial: "PRIVATE_STATION", streamSupported: true, doorbellSupported: false });
    const requests: ViewerSourceRequestSummary[] = [];
    const stops: ViewerClientSummary[] = [];
    let starts = 0, closes = 0;
    const source = new PassThrough();
    const manager = new LiveStreamManager(state, {} as never, {
      async startStream(serial) {
        starts++;
        if (serial === "PRIVATE_CAMERA_B") throw new Error("PRIVATE_PROVIDER_ERROR");
        manager.attachSource(serial, source, () => "h264");
      },
      async stopStream() { closes++; },
    }, 60_000);
    manager.on("viewer-source-request", (value: ViewerSourceRequestSummary) => requests.push(value));
    if (throwingObserver) manager.on("viewer-source-request", () => { throw new Error("PRIVATE_OBSERVER_ERROR"); });
    manager.on("viewer-client-stopped", (value: ViewerClientSummary) => stops.push(value));
    const consumer = (): ServerResponse => {
      const value = new PassThrough() as unknown as ServerResponse;
      value.on("error", () => {});
      return value;
    };
    try {
      const first = consumer(), remaining = consumer();
      await manager.addClient("PRIVATE_CAMERA_A", first);
      await manager.addClient("PRIVATE_CAMERA_A", remaining);
      first.emit("close");
      for (let i = 0; i < 4; i++) await manager.addClient("PRIVATE_CAMERA_A", consumer());
      assert.equal(starts, 1);
      assert.equal(closes, 0);
      assert.equal(remaining.destroyed, false);
      assert.equal(requests.length, 6);
      assert.deepEqual(requests.map(value => value.cameraSlot), Array(6).fill(1));
      assert.ok(requests.slice(1).every(value => value.state === "streaming" && value.sourceAttached));
      await manager.addClient("PRIVATE_CAMERA_B", consumer());
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(starts, 2);
      assert.equal(closes, 0);
      assert.equal(remaining.destroyed, false);
      assert.deepEqual(requests.slice(-2).map(value => [value.cameraSlot, value.model, value.outcome, value.sourceAttached, value.otherActiveCameraSlots]),
        [[2, "T8172", "requested", false, [1]], [2, "T8172", "start_failed", false, [1]]]);
      assert.equal(stops[0]?.cameraSlot, 1);
      assert.equal(stops.at(-1)?.cameraSlot, 2);
      assert.equal(/PRIVATE_/.test(JSON.stringify({ requests, stops })), false);
    } finally { await manager.close(); }
  });
}

test("NVR refusal names same-camera and same-station reservations without exposing identities", async context => {
  const directory = await mkdtemp(join(tmpdir(), "viewer-reservation-"));
  context.mock.method(globalThis, "fetch", async () => { assert.fail("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.getter(MegaClient.prototype, "isAuthenticated", () => true);
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
    { device_sn: "PRIVATE_STATION", device_model: "T9000", device_type: 27, category: "eufy_security", member: { admin_user_id: "PRIVATE_OWNER" } },
    ...["PRIVATE_CAMERA_A", "PRIVATE_CAMERA_B"].map((serial, channel) => ({ device_sn: serial, device_model: "T8172", device_type: 89,
      category: "eufy_security", parent_sn: "PRIVATE_STATION", device_channel: channel, member: { admin_user_id: "PRIVATE_OWNER" } })),
  ] }));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
  context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => ({ host: "security-smart-eu.eufylife.com", region: "EU", authToken: "PRIVATE_TOKEN", gtoken: "PRIVATE_GTOKEN", sign: "PRIVATE_SIGN" }));
  let starts = 0, closes = 0;
  context.mock.method(NvrRtcSession.prototype, "start", async () => { starts++; });
  context.mock.method(NvrRtcSession.prototype, "close", async () => { closes++; });
  const logs: string[] = [];
  context.mock.method(process.stderr, "write", (chunk: unknown) => { logs.push(String(chunk)); return true; });
  const events = new Proxy({}, { get: () => () => {} }) as ProviderEvents;
  const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: directory,
    maxStreamSeconds: 120, experimentalNvrLive: true, normalNvrLive: true });
  try {
    await provider.start(events);
    await provider.startStream("PRIVATE_CAMERA_A");
    assert.throws(() => provider.reserveNvrLiveTrial("PRIVATE_CAMERA_A", new AbortController().signal));
    assert.throws(() => provider.reserveNvrLiveTrial("PRIVATE_CAMERA_B", new AbortController().signal));
    const refusals = logs.filter(line => line.includes("event=nvr_live_start_refused"));
    assert.equal(refusals.length, 2);
    assert.match(refusals[0]!, /reason=call_reserved model=T8172 active_model=T8172 same_camera=true same_station=true/);
    assert.match(refusals[1]!, /reason=call_reserved model=T8172 active_model=T8172 same_camera=false same_station=true/);
    assert.equal(/PRIVATE_/.test(refusals.join("")), false);
    assert.equal(starts, 1); assert.equal(closes, 0);
  } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
