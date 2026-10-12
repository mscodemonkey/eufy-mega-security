/**
 * Drives the real S100 session with synthetic key negotiation and a mocked UDP
 * socket. Tests own every protocol reply and key and cannot contact hardware.
 */

import assert from "node:assert/strict";
import { createCipheriv, createECDH, createHmac } from "node:crypto";
import { Socket } from "node:dgram";
import test, { type TestContext } from "node:test";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { S100SirenTrialError } from "../src/provider/s100-siren-trial.js";

const route = { model: "T84A1", deviceType: 151, peerModel: "T84A1", selfPeer: true, homeBaseAttached: false, channel: 0 };

async function syntheticSession(context: TestContext, negotiated = true) {
  let socket!: Socket, sequence = 0;
  const controls: { command: number; channel: number }[] = [];
  const remote = { address: "127.0.0.1", port: 12345 };
  const recipient = createECDH("prime256v1"); recipient.generateKeys();
  const incoming = (command: number, channel: number, payload: Buffer, sign: number, kind: number) => {
    const header = Buffer.alloc(16); header.write("XZYH"); header.writeUInt16LE(command, 4);
    header.writeUInt32LE(payload.length, 6); header[12] = channel; header[13] = sign; header[14] = kind;
    const outer = Buffer.from([0xf1, 0xd0, 0, 0, 0xd1, 0, 0, 0]); outer.writeUInt16BE(sequence++, 6);
    socket.emit("message", Buffer.concat([outer, header, payload]), remote);
  };
  const respond = (command: number, channel: number, value = 0) => {
    const body = Buffer.alloc(4); body.writeInt32LE(value); incoming(command, channel, body, 0, 1);
  };
  const callbacks = { failSend: false, control: (command: number, channel: number) => respond(command, channel) };
  context.mock.method(Socket.prototype, "bind", function(this: Socket) {
    socket = this; queueMicrotask(() => this.emit("message", Buffer.from([0xf1, 0x42, 0, 0]), remote)); return this;
  });
  context.mock.method(Socket.prototype, "close", function(this: Socket) { return this; });
  context.mock.method(Socket.prototype, "send", (packet: Buffer) => {
    if (packet.length < 24 || packet.subarray(8, 12).toString() !== "XZYH") return;
    const command = packet.readUInt16LE(12), channel = packet[20]!;
    if (command !== 1201 && command !== 1202) return;
    controls.push({ command, channel });
    if (callbacks.failSend) throw Error("private-send-error");
    queueMicrotask(() => callbacks.control(command, channel));
  });
  const session = new FirstPartyPpcsSession({ stationSerial: "test fixture 1234567", p2pDid: "TEST-12345678-TEST", appConnection: "", dskKey: "synthetic", channel: 0,
    homeBaseAttached: false, cameraModel: "T84A1", accountId: "synthetic-owner", purpose: "control", modelControlTrial: true, maxSeconds: 40,
    resolveCipherKey: async () => negotiated ? recipient.getPrivateKey().toString("hex") : undefined });
  await session.start();
  const ephemeral = createECDH("prime256v1"); ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(recipient.getPublicKey()), label = Buffer.from("ECIES");
  const hmac = (data: Buffer) => createHmac("sha256", shared).update(data).digest();
  let previous: Buffer<ArrayBufferLike> = label, derived: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (derived.length < 48) { previous = hmac(previous); derived = Buffer.concat([derived, hmac(Buffer.concat([previous, label]))]); }
  const envelope = Buffer.alloc(129), iv = Buffer.alloc(16, 9);
  ephemeral.getPublicKey(undefined, "compressed").copy(envelope); iv.copy(envelope, 33);
  const cipher = createCipheriv("aes-128-cbc", derived.subarray(0, 16), iv);
  Buffer.concat([cipher.update(Buffer.alloc(32, 7)), cipher.final()]).copy(envelope, 49);
  const gateway = Buffer.alloc(144); gateway.writeUInt16LE(1); envelope.copy(gateway, 4);
  const legacy = createCipheriv("aes-128-ecb", Buffer.from("1234567-12345678"), null); legacy.setAutoPadding(false);
  incoming(1100, 0, Buffer.concat([legacy.update(gateway), legacy.final()]), 1, 0);
  await new Promise(resolve => setImmediate(resolve));
  return { session, controls, callbacks, respond };
}

