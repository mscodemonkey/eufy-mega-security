/**
 * Exercises V8 picture authentication and provider-owned key lookup with generated
 * keys and images only. No reporter bytes, identity or account material is used.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, createECDH, createHmac } from "node:crypto";
import { encode, decode } from "jpeg-js";
import { parseV8EventImage, decodeV8EventImage } from "../src/mega/v8-image.js";
import { downloadPushSnapshot } from "../src/provider/eufy-provider.js";
import { EventImageCapture } from "../src/diagnostics/event-image-capture.js";

const station = "SYNTHETIC0000001";
const recipient = createECDH("prime256v1");
recipient.setPrivateKey(Buffer.alloc(32, 1));
const jpeg = encode({ width: 8, height: 8, data: Buffer.alloc(8 * 8 * 4, 127) }, 50).data;

/** Encrypt a generated JPEG with a separately constructed ECC key envelope. */
function fixture(clear: Buffer = jpeg, aad = "eufy security"): Buffer {
  const ephemeral = createECDH("prime256v1");
  ephemeral.setPrivateKey(Buffer.alloc(32, 2));
  const secret = ephemeral.computeSecret(recipient.getPublicKey());
  const label = Buffer.from("ECIES");
  const mac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
  const a1 = mac(secret, label), a2 = mac(secret, a1);
  const derived = Buffer.concat([mac(secret, Buffer.concat([a1, label])), mac(secret, Buffer.concat([a2, label]))]);
  const mediaKey = Buffer.alloc(32, 3), iv = Buffer.alloc(16, 4);
  const wrap = createCipheriv("aes-128-cbc", derived.subarray(0, 16), iv);
  const body = Buffer.concat([iv, wrap.update(mediaKey), wrap.final()]);
  const envelope = Buffer.concat([ephemeral.getPublicKey(undefined, "compressed"), body, mac(derived.subarray(16, 48), body)]);
  const nonce = Buffer.alloc(12, 5);
  const encrypt = createCipheriv("aes-256-gcm", mediaKey, nonce);
  encrypt.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([encrypt.update(clear), encrypt.final()]);
  return Buffer.concat([Buffer.from(`v8_eufysecurity:${station}:`), Buffer.from([10]), envelope, nonce, encrypt.getAuthTag(), ciphertext]);
}

/** Decode through the real download boundary with a fake authorized key endpoint. */
async function download(body: Buffer, options: { station?: string; owner?: string | null; rows?: readonly Record<string, unknown>[]; fail?: boolean } = {}) {
  const calls: unknown[][] = [];
  const result = await downloadPushSnapshot({
    download: async () => body,
    getCiphers: async (...args) => {
      calls.push(args);
      if (options.fail) throw new Error("private server response");
      return options.rows ?? [{ cipher_id: 10, ecc_private_key: recipient.getPrivateKey().toString("hex") }];
    },
  }, { pictureUrl: "https://example.invalid/private", stationSerial: options.station ?? station },
  new Map([[station, { p2pDid: null, adminUserId: options.owner === undefined ? "synthetic-owner" : options.owner }]]));
  return { result, calls };
}

test("V8 complete JPEG is authenticated through the matching station-owner cipher lookup", async () => {
  const original = fixture(), saved = Buffer.from(original);
  const { result, calls } = await download(original);
  assert.deepEqual(calls, [[[10], "synthetic-owner", station]]);
  assert.deepEqual(result?.data, jpeg);
  assert.equal(decode(result!.data, { tolerantDecoding: false }).width, 8);
  assert.deepEqual(original, saved);
});

test("V8 rejects key, nonce, tag and ciphertext tampering without mutating evidence", async () => {
  for (const offset of [35, 67, 100, 162, 163, 175, 191]) {
    const body = fixture(); body[offset] = body[offset]! ^ 1;
    const before = Buffer.from(body);
    await assert.rejects(download(body), /format=v8 result=(key_authentication_failed|image_authentication_failed)/);
    assert.deepEqual(body, before);
  }
  await assert.rejects(download(fixture(jpeg, "wrong AAD")), /image_authentication_failed/);
  await assert.rejects(download(fixture(Buffer.from("not a picture"))), /image_authentication_failed/);
});

