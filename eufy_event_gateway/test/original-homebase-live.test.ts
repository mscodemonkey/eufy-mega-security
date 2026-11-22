/**
 * Exercises T8001 live video through the real provider and PPCS session.
 * Synthetic inventory, keys and UDP replies own every byte. No account, camera or network is used.
 * The clear 133-byte gateway reply reproduces the shape reported from a T8001.
 */
import assert from "node:assert/strict";
import { constants, createCipheriv, createDecipheriv, createPublicKey, generateKeyPairSync, privateEncrypt, publicEncrypt, randomBytes } from "node:crypto";
import { Socket } from "node:dgram";
import test, { type TestContext } from "node:test";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { originalHomeBaseStartCommand, selectOriginalHomeBaseSeal, usesOriginalHomeBaseLive } from "../src/stream/original-homebase-live.js";

const STATION = "T8001P1234567890";
const CAMERA = "T8111P0000000001";
const DERIVED = Buffer.from("4567890-12345678");
const RSA_KEY = Buffer.alloc(16, 9);
const CHANNEL = 2;
const account = generateKeyPairSync("rsa", { modulusLength: 1024 });
const pkcs8 = account.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

interface Options {
  readonly station?: string;
  readonly firmware?: string | null;
  readonly sign?: number;
  readonly lookup?: "sn" | "omitted" | "none" | "fail" | "partial";
  readonly held?: Promise<void>;
  readonly keyBytes?: Buffer;
  readonly did?: string;
  readonly cameraOwner?: string;

  /** Runs in place of the normal gateway answer. */
  readonly answer?: (send: (command: number, body: Buffer, sign?: number, type?: number, sequence?: number, from?: string) => void, info: Buffer) => void;
}

/** Apply or remove unpadded ECB around block-aligned synthetic values. */
function ecb(value: Buffer, key: Buffer, decrypt = false): Buffer {
  const cipher = decrypt ? createDecipheriv("aes-128-ecb", key, null) : createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(value), cipher.final()]);
}

/** Let microtask-owned packet and lookup work drain without advancing real timers. */
async function settle(): Promise<void> {
  for (let index = 0; index < 12; index++) await new Promise((resolve) => setImmediate(resolve));
}

