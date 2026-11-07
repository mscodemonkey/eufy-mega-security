/**
 * Exercises media-start repair and owned motion at the real UDP boundary.
 * Synthetic peer keys and sockets are test-owned. No account or camera is used.
 */
import { qualifiedLiveFrameClock, qualifiedS340LiveSource } from "../src/stream/live-frame-clock.js";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createECDH, createHmac } from "node:crypto";
import { Socket } from "node:dgram";
import test, { type TestContext } from "node:test";
import { CameraControlAcknowledgementTimeoutError, decodePpcsControlRecord, FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";

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
async function peer(context: TestContext, attached = true, model = "T8113-Z", purpose: "media" | "control" | "passive" = "media", stationModel = "T8010", startupDeadlineMilliseconds?: number, channelOverride?: number, deviceTypeOverride?: number | null) {
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
    appConnection: "", dskKey: "synthetic", channel: channelOverride ?? (attached ? 1 : 0), homeBaseAttached: attached, stationModel,
    ...(startupDeadlineMilliseconds === undefined ? {} : { startupDeadlineMilliseconds }),
    purpose, cameraModel: model,
    ...(deviceTypeOverride !== undefined
      ? { cameraDeviceType: deviceTypeOverride }
      : model === "T8171" ? { cameraDeviceType: 88 } : {}),
    accountId: "synthetic-owner", maxSeconds: 120,
    resolveCipherKey: async () => Buffer.alloc(32, 1).toString("hex") });
  const receive = (packet: Buffer, port = 12345, address = "127.0.0.1") => socket.emit("message", packet, { address, port });
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
  const video = (channel = 1, format?: { width: number; height: number; timestamp: number; keyframe?: boolean }) => {
    const data = Buffer.from("000000016742001e898b600000000168ce3c8000000001658884000000010940", "hex");
    const header = Buffer.alloc(22); header.writeUInt32LE(data.length); header[4] = 1; header[5] = 1;
    if (format) {
      header[4] = format.keyframe === false ? 0 : 1;
      header.writeInt16LE(format.width, 10); header.writeInt16LE(format.height, 12);
      header.writeUInt32LE(format.timestamp, 14);
    }
    frame(1300, Buffer.concat([header, data]), channel);
  };
  await session.start();
  return { session, sent, frame, ack, negotiate, video, receive };
}

test("T8171 acknowledged startup leaves a slow encoder alive until its first frame", async context => {
  const f = await peer(context, true, "T8171", "media", "T8030");
  try {
    await f.negotiate();
    f.ack(f.sent.at(-1)!.readUInt16BE(6));
    const firstFrame = setTimeout(() => f.video(), 6500);
    try {
      context.mock.timers.tick(5000);
      assert.equal(f.session.stats.mediaStopAttempts, 0);
      assert.equal(f.session.stats.mediaStartAttempts, 1);
      context.mock.timers.tick(1500);
      assert.ok(f.session.stats.videoOutputFrames > 0);
      assert.equal(f.session.stats.closeReason, "open");
      context.mock.timers.tick(8500);
      assert.equal(f.session.stats.mediaStartAttempts, 1);
    } finally { clearTimeout(firstFrame); }
  } finally { f.session.close(); }
});

test("T8171 without a valid start ACK retains datagram repair and startup recovery", async context => {
  const f = await peer(context, true, "T8171", "media", "T8030");
  try {
    await f.negotiate();
    f.ack(f.sent.at(-1)!.readUInt16BE(6), "peer");
    context.mock.timers.tick(150);
    assert.ok(f.session.stats.mediaStartRetransmitted > 0);
    context.mock.timers.tick(4850);
    assert.equal(f.session.stats.mediaStartAcknowledged, 0);
    assert.equal(f.session.stats.mediaStopAttempts, 1);
    context.mock.timers.tick(250);
    assert.equal(f.session.stats.mediaStartAttempts, 2);
  } finally { f.session.close(); }
});

