/**
 * Verifies attached-camera media restart boundaries for the PPCS transport.
 *
 * The session owns the UDP protocol; this test guards the time-based policy
 * that prevents a healthy HomeBase stream being reset by its own heartbeat.
 */
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createECDH, createHmac } from "node:crypto";
import test from "node:test";

import {
  buildCameraEnableBody,
  buildAttachedMediaControlValue,
  buildLegacyAttachedMediaStopPayload,
  buildNightVisionBody,
  acceptsAttachedCameraMedia,
  buildPpcsCloudLookup,
  buildStandaloneLiveStartPayload,
  decodePpcsVideoFrame,
  hasDecoderReadyKeyframe,
  isPpcsCameraIdentity,
  needsAttachedMediaReassert,
  needsStandaloneMediaReassert,
  PpcsVideoFrameDecoder,
  PpcsVideoStreamNormalizer,
  ppcsCandidatePorts,
  ppcsCommandMagicOffset,
  ppcsFrameChannel,
  ppcsLookupCandidate,
  ppcsLocalLookupTargets,
  ppcsPartialCommandPrefix,
  ppcsSequenceDisposition,
} from "../src/stream/first-party-ppcs.js";

test("builds the two PPCS cloud lookup variants", () => {
  const did = "EUPRCAM-000000-XXXXX";
  const dsk = "XXXXXXXXXXXXXXXXXXXX";
  const fallback = buildPpcsCloudLookup(did, dsk);
  assert.equal(fallback.type.toString("hex"), "f16a");
  assert.equal(fallback.payload.length, 20 + dsk.length + 4);

  const classic = buildPpcsCloudLookup(did, dsk, { host: "192.0.2.1", port: 12_345 });
  assert.equal(classic.type.toString("hex"), "f126");
  assert.equal(classic.payload.length, fallback.payload.length + 20);
  assert.equal(classic.payload.subarray(20, 22).toString("hex"), "0002");
  assert.equal(classic.payload.readUInt16LE(22), 12_345);
  assert.deepEqual(classic.payload.subarray(24, 28), Buffer.from([1, 2, 0, 192]));
  assert.deepEqual(classic.payload.subarray(36, 40), Buffer.from([2, 5, 1, 5]));
  assert.deepEqual(classic.payload.subarray(40), fallback.payload.subarray(20));
});

test("builds a bounded camera enablement body without leaking adjacent data", () => {
  const body = buildCameraEnableBody(3, 0, "account-owner");
  assert.equal(body.length, 136);
  assert.equal(body.readUInt32LE(0), 3);
  assert.equal(body.readUInt32LE(4), 0);
  assert.equal(body.subarray(8, 21).toString("ascii"), "account-owner");
  assert.ok(body.subarray(21).every((value) => value === 0));
  assert.throws(() => buildCameraEnableBody(3, 0, ""), /non-empty account identity/);
});

test("builds the verified night-vision SET_PAYLOAD body", () => {
  assert.deepEqual(JSON.parse(buildNightVisionBody(3, 2, "account-owner").toString("utf8")), {
    account_id: "account-owner",
    cmd: 1277,
    mChannel: 0,
    mValue3: 0,
    payload: { channel: 3, night_sion: 2 },
  });
  assert.throws(() => buildNightVisionBody(3, 3, "account-owner"), /must be 0, 1, or 2/);
});

test("reissues a standalone start only while codec headers are missing", () => {
  assert.equal(needsStandaloneMediaReassert(false, "unknown"), true);
  assert.equal(needsStandaloneMediaReassert(false, "h264"), false);
  assert.equal(needsStandaloneMediaReassert(false, "h265"), false);
  assert.equal(needsStandaloneMediaReassert(true, "unknown"), false);
});

test("accepts both PPCS cloud candidate response forms", () => {
  for (const header of [[0xf1, 0x40], [0xf1, 0x82]]) {
    const response = Buffer.alloc(24);
    response.set(header, 0);
    response.writeUInt16LE(32_108, 6);
    response.set([9, 2, 0, 192], 8);
    assert.deepEqual(ppcsLookupCandidate(response), { host: "192.0.2.9", port: 32_108 });
  }
  assert.equal(isPpcsCameraIdentity(Buffer.from([0xf1, 0x42])), true);
  assert.equal(isPpcsCameraIdentity(Buffer.from([0xf1, 0x84])), true);
  assert.equal(isPpcsCameraIdentity(Buffer.from([0xf1, 0x40])), false);
  assert.deepEqual(ppcsCandidatePorts(32_108), [32_105, 32_106, 32_107, 32_108, 32_109, 32_110, 32_111]);
});

