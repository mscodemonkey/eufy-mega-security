/**
 * Exercises media-start repair and owned motion at the real UDP boundary.
 * Synthetic peer keys and sockets are test-owned. No account or camera is used.
 */
import assert from "node:assert/strict";
import { createCipheriv, createECDH, createHmac } from "node:crypto";
import { Socket } from "node:dgram";
import test, { type TestContext } from "node:test";
import { CameraControlAcknowledgementTimeoutError, FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";

/** Encode one synthetic encrypted gateway key using the session's public wire contract. */
function gateway(): Buffer {
  const recipient = createECDH("prime256v1"); recipient.setPrivateKey(Buffer.alloc(32, 1));
  const ephemeral = createECDH("prime256v1"); ephemeral.setPrivateKey(Buffer.alloc(32, 2));
  const shared = ephemeral.computeSecret(recipient.getPublicKey());
  const label = Buffer.from("ECIES");
  const hmac = (data: Buffer): Buffer => createHmac("sha256", shared).update(data).digest();
  let previous: Buffer<ArrayBufferLike> = label;
  let derived: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (derived.length < 48) {
    previous = hmac(previous);
    derived = Buffer.concat([derived, hmac(Buffer.concat([previous, label]))]);
  }
  const plain = Buffer.alloc(144); plain.writeUInt16LE(1);
  ephemeral.getPublicKey(undefined, "compressed").copy(plain, 4);
  const iv = Buffer.alloc(16, 3); iv.copy(plain, 37);
  const wrap = createCipheriv("aes-128-cbc", derived.subarray(0, 16), iv);
  Buffer.concat([wrap.update(Buffer.alloc(32, 9)), wrap.final()]).copy(plain, 53);
  const cipher = createCipheriv("aes-128-ecb", Buffer.from("1234567-12345678"), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

/** Own a synthetic CAM_ID handshake, inbound frames, packet loss and fake time. */
async function peer(context: TestContext, attached = true, model = "T8113-Z", purpose: "media" | "control" = "media") {
  let socket!: Socket;
  let inbound = 0;
  const sent: Buffer[] = [];
  context.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1800000000000 });
  context.mock.method(Socket.prototype, "bind", function (this: Socket) {
    socket = this;
    queueMicrotask(() => this.emit("message", Buffer.from([0xf1, 0x42, 0, 0]), { address: "127.0.0.1", port: 12345 }));
    return this;
  });
  context.mock.method(Socket.prototype, "send", (packet: Buffer) => { sent.push(Buffer.from(packet)); });
  context.mock.method(Socket.prototype, "close", function (this: Socket) { return this; });
  const session = new FirstPartyPpcsSession({ stationSerial: "SYNTHETIC1234567", p2pDid: "TEST-12345678-TEST",
    appConnection: "", dskKey: "synthetic", channel: attached ? 1 : 0, homeBaseAttached: attached, stationModel: "T8010",
    purpose, cameraModel: model, accountId: "synthetic-owner", maxSeconds: 120,
    resolveCipherKey: async () => Buffer.alloc(32, 1).toString("hex") });
  const receive = (packet: Buffer, port = 12345) => socket.emit("message", packet, { address: "127.0.0.1", port });
  const frame = (command: number, payload: Buffer, channel = 1, result = false, sign = 0) => {
    const packet = Buffer.alloc(24 + payload.length);
    packet.set([0xf1, 0xd0], 0); packet.writeUInt16BE(packet.length - 4, 2);
    packet.set([0xd1, 0], 4); packet.writeUInt16BE(inbound++, 6);
    packet.write("XZYH", 8); packet.writeUInt16LE(command, 12); packet.writeUInt32LE(payload.length, 14);
    packet[20] = channel; packet[21] = sign; packet[22] = result ? 1 : 0;
    payload.copy(packet, 24); receive(packet);
  };
  const ack = (sequence: number, variant = "valid") => {
    const packet = Buffer.from([0xf1, 0xd1, 0, 6, 0xd1, 0, 0, 1, 0, 0]);
    packet.writeUInt16BE(sequence, 8);
    if (variant === "channel") packet[5] = 1;
    if (variant === "length") packet[3] = 5;
    if (variant === "count") packet[7] = 0;
    receive(packet, variant === "peer" ? 12346 : 12345);
  };
  const negotiate = async () => { frame(1100, gateway(), 0, false, 1); await new Promise(resolve => setImmediate(resolve)); };
  const video = (channel = 1) => {
    const data = Buffer.from("000000016742001e898b600000000168ce3c8000000001658884000000010940", "hex");
    const header = Buffer.alloc(22); header.writeUInt32LE(data.length); header[4] = 1; header[5] = 1;
    frame(1300, Buffer.concat([header, data]), channel);
  };
  await session.start();
  return { session, sent, frame, ack, negotiate, video };
}

for (const [attached, model] of [[true, "T8113-Z"], [false, "T817L"], [false, "T8200"]] as const) {
  test(`repairs the exact live-start datagram for ${model} attached=${attached}`, async context => {
    const f = await peer(context, attached, model);
    try {
      if (attached) await f.negotiate();
      const original = f.sent.at(-1)!;
      const sequence = original.readUInt16BE(6);
      const attempts = f.session.stats.mediaStartAttempts;
      for (const invalid of ["peer", "channel", "length", "count"]) f.ack(sequence, invalid);
      context.mock.timers.tick(150);
      assert.deepEqual(f.sent.at(-1), original);
      assert.equal(f.session.stats.mediaStartAttempts, attempts);
      assert.equal(f.session.stats.mediaStartRetransmitted, 1);
      f.ack(sequence); f.ack(sequence);
      const count = f.sent.length;
      context.mock.timers.tick(150);
      assert.equal(f.sent.length, count);
      assert.equal(f.session.stats.mediaStartAcknowledged, 1);
      f.session.close();
      const closedCount = f.sent.length;
      context.mock.timers.tick(30000);
      assert.equal(f.sent.length, closedCount);
    } finally { f.session.close(); }
  });
}

test("late level-two upgrade preserves repair of the original level-one start", async context => {
  const f = await peer(context, false, "T817L");
  try {
    const original = f.sent.at(-1)!;
    await f.negotiate();
    const upgraded = f.sent.at(-1)!;
    assert.notDeepEqual(upgraded, original);
    context.mock.timers.tick(150);
    assert.deepEqual(f.sent.slice(-2), [original, upgraded]);
    f.ack(original.readUInt16BE(6)); f.ack(upgraded.readUInt16BE(6));
    assert.equal(f.session.stats.mediaStartAcknowledged, 2);
  } finally { f.session.close(); }
});

test("a late attached start defers heartbeat restart until its repair window ends", async context => {
  const f = await peer(context);
  try {
    context.mock.timers.tick(4000);
    await f.negotiate();
    context.mock.timers.tick(1000);
    assert.equal(f.session.stats.mediaStartAttempts, 1);
    assert.equal(f.session.stats.mediaStopAttempts, 0);
    context.mock.timers.tick(2000);
    assert.equal(f.session.stats.mediaStartExpired, 1);
    context.mock.timers.tick(3000);
    assert.equal(f.session.stats.mediaStopAttempts, 1);
    context.mock.timers.tick(250);
    assert.equal(f.session.stats.mediaStartAttempts, 2);
  } finally { f.session.close(); }
});

test("only delivered requested-channel media cancels a pending attached start", async context => {
  const f = await peer(context);
  try {
    await f.negotiate();
    f.video(2);
    context.mock.timers.tick(150);
    assert.equal(f.session.stats.mediaStartRetransmitted, 1);
    f.video();
    assert.ok(f.session.stats.videoOutputFrames > 0);
    context.mock.timers.tick(150);
    assert.equal(f.session.stats.mediaStartRetransmitted, 1);
  } finally { f.session.close(); }
});

test("owned motion binds results to its channel", async context => {
  const f = await peer(context, true, "T8113-Z", "control");
  try {
    await f.negotiate(); f.video();
    const pending = f.session.writeMotionDetection(false);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.session.writeMotionDetection(true), /already has/);
    let finished = false;
    void pending.then(() => { finished = true; });
    f.frame(1011, Buffer.alloc(4), 2, true);
    context.mock.timers.tick(400);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    f.frame(1011, Buffer.alloc(4), 1, true);
    context.mock.timers.tick(200);
    await pending;
    assert.equal(f.session.stats.closeReason, "open");
  } finally { f.session.close(); }
});

