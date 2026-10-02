/**
 * Covers the event-image path from a normalized push URL to JPEG bytes.
 *
 * The fake client verifies HTTPS download, ordinary-JPEG passthrough, wrapped
 * image decoding, and the required station P2P identity for encrypted images.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { downloadPushSnapshot } from "../src/provider/eufy-provider.js";

const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);

test("downloads a plain JPEG from a Mega event", async () => {
  const picture = await downloadPushSnapshot(
    { download: async () => jpeg },
    { pictureUrl: "https://example.invalid/signed-event-image", stationSerial: "station-1" },
    new Map(),
  );
  assert.deepEqual(picture, { data: jpeg });
});

test("does not download when the event has no picture URL", async () => {
  let downloaded = false;
  const picture = await downloadPushSnapshot(
    { download: async () => { downloaded = true; return jpeg; } },
    { pictureUrl: null, stationSerial: "station-1" },
    new Map(),
  );
  assert.equal(picture, null);
  assert.equal(downloaded, false);
});

test("requires the parent HomeBase identity for an encoded event image", async () => {
  await assert.rejects(downloadPushSnapshot(
    { download: async () => Buffer.from("encoded") },
    { pictureUrl: "https://example.invalid/image", stationSerial: "station-1" },
    new Map(),
  ), /HomeBase identity/);
});

test("reports a truncated JPEG without logging its bytes or download URL", async () => {
  await assert.rejects(downloadPushSnapshot(
    { download: async () => Buffer.from([0xff, 0xd8, 0x01, 0x02]) },
    { pictureUrl: "https://example.invalid/private-signed-url", stationSerial: "station-1" },
    new Map([["station-1", { p2pDid: "ABC-123456-XYZ" }]]),
  ), (error: unknown) => {
    assert.match(String(error), /format=jpeg result=missing_end/);
    assert.doesNotMatch(String(error), /private-signed-url|ffd8|123456/);
    return true;
  });
});

test("reports an unrecognised v2 wrapper shape without retaining payload data", async () => {
  await assert.rejects(downloadPushSnapshot(
    { download: async () => Buffer.from("v2_eufysecurity:camera:event:private-payload") },
    { pictureUrl: "https://example.invalid/private-signed-url", stationSerial: "station-1" },
    new Map([["station-1", { p2pDid: "ABC-123456-XYZ" }]]),
  ), (error: unknown) => {
    assert.match(String(error), /format=v2 result=missing_both/);
    assert.doesNotMatch(String(error), /private-payload|private-signed-url|123456/);
    return true;
  });
});