test("adds the HomeBase inventory address to local PPCS lookup", () => {
  assert.deepEqual(ppcsLocalLookupTargets(null), [
    { host: "255.255.255.255", port: 32_108 },
  ]);
  assert.deepEqual(ppcsLocalLookupTargets("192.168.1.50"), [
    { host: "255.255.255.255", port: 32_108 },
    { host: "192.168.1.50", port: 32_108 },
  ]);
});

test("labels a standalone live start as level-one frame type 11", () => {
  const key = Buffer.from("0123456789abcdef", "utf8");
  const value = JSON.stringify({ commandType: 1000, data: { cmd: 1000 } });
  const payload = buildStandaloneLiveStartPayload(value, 4, key);

  assert.equal(payload.readUInt16LE(0), payload.length - 10);
  assert.deepEqual(payload.subarray(4, 10), Buffer.from([1, 0, 4, 1, 11, 0]));

  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  const clear = Buffer.concat([decipher.update(payload.subarray(10)), decipher.final()]);
  assert.equal(clear.subarray(0, value.length).toString("utf8"), value);
});

test("reasserts attached media during startup or after a stall", () => {
  assert.equal(needsAttachedMediaReassert(null, 1_000), true);
  assert.equal(needsAttachedMediaReassert(1_000, 6_000), false);
  assert.equal(needsAttachedMediaReassert(1_000, 11_000), true);
});

test("builds distinct HomeBase start and stop media envelopes", () => {
  assert.deepEqual(JSON.parse(buildAttachedMediaControlValue(1003, 4, "account-owner", "public-key").toString()), {
    account_id: "account-owner",
    cmd: 1003,
    mChannel: 4,
    mValue3: 1003,
    payload: {
      ClientOS: "Android",
      accountId: "account-owner",
      camera_type: 0,
      entrytype: 0,
      key: "public-key",
      streamtype: 1,
    },
  });
  assert.deepEqual(JSON.parse(buildAttachedMediaControlValue(1004, 4, "account-owner").toString()), {
    account_id: "account-owner",
    cmd: 1004,
    mChannel: 4,
    mValue3: 1004,
    payload: {},
  });
  assert.throws(
    () => buildAttachedMediaControlValue(1003, 4, "account-owner"),
    /requires an RSA public key/,
  );
});

test("builds the T8010 direct encrypted media stop command", () => {
  const key = Buffer.from("0123456789abcdef", "utf8");
  const payload = buildLegacyAttachedMediaStopPayload(4, key);

  assert.equal(payload.readUInt16LE(0), 16);
  assert.deepEqual(payload.subarray(4, 10), Buffer.from([1, 0, 4, 1, 0, 0]));
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  const clear = Buffer.concat([decipher.update(payload.subarray(10)), decipher.final()]);
  assert.equal(clear.readUInt32LE(0), 4);
  assert.ok(clear.subarray(4).every((value) => value === 0));
});

test("requires complete codec setup and an IDR before attached media settles", () => {
  assert.equal(hasDecoderReadyKeyframe("h264", [7, 8, 5]), true);
  assert.equal(hasDecoderReadyKeyframe("h264", [7, 8, 1]), false);
  assert.equal(hasDecoderReadyKeyframe("h265", [32, 33, 34, 19]), true);
  assert.equal(hasDecoderReadyKeyframe("h265", [32, 33, 34, 20]), true);
  assert.equal(hasDecoderReadyKeyframe("h265", [32, 39, 1]), false);
  assert.equal(hasDecoderReadyKeyframe("unknown", [32, 33, 34, 19]), false);
});

test("accepts only the requested camera's HomeBase video", () => {
  assert.equal(acceptsAttachedCameraMedia(1300, 4, 4), true);
  assert.equal(acceptsAttachedCameraMedia(1300, 3, 4), false);
  assert.equal(acceptsAttachedCameraMedia(1100, 3, 4), true);
});