test("real S100 session sends one start, deduplicates stop and continues after primary rejection", async context => {
  const h = await syntheticSession(context);
  try {
    let first = true;
    h.callbacks.control = (command, channel) => { h.respond(command, channel, first || command === 1202 ? 0 : -1); first = false; };
    const trial = await h.session.prepareS100SirenTrial(route, true);
    await trial.start();
    const stopping = trial.stop(); assert.equal(trial.stop(), stopping);
    await assert.rejects(stopping, (e: unknown) => e instanceof S100SirenTrialError && e.stages.join() === "primary_stop");
    assert.deepEqual(h.controls, [{ command: 1201, channel: 255 }, { command: 1201, channel: 255 }, { command: 1202, channel: 0 }]);
  } finally { h.session.close(); }
});

test("real S100 preflight sends nothing for bad route or exhausted counters", async context => {
  const h = await syntheticSession(context);
  try {
    await assert.rejects(h.session.prepareS100SirenTrial({ ...route, deviceType: 150 }, true));
    await h.session.prepareS100SirenTrial(route, false);
    for (let i = 0; i < 83; i++) await h.session.prepareS100SirenTrial(route, true);
    await h.session.prepareS100SirenTrial(route, false);
    await h.session.prepareS100SirenTrial(route, true);
    await assert.rejects(h.session.prepareS100SirenTrial(route, true));
    assert.deepEqual(h.controls, []);
  } finally { h.session.close(); }
});

test("real S100 session sends nothing when negotiation supplies no level-two key", async context => {
  const h = await syntheticSession(context, false);
  try { await assert.rejects(h.session.prepareS100SirenTrial(route, true)); assert.deepEqual(h.controls, []); }
  finally { h.session.close(); }
});

test("late start reply cannot acknowledge an ambiguous primary stop", async context => {
  const h = await syntheticSession(context);
  try {
    let count = 0;
    h.callbacks.control = (command, channel) => { if (++count > 1) h.respond(command, channel); };
    const trial = await h.session.prepareS100SirenTrial(route, true);
    await assert.rejects(trial.start(), /start/);
    await assert.rejects(trial.stop(), (e: unknown) => e instanceof S100SirenTrialError && e.stages.join() === "primary_stop");
    assert.equal(count, 3);
  } finally { h.session.close(); }
});


test("real S100 stop-only request sends both stops without a start", async context => {
  const h = await syntheticSession(context);
  try {
    const trial = await h.session.prepareS100SirenTrial(route, false);
    await trial.stop();
    assert.deepEqual(h.controls, [{ command: 1201, channel: 255 }, { command: 1202, channel: 0 }]);
  } finally { h.session.close(); }
});

for (const mode of ["send-throws", "start-rejected"]) {
  test(`real S100 ${mode} preserves failed start and still attempts both stops`, async context => {
    const h = await syntheticSession(context);
    try {
      if (mode === "send-throws") h.callbacks.failSend = true;
      else h.callbacks.control = (command, channel) => h.respond(command, channel, -1);
      const trial = await h.session.prepareS100SirenTrial(route, true);
      await assert.rejects(trial.start(), /start/);
      h.callbacks.failSend = false;
      h.callbacks.control = (command, channel) => h.respond(command, channel);
      await assert.rejects(trial.stop(), (e: unknown) => e instanceof S100SirenTrialError && e.stages.join() === "primary_stop");
      assert.deepEqual(h.controls.map(row => row.command), [1201, 1201, 1202]);
    } finally { h.session.close(); }
  });
}