test("V8 structural and station checks precede key lookup", async () => {
  let calls = 0;
  const client = { download: async () => fixture(), getCiphers: async () => { calls++; return []; } };
  await assert.rejects(downloadPushSnapshot(client,
    { pictureUrl: "https://example.invalid/private", stationSerial: "wrong-station" }, new Map()), /station_mismatch/);
  assert.equal(calls, 0);
  for (const length of [16, 33, 163, 191]) assert.throws(() => parseV8EventImage(fixture().subarray(0, length)), /invalid_header/);
  const unsupported = fixture(); unsupported[33] = 1;
  assert.throws(() => parseV8EventImage(unsupported), /unsupported_key_scheme/);
  assert.equal(parseV8EventImage(jpeg), null);
});

test("V8 owner, lookup and key failures expose no private response or key", async () => {
  for (const options of [{ owner: null }, { rows: [] }, { rows: [{ cipher_id: 11, ecc_private_key: "f".repeat(64) }] },
    { rows: [{ cipher_id: 10, ecc_private_key: "private-value" }] }, { fail: true }]) {
    await assert.rejects(download(fixture(), options), (error: unknown) => {
      assert.match(String(error), /format=v8 result=key_(unavailable|lookup_failed)/);
      assert.doesNotMatch(String(error), /private-value|private server response|synthetic-owner|SYNTHETIC/);
      return true;
    });
  }
  const image = parseV8EventImage(fixture())!;
  assert.throws(() => decodeV8EventImage(image, Buffer.alloc(32, 9)), /key_authentication_failed/);
});

test("V8 rejects a key response after its inventory owner changes", async () => {
  const devices = new Map([[station, { p2pDid: null, adminUserId: "first-owner" }]]);
  await assert.rejects(downloadPushSnapshot({
    download: async () => fixture(),
    getCiphers: async () => {
      devices.set(station, { p2pDid: null, adminUserId: "replacement-owner" });
      return [{ cipher_id: 10, ecc_private_key: recipient.getPrivateKey().toString("hex") }];
    },
  }, { pictureUrl: "https://example.invalid/private", stationSerial: station }, devices), /owner_changed/);
});

test("V8 retains only failed originals in the opt-in private capture", async () => {
  const capture = new EventImageCapture();
  const devices = new Map([[station, { p2pDid: null, adminUserId: "synthetic-owner" }]]);
  const body = fixture();
  const client = {
    download: async () => body,
    getCiphers: async () => [{ cipher_id: 10, ecc_private_key: recipient.getPrivateKey().toString("hex") }],
  };
  try {
    await downloadPushSnapshot(client, { pictureUrl: "https://example.invalid/private", stationSerial: station }, devices, capture);
    assert.equal(capture.status().sampleCount, 0);
    body[175] = body[175]! ^ 1;
    const original = Buffer.from(body);
    await assert.rejects(downloadPushSnapshot(client,
      { pictureUrl: "https://example.invalid/private", stationSerial: station }, devices, capture), /image_authentication_failed/);
    assert.deepEqual(Buffer.from(capture.archive()!.samples[0]!.bodyBase64, "base64"), original);
    assert.deepEqual(body, original);
  } finally { capture.close(); }
});

test("V8 fails closed on ambiguous responses and invalid private scalars", async () => {
  const row = { cipher_id: 10, ecc_private_key: recipient.getPrivateKey().toString("hex") };
  await assert.rejects(download(fixture(), { rows: [row, row] }), /key_unavailable/);
  for (const key of ["0".repeat(64), "f".repeat(64)]) {
    await assert.rejects(download(fixture(), { rows: [{ cipher_id: 10, ecc_private_key: key }] }), /key_authentication_failed/);
  }
});