test("reads the media channel from the current frame before the parser advances", () => {
  const currentFrame = Buffer.alloc(16);
  Buffer.from("XZYH").copy(currentFrame);
  currentFrame[12] = 4;
  const followingFrame = Buffer.alloc(16, 9);

  assert.equal(ppcsFrameChannel(Buffer.concat([currentFrame, followingFrame])), 4);
  assert.equal(ppcsFrameChannel(followingFrame), null);
});

test("retains a split PPCS command magic prefix", () => {
  assert.deepEqual(ppcsPartialCommandPrefix(Buffer.from("X")), Buffer.from("X"));
  assert.deepEqual(ppcsPartialCommandPrefix(Buffer.from("XZ")), Buffer.from("XZ"));
  assert.deepEqual(ppcsPartialCommandPrefix(Buffer.from("XZYH\0")), Buffer.from("XZYH\0"));
  assert.equal(ppcsPartialCommandPrefix(Buffer.from("garbage")), undefined);
  assert.equal(ppcsPartialCommandPrefix(Buffer.alloc(16, 0)), undefined);
});

test("finds a command header after a short parser resync tail", () => {
  assert.equal(ppcsCommandMagicOffset(Buffer.from("discardXZYH")), 7);
  assert.equal(ppcsCommandMagicOffset(Buffer.from("no command")), -1);
});

test("distinguishes forward loss from duplicate and stale PPCS datagrams", () => {
  assert.equal(ppcsSequenceDisposition(null, 12), "first");
  assert.equal(ppcsSequenceDisposition(12, 13), "next");
  assert.equal(ppcsSequenceDisposition(12, 15), "gap");
  assert.equal(ppcsSequenceDisposition(12, 12), "duplicate");
  assert.equal(ppcsSequenceDisposition(12, 11), "stale");
  assert.equal(ppcsSequenceDisposition(5_000, 1), "restart");
  assert.equal(ppcsSequenceDisposition(0xffff, 0), "next");
});

test("does not apply an earlier encrypted frame key to a plaintext frame", () => {
  const annexB = Buffer.from([0, 0, 0, 1, 0x65, 0x88]);
  const frame = Buffer.alloc(22 + annexB.length);
  frame.writeUInt32LE(annexB.length, 0);
  annexB.copy(frame, 22);

  assert.deepEqual(decodePpcsVideoFrame(frame, 0, () => Buffer.alloc(16, 9)), annexB);
});

test("unwraps and uses the key carried by an encrypted video frame", () => {
  const key = Buffer.alloc(16, 7);
  const clear = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x65]), Buffer.alloc(123, 3)]);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
  const tail = Buffer.from([4, 5, 6]);
  const frame = Buffer.alloc(151 + clear.length + tail.length);
  frame.writeUInt32LE(clear.length + tail.length, 0);
  Buffer.alloc(128, 8).copy(frame, 22);
  encrypted.copy(frame, 151);
  tail.copy(frame, 151 + encrypted.length);

  assert.deepEqual(decodePpcsVideoFrame(frame, 1, () => key), Buffer.concat([clear, tail]));
});

test("accepts a legacy encrypted keyframe with length-prefixed H.264 media", () => {
  const key = Buffer.alloc(16, 7);
  const clear = Buffer.alloc(128, 3);
  clear.writeUInt32BE(124, 0);
  clear[4] = 0x67;
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
  const frame = Buffer.alloc(151 + encrypted.length);
  frame.writeUInt32LE(encrypted.length, 0);
  Buffer.alloc(128, 8).copy(frame, 22);
  encrypted.copy(frame, 151);
  const decoder = new PpcsVideoFrameDecoder(() => key);

  assert.deepEqual(decoder.decode(frame, 1), {
    data: clear,
    protection: "rsa-ecb",
  });
  const normalizer = new PpcsVideoStreamNormalizer();
  assert.deepEqual(normalizer.push(clear), Buffer.concat([Buffer.from([0, 0, 0, 1]), clear.subarray(4)]));
  assert.equal(normalizer.framing, "length-prefixed");
  assert.deepEqual(normalizer.nalTypes, [7]);
});