/** Own one provider, station and T8111 with a peer that answers gateway-info. */
async function fixture(context: TestContext, options: Options = {}) {
  let socket!: Socket;
  let answered = false;
  let gatewayInfo: Buffer;
  const sequences = [0, 0, 0];
  const packets: Buffer[] = [];
  const lookups: string[] = [];
  const output: Buffer[] = [];
  const remote = { address: "127.0.0.1", port: 12345 };
  const incoming = (command: number, body: Buffer, sign = 0, type = 2, kind = 0, channel = CHANNEL,
    sequence = sequences[type]!++, address = remote.address): void => {
    const frame = Buffer.alloc(24 + body.length);
    frame.set([0xf1, 0xd0]); frame.writeUInt16BE(frame.length - 4, 2);
    frame.set([0xd1, type], 4); frame.writeUInt16BE(sequence, 6);
    frame.write("XZYH", 8); frame.writeUInt16LE(command, 12); frame.writeUInt32LE(body.length, 14);
    frame[18] = 1; frame[20] = channel; frame[21] = sign; frame[22] = kind;
    body.copy(frame, 24);
    socket.emit("message", frame, { ...remote, address });
  };
  context.mock.method(Socket.prototype, "bind", function(this: Socket) {
    socket = this; queueMicrotask(() => this.emit("message", Buffer.from([0xf1, 0x42, 0, 0]), remote)); return this;
  });
  context.mock.method(Socket.prototype, "close", function(this: Socket) { return this; });
  context.mock.method(Socket.prototype, "send", function(this: Socket, packet: Buffer, ...args: unknown[]) {

    // A preceding test's stop drain may still be finishing on its own socket.
    if (this === socket) packets.push(Buffer.from(packet));
    const callback = args.at(-1); if (typeof callback === "function") queueMicrotask(() => callback());
    if (answered || packet.length < 24 || packet.readUInt16LE(12) !== 1100) return;
    answered = true;
    const info = Buffer.alloc(options.sign === 1 ? 144 : 133);
    info.writeUInt16LE(7);
    publicEncrypt({ key: account.publicKey, padding: constants.RSA_PKCS1_PADDING }, options.keyBytes ?? RSA_KEY).copy(info, 4);
    gatewayInfo = info;
    if (options.answer) {
      const { answer } = options;
      queueMicrotask(() => answer((command, body, sign, type, sequence, from) => incoming(command, body, sign, type, 0, CHANNEL, sequence, from), info));
      return;
    }
    queueMicrotask(() => incoming(1100, options.sign === 1 ? ecb(info, DERIVED) : info, options.sign ?? 0));
  });
  context.mock.method(globalThis, "fetch", async () => { assert.fail("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
    { device_sn: STATION, device_model: options.station ?? "T8001", device_type: 0, category: "eufy_security",
      device_channel: 255, main_sw_version: options.firmware === undefined ? "2.1.8.8h" : options.firmware,
      p2p_did: options.did ?? "TEST-12345678-TEST", p2p_conn: "synthetic-route", member: { admin_user_id: "synthetic-owner" } },
    { device_sn: CAMERA, device_model: "T8111", device_type: 1, category: "eufy_security", parent_sn: STATION,
      station_sn: STATION, device_channel: CHANNEL, member: { admin_user_id: options.cameraOwner ?? "synthetic-owner" } },
    ...[0, 1, 3].map((channel) => ({ device_sn: `T8111P000000001${channel}`, device_model: "T8111", device_type: 1,
      category: "eufy_security", parent_sn: STATION, station_sn: STATION, device_channel: channel })),
  ] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ [STATION]: { key: "synthetic", expiresAt: null } }));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
  context.mock.method(MegaClient.prototype, "getCiphers", async (_ids: readonly number[], _owner: string, _serial: string, field = "station_sn") => {
    lookups.push(field);
    await options.held;
    const mode = options.lookup ?? "omitted";
    if (mode === "fail" || mode === "partial" && field === "omitted") throw new Error("synthetic lookup failure");
    return (mode === field || mode === "partial" ? [{ cipher_id: 7, private_key: pkcs8 }] : []) as never;
  });
  const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "US",
    persistentDirectory: "/nonexistent/synthetic", maxStreamSeconds: 120 });
  context.after(async () => { await provider.close(); });
  await provider.start(new Proxy({}, { get: (_target, key) => key === "streamStarted"
    ? (_serial: string, stream: NodeJS.ReadableStream) => stream.on("data", (data: Buffer) => output.push(data))
    : () => undefined }) as ProviderEvents);
  await provider.startStream(CAMERA);
  await settle();
  const commands = (command: number) => packets
    .filter((packet) => packet.length >= 24 && packet.subarray(8, 12).toString() === "XZYH" && packet.readUInt16LE(12) === command)
    .map((packet) => ({ sequence: packet.readUInt16BE(6), channel: packet[20], sign: packet[21], body: packet.subarray(24) }));
  const answerLatest = (): void => incoming(1100, gatewayInfo, 0, 2, 0, CHANNEL, 0);
  return { provider, incoming, commands, lookups, output, packets, answerLatest };
}

for (const station of ["T8001"]) {
  for (const sign of [0, 1]) {
    test(`${station} starts and stops with RSA after gateway sign ${sign}`, async (context) => {
      const f = await fixture(context, { station, sign });
      const [start] = f.commands(1350);
      assert.ok(start);
      assert.deepEqual([start.channel, start.sign], [CHANNEL, 2]);
      const value = JSON.parse(ecb(start.body, RSA_KEY, true).toString().replace(/\0+$/, ""));
      assert.deepEqual({ ...value, payload: { ...value.payload, key: value.payload.key.length } }, {
        account_id: "synthetic-owner", cmd: 1003, mValue3: 1003,
        payload: { ClientOS: "Android", key: 256, streamtype: 1 },
      });
      assert.deepEqual(f.lookups, ["omitted"]);
      await f.provider.stopStream(CAMERA);
      const [stop] = f.commands(1004);
      assert.ok(stop);
      assert.deepEqual([stop.channel, stop.sign], [CHANNEL, 2]);
      assert.equal(ecb(stop.body, RSA_KEY, true).readUInt32LE(), CHANNEL);
    });
  }
}

for (const lookup of ["none", "fail"] as const) {
  test(`an original HomeBase falls back to its derived key: ${lookup}`, async (context) => {
    const f = await fixture(context, { lookup });
    const [start] = f.commands(1350);
    assert.ok(start);
    assert.equal(start.sign, 1);
    assert.equal(JSON.parse(ecb(start.body, DERIVED, true).toString().replace(/\0+$/, "")).cmd, 1003);
    await f.provider.stopStream(CAMERA);
    assert.equal(ecb(f.commands(1004)[0]!.body, DERIVED, true).readUInt32LE(), CHANNEL);
  });
}

