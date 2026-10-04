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

test("requires the parent HomeBase identity for a legacy encrypted event image", async () => {
  await assert.rejects(downloadPushSnapshot(
    { download: async () => Buffer.from("eufysecurity:encoded") },
    { pictureUrl: "https://example.invalid/image", stationSerial: "station-1" },
    new Map(),
  ), /HomeBase identity/);
});

test("decodes keyless v2 wrappers without requiring a station identity", async () => {
  await assert.rejects(downloadPushSnapshot(
    { download: async () => Buffer.from("v2_eufysecurity:synthetic:event:incomplete") },
    { pictureUrl: "https://example.invalid/image", stationSerial: "station-1" },
    new Map(),
  ), /format=v2/);
});

test("reports a truncated JPEG without logging its bytes or download URL", async () => {
  await assert.rejects(downloadPushSnapshot(
    { download: async () => Buffer.from([0xff, 0xd8, 0x01, 0x02]) },
    { pictureUrl: "https://example.invalid/private-signed-url", stationSerial: "station-1" },
    new Map([["station-1", { p2pDid: "ABC-123456-XYZ" }]]),
  ), (error: unknown) => {
    assert.match(String(error), /format=jpeg size=<1KiB result=missing_end/);
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
    assert.match(String(error), /format=v2 size=<1KiB result=missing_both/);
    assert.doesNotMatch(String(error), /private-payload|private-signed-url|123456/);
    return true;
  });
});

/** Return the privacy-safe structural failure for one downloaded body. */
async function failureFor(body: Buffer): Promise<string> {
  try {
    await downloadPushSnapshot(
      { download: async () => body },
      { pictureUrl: "https://example.invalid/private-signed-url", stationSerial: "station-1" },
      new Map(),
    );
  } catch (error) {
    return String(error);
  }
  assert.fail("expected event-image decoding to fail");
}

test("classifies downloaded event-image structures without exposing contents", async () => {
  const bodies = [
    ["empty", Buffer.alloc(0)],
    ["png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["webp", Buffer.from("RIFF0000WEBP", "latin1")],
    ["gzip", Buffer.from([0x1f, 0x8b, 0x00])],
    ["json", Buffer.from([0xef, 0xbb, 0xbf, 0x20, 0x0a, 0x7b, 0x7d])],
    ["html", Buffer.from("\t\r <html>")],
    ["binary", Buffer.from([0x01, 0x02, 0x03])],
  ] as const;
  for (const [format, body] of bodies) {
    const failure = await failureFor(body);
    assert.match(failure, new RegExp(`format=${format} size=`));
    assert.doesNotMatch(failure, /private-signed-url|\{\}|<html>/);
  }
});

test("keeps short signatures binary and truncated JPEGs classified as JPEG", async () => {
  for (const body of [
    Buffer.from([0x89]),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]),
    Buffer.from("RIFF0000WEB", "latin1"),
    Buffer.from([0x1f]),
    Buffer.from("eufysecurit", "latin1"),
  ]) assert.match(await failureFor(body), /format=binary/);
  assert.match(await failureFor(Buffer.from([0xff, 0xd8, 0x1f, 0x8b])), /format=jpeg/);
  assert.match(await failureFor(Buffer.from([0x1f, 0x8b, 0xff, 0xd8])), /format=gzip/);
  assert.match(await failureFor(Buffer.concat([Buffer.alloc(64, 0x20), Buffer.from("{")])), /format=binary/);
});

test("buckets the encoded body size at fixed privacy boundaries", async () => {
  const cases = [
    [0, "0"], [1, "<1KiB"], [1023, "<1KiB"], [1024, "<64KiB"],
    [65535, "<64KiB"], [65536, "<1MiB"], [1048575, "<1MiB"], [1048576, ">=1MiB"],
  ] as const;
  for (const [length, bucket] of cases) {
    assert.equal((await failureFor(Buffer.alloc(length, 0x01))).includes(`size=${bucket}`), true);
  }
});

test("preserves failed HTTP download errors without adding the private URL", async () => {
  await assert.rejects(downloadPushSnapshot(
    { download: async () => { throw new Error("Mega media download failed (HTTP 403)"); } },
    { pictureUrl: "https://example.invalid/private-signed-url", stationSerial: "station-1" },
    new Map(),
  ), (error: unknown) => {
    assert.match(String(error), /HTTP 403/);
    assert.doesNotMatch(String(error), /private-signed-url/);
    return true;
  });
});
