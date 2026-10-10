import assert from "node:assert/strict";
import { createCipheriv, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes } from "node:crypto";
import test from "node:test";

import {
  buildHomeBase2DownloadValue,
  homeBase2RecordingPath,
  HomeBase2EventFrameReader,
  isHomeBase2RecordingPath,
  parseCipherRsaKey,
  type HomeBase2EventFrameTransport,
} from "../src/stream/homebase2-event-frame.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });

function header(command: number, size: number, channel: number, sign: number, type = 0): Buffer {
  const value = Buffer.alloc(16);
  value.write("XZYH", 0, "latin1");
  value.writeUInt16LE(command, 4);
  value.writeUInt32LE(size, 6);
  value[12] = channel; value[13] = sign; value[14] = type;
  return value;
}

/** Build a signed legacy video frame whose first 128 media bytes are AES-ECB protected. */
function signedFrame(media: Buffer, keyframe: boolean): Buffer {
  const aesKey = randomBytes(16);
  const meta = Buffer.alloc(22);
  meta.writeUInt32LE(media.length, 0);
  meta[4] = keyframe ? 1 : 0;
  meta[5] = 1;
  const wrapped = publicEncrypt({ key: publicKey, padding: 1 }, aesKey);
  const cipher = createCipheriv("aes-128-ecb", aesKey, null);
  cipher.setAutoPadding(false);
  const protectedPart = Buffer.concat([cipher.update(media.subarray(0, 128)), cipher.final()]);
  return Buffer.concat([meta, wrapped, Buffer.alloc(1), protectedPart, media.subarray(128)]);
}

function media(nalType: number): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 1, nalType]), Buffer.alloc(200, nalType)]);
}

function transport(overrides: Partial<HomeBase2EventFrameTransport> = {}) {
  const calls: string[] = [];
  const value: HomeBase2EventFrameTransport = {
    channel: 2,
    request: (path) => calls.push(`request ${path}`),
    cancel: () => calls.push("cancel"),
    unwrapKey: (wrapped) => privateDecrypt({ key: privateKey, padding: 1 }, wrapped),
    decodeReply: (payload) => payload,
    ...overrides,
  };
  return { value, calls };
}

const PATH = "/media/mmcblk0p1/Camera02/20261010123456.dat";

test("resolves HomeBase 2 clip names and refuses paths outside the camera folders", () => {
  assert.equal(homeBase2RecordingPath("20261010123456", 2), PATH);
  assert.equal(homeBase2RecordingPath("20261010123456.dat", 2), PATH);
  assert.equal(homeBase2RecordingPath(PATH, null), PATH);
  assert.equal(homeBase2RecordingPath("20261010123456", null), null);
  assert.equal(homeBase2RecordingPath("../../etc/passwd", 2), null);
  assert.equal(homeBase2RecordingPath("/etc/passwd", 2), null);
  assert.equal(homeBase2RecordingPath("/media/mmcblk0p1/Camera02/../x.dat", 2), null);
  assert.equal(homeBase2RecordingPath(null, 2), null);
  assert.equal(isHomeBase2RecordingPath("/media/mmcblk0p1/Camera2/x.dat"), false);
});

test("builds the fixed-width HomeBase 2 download value", () => {
  const value = buildHomeBase2DownloadValue(PATH, "account-id");
  assert.equal(value.length, 261);
  assert.deepEqual(value.subarray(0, 5), Buffer.alloc(5));
  assert.equal(value.subarray(5, 5 + PATH.length).toString(), PATH);
  assert.equal(value[5 + PATH.length], 0);
  assert.equal(value.subarray(133, 143).toString(), "account-id");
  assert.equal(value[143], 0);
  assert.throws(() => buildHomeBase2DownloadValue("/etc/passwd", "account-id"));
  assert.throws(() => buildHomeBase2DownloadValue(PATH, ""));
});

