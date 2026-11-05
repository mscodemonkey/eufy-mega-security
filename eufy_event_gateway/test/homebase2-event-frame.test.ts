/**
 * Exercises the HomeBase 2 clip reader, its session wiring and its first-picture decode.
 * Tests own every socket and key. Only the local FFmpeg decode leaves the process.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, createECDH, createHmac, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes } from "node:crypto";
import { Socket } from "node:dgram";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { decode, encode } from "jpeg-js";

import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import {
  buildHomeBase2DownloadValue,
  homeBase2RecordingPath,
  HomeBase2EventFrameReader,
  isCroppedEventPicture,
  isHomeBase2RecordingPath,
  parseCipherRsaKey,
  type HomeBase2EventFrameTransport,
} from "../src/stream/homebase2-event-frame.js";
import { extractFirstJpeg } from "../src/stream/live-stream-manager.js";

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

test("resolves HomeBase 2 clip names and refuses paths outside the camera's own folder", () => {
  assert.equal(homeBase2RecordingPath("20261010123456", 2), PATH);
  assert.equal(homeBase2RecordingPath("20261010123456.dat", 2), PATH);
  assert.equal(homeBase2RecordingPath(PATH, 2), PATH);
  assert.equal(homeBase2RecordingPath(PATH, 3), null);
  assert.equal(homeBase2RecordingPath("20261010123456", 100), null);
  assert.equal(homeBase2RecordingPath("../../etc/passwd", 2), null);
  assert.equal(homeBase2RecordingPath("/etc/passwd", 2), null);
  assert.equal(homeBase2RecordingPath("/media/mmcblk0p1/Camera02/../x.dat", 2), null);
  assert.equal(homeBase2RecordingPath(null, 2), null);
  assert.equal(homeBase2RecordingPath(undefined, 2), null);
  assert.equal(isHomeBase2RecordingPath("/media/mmcblk0p1/Camera2/x.dat"), false);
});

test("treats only a readable narrow JPEG as a cropped event picture", () => {
  const jpeg = (width: number): Buffer => encode({ width, height: 16, data: Buffer.alloc(width * 16 * 4, 90) }, 50).data;
  assert.equal(isCroppedEventPicture(jpeg(152)), true);
  assert.equal(isCroppedEventPicture(jpeg(319)), true);
  assert.equal(isCroppedEventPicture(jpeg(320)), false);
  assert.equal(isCroppedEventPicture(jpeg(640)), false);
  assert.equal(isCroppedEventPicture(Buffer.alloc(0)), false);
  assert.equal(isCroppedEventPicture(Buffer.from([255, 216, 1, 2, 255, 217])), false);
  assert.equal(isCroppedEventPicture(jpeg(152).subarray(0, 12)), false);
  assert.equal(isCroppedEventPicture(Buffer.from("not a picture at all")), false);
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

/** Encode deterministic Annex B H.264 without involving a camera. */
async function videoFixture(): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "homebase2-event-frame-"));
  const source = join(directory, "source.h264");
  try {
    await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10",
      "-t", "0.5", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-f", "h264", source]);
    return await readFile(source);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("decodes the first picture of a keyframe-led stream to one JPEG", async () => {
  const image = decode(await extractFirstJpeg(await videoFixture(), "h264"));
  assert.equal(image.width, 160); assert.equal(image.height, 90);
});

test("reports undecodable video and cancellation without decoder output", async () => {
  await assert.rejects(extractFirstJpeg(Buffer.from("not video"), "h264"), /^Error: Recorded event frame could not be decoded \(status \d+\)$/);
  await assert.rejects(extractFirstJpeg(await videoFixture(), "h264", AbortSignal.abort()), (error: Error) => error.name === "AbortError");
});

test("the reader decodes the first picture of a transferred clip", async () => {
  const video = await videoFixture();
  const { value } = transport();
  const reader = new HomeBase2EventFrameReader(value);
  const pending = reader.firstFrameJpeg(PATH);
  const meta = Buffer.alloc(22); meta.writeUInt32LE(video.length, 0); meta[4] = 1; meta[5] = 1;
  const frame = Buffer.concat([meta, video]);
  reader.handleFrame(header(1300, frame.length, 2, 0, 1), frame, 3);
  reader.handleFrame(header(1304, 0, 2, 0), Buffer.alloc(0), 2);
  assert.equal(decode(await pending).width, 160);
});

/** Deliver one complete invented frame through the session's real listener. */
function deliver(socket: Socket, command: number, payload: Buffer, sign: number, sequence: number, type = 0, channel = 255): void {
  const frame = Buffer.alloc(16); frame.write("XZYH"); frame.writeUInt16LE(command, 4); frame.writeUInt32LE(payload.length, 6);
  frame[12] = channel; frame[13] = sign;
  const outer = Buffer.from([0xf1, 0xd0, 0, 0, 0xd1, 0, 0, 0]); outer.writeUInt16BE(sequence, 6); outer[5] = type;
  socket.emit("message", Buffer.concat([outer, frame, payload]), { address: "127.0.0.1", port: 12345 });
}

/** Negotiate an invented HomeBase 2 gateway key while replacing every network operation. */
async function peer(context: TestContext, stationModel = "T8010") {
  let socket!: Socket;
  const sent: Buffer[] = [];
  context.mock.method(Socket.prototype, "bind", function(this: Socket) {
    socket = this;
    queueMicrotask(() => this.emit("message", Buffer.from([0xf1, 0x42, 0, 0]), { address: "127.0.0.1", port: 12345 }));
    return this;
  });
  context.mock.method(Socket.prototype, "send", function(data: Buffer) { sent.push(Buffer.from(data)); });
  context.mock.method(Socket.prototype, "close", function(this: Socket) { return this; });
  const recipient = createECDH("prime256v1"), ephemeral = createECDH("prime256v1");
  recipient.setPrivateKey(Buffer.alloc(32, 1)); ephemeral.setPrivateKey(Buffer.alloc(32, 2));
  const shared = ephemeral.computeSecret(recipient.getPublicKey()), label = Buffer.from("ECIES");
  const hmac = (value: Buffer): Buffer => createHmac("sha256", shared).update(value).digest();
  let previous: Buffer<ArrayBufferLike> = label, derived: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (derived.length < 48) { previous = hmac(previous); derived = Buffer.concat([derived, hmac(Buffer.concat([previous, label]))]); }
  const key = Buffer.alloc(32, 9), iv = Buffer.alloc(16, 3), envelope = Buffer.alloc(129);
  ephemeral.getPublicKey(undefined, "compressed").copy(envelope); iv.copy(envelope, 33);
  const wrap = createCipheriv("aes-128-cbc", derived.subarray(0, 16), iv);
  Buffer.concat([wrap.update(key), wrap.final()]).copy(envelope, 49);
  createHmac("sha256", derived.subarray(16, 48)).update(envelope.subarray(33, 97)).digest().copy(envelope, 97);
  const plain = Buffer.alloc(144); plain.writeUInt16LE(1); envelope.copy(plain, 4);
  const legacy = createCipheriv("aes-128-ecb", LEVEL_ONE_KEY, null); legacy.setAutoPadding(false);
  const session = new FirstPartyPpcsSession({ stationSerial: "SYNTHETIC1234567", p2pDid: "TEST-12345678-TEST", appConnection: "",
    dskKey: "synthetic", channel: 2, homeBaseAttached: true, cameraModel: "T8140", stationModel, accountId: "inventedaccount",
    recordingCameraSerial: "invented-child", purpose: "control", resolveCipherKey: async () => recipient.getPrivateKey().toString("hex") });
  await session.start(); deliver(socket, 1100, Buffer.concat([legacy.update(plain), legacy.final()]), 1, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.stats.level2, 1);
  return { session, socket, sent };
}

const LEVEL_ONE_KEY = Buffer.from("1234567-12345678");
const commands = (sent: readonly Buffer[]): Buffer[] => sent.filter(wire => wire.subarray(8, 12).toString() === "XZYH");

/** Decrypt one level-one command, checking the envelope a T8010 direct command uses on channel 2. */
function levelOneCommand(wire: Buffer): Buffer {
  assert.equal(wire.readUInt16LE(14), wire.length - 24);
  assert.deepEqual([...wire.subarray(18, 23)], [1, 0, 2, 1, 0]);
  const decipher = createDecipheriv("aes-128-ecb", LEVEL_ONE_KEY, null); decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(wire.subarray(24)), decipher.final()]);
}

