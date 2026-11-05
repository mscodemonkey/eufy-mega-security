/**
 * Verifies default-off cloud recording admission and stale-result retirement.
 * Synthetic inventory and mocked cloud calls own all state. The tests never
 * open a camera, play a siren, change an account or contact vendor services.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { CloudRecordingError } from "../src/stream/cloud-recordings.js";

for (const mode of ["disabled", "unknown-camera", "unauthenticated", "valid", "cancelled", "closed"]) {
  test(`cloud recording provider ${mode} requires current camera ownership`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "cloud-preview-provider-"));
    const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.getter(MegaClient.prototype, "isAuthenticated", () => mode !== "unauthenticated");
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ device_sn: "camera", device_model: "T8113-Z",
      device_type: 8, category: "eufy_security", parent_sn: "station", device_channel: 0, member: { admin_user_id: "owner" } }] }));
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
    context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
    const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalCloudRecordings: mode !== "disabled" });
    const events = new Proxy({}, { get: () => () => undefined }) as ProviderEvents;
    const controller = new AbortController(), media = Buffer.from("checked-private-media");
    const trial = context.mock.method(MegaClient.prototype, "cloudRecordingTrial", async (serial: string, parent: string) => {
      assert.equal(serial, "camera"); assert.equal(parent, "station");
      if (mode === "cancelled") controller.abort(); if (mode === "closed") await provider.close();
      return media;
    });
    try {
      await provider.start(events);
      const result = provider.cloudRecordingTrial(mode === "unknown-camera" ? "other" : "camera", "record", { startTime: 90, endTime: 130 }, controller.signal);
      if (["disabled", "unknown-camera", "unauthenticated"].includes(mode)) {
        await assert.rejects(result, error => error instanceof CloudRecordingError && error.stage === "admission"); assert.equal(trial.mock.callCount(), 0);
      } else if (mode === "valid") { assert.equal(await result, media); assert.equal(trial.mock.callCount(), 1); }
      else { await assert.rejects(result, /cancelled/); assert.ok(media.every(byte => byte === 0)); }
      assert.equal(network.mock.callCount(), 0);
    } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