for (const lookup of ["sn", "partial"] as const) {
  test(`either older RSA lookup can supply the key: ${lookup}`, async (context) => {
    assert.equal((await fixture(context, { lookup })).commands(1350)[0]?.sign, 2);
  });
}

test("a delivered key of another size keeps v4's clear command form", async (context) => {
  const f = await fixture(context, { keyBytes: Buffer.alloc(24, 4) });
  assert.equal(f.commands(1350)[0]?.sign, 0);
  await f.provider.stopStream(CAMERA);
  assert.deepEqual(f.commands(1004)[0]?.body, Buffer.from([CHANNEL, 0, 0, 0]));
});

for (const firmware of ["2.0.9.6", null]) {
  test(`older or unknown firmware uses the clear direct start: ${firmware}`, async (context) => {
    const f = await fixture(context, { firmware });
    const [start] = f.commands(1003);
    assert.ok(start);
    assert.deepEqual([start.channel, start.sign, start.body.length], [CHANNEL, 0, 260]);
    assert.equal(start.body.readUInt32LE(), CHANNEL);
    assert.match(start.body.subarray(4).toString(), /^[a-f0-9]{256}$/);
    assert.equal(f.commands(1350).length, 0);
  });
}

for (const station of ["T8010", "T8002"]) test(`${station} keeps its existing route without the older lookup`, async (context) => {
  const f = await fixture(context, { station });
  assert.equal(f.commands(1350).length + f.commands(1003).length, 0);
  assert.deepEqual(f.lookups, []);
});

test("closing during key lookup cannot start or stop the camera", async (context) => {
  let release!: () => void;
  const f = await fixture(context, { held: new Promise<void>((resolve) => { release = resolve; }) });
  await f.provider.stopStream(CAMERA);
  release();
  await settle();
  assert.equal(f.commands(1350).length + f.commands(1004).length, 0);
});

test("repeated gateway replies start the camera once", async (context) => {
  const f = await fixture(context);
  f.incoming(1100, Buffer.alloc(133));
  await settle();
  assert.equal(f.commands(1350).length, 1);
});

test("busy results are spaced, use fresh sequences and stay bounded", async (context) => {
  const f = await fixture(context);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const busy = Buffer.alloc(16); busy.writeInt32LE(503);
  f.incoming(1350, ecb(busy, RSA_KEY), 2, 0, 1);
  f.incoming(1350, ecb(busy, RSA_KEY), 2, 0, 1);
  assert.equal(f.commands(1350).length, 1);
  context.mock.timers.tick(999);
  assert.equal(f.commands(1350).length, 1);
  context.mock.timers.tick(1);
  for (let index = 0; index < 14; index++) {
    f.incoming(1350, ecb(busy, RSA_KEY), 2, 0, 1);
    context.mock.timers.tick(1000);
  }
  const starts = f.commands(1350);
  assert.equal(new Set(starts.map((start) => start.sequence)).size, 11);
  for (const start of starts) assert.deepEqual(start.body, starts[0]!.body);
  context.mock.timers.reset();
});

test("a rejected start is not repeated", async (context) => {
  const f = await fixture(context);
  const rejected = Buffer.alloc(4); rejected.writeInt32LE(-104);
  f.incoming(1350, rejected, 0, 0, 1);
  assert.equal(f.commands(1350).length, 1);
});

test("a device ping receives v4's empty echo on its channel", async (context) => {
  const f = await fixture(context);
  f.incoming(1152, Buffer.alloc(8));
  assert.deepEqual(f.commands(1152).map(({ channel, sign, body }) => [channel, sign, body.length]), [[CHANNEL, 0, 0]]);
});

test("RSA-protected video and short continuation chunks keep byte order", async (context) => {
  const f = await fixture(context);
  const start = f.commands(1350)[0]!;
  const modulus = JSON.parse(ecb(start.body, RSA_KEY, true).toString().replace(/\0+$/, "")).payload.key as string;
  const publicKey = createPublicKey({ format: "jwk", key: { kty: "RSA", e: "AQAB", n: Buffer.from(modulus, "hex").toString("base64url") } });
  const first = Buffer.alloc(300, 0x55);
  Buffer.from([0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 1, 0, 0, 0, 1, 0x65]).copy(first);
  const mediaKey = randomBytes(16);
  const head = Buffer.alloc(22); head.writeUInt32LE(first.length); head[4] = 1;
  f.incoming(1300, Buffer.concat([head, publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, mediaKey),
    Buffer.alloc(1), ecb(first.subarray(0, 128), mediaKey), first.subarray(128)]), 1, 1);
  const tail = Buffer.alloc(90, 0x33);
  const next = Buffer.alloc(22); next.writeUInt32LE(tail.length);
  f.incoming(1300, Buffer.concat([next, tail]), 0, 1);
  f.incoming(1300, Buffer.concat([next, Buffer.alloc(90, 0x77)]), 0, 1, 0, 1);
  await settle();
  assert.deepEqual(Buffer.concat(f.output), Buffer.concat([first, tail]));
});