for (const afterDispatch of [false, true]) {
  test(`owned closure ${afterDispatch ? "after" : "before"} dispatch has a precise outcome`, async context => {
    const f = await peer(context, true, "T8113-Z", "control");
    await f.negotiate(); f.video();
    const pending = f.session.writeMotionDetection(false);
    const result = assert.rejects(pending, afterDispatch ? CameraControlAcknowledgementTimeoutError : /closed before dispatch/);
    if (afterDispatch) await new Promise(resolve => setImmediate(resolve));
    f.session.close();
    const count = f.sent.length;
    context.mock.timers.tick(500);
    await result;
    assert.equal(f.sent.length, count);
  });
}


test("motion cannot borrow a decoded media-purpose session", async context => {
  const f = await peer(context);
  try {
    await f.negotiate(); f.video();
    await assert.rejects(f.session.writeMotionDetection(false), /requires a control session/);
  } finally { f.session.close(); }
});

test("solo motion also stops its redundant transmissions after retirement", async context => {
  const f = await peer(context, false, "T8171", "control");
  await f.negotiate();
  const pending = assert.rejects(f.session.writeMotionDetection(false), CameraControlAcknowledgementTimeoutError);
  await new Promise(resolve => setImmediate(resolve));
  f.session.close();
  const count = f.sent.length;
  context.mock.timers.tick(500);
  await pending;
  assert.equal(f.sent.length, count);
});