test("accepts a decrypted legacy continuation without a video start code", () => {
  const key = Buffer.alloc(16, 7);
  const clear = Buffer.alloc(128, 0xff);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
  const frame = Buffer.alloc(151 + encrypted.length);
  frame.writeUInt32LE(encrypted.length, 0);
  Buffer.alloc(128, 8).copy(frame, 22);
  encrypted.copy(frame, 151);

  assert.deepEqual(new PpcsVideoFrameDecoder(() => key).decode(frame, 1), {
    data: clear,
    protection: "rsa-ecb",
  });
});

/** Build a deterministic authenticated-media frame for the public decoder contract. */
function authenticatedFrame(
  recipient: ReturnType<typeof createECDH>,
  mediaKey: Buffer,
  clear: Buffer,
  keyframe: boolean,
): Buffer {
  const ephemeral = createECDH("prime256v1");
  ephemeral.setPrivateKey(Buffer.alloc(32, 2));
  const shared = ephemeral.computeSecret(recipient.getPublicKey());
  const label = Buffer.from("ECIES");
  const hmac = (key: Buffer, value: Buffer): Buffer => createHmac("sha256", key).update(value).digest();
  let previous: Buffer<ArrayBufferLike> = label;
  let derived: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (derived.length < 48) {
    previous = hmac(shared, previous);
    derived = Buffer.concat([derived, hmac(shared, Buffer.concat([previous, label]))]);
  }

  const envelope = Buffer.alloc(129);
  ephemeral.getPublicKey(undefined, "compressed").copy(envelope, 0);
  const envelopeIv = Buffer.alloc(16, 3);
  envelopeIv.copy(envelope, 33);
  const envelopeCipher = createCipheriv("aes-128-cbc", derived.subarray(0, 16), envelopeIv);
  const wrapped = Buffer.concat([envelopeCipher.update(mediaKey), envelopeCipher.final()]);
  wrapped.copy(envelope, 49);
  hmac(derived.subarray(16, 48), envelope.subarray(33, 97)).copy(envelope, 97);

  const nonce = Buffer.alloc(12, keyframe ? 4 : 5);
  const bodyCipher = createCipheriv("aes-256-gcm", mediaKey, nonce);
  bodyCipher.setAAD(Buffer.from("eufy security"));
  const body = Buffer.concat([bodyCipher.update(clear), bodyCipher.final()]);
  const frame = Buffer.alloc(179 + body.length);
  frame.writeUInt32LE(clear.length, 0);
  frame[4] = keyframe ? 1 : 0;
  if (keyframe) envelope.copy(frame, 22);
  bodyCipher.getAuthTag().copy(frame, 151);
  nonce.copy(frame, 167);
  body.copy(frame, 179);
  return frame;
}

test("authenticates ECC-wrapped keyframes and reuses their media key for delta frames", () => {
  const recipient = createECDH("prime256v1");
  recipient.setPrivateKey(Buffer.alloc(32, 1));
  const mediaKey = Buffer.alloc(32, 9);
  const keyframe = Buffer.from([0, 0, 0, 1, 0x40, 0x01, 0x42, 0x01]);
  const delta = Buffer.from([0, 0, 0, 1, 0x02, 0x01, 0xaa]);
  const decoder = new PpcsVideoFrameDecoder(() => undefined);
  decoder.setEccPrivateKey(recipient.getPrivateKey().toString("hex"));

  assert.deepEqual(decoder.decode(authenticatedFrame(recipient, mediaKey, keyframe, true), 1), {
    data: keyframe,
    protection: "ecc-gcm",
  });
  assert.deepEqual(decoder.decode(authenticatedFrame(recipient, mediaKey, delta, false), 1), {
    data: delta,
    protection: "ecc-gcm",
  });
});

test("rejects authenticated media after its tag is changed", () => {
  const recipient = createECDH("prime256v1");
  recipient.setPrivateKey(Buffer.alloc(32, 1));
  const frame = authenticatedFrame(recipient, Buffer.alloc(32, 9), Buffer.from([0, 0, 0, 1, 0x65]), true);
  frame[151] = (frame[151] ?? 0) ^ 1;
  const decoder = new PpcsVideoFrameDecoder(() => undefined);
  decoder.setEccPrivateKey(recipient.getPrivateKey().toString("hex"));

  assert.equal(decoder.decode(frame, 1), undefined);
});

