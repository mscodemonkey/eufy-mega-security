/**
 * Verifies standalone E30 eligibility and encrypted night-vision transmissions.
 * Tests own synthetic sockets and clocks. No account or network is contacted;
 * provider and Home Assistant consumers remain responsible for fresh readback.
 */
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createECDH, createHmac } from "node:crypto";
import { Socket } from "node:dgram";
import test, { type TestContext } from "node:test";

import { nightVisionModes, parseMegaInventory, safeInventoryReads, supportsStandaloneNightVision } from "../src/provider/eufy-provider.js";
import { describeCameraCapabilities } from "../src/provider/device-capabilities-core.js";
import { buildNightVisionBody, FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";

/** Replace UDP binding with a synthetic peer handshake and retain sent bytes. */
function offlinePeer(context: TestContext) {
  const packets: { body: Buffer; at: number }[] = [];
  let now = 0;
  let socket: Socket;
  context.mock.method(Socket.prototype, "send", (body: Buffer) => { packets.push({ body: Buffer.from(body), at: now }); });
  context.mock.method(Socket.prototype, "close", () => undefined);
  context.mock.method(Socket.prototype, "bind", function (this: Socket) {
    socket = this;
    queueMicrotask(() => this.emit("message", Buffer.from([0xf1, 0x42]), { address: "192.0.2.1", port: 32100 }));
    return this;
  });
  const schedule = globalThis.setTimeout;
  context.mock.method(globalThis, "setTimeout", (callback: () => void, milliseconds?: number) => {
    if (milliseconds !== 200) return schedule(callback, milliseconds);
    now += milliseconds;
    return schedule(callback, 0);
  });
  return { packets, clock: () => now, receive: (body: Buffer) => socket.emit("message", body, { address: "192.0.2.1", port: 32100 }) };
}

/** Encode a deterministic gateway-info key exchange consumed by the real session. */
function gatewayKeyFrame(privateKey: Buffer, level2Key: Buffer): Buffer {
  const recipient = createECDH("prime256v1");
  recipient.setPrivateKey(privateKey);
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
  const clear = Buffer.alloc(144);
  clear.writeUInt16LE(7);
  ephemeral.getPublicKey(undefined, "compressed").copy(clear, 4);
  const iv = Buffer.alloc(16, 3);
  iv.copy(clear, 37);
  const ecies = createCipheriv("aes-128-cbc", derived.subarray(0, 16), iv);
  Buffer.concat([ecies.update(level2Key), ecies.final()]).copy(clear, 53);
  const cipher = createCipheriv("aes-128-ecb", Buffer.from("1234567-000000-X"), null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
  const frame = Buffer.alloc(24 + encrypted.length);
  frame.set([0xf1, 0xd0], 0);
  frame.writeUInt16BE(frame.length - 4, 2);
  frame.set([0xd1, 0], 4);
  frame.write("XZYH", 8);
  frame.writeUInt16LE(1100, 12);
  frame.writeUInt32LE(encrypted.length, 14);
  frame[21] = 1;
  encrypted.copy(frame, 24);
  return frame;
}

test("attached night vision still negotiates level two and ignores the direct flag", async (context) => {
  const peer = offlinePeer(context);
  const privateKey = Buffer.alloc(32, 1);
  const key = Buffer.alloc(32, 9);
  const resolve = context.mock.fn(async () => privateKey.toString("hex"));
  const session = new FirstPartyPpcsSession({ ...options, cameraModel: "T8425", channel: 3,
    homeBaseAttached: true, standaloneNightVisionSupported: false, resolveCipherKey: resolve });
  try {
    await session.start();
    peer.receive(gatewayKeyFrame(privateKey, key));
    await session.writeNightVision(2);
    assert.equal(resolve.mock.callCount(), 1);
    assert.deepEqual(resolve.mock.calls[0]!.arguments, [7]);
    const writes = peer.packets.filter(({ body }) => body.length >= 14 && body.readUInt16LE(12) === 1350);
    assert.equal(writes.length, 3);
    assert.equal(peer.clock(), 400);
    for (const [index, { body }] of writes.entries()) {
      const value = body.subarray(14);
      assert.deepEqual([...value.subarray(4, 10)], [8, 0, 0, 8, 0, 0]);
      const encrypted = value.subarray(10);
      assert.deepEqual([...encrypted.subarray(28, 32)], [index, 3, 2, 1]);
      const decrypt = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
      decrypt.setAAD(Buffer.from("eufy security"));
      decrypt.setAuthTag(encrypted.subarray(0, 16));
      assert.deepEqual(Buffer.concat([decrypt.update(encrypted.subarray(32)), decrypt.final()]),
        buildNightVisionBody(3, 2, options.accountId));
    }
  } finally { session.close(); }
});

test("direct control retains purpose, connection, account and provider-validation refusals", async (context) => {
  offlinePeer(context);
  const disconnected = new FirstPartyPpcsSession(options);
  await assert.rejects(disconnected.writeNightVision(1), /not connected/);
  const media = new FirstPartyPpcsSession({ ...options, purpose: "media" });
  await assert.rejects(media.writeNightVision(1), /requires a control session/);
  const { standaloneNightVisionSupported: _flag, ...unvalidated } = options;
  for (const [candidate, error] of [[unvalidated, /requires a HomeBase-attached camera/], [{ ...options, accountId: null }, /account identity/]] as const) {
    const session = new FirstPartyPpcsSession(candidate);
    try { await session.start(); await assert.rejects(session.writeNightVision(1), error); }
    finally { session.close(); }
  }
});

const options = {
  stationSerial: "fixture1234567", p2pDid: "EUPRCAM-000000-XXXXX", appConnection: "",
  dskKey: "fixture", channel: 0, cameraModel: "T8171", accountId: "fixture-account",
  homeBaseAttached: false, purpose: "control" as const, standaloneNightVisionSupported: true,
};

for (const mode of [0, 1, 3]) {
  test(`direct E30 mode ${mode} sends level-one repetitions and drains before closing`, async (context) => {
    const peer = offlinePeer(context);
    const cipher = context.mock.fn(async () => { throw new Error("Level two forbidden"); });
    const session = new FirstPartyPpcsSession({ ...options, resolveCipherKey: cipher });
    try {
      await session.start();
      await session.writeNightVision(mode);
      const writes = peer.packets.filter(({ body }) => body.length >= 14 && body.readUInt16LE(12) === 1350);
      assert.equal(writes.length, 3);
      assert.deepEqual(writes.map(({ at }) => at), [0, 200, 400]);
      assert.equal(peer.clock(), 600);
      assert.equal(cipher.mock.callCount(), 0);
      assert.deepEqual(writes.map(({ body }) => body.readUInt16BE(6)), [1, 2, 3]);
      for (const { body } of writes) {
        const value = body.subarray(14);
        assert.deepEqual([...value.subarray(4, 10)], [1, 0, 0, 1, 0, 0]);
        const encrypted = value.subarray(10);
        const decrypt = createDecipheriv("aes-128-ecb", Buffer.from("1234567-000000-X"), null);
        decrypt.setAutoPadding(false);
        const plain = Buffer.concat([decrypt.update(encrypted), decrypt.final()]);
        const expected = buildNightVisionBody(0, mode, options.accountId);
        assert.deepEqual(plain.subarray(0, expected.length), expected);
        assert.ok(plain.subarray(expected.length).every((byte) => byte === 0));
        assert.deepEqual(value, writes[0]!.body.subarray(14));
      }
    } finally { session.close(); }
  });
}

for (const override of [{ cameraModel: "T8214" }, { channel: 1 }, { standaloneNightVisionSupported: false }]) {
  test(`unapproved direct route refuses ${JSON.stringify(override)}`, async (context) => {
    offlinePeer(context);
    const session = new FirstPartyPpcsSession({ ...options, ...override });
    try {
      await session.start();
      await assert.rejects(session.writeNightVision(1), /requires a HomeBase-attached camera/);
    } finally { session.close(); }
  });
}

test("one eligibility decision gates direct identity, route and capability offering", () => {
  const device = parseMegaInventory({ devices: [{ device_sn: "camera", device_model: "T8171", device_type: 88,
    category: "eufy_security", device_channel: 0, member: { admin_user_id: "fixture-account" },
    params: [{ param_type: 1277, param_value: "1" }] }] })[0]!;
  const route = { peer: device, homeBaseAttached: false };
  assert.equal(supportsStandaloneNightVision(device, route, true), true);
  for (const changed of [{ model: "T8171-X" }, { deviceType: 94 }, { channel: 1 }, { adminUserId: null }, { reads: {} }]) {
    assert.equal(supportsStandaloneNightVision({ ...device, ...changed }, route, true), false);
  }
  assert.equal(supportsStandaloneNightVision(device, route, false), false);
  assert.equal(supportsStandaloneNightVision(device, null, true), false);
  assert.equal(supportsStandaloneNightVision(device, { ...route, homeBaseAttached: true }, true), false);
  assert.equal(supportsStandaloneNightVision(device, { ...route, peer: { ...device, serial: "foreign" } }, true), false);
  for (const [attached, direct, expected] of [[false, undefined, false], [false, true, true], [true, false, true]] as const) {
    const manifest = describeCameraCapabilities(device, { doorbellSupported: false, streamSupported: true,
      homeBaseAttached: attached, ...(direct === undefined ? {} : { standaloneNightVisionSupported: direct }) });
    assert.equal(manifest.matrix.find(({ id }) => id === "camera.night_vision")?.offerable, expected);
  }
});


test("SoloCam T8171 uses its native infrared values without widening other models", () => {
  const device = { model: "T8171", deviceType: 88, category: "eufy_security", reads: { nightVisionMode: 1 } };
  assert.deepEqual(nightVisionModes(device), [
    { value: 3, name: "Infrared on" }, { value: 1, name: "Infrared" }, { value: 0, name: "Off" },
  ]);
  assert.equal(safeInventoryReads([{ param_type: 1277, param_value: "3" }], 88, "T8171").nightVisionMode, 3);
  assert.equal(safeInventoryReads([{ param_type: 1277, param_value: "3" }], 34, "T8417").nightVisionMode, undefined);
  assert.equal(safeInventoryReads([{ param_type: 1277, param_value: "3" }], 88, "T8171-X").nightVisionMode, undefined);
  for (const [model, zeroName] of [["T817L", "Colour"], ["T8160", "Colour"], ["T8171-X", "Off"]] as const) {
    assert.deepEqual(nightVisionModes({ ...device, model }), [
      { value: 0, name: zeroName }, { value: 1, name: "Infrared" }, { value: 2, name: "Spotlight" },
    ]);
  }
});

test("SoloCam T8171 rejects the unrelated spotlight value", async (context) => {
  offlinePeer(context);
  const session = new FirstPartyPpcsSession(options);
  try {
    await session.start();
    await assert.rejects(session.writeNightVision(2), /not supported for this camera model/);
    await assert.rejects(session.writeNightVision(4), /not supported for this camera model/);
  } finally { session.close(); }
});
