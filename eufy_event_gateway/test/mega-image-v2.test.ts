/**
 * Exercises V2 authenticated picture prefixes with synthetic, locally encoded
 * JPEGs. Tests own all keys and wrappers and never access a device or account.
 */
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import test from "node:test";
import { decode, encode } from "jpeg-js";
import { decodeEventImage, imageKey } from "../src/mega/image.js";

const SERIAL = "TESTCAM000000001";
const DID = "TEST-123456-TEST";
const CODE = "1700000000";

/** Encode a complete synthetic image whose dimensions are lost by reconstruction. */
function picture(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = index % 251;
    pixels[index + 1] = Math.floor(index / 251) % 251;
    pixels[index + 2] = 75;
    pixels[index + 3] = 255;
  }
  return encode({ width, height, data: pixels }, 70).data;
}

/** Wrap only the first 256 bytes, leaving the image tail untouched on the wire. */
function wrap(source: Buffer, aad = "eufy security"): Buffer {
  const nonce = Buffer.from("01023a0405060708090a0b0c", "hex");
  const key = Buffer.from(imageKey(SERIAL, DID, CODE), "ascii");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(aad, "ascii"));
    const encrypted = Buffer.concat([cipher.update(source.subarray(0, 256)), cipher.final()]);
    return Buffer.concat([
      Buffer.from(`v2_eufysecurity:${SERIAL}:${CODE}:`, "ascii"), nonce,
      Buffer.from(":"), cipher.getAuthTag(), Buffer.from(":"), encrypted,
      source.subarray(256),
    ]);
  } finally {
    key.fill(0);
  }
}

test("V2 authentication preserves exact JPEG bytes, dimensions and caller-owned input", () => {
  for (const [width, height] of [[640, 360], [278, 210]]) {
    const source = picture(width!, height!);
    const wrapped = wrap(source);
    const before = Buffer.from(wrapped);
    const result = decodeEventImage(wrapped, DID);
    assert.deepEqual(result, source);
    assert.deepEqual(wrapped, before);
    const decoded = decode(result, { tolerantDecoding: false });
    assert.equal(decoded.width, width);
    assert.equal(decoded.height, height);
    result.fill(0);
    assert.deepEqual(wrapped, before);
  }
});

test("missing or wrong V2 keys and authentication failures retain the prior fallback", () => {
  const source = picture(278, 210);
  const wrapped = wrap(source);
  assert.deepEqual(decodeEventImage(wrapped, "TEST-654321-TEST"), decodeEventImage(wrapped));
  for (const offset of [44, 57, 74, 329]) {
    const corrupted = Buffer.from(wrapped);
    corrupted[offset] = corrupted[offset]! ^ 1;
    const before = Buffer.from(corrupted);
    assert.deepEqual(decodeEventImage(corrupted, DID), decodeEventImage(corrupted));
    assert.deepEqual(corrupted, before);
  }
  const wrongAad = wrap(source, "different aad");
  assert.deepEqual(decodeEventImage(wrongAad, DID), decodeEventImage(wrongAad));
});

test("unsupported V2 layouts and truncated wrappers do not enter authenticated decoding", () => {
  const wrapped = wrap(picture(278, 210));
  for (const offset of [32, 33, 43, 56, 73]) {
    const malformed = Buffer.from(wrapped);
    malformed[offset] = 0x78;
    assert.deepEqual(decodeEventImage(malformed, DID), decodeEventImage(malformed));
  }
  for (const length of [16, 43, 73, 74, 329]) {
    const truncated = wrapped.subarray(0, length);
    assert.equal(decodeEventImage(truncated, DID), truncated);
  }
});