test("converts complete length-prefixed H.264 NAL units to Annex-B", () => {
  const sei = Buffer.from([0x06, 0x05, 0x3a, 0xfe]);
  const idr = Buffer.from([0x65, 0x88, 0x84]);
  const lengthPrefixed = Buffer.alloc(8 + sei.length + idr.length);
  lengthPrefixed.writeUInt32BE(sei.length, 0);
  sei.copy(lengthPrefixed, 4);
  lengthPrefixed.writeUInt32BE(idr.length, 4 + sei.length);
  idr.copy(lengthPrefixed, 8 + sei.length);

  const normalizer = new PpcsVideoStreamNormalizer();
  assert.deepEqual(
    normalizer.push(lengthPrefixed),
    Buffer.concat([Buffer.from([0, 0, 0, 1]), sei, Buffer.from([0, 0, 0, 1]), idr]),
  );
  assert.equal(normalizer.framing, "length-prefixed");
});

test("leaves an Annex-B stream unchanged", () => {
  const annexB = Buffer.from([0, 0, 0, 1, 0x65, 0x88]);
  const normalizer = new PpcsVideoStreamNormalizer();

  assert.equal(normalizer.push(annexB), annexB);
  assert.equal(normalizer.framing, "annexb");
});

test("records privacy-safe H.264 NAL types across output chunks", () => {
  const normalizer = new PpcsVideoStreamNormalizer();

  normalizer.push(Buffer.from([0, 0]));
  normalizer.push(Buffer.from([0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0xce]));
  normalizer.push(Buffer.from([0, 0, 1, 0x65, 0x88]));

  assert.equal(normalizer.codec, "h264");
  assert.deepEqual(normalizer.nalTypes, [7, 8, 5]);
});

test("prefers decoder setup over a conflicting PPCS frame marker", () => {
  const normalizer = new PpcsVideoStreamNormalizer();

  normalizer.push(Buffer.from([0, 0, 0, 1, 0x40, 0x01]), "h264");

  assert.equal(normalizer.codec, "h265");
  assert.deepEqual(normalizer.nalTypes, [32]);
});

test("uses the PPCS frame marker when media bytes do not identify a codec", () => {
  const normalizer = new PpcsVideoStreamNormalizer();

  normalizer.push(Buffer.from([0, 0, 0, 1, 0x1c, 0x01]), "h264");

  assert.equal(normalizer.codec, "h264");
  assert.deepEqual(normalizer.nalTypes, [28]);
});

test("records privacy-safe H.265 NAL types across output chunks", () => {
  const normalizer = new PpcsVideoStreamNormalizer();

  normalizer.push(Buffer.from([0, 0, 0, 1, 0x40, 0x01]));
  normalizer.push(Buffer.from([0, 0, 1, 0x42, 0x01, 0, 0, 1, 0x44, 0x01]));
  normalizer.push(Buffer.from([0, 0, 1, 0x26, 0x01]));

  assert.equal(normalizer.codec, "h265");
  assert.deepEqual(normalizer.nalTypes, [32, 33, 34, 19]);
});

test("converts a length-prefixed NAL split across PPCS video frames", () => {
  const normalizer = new PpcsVideoStreamNormalizer();
  const first = Buffer.from([0, 0, 0, 0xfc, 0x21, 0xe6, 0x03, 0x04]);
  const second = Buffer.alloc(248, 0x55);

  assert.deepEqual(
    normalizer.push(first),
    Buffer.from([0, 0, 0, 1, 0x21, 0xe6, 0x03, 0x04]),
  );
  assert.deepEqual(normalizer.push(second), second);
  assert.equal(normalizer.framing, "length-prefixed");
});

test("retains a split length prefix until the next PPCS video frame", () => {
  const normalizer = new PpcsVideoStreamNormalizer();

  assert.deepEqual(normalizer.push(Buffer.from([0, 0])), Buffer.alloc(0));
  assert.deepEqual(
    normalizer.push(Buffer.from([0, 3, 0x65, 0x88, 0x84])),
    Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84]),
  );
});