test("the session reads one signed clip without starting media", async context => {
  const video = await videoFixture();
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { session, socket, sent } = await peer(context);
  try {
    const reading = session.readHomeBase2EventFrame(PATH, privateKey, new AbortController().signal);
    await new Promise(resolve => setImmediate(resolve));
    const request = commands(sent).at(-1)!;
    assert.equal(request.readUInt16LE(12), 1024);
    const value = levelOneCommand(request);
    assert.equal(value.length, 272, "the 261-byte value is padded to AES blocks");
    assert.deepEqual(value.subarray(0, 261), buildHomeBase2DownloadValue(PATH, "inventedaccount"));

    // Binary and control data are sequenced independently, and only the first is media.
    deliver(socket, 1300, signedFrame(video, true), 1, 0, 3, 2);
    deliver(socket, 1304, Buffer.alloc(0), 0, 0, 2, 2);
    const image = decode(await reading);
    assert.equal(image.width, 160); assert.equal(image.height, 90);
    const cancel = commands(sent).at(-1)!;
    assert.equal(cancel.readUInt16LE(12), 1051, "the station is told to stop the rest of the clip");
    assert.equal(levelOneCommand(cancel).readUInt32LE(0), 2);
    assert.equal(session.stats.mediaStartAttempts, 0);
    assert.deepEqual(commands(sent).map(wire => wire.readUInt16LE(12)), [1100, 1024, 1051]);
    await assert.rejects(session.readHomeBase2EventFrame(PATH, privateKey, AbortSignal.abort()), /cancelled/);
  } finally { session.close(); }
});

test("binary data is ignored unless a clip is being read", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { session, socket } = await peer(context);
  try {
    const before = session.stats.frameHeaders;
    deliver(socket, 1300, signedFrame(media(5), true), 1, 0, 3, 2);
    assert.equal(session.stats.frameHeaders, before);
  } finally { session.close(); }
});

test("closing the session ends a clip read without sending to the closed socket", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { session, sent } = await peer(context);
  const reading = session.readHomeBase2EventFrame(PATH, privateKey, new AbortController().signal);
  await new Promise(resolve => setImmediate(resolve));
  session.close();
  await assert.rejects(reading, /session closed/);
  assert.deepEqual(commands(sent).map(wire => wire.readUInt16LE(12)), [1100, 1024], "no cancel follows the close");
});

test("a clip read is refused outside an idle HomeBase 2 control session", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { session, sent } = await peer(context, "T8030");
  try {
    await assert.rejects(session.readHomeBase2EventFrame(PATH, privateKey, new AbortController().signal), /idle HomeBase 2 control session/);
    assert.deepEqual(commands(sent).map(wire => wire.readUInt16LE(12)), [1100]);
  } finally { session.close(); }
});