test("an acknowledged T8171 start still fails at its original first-frame deadline", async context => {
  const f = await peer(context, true, "T8171", "media", "T8030");
  try {
    await f.negotiate();
    f.ack(f.sent.at(-1)!.readUInt16BE(6));
    context.mock.timers.tick(19999);
    assert.equal(f.session.stats.closeReason, "open");
    assert.equal(f.session.stats.mediaStopAttempts, 0);
    context.mock.timers.tick(1);
    assert.equal(f.session.stats.closeReason, "first_frame_timeout");
    assert.equal(f.session.stats.videoOutputFrames, 0);
    assert.equal(f.session.stats.mediaStartAttempts, 1);
    assert.equal(f.session.stats.mediaStopAttempts, 1);
  } finally { f.session.close(); }
});

test("closing an acknowledged T8171 startup stops once and retires its timers", async context => {
  const f = await peer(context, true, "T8171", "media", "T8030");
  try {
    await f.negotiate();
    f.ack(f.sent.at(-1)!.readUInt16BE(6));
    context.mock.timers.tick(7500);
    assert.equal(f.session.stats.mediaStopAttempts, 0);
    f.session.close();
    assert.equal(f.session.stats.mediaStopAttempts, 1);
    const closedCount = f.sent.length;
    context.mock.timers.tick(30000);
    assert.equal(f.sent.length, closedCount);
  } finally { f.session.close(); }
});

test("T8171 media-stall recovery remains active after the first real output", async context => {
  const f = await peer(context, true, "T8171", "media", "T8030");
  try {
    await f.negotiate();
    f.ack(f.sent.at(-1)!.readUInt16BE(6));
    context.mock.timers.tick(6500);
    f.video();
    assert.ok(f.session.stats.videoOutputFrames > 0);
    context.mock.timers.tick(13500);
    assert.equal(f.session.stats.closeReason, "open");
    assert.equal(f.session.stats.mediaStopAttempts, 1);
    context.mock.timers.tick(250);
    assert.equal(f.session.stats.mediaStartAttempts, 2);
    f.ack(f.sent.at(-1)!.readUInt16BE(6));
    f.video();
    assert.equal(f.session.stats.closeReason, "open");
  } finally { f.session.close(); }
});

for (const [model, station, channel] of [
  ["T8210", "T8030", 4], ["T8113-Z", "T8030", 3], ["T8113-Z", "T8030", 2],
  ["T8113-Z", "T8010", 0], ["T8171", "T8010", 1], ["T8171", "T8030", 2],
] as const) {
  test(`acknowledged attached startup waits for the first picture on ${model}/${station}/channel${channel}`, async context => {
    const f = await peer(context, true, model, "media", station, undefined, channel);
    try {
      await f.negotiate();
      f.ack(f.sent.at(-1)!.readUInt16BE(6));
      context.mock.timers.tick(7500);
      assert.equal(f.session.stats.mediaStopAttempts, 0);
      assert.equal(f.session.stats.mediaStartAttempts, 1);
      f.video(channel);
      assert.ok(f.session.stats.videoOutputFrames > 0);
      assert.equal(f.session.stats.closeReason, "open");
    } finally { f.session.close(); }
  });
}