test("imports armoured PKCS#8 and bare PKCS#1 cipher keys and refuses anything else", () => {
  const pkcs8 = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const pkcs1 = (privateKey.export({ format: "der", type: "pkcs1" }) as Buffer).toString("base64");
  assert.equal(parseCipherRsaKey(pkcs8)?.asymmetricKeyType, "rsa");
  assert.equal(parseCipherRsaKey(pkcs1)?.asymmetricKeyType, "rsa");
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" });
  assert.equal(parseCipherRsaKey(ec), null);
  assert.equal(parseCipherRsaKey("not a key"), null);
  assert.equal(parseCipherRsaKey(undefined), null);
});

test("keeps video from the first keyframe, decrypts it and stops after enough frames", async () => {
  const { value, calls } = transport();
  const reader = new HomeBase2EventFrameReader(value);
  const pending = reader.firstFrames(PATH);
  assert.equal(reader.downloading, true);
  assert.deepEqual(calls, [`request ${PATH}`]);

  // A delta frame before the first keyframe cannot be decoded and is skipped.
  const delta = signedFrame(media(1), false);
  assert.equal(reader.handleFrame(header(1300, delta.length, 2, 1, 1), delta, 3), true);
  const frames = [signedFrame(media(5), true), ...Array.from({ length: 7 }, () => signedFrame(media(1), false))];
  for (const frame of frames) reader.handleFrame(header(1300, frame.length, 2, 1, 1), frame, 3);

  const result = await pending;
  assert.equal(result.codec, "h264");
  assert.equal(result.frames, 8);
  assert.deepEqual(result.video.subarray(0, 5), Buffer.from([0, 0, 0, 1, 5]));
  assert.equal(reader.downloading, false);
  assert.deepEqual(calls, [`request ${PATH}`, "cancel"]);
});

test("ignores other channels and audio while a clip is read", async () => {
  const { value } = transport();
  const reader = new HomeBase2EventFrameReader(value);
  const pending = reader.firstFrames(PATH);
  const frame = signedFrame(media(5), true);
  assert.equal(reader.handleFrame(header(1300, frame.length, 3, 1, 1), frame, 3), false);
  assert.equal(reader.handleFrame(header(1301, 40, 2, 0, 1), Buffer.alloc(40), 3), true);
  reader.handleFrame(header(1304, 0, 255, 0), Buffer.alloc(0), 2);
  await assert.rejects(pending, /ended before a keyframe/);
});

test("returns the frames received when the station finishes the clip early", async () => {
  const { value } = transport();
  const reader = new HomeBase2EventFrameReader(value);
  const pending = reader.firstFrames(PATH);
  const frame = signedFrame(media(5), true);
  reader.handleFrame(header(1300, frame.length, 2, 1, 1), frame, 3);
  reader.handleFrame(header(1304, 0, 2, 0), Buffer.alloc(0), 2);
  assert.equal((await pending).frames, 1);
});

test("reports a rejected download request and undecryptable video", async () => {
  const rejected = new HomeBase2EventFrameReader(transport().value);
  const pendingRejected = rejected.firstFrames(PATH);
  const result = Buffer.alloc(4);
  result.writeInt32LE(-104, 0);
  rejected.handleFrame(header(1024, 4, 2, 0, 1), result, 0);
  await assert.rejects(pendingRejected, /rejected the recording request \(-104\)/);

  const keyless = new HomeBase2EventFrameReader(transport({ unwrapKey: () => undefined }).value);
  const pendingKeyless = keyless.firstFrames(PATH);
  const frame = signedFrame(media(5), true);
  keyless.handleFrame(header(1300, frame.length, 2, 1, 1), frame, 3);
  await assert.rejects(pendingKeyless, /could not be decrypted/);
});

test("refuses invalid paths, concurrent reads and work after close", async () => {
  const reader = new HomeBase2EventFrameReader(transport().value);
  await assert.rejects(reader.firstFrames("/etc/passwd"), /Invalid HomeBase 2 recording path/);
  const pending = reader.firstFrames(PATH);
  await assert.rejects(reader.firstFrames(PATH), /already active/);
  reader.close();
  await assert.rejects(pending, /session closed/);
  await assert.rejects(reader.firstFrames(PATH), /cancelled/);
});