test("key parsing accepts every label and container v4 or OpenSSL produces", () => {
  const info = Buffer.concat([Buffer.alloc(4), publicEncrypt({ key: account.publicKey, padding: constants.RSA_PKCS1_PADDING }, RSA_KEY)]);
  const keys = [pkcs8, `-----BEGIN RSA PRIVATE KEY-----\n${pkcs8}\n-----END RSA PRIVATE KEY-----`,
    account.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    account.privateKey.export({ type: "pkcs1", format: "pem" }).toString()];
  for (const key of keys) assert.deepEqual(selectOriginalHomeBaseSeal(info, [key], DERIVED).key, RSA_KEY);
});

test("bad key material fails closed to the derived key", () => {
  const invalid = Buffer.alloc(128, 1);
  const info = Buffer.concat([Buffer.alloc(4), privateEncrypt({ key: account.privateKey, padding: constants.RSA_PKCS1_PADDING }, RSA_KEY)]);
  for (const [body, keys, reason] of [
    [info, null, "lookup_failed"], [info, [], "no_rsa_key"], [info, ["not a key"], "key_invalid"],
    [Buffer.alloc(8, 1), [pkcs8], "gateway_short"], [Buffer.concat([Buffer.alloc(4), invalid]), [pkcs8], "unwrap_failed"],
  ] as const) assert.deepEqual(selectOriginalHomeBaseSeal(body, keys, DERIVED), { signCode: 1, key: DERIVED, reason });
});

test("an empty key field uses clear commands only when the account has a key", () => {
  for (const info of [Buffer.alloc(4), Buffer.alloc(133)]) {
    assert.deepEqual(selectOriginalHomeBaseSeal(info, [pkcs8], DERIVED), { signCode: 0, key: null, reason: "empty_key_field" });
    assert.equal(selectOriginalHomeBaseSeal(info, [], DERIVED).signCode, 1);
    assert.equal(selectOriginalHomeBaseSeal(info, ["not a key"], DERIVED).signCode, 1);
  }
});

test("the firmware boundary matches v4", () => {
  for (const [version, command] of [["2.0.9.6", 1003], ["2.0.9.7", 1350], ["2.0.10", 1350], ["2.0.9", 1003],
    ["3.1", 1350], ["1.9.99.99", 1003], ["2.1.8.8h", 1350], ["unknown", 1003]] as const) {
    assert.equal(originalHomeBaseStartCommand(version), command, version);
  }
});

test("only T8111 media through an exact original HomeBase is admitted", () => {
  const exact = { cameraModel: "T8111", cameraDeviceType: 1, stationModel: "T8001", stationDeviceType: 0, channel: 0, homeBaseAttached: true };
  assert.equal(usesOriginalHomeBaseLive(exact), true);
  for (const change of [{ stationModel: "T8002" }, { stationModel: "T8010" }, { stationModel: "T8030" }, { stationDeviceType: 18 }, { cameraModel: "T8113-Z" },
    { cameraDeviceType: 8 }, { homeBaseAttached: false }, { purpose: "control" as const }, { channel: 255 }]) {
    assert.equal(usesOriginalHomeBaseLive({ ...exact, ...change }), false);
  }
});

test("an early successor cannot hide the first gateway datagram", async (context) => {
  const f = await fixture(context, { answer: (send, info) => { send(1351, Buffer.alloc(48), 1, 2, 1); send(1100, info, 0, 2, 0); } });
  assert.equal(f.commands(1350)[0]?.sign, 2);
});

test("a DATA result cannot replace CONTROL gateway info", async (context) => {
  const f = await fixture(context, { answer: (send, info) => { send(1100, Buffer.alloc(4), 0, 0, 0); send(1100, info, 0, 2, 0); } });
  assert.equal(f.commands(1350)[0]?.sign, 2);
});

test("gateway info from another sender is ignored", async (context) => {
  const f = await fixture(context, { answer: (send, info) => { send(1100, Buffer.alloc(133), 0, 2, 0, "192.0.2.9"); send(1100, info, 0, 2, 0); } });
  assert.equal(f.commands(1350)[0]?.sign, 2);
});