for (const [model, channel] of [["T8210", 4], ["T8113-Z", 3]] as const) {
  test(`acknowledged attached ${model} without video still reaches the existing deadline`, async context => {
    const f = await peer(context, true, model, "media", "T8030", undefined, channel);
    try {
      await f.negotiate();
      f.ack(f.sent.at(-1)!.readUInt16BE(6));
      context.mock.timers.tick(19999);
      assert.equal(f.session.stats.mediaStartAttempts, 1);
      assert.equal(f.session.stats.mediaStopAttempts, 0);
      assert.equal(f.session.stats.closeReason, "open");
      context.mock.timers.tick(1);
      assert.equal(f.session.stats.closeReason, "first_frame_timeout");
      assert.equal(f.session.stats.mediaStopAttempts, 1);
    } finally { f.session.close(); }
  });

  test(`unacknowledged attached ${model} retains repair and startup recovery`, async context => {
    const f = await peer(context, true, model, "media", "T8030", undefined, channel);
    try {
      await f.negotiate();
      f.ack(f.sent.at(-1)!.readUInt16BE(6), "peer");
      context.mock.timers.tick(150);
      assert.ok(f.session.stats.mediaStartRetransmitted > 0);
      context.mock.timers.tick(4850);
      assert.equal(f.session.stats.mediaStartAcknowledged, 0);
      assert.equal(f.session.stats.mediaStopAttempts, 1);
      context.mock.timers.tick(250);
      assert.equal(f.session.stats.mediaStartAttempts, 2);
    } finally { f.session.close(); }
  });
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

test("the exact T8210 HomeBase 3 route receives station heartbeats without restarting child media", async context => {
  const f = await peer(context, true, "T8210", "media", "T8030", undefined, 4, 7);
  try {
    await f.negotiate();
    f.ack(f.sent.at(-1)!.readUInt16BE(6));
    f.video(4);
    const mediaStarts = f.session.stats.mediaStartAttempts;
    context.mock.timers.tick(5000);
    const heartbeat = f.sent.find(packet => packet.length >= 24
      && packet.readUInt16LE(12) === 1139 && packet[20] === 255);
    assert.ok(heartbeat);
    assert.equal(f.session.stats.mediaStartAttempts, mediaStarts);
    assert.equal(f.session.stats.mediaStopAttempts, 0);
  } finally { f.session.close(); }
});

test("attached routes without the exact T8210 identity do not receive station command heartbeats", async context => {
  const f = await peer(context, true, "T8113-Z", "media", "T8030", undefined, 4, 7);
  try {
    await f.negotiate();
    f.ack(f.sent.at(-1)!.readUInt16BE(6));
    f.video(4);
    context.mock.timers.tick(5000);
    assert.equal(f.sent.some(packet => packet.length >= 24 && packet.readUInt16LE(12) === 1139), false);
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

test("logical close cancels media immediately but drains stop and END before releasing UDP", async context => {
  const f = await peer(context);
  await f.negotiate();
  const socketClose = context.mock.method(Socket.prototype, "close", function (this: Socket) { return this; });
  let complete!: (error: Error | null) => void;
  context.mock.method(Socket.prototype, "send", (packet: Buffer, _port: number, _host: string, callback?: (error: Error | null) => void) => {
    f.sent.push(Buffer.from(packet));
    if (callback) complete = callback;
  });
  f.session.close();
  f.session.close();
  assert.equal(f.session.output.writableEnded, true);
  assert.equal(socketClose.mock.callCount(), 0);
  assert.equal(f.sent.at(-2)!.readUInt16LE(12), 1004);
  assert.deepEqual(f.sent.at(-1), Buffer.from([0xf1, 0xf0, 0, 0]));
  const count = f.sent.length;
  complete(null);
  await f.session.waitUntilClosed();
  assert.equal(socketClose.mock.callCount(), 1);
  context.mock.timers.tick(30000);
  assert.equal(f.sent.length, count);
});

test("missing END completion releases the port after a finite local drain deadline", async context => {
  const f = await peer(context, true, "T8113-Z", "control");
  const socketClose = context.mock.method(Socket.prototype, "close", function (this: Socket) { return this; });
  f.session.close();
  context.mock.timers.tick(499);
  assert.equal(socketClose.mock.callCount(), 0);
  context.mock.timers.tick(1);
  await f.session.waitUntilClosed();
  assert.equal(socketClose.mock.callCount(), 1);
});

test("HB2 2C setup repairs the identical initial query until its validated ACK", async context => {
  const f = await peer(context);
  try {
    const original = f.sent.at(-1)!;
    assert.equal(original.readUInt16LE(original.indexOf(Buffer.from("XZYH")) + 4), 1100);
    const sequence = original.readUInt16BE(6);
    const count = f.sent.length;
    context.mock.timers.tick(150);
    assert.equal(f.sent.length, count + 1);
    assert.deepEqual(f.sent.at(-1), original);
    assert.equal(f.session.stats.gatewayInfoRetransmitted, 1);
    for (const invalid of ["peer", "channel", "length", "count"]) f.ack(sequence, invalid);
    context.mock.timers.tick(150);
    assert.equal(f.session.stats.gatewayInfoRetransmitted, 2);
    f.ack(sequence);
    f.ack(sequence);
    context.mock.timers.tick(1000);
    assert.equal(f.session.stats.gatewayInfoAcknowledged, 1);
    assert.equal(f.session.stats.gatewayInfoRetransmitted, 2);
    assert.equal(f.session.stats.mediaStartAttempts, 0);
  } finally { f.session.close(); }
});

test("a setup reply retires lost-ACK repair before media starts", async context => {
  const f = await peer(context);
  try {
    context.mock.timers.tick(150);
    await f.negotiate();
    context.mock.timers.tick(150);
    assert.equal(f.session.stats.gatewayInfoRetransmitted, 1);
    assert.equal(f.session.stats.gatewayInfoAcknowledged, 0);
    assert.equal(f.session.stats.mediaStartAttempts, 1);
    assert.equal(f.session.stats.mediaStartRetransmitted, 1);
  } finally { f.session.close(); }
});

for (const action of ["expiry", "close"] as const) test(`setup repair has bounded ${action} and sends nothing afterwards`, async context => {
  const f = await peer(context);
  try {
    context.mock.timers.tick(150);
    if (action === "close") f.session.close();
    else context.mock.timers.tick(2850);
    const repaired = f.session.stats.gatewayInfoRetransmitted;
    context.mock.timers.tick(5000);
    assert.equal(f.session.stats.gatewayInfoRetransmitted, repaired);
    assert.equal(f.session.stats.gatewayInfoExpired, action === "expiry" ? 1 : 0);
  } finally { f.session.close(); }
});

for (const [model, station] of [["T8210", "T8010"], ["T8113-Z", "T8030"], ["T8210", "T8030"], ["T8171", "T8030"]] as const) {
  test(`attached ${model} on ${station} repairs only the original unacknowledged setup`, async context => {
    const f = await peer(context, true, model, "media", station);
    try {
      const original = Buffer.from(f.sent.at(-1)!);
      assert.equal(original.readUInt16LE(12), 1100);
      const sequence = original.readUInt16BE(6);
      context.mock.timers.tick(150);
      assert.deepEqual(f.sent.at(-1), original);
      assert.equal(f.session.stats.gatewayInfoRetransmitted, 1);
      for (const invalid of ["peer", "channel", "length", "count"]) f.ack(sequence, invalid);
      context.mock.timers.tick(150);
      assert.equal(f.session.stats.gatewayInfoRetransmitted, 2);
      f.ack(sequence);
      context.mock.timers.tick(1000);
      assert.equal(f.session.stats.gatewayInfoAcknowledged, 1);
      assert.equal(f.session.stats.gatewayInfoRetransmitted, 2);
      assert.equal(f.session.stats.mediaStartAttempts, 0);
    } finally { f.session.close(); }
  });
}

for (const purpose of ["control", "passive"] as const) test(`HB3 ${purpose} setup retains its existing single send`, async context => {
  const f = await peer(context, true, "T8210", purpose, "T8030");
  try {
    context.mock.timers.tick(150);
    assert.equal(f.session.stats.gatewayInfoRetransmitted, 0);
  } finally { f.session.close(); }
});

for (const finish of ["response", "expiry", "close"] as const) {
  test(`HB3 setup repair retires on ${finish} without extending startup`, async context => {
    const f = await peer(context, true, "T8210", "media", "T8030");
    try {
      context.mock.timers.tick(150);
      assert.equal(f.session.stats.gatewayInfoRetransmitted, 1);
      if (finish === "response") await f.negotiate();
      else if (finish === "close") f.session.close();
      else context.mock.timers.tick(2850);
      const repaired = f.session.stats.gatewayInfoRetransmitted;
      context.mock.timers.tick(5000);
      assert.equal(f.session.stats.gatewayInfoRetransmitted, repaired);
      assert.equal(f.session.stats.gatewayInfoExpired, finish === "expiry" ? 1 : 0);
      if (finish === "expiry") {
        context.mock.timers.tick(12000);
        assert.equal(f.session.stats.closeReason, "first_frame_timeout");
        assert.equal(f.session.stats.mediaStartAttempts, 0);
      }
    } finally { f.session.close(); }
  });
}

for (const remaining of [1000, 60000]) test(`absolute startup deadline cannot extend first-frame budget: ${remaining}`, async context => {
  context.mock.method(performance, "now", () => Date.now());
  const f = await peer(context, true, "T8113-Z", "media", "T8010", 1800000000000 + remaining);
  try {
    const expected = Math.min(remaining, 20000);
    context.mock.timers.tick(expected - 1);
    assert.equal(f.session.stats.closeReason, "open");
    context.mock.timers.tick(1);
    assert.equal(f.session.stats.closeReason, "first_frame_timeout");
  } finally { f.session.close(); }
});

test("remaining owned startup budget also bounds replacement lookup", async context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1800000000000 });
  context.mock.method(performance, "now", () => Date.now());
  context.mock.method(Socket.prototype, "bind", function (this: Socket) { return this; });
  context.mock.method(Socket.prototype, "close", function (this: Socket) { return this; });
  const session = new FirstPartyPpcsSession({ stationSerial: "SYNTHETIC1234567", p2pDid: "TEST-12345678-TEST",
    appConnection: "", dskKey: "synthetic", channel: 0, cameraModel: "T8113-Z", stationModel: "T8010",
    homeBaseAttached: true, accountId: "synthetic-owner", startupDeadlineMilliseconds: Date.now() + 1000 });
  const result = assert.rejects(session.start(), /lookup timed out/);
  context.mock.timers.tick(1000);
  await result;
  assert.equal(session.stats.closeReason, "start_failed");
  await session.waitUntilClosed();
});


test("selected HomeBase heartbeats receive a pong while video remains active", async context => {
  const f = await peer(context, true, "T8113-Z", "media", "T8030", undefined, 3);
  try {
    await f.negotiate();
    f.ack(f.sent.at(-1)!.readUInt16BE(6));
    f.video(3);
    for (let index = 0; index < 9; index++) {
      context.mock.timers.tick(5000);
      f.receive(Buffer.from([0xf1, 0xe0, 0, 0]));
      f.video(3);
    }
    const pongs = f.sent.filter(packet => packet[0] === 0xf1 && packet[1] === 0xe1);
    assert.equal(pongs.length, 9);
    assert.ok(pongs.every(packet => packet.equals(Buffer.from([0xf1, 0xe1, 0, 0]))));
    assert.equal(f.session.stats.closeReason, "open");
    assert.equal(f.session.stats.mediaStartAttempts, 1);
    assert.equal(f.session.stats.mediaStopAttempts, 0);
  } finally { f.session.close(); }
});

test("heartbeats from another peer or a malformed packet receive no reply", async context => {
  const f = await peer(context);
  try {
    const before = f.sent.length;
    f.receive(Buffer.from([0xf1, 0xe0, 0, 0]), 12346);
    f.receive(Buffer.from([0xf1, 0xe0, 0, 0]), 12345, "127.0.0.2");
    f.receive(Buffer.from([0xf1, 0xe0, 0]));
    f.receive(Buffer.from([0xf1, 0xe0, 0, 1]));
    f.receive(Buffer.from([0xf1, 0xe0, 0, 0, 1]));
    assert.equal(f.sent.length, before);
    f.receive(Buffer.from([0xf1, 0xe0, 0, 0]));
    assert.equal(f.sent.length, before + 1);
    f.session.close();
    const closed = f.sent.length;
    f.receive(Buffer.from([0xf1, 0xe0, 0, 0]));
    assert.equal(f.sent.length, closed);
  } finally { f.session.close(); }
});

test("peer heartbeats do not extend an acknowledged start's first-frame deadline", async context => {
  const f = await peer(context, true, "T8171", "media", "T8030");
  try {
    await f.negotiate();
    f.ack(f.sent.at(-1)!.readUInt16BE(6));
    for (let index = 0; index < 19; index++) {
      context.mock.timers.tick(1000);
      f.receive(Buffer.from([0xf1, 0xe0, 0, 0]));
    }
    assert.equal(f.session.stats.closeReason, "open");
    assert.equal(f.sent.filter(packet => packet[1] === 0xe1).length, 19);
    context.mock.timers.tick(1000);
    assert.equal(f.session.stats.closeReason, "first_frame_timeout");
    assert.equal(f.session.stats.videoOutputFrames, 0);
    assert.equal(f.session.stats.mediaStartAttempts, 1);
  } finally { f.session.close(); }
});


for (const [model, station, channel] of [["T8171", "T8030", 1], ["T8210", "T8030", 4], ["T8113-Z", "T8010", 0]] as const) {
  test(`attached ${model} requests the app live selector on its encrypted channel`, async context => {
    const f = await peer(context, true, model, "media", station, undefined, channel);
    try {
      await f.negotiate();
      const packet = f.sent.at(-1)!;
      assert.equal(packet.readUInt16LE(12), 1350);
      assert.equal(packet[20], channel);
      assert.equal(packet[21], 8);
      const value = decodePpcsControlRecord(packet.subarray(24), 8, Buffer.alloc(16), Buffer.alloc(32, 9));
      assert.equal(value?.cmd, 1003);
      assert.equal(value?.mChannel, channel);
      assert.equal(value?.mValue3, 1003);
      const payload = value?.payload as Record<string, unknown> | undefined;
      assert.equal(payload?.streamtype, model === "T8171" ? 0 : 2);
      assert.equal(payload?.camera_type, 0);
      assert.equal(payload?.entrytype, 0);
      assert.equal(typeof payload?.key, "string");
      assert.equal(f.session.stats.mediaStartAttempts, 1);
    } finally { f.session.close(); }
  });
}

test("T8171 native start and stop retain their distinct encrypted wire slots", async context => {
  const f = await peer(context, true, "T8171", "media", "T8030");
  try {
    await f.negotiate();
    const start = f.sent.at(-1)!;
    assert.equal(start[22], 10);
    const value = decodePpcsControlRecord(start.subarray(24), 8, Buffer.alloc(16), Buffer.alloc(32, 9));
    const payload = value?.payload as Record<string, unknown>;
    assert.deepEqual(payload.chn_list, [{ cameraType: 0, chn: 1, index: 0, sensor: 0 }]);
    assert.equal(payload.ClientOS, "ANDROID");
    f.session.close();
    const stop = f.sent.filter(packet => packet.length > 24 && packet[0] === 0xf1 && packet[1] === 0xd0
      && packet.readUInt16LE(12) === 1350).at(-1)!;
    assert.equal(stop[20], 1);
    assert.equal(stop[21], 8);
    assert.equal(stop[22], 0);
    const stopped = decodePpcsControlRecord(stop.subarray(24), 8, Buffer.alloc(16), Buffer.alloc(32, 9));
    assert.equal(stopped?.cmd, 1004);
    assert.equal(stopped?.mValue3, 0);
    assert.deepEqual(stopped?.payload, { channel: 1, transaction: "1800000000000" });
  } finally { f.session.close(); }
});

test("the qualified T8210 close sends one authenticated direct integer stop", async context => {
  const f = await peer(context, true, "T8210", "media", "T8030", undefined, 4, 7);
  try {
    await f.negotiate();
    f.session.close();
    const stops = f.sent.filter(packet => packet.length >= 24 && packet[1] === 0xd0
      && packet.readUInt16LE(12) === 1004);
    assert.equal(stops.length, 1);
    const stop = stops[0]!;
    assert.equal(stop[20], 4);
    assert.equal(stop[21], 8);
    assert.equal(stop[22], 0);
    const body = stop.subarray(24);
    assert.equal(body.length, 36);
    const decipher = createDecipheriv("aes-256-gcm", Buffer.alloc(32, 9), body.subarray(16, 28));
    decipher.setAAD(Buffer.from("eufy security"));
    decipher.setAuthTag(body.subarray(0, 16));
    assert.deepEqual(Buffer.concat([decipher.update(body.subarray(32)), decipher.final()]), Buffer.from([4, 0, 0, 0]));
    assert.equal(f.session.stats.mediaStopProtocol, "level2-direct");
    assert.equal(f.session.stats.mediaStopAttempts, 1);
    const sent = f.sent.length;
    f.session.close();
    context.mock.timers.tick(30_000);
    assert.equal(f.sent.length, sent);
  } finally { f.session.close(); }
});

test("T8210 startup recovery sends its direct stop before the next start", async context => {
  const f = await peer(context, true, "T8210", "media", "T8030", undefined, 4, 7);
  try {
    await f.negotiate();
    context.mock.timers.tick(5000);
    assert.equal(f.session.stats.mediaStopAttempts, 1);
    assert.equal(f.session.stats.mediaStopProtocol, "level2-direct");
    assert.equal(f.sent.at(-1)!.readUInt16LE(12), 1004);
    assert.equal(f.session.stats.mediaStartAttempts, 1);
    context.mock.timers.tick(250);
    assert.equal(f.session.stats.mediaStartAttempts, 2);
    assert.equal(f.sent.at(-1)!.readUInt16LE(12), 1350);
    assert.equal(f.session.stats.closeReason, "open");
  } finally { f.session.close(); }
});

for (const [model, channel, deviceType] of [
  ["T8210", 4, null], ["T8210", 4, 88], ["T8210", 3, 7], ["T8211", 4, 7],
] as const) test(`an unqualified ${model}/${channel}/${deviceType} retains its JSON stop`, async context => {
  const f = await peer(context, true, model, "media", "T8030", undefined, channel, deviceType);
  try {
    await f.negotiate();
    f.session.close();
    assert.equal(f.sent.some(packet => packet.length >= 24 && packet[1] === 0xd0 && packet.readUInt16LE(12) === 1004), false);
    const stop = f.sent.filter(packet => packet.length >= 24 && packet[1] === 0xd0 && packet.readUInt16LE(12) === 1350).at(-1)!;
    assert.equal(decodePpcsControlRecord(stop.subarray(24), 8, Buffer.alloc(16), Buffer.alloc(32, 9))?.cmd, 1004);
    assert.equal(f.session.stats.mediaStopProtocol, "level2-payload");
  } finally { f.session.close(); }
});

for (const [model, station, channel, purpose, deviceType, qualified] of [
  ["T8171", "T8030", 1, "media", 88, true],
  ["T8171", "T8030", 1, "media", 87, false],
  ["T8171", "T8030", 1, "media", null, false],
  ["T8171", "T8010", 1, "media", 88, false],
  ["T8171", "T8030", 2, "media", 88, false],
  ["T8210", "T8030", 4, "media", 88, false],
  ["T8171", "T8030", 1, "control", 88, false],
  ["T8171", "T8030", 1, "passive", 88, false],
] as const) test(`late video repair admission ${model}/${station}/${channel}/${purpose}/${deviceType}`, async context => {
  const f = await peer(context, true, model, purpose, station, undefined, channel, deviceType);
  const fragment = (sequence: number, text: string): void => {
    const body = Buffer.from(text), packet = Buffer.alloc(8 + body.length);
    packet.set([0xf1, 0xd0], 0); packet.writeUInt16BE(packet.length - 4, 2);
    packet.set([0xd1, 1], 4); packet.writeUInt16BE(sequence, 6); body.copy(packet, 8);
    f.receive(packet);
  };
  try {
    fragment(0, "first"); fragment(2, "third");
    context.mock.timers.tick(300);
    assert.equal(f.session.stats.sequenceGaps, qualified ? 0 : 1);
    context.mock.timers.tick(1200); fragment(1, "second");
    assert.equal(f.session.stats.sequenceGaps, qualified ? 0 : 1);
    assert.equal(f.session.stats.closeReason, "open");
  } finally { f.session.close(); }
});

for (const [model, station, channel, purpose, deviceType, qualified] of [
  ["T8171", "T8030", 1, "media", 88, true],
  ["T8171", "T8030", 1, "media", 87, false],
  ["T8171", "T8030", 1, "media", null, false],
  ["T8171", "T8010", 1, "media", 88, false],
  ["T8171", "T8030", 2, "media", 88, false],
  ["T8210", "T8030", 1, "media", 88, false],
  ["T8171", "T8030", 1, "control", 88, false],
  ["T8171", "T8030", 1, "passive", 88, false],
] as const) test(`live clock admission ${model}/${station}/${channel}/${purpose}/${deviceType}`, async context => {
  const f = await peer(context, true, model, purpose, station, undefined, channel, deviceType);
  const chunks: Buffer[] = [];
  f.session.output.on("data", (data: Buffer) => chunks.push(data));
  try {
    assert.equal(qualifiedS340LiveSource(f.session.output), false);
    f.video(channel);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(qualifiedS340LiveSource(f.session.output), qualified);
    assert.equal(chunks.some(chunk => qualifiedLiveFrameClock(chunk)?.timestampMilliseconds === 0), qualified);
  } finally { f.session.close(); }
});

for (const [width, height, keyframe, changed] of [
  [2560, 1440, true, true],
  [2560, 1440, false, false],
  [1280, 720, true, false],
  [0, 0, true, false],
] as const) test(`qualified format transition ${width}/${height}/${keyframe}`, async context => {
  const f = await peer(context, true, "T8171", "media", "T8030");
  const chunks: Buffer[] = [];
  f.session.output.on("data", (data: Buffer) => chunks.push(data));
  try {
    f.video(1, { width: 1280, height: 720, timestamp: 1_000 });
    assert.equal(qualifiedLiveFrameClock(chunks.at(-1)!)?.encoderFormatChanged, undefined);
    f.video(1, { width, height, timestamp: 8_422, keyframe });
    assert.equal(qualifiedLiveFrameClock(chunks.at(-1)!)?.encoderFormatChanged === true, changed);
  } finally { f.session.close(); }
});


test("the exact T8210 first-start low-power reply survives transport acknowledgement", async context => {
  const f = await peer(context, true, "T8210", "media", "T8030", undefined, 4, 7);
  try {
    await f.negotiate();
    const start = f.sent.at(-1)!;
    f.ack(start.readUInt16BE(6));
    const reply = Buffer.alloc(132); reply.writeInt32LE(-117);
    f.frame(1350, reply, 4, true);
    assert.equal(f.session.stats.mediaStartAcknowledged, 1);
    assert.equal(f.session.stats.mediaStartLowPower, 1);
    context.mock.timers.tick(10_000);
    assert.equal(f.session.stats.mediaStartAttempts, 1);
    assert.equal(f.session.stats.mediaStopAttempts, 0);
    assert.equal(f.session.stats.closeReason, "open");
  } finally { f.session.close(); }
});

for (const variant of ["model", "type", "station", "channel", "purpose", "result", "sign", "command", "short", "padding", "success", "video", "not-result"] as const) {
  test(`low-power startup evidence rejects the unqualified ${variant} reply`, async context => {
    const f = await peer(context, true, variant === "model" ? "T8211" : "T8210",
      variant === "purpose" ? "control" : "media", variant === "station" ? "T8010" : "T8030",
      undefined, 4, variant === "type" ? 88 : 7);
    try {
      await f.negotiate();
      const reply = Buffer.alloc(variant === "short" ? 4 : 132);
      reply.writeInt32LE(variant === "success" ? 0 : variant === "result" ? -118 : -117);
      if (variant === "padding") reply[131] = 1;
      if (variant === "video") f.video(4);
      f.frame(variant === "command" ? 1003 : 1350, reply, variant === "channel" ? 3 : 4,
        variant !== "not-result", variant === "sign" ? 8 : 0);
      assert.equal(f.session.stats.mediaStartLowPower, 0);
    } finally { f.session.close(); }
  });
}
