/**
 * Exercises the manual history query through a synthetic encrypted PPCS peer.
 * Tests own sockets and keys and verify one metadata request and one image read with no media start.
 */
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createECDH, createHmac } from "node:crypto";
import { encode } from "jpeg-js";
import { Socket } from "node:dgram";
import test, { type TestContext } from "node:test";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";

/** Deliver one complete invented station-channel control frame through the real listener. */
function deliver(socket: Socket, command: number, payload: Buffer, sign: number, sequence: number, type = 0): void {
  const frame = Buffer.alloc(16); frame.write("XZYH"); frame.writeUInt16LE(command, 4); frame.writeUInt32LE(payload.length, 6);
  frame[12] = 255; frame[13] = sign;
  const header = Buffer.from([0xf1, 0xd0, 0, 0, 0xd1, 0, 0, 0]); header.writeUInt16BE(sequence, 6); header[5] = type;
  socket.emit("message", Buffer.concat([header, frame, payload]), { address: "127.0.0.1", port: 12345 });
}

/** Negotiate an invented gateway key while replacing every network operation. */
async function peer(context: TestContext) {
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
  const legacy = createCipheriv("aes-128-ecb", Buffer.from("1234567-12345678"), null); legacy.setAutoPadding(false);
  const session = new FirstPartyPpcsSession({ stationSerial: "SYNTHETIC1234567", p2pDid: "TEST-12345678-TEST", appConnection: "",
    dskKey: "synthetic", channel: 2, homeBaseAttached: true, cameraModel: "T8113-Z", stationModel: "T8030", accountId: "inventedaccount",
    recordingCameraSerial: "invented-child", purpose: "control", resolveCipherKey: async () => recipient.getPrivateKey().toString("hex") });
  await session.start(); deliver(socket, 1100, Buffer.concat([legacy.update(plain), legacy.final()]), 1, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.stats.level2, 1);
  return { session, socket, sent, key };
}

for (const protection of ["bootstrap", "legacy"] as const) for (const operationKind of ["diagnostic", "recovery"] as const) test(`thumbnail session uses distinct outbound and receive keys with ${protection} replies for ${operationKind}`, async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { session, socket, sent, key } = await peer(context);
  const commands = () => sent.filter(v => v.subarray(8, 12).toString() === "XZYH");
  const request = (wire: Buffer) => {
    const body = wire.subarray(24), decoder = createDecipheriv("aes-256-gcm", key, body.subarray(16, 28));
    decoder.setAAD(Buffer.from("eufy security")); decoder.setAuthTag(body.subarray(0, 16));
    return JSON.parse(Buffer.concat([decoder.update(body.subarray(32)), decoder.final()]).toString());
  };
  const reply = (value: unknown) => {
    if (protection === "legacy") {
      const body = Buffer.from(JSON.stringify(value)), padding = Buffer.alloc(16 - body.length % 16, 0x5a); padding[0] = 0;
      const cipher = createCipheriv("aes-128-ecb", Buffer.from("1234567-12345678"), null); cipher.setAutoPadding(false);
      return Buffer.concat([cipher.update(Buffer.concat([body, padding])), cipher.final()]);
    }
    const receive = Buffer.alloc(32); Buffer.from("inventedaccount").copy(receive); Buffer.from("1234567").copy(receive);
    const nonce = Buffer.alloc(12, 4), cipher = createCipheriv("aes-256-gcm", receive, nonce);
    cipher.setAAD(Buffer.from("eufy security"));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([cipher.getAuthTag(), nonce, encrypted]);
  };
  try {
    const storagePath = "/zx/hdd_data0/Camera00/202611/20261102090000/20261102092000.zxvideo";
    const operation = operationKind === "diagnostic" ? session.readEventPicture("2026-11-02", "123", "122")
      : session.recoverEventPicture({ id: "122", storagePath, triggerMilliseconds: 1_793_568_000_000 }, new AbortController().signal);
    await new Promise(resolve => setImmediate(resolve));
    const query = request(commands()[1]!);
    assert.equal(query.cmd, 1306); assert.equal(query.payload.payload.start_id, operationKind === "diagnostic" ? 123 : 0);
    const file = "/recordings/camera0/fixture.jpg";
    deliver(socket, 1306, reply({ cmd: 10011, table: "history_record_info", transaction: query.payload.transaction, mIntRet: 0,
      data: [{ table_name: "history_record_info", payload: [{ record_id: 122, device_sn: "invented-child",
        station_sn: "SYNTHETIC1234567", device_type: 8, storage_path: storagePath, start_time: "2026-11-02 09:20:00", time_zone: "+1000", thumb_path: file }] }] }), 1, 1);
    await new Promise(resolve => setImmediate(resolve));
    const imageWire = commands()[2]!, imageRequest = request(imageWire);
    assert.equal(imageWire[20], 0); assert.equal(imageWire[21], 8);
    assert.deepEqual(imageRequest, { account_id: "inventedaccount", cmd: 1308, mChannel: 0, mValue3: 0, payload: [{ file }] });
    const jpeg = encode({ width: 8, height: 4, data: Buffer.alloc(8 * 4 * 4, 127) }, 50).data;
    deliver(socket, 1308, reply({ file, content: jpeg.toString("base64url") }), 1, 0, 2);
    if (operationKind === "recovery") { const data = await operation; assert.deepEqual(data, jpeg); if (Buffer.isBuffer(data)) data.fill(0); }
    else assert.deepEqual(await operation, { scope: "one_history_thumbnail", records: 1, imageBytes: jpeg.length, width: 8, height: 4 });
    assert.equal(session.stats.mediaStartAttempts, 0);
    assert.deepEqual(commands().map(v => v.readUInt16LE(12)), [1100, 1350, 1350]);
  } finally { session.close(); }
});