test("a ping flood cannot amplify or exhaust the command sequence", async (context) => {
  const f = await fixture(context);
  for (let index = 0; index < 70_000; index++) f.incoming(1152, Buffer.alloc(0), 0, 2, 0, CHANNEL, (index + 1) & 0xffff);
  assert.equal(new Set(f.commands(1152).map((reply) => reply.sequence)).size, 1);
  await f.provider.stopStream(CAMERA);
});

test("a malformed station DID fails the stream instead of rejecting unhandled", async (context) => {
  const f = await fixture(context, { did: "BAD", lookup: "none" });
  assert.equal(f.commands(1350).length, 0);
});

test("the start carries the station owner's account", async (context) => {
  const f = await fixture(context, { cameraOwner: "another-account" });
  const value = JSON.parse(ecb(f.commands(1350)[0]!.body, RSA_KEY, true).toString().replace(/\0+$/, ""));
  assert.equal(value.account_id, "synthetic-owner");
});

test("a slow key lookup falls back inside the first-frame deadline", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(context, { held: new Promise<void>(() => undefined) });
  context.mock.timers.tick(10_000);
  await settle();
  assert.equal(f.commands(1350)[0]?.sign, 1);
  context.mock.timers.reset();
});

test("video joins at a start code and keeps short signed chunks", async (context) => {
  const f = await fixture(context);
  const chunk = (data: Buffer): Buffer => {
    const head = Buffer.alloc(22); head.writeUInt32LE(data.length);
    return Buffer.concat([head, data]);
  };
  const begun = Buffer.from([0, 0, 0, 1, 0x67, 1, 2, 3]);
  const tail = Buffer.alloc(90, 0x44);
  f.incoming(1300, chunk(Buffer.from([0, 9, 9, 9, 9, 9])), 0, 1);
  f.incoming(1300, chunk(begun), 1, 1);
  f.incoming(1300, chunk(tail), 1, 1);
  await settle();
  assert.deepEqual(Buffer.concat(f.output), Buffer.concat([begun, tail]));
});

test("a start without an ACK is repeated beyond three seconds", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const f = await fixture(context);
  context.mock.timers.tick(4000);
  const before = f.commands(1350).length;
  context.mock.timers.tick(300);
  assert.ok(f.commands(1350).length > before);
  context.mock.timers.reset();
});

test("a stop is repeated before the peer is ended", async (context) => {
  const f = await fixture(context);
  await f.provider.stopStream(CAMERA);
  const stops = f.commands(1004);
  assert.equal(stops.length, 3);
  assert.equal(new Set(stops.map((stop) => stop.sequence)).size, 1);
  const end = f.packets.findIndex((packet) => packet.readUInt16BE(0) === 0xf1f0);
  const lastStop = f.packets.findLastIndex((packet) => packet.length >= 24 && packet.readUInt16LE(12) === 1004);
  assert.ok(end > lastStop);
});

test("four cameras share one queued cloud key lookup", async (context) => {
  let release!: () => void;
  const f = await fixture(context, {
    held: new Promise<void>((resolve) => { release = resolve; }),
    answer: (send, info) => send(1100, info, 0, 2, 0),
  });
  for (const channel of [0, 1, 3]) {
    await f.provider.startStream(`T8111P000000001${channel}`);
    f.answerLatest();
    await settle();
  }
  assert.deepEqual(f.lookups, ["omitted"]);
  release();
  await settle();
});


for (const result of [0, -104]) {
  test(`terminal result ${result} retires a queued busy retry`, async (context) => {
    const f = await fixture(context);
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const busy = Buffer.alloc(4); busy.writeInt32LE(503);
    f.incoming(1350, busy, 0, 0, 1);
    const terminal = Buffer.alloc(4); terminal.writeInt32LE(result);
    f.incoming(1350, terminal, 0, 0, 1);
    f.incoming(1350, busy, 0, 0, 1);
    context.mock.timers.tick(1000);
    const starts = f.commands(1350).length;
    context.mock.timers.reset();
    assert.equal(starts, 1);
  });
}

test("a foreign child result cannot schedule a busy retry", async (context) => {
  const f = await fixture(context);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const busy = Buffer.alloc(4); busy.writeInt32LE(503);
  f.incoming(1350, busy, 0, 0, 1, CHANNEL + 1);
  context.mock.timers.tick(1000);
  const starts = f.commands(1350).length;
  context.mock.timers.reset();
  assert.equal(starts, 1);
});
