/**
 * Exercises the manual history query through a synthetic encrypted PPCS peer.
 * Tests own sockets and keys and verify one metadata request with no media start.
 */
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createECDH, createHmac } from "node:crypto";
import { Socket } from "node:dgram";
import test, { type TestContext } from "node:test";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";

/** Deliver one complete invented station-channel control frame through the real listener. */
function deliver(socket: Socket, command: number, payload: Buffer, sign: number, sequence: number): void {
  const frame = Buffer.alloc(16); frame.write("XZYH"); frame.writeUInt16LE(command, 4); frame.writeUInt32LE(payload.length, 6);
  frame[12] = 255; frame[13] = sign;
  const header = Buffer.from([0xf1, 0xd0, 0, 0, 0xd1, 0, 0, 0]); header.writeUInt16BE(sequence, 6);
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
    dskKey: "synthetic", channel: 2, homeBaseAttached: true, cameraModel: "T8210", stationModel: "T8030", accountId: "invented-account",
    recordingCameraSerial: "invented-child", purpose: "control", resolveCipherKey: async () => recipient.getPrivateKey().toString("hex") });
  await session.start(); deliver(socket, 1100, Buffer.concat([legacy.update(plain), legacy.final()]), 1, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.stats.level2, 1);
  return { session, socket, sent, key };
}

for (const tampered of [false, true]) test(`one authenticated history-name query, tampered=${tampered}`, async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { session, socket, sent, key } = await peer(context);
  try {
    const operation = session.readEventNameHistory("2026-10-31", "123");
    const failed = tampered ? assert.rejects(operation, /invalid_response/) : null;
    await new Promise(resolve => setImmediate(resolve));
    const commands = sent.filter(value => value.subarray(8, 12).toString() === "XZYH");
    assert.deepEqual(commands.map(value => value.readUInt16LE(12)), [1100, 1350]);
    const wire = commands[1]!, body = wire.subarray(24);
    assert.equal(wire[20], 255); assert.equal(wire[21], 8);
    const decoder = createDecipheriv("aes-256-gcm", key, body.subarray(16, 28));
    decoder.setAAD(Buffer.from("eufy security")); decoder.setAuthTag(body.subarray(0, 16));
    const request = JSON.parse(Buffer.concat([decoder.update(body.subarray(32)), decoder.final()]).toString());
    assert.equal(request.cmd, 1306); assert.equal(request.mChannel, 255);
    assert.deepEqual(request.payload.payload, { count: 50, start_date: "20261031", end_date: "20261101", start_id: 123,
      end_id: 1, flag: 0, need_ai: 1, res_unzip: 1, update_time: "0", start_time: "0", alarm_id: "" });
    const value = { cmd: 10011, table: "history_record_info", transaction: request.payload.transaction, mIntRet: 0,
      data: ["history_record_info", "record_crop_picture_info", "person_basic_info"].map(table_name => ({ table_name, payload: [] })) };
    const nonce = Buffer.alloc(12, 7), cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from("eufy security"));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const response = Buffer.concat([cipher.getAuthTag(), nonce, Buffer.alloc(4), encrypted]);
    if (tampered) response[0] = response[0]! ^ 1;
    deliver(socket, 1306, response, 8, 1);
    if (failed) await failed;
    else assert.deepEqual(await operation, { scope: "one_history_page", records: 0, personCrops: 0, recordsWithFamiliarNames: 0, unresolvedPersonCrops: 0 });
    assert.equal(session.stats.mediaStartAttempts, 0);
    assert.equal(commands.length, 2);
  } finally { session.close(); }
});
