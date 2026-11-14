/**
 * Qualifies the E330's exact attached manual-light candidate with synthetic
 * envelopes and sockets. The trial owns one dispatch and requires observation
 * on real hardware before its receipt can be interpreted as illumination.
 */
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { Socket } from "node:dgram";
import test from "node:test";
import { modelControlTrialActions, type ModelControlRoute } from "../src/provider/model-control-trials.js";
import { buildModelControlTrialPayload, FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";

const route: ModelControlRoute = { model: "T8600", deviceType: 24, peerModel: "T8030", peerDeviceType: 18,
  homeBaseAttached: true, selfPeer: false, channel: 3 };

test("E330 manual light excludes model aliases, other parents and ambiguous child channels", () => {
  assert.deepEqual(modelControlTrialActions(route), ["manualLight"]);
  for (const patch of [{ model: "T8600S" }, { deviceType: 124 }, { peerModel: "T8010" }, { peerDeviceType: 0 },
    { peerDeviceType: null }, { homeBaseAttached: false }, { selfPeer: true }, { channel: 255 }, { channel: -1 },
    { channel: .5 }, { channel: null }]) {
    assert.equal(modelControlTrialActions({ ...route, ...patch }).includes("manualLight"), false);
  }
});

test("E330 on/off keeps the child channel, account and level-one integer envelope", () => {
  const key = Buffer.from("0123456789abcdef");
  for (const channel of [0, 3, 254]) for (const enabled of [false, true]) {
    const frame = buildModelControlTrialPayload({ action: "manualLight", enabled }, { ...route, channel },
      "synthetic-account", key, null, 0, 1_800_000_000_000);
    assert.equal(frame.command, 1400);
    assert.deepEqual(frame.payload.subarray(4, 10), Buffer.from([1, 0, channel, 1, 0, 0]));
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    decipher.setAutoPadding(false);
    const clear = Buffer.concat([decipher.update(frame.payload.subarray(10)), decipher.final()]);
    assert.equal(clear.readUInt32LE(0), channel);
    assert.equal(clear.readUInt32LE(4), Number(enabled));
    assert.equal(clear.subarray(8, 25).toString(), "synthetic-account");
    assert.ok(clear.subarray(25).every(value => value === 0));
  }
});

/** Deliver a framed result through the session's real socket listener. */
function deliver(socket: Socket, payload: Buffer, sign: number, sequence: number, channel = 3, command = 1400, result = true): void {
  const frame = Buffer.alloc(16);
  frame.write("XZYH"); frame.writeUInt16LE(command, 4); frame.writeUInt32LE(payload.length, 6);
  frame[12] = channel; frame[13] = sign; frame[14] = result ? 1 : 0;
  const header = Buffer.from([0xf1, 0xd0, 0, 0, 0xd1, 0, 0, 0]); header.writeUInt16BE(sequence, 6);
  socket.emit("message", Buffer.concat([header, frame, payload]), { address: "127.0.0.1", port: 12345 });
}

for (const mode of ["on", "off", "negative", "timeout", "unusable", "cancelled"] as const) {
  test(`E330 sends once without a level-two key and correlates its encrypted receipt: ${mode}`, async context => {
    let socket!: Socket;
    const sent: Buffer[] = [];
    context.mock.method(Socket.prototype, "bind", function(this: Socket) {
      socket = this;
      queueMicrotask(() => this.emit("message", Buffer.from([0xf1, 0x42, 0, 0]), { address: "127.0.0.1", port: 12345 }));
      return this;
    });
    context.mock.method(Socket.prototype, "send", (data: Buffer) => { sent.push(Buffer.from(data)); });
    context.mock.method(Socket.prototype, "close", function(this: Socket) { return this; });
    const session = new FirstPartyPpcsSession({ stationSerial: "SYNTHETIC1234567", p2pDid: "TEST-12345678-TEST",
      appConnection: "", dskKey: "synthetic", channel: 3, homeBaseAttached: true, cameraModel: "T8600",
      stationModel: "T8030", accountId: "synthetic-account", purpose: "control", modelControlTrial: true });
    await session.start();
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let settled = false, dispatches = 0;
    const operation = session.writeModelControlTrial({ action: "manualLight", enabled: mode !== "off" }, route,
      () => { if (mode === "cancelled") throw Error("route retired"); }, () => { dispatches++; });
    const result = mode === "on" || mode === "off" ? operation.then(() => { settled = true; }) : assert.rejects(operation);
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(dispatches, mode === "cancelled" ? 0 : 1);
      const commands = sent.filter(value => {
        const at = value.indexOf(Buffer.from("XZYH"));
        return at >= 0 && value.readUInt16LE(at + 4) === 1400;
      });
      assert.equal(commands.length, dispatches);
      if (mode === "timeout") context.mock.timers.tick(10_000);
      else if (mode !== "cancelled") {
        const plain = Buffer.alloc(16); plain.writeInt32LE(mode === "negative" ? -1 : 0);
        const cipher = createCipheriv("aes-128-ecb", Buffer.from("1234567-12345678"), null);
        cipher.setAutoPadding(false);
        const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
        deliver(socket, Buffer.alloc(4), 0, 1);
        deliver(socket, encrypted, 1, 2, 4);
        deliver(socket, encrypted, 1, 3, 3, 1403);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false);
        if (mode === "unusable") {
          deliver(socket, Buffer.from("{}"), 1, 4, 3, 1351, false);
          context.mock.timers.tick(10_000);
        }
        else deliver(socket, encrypted, 1, 4);
      }
      await result;
      const evidence = session.controlReceiptEvidence();
      if (mode === "cancelled") assert.equal(evidence, undefined);
      else assert.deepEqual(evidence, mode === "timeout"
        ? { notificationFrames: 0, selectedNotifications: 0, resultFrames: 0, selectedFrames: 0, matchingFrames: 0, decodedFrames: 0 }
        : { notificationFrames: mode === "unusable" ? 1 : 0, selectedNotifications: mode === "unusable" ? 1 : 0,
          resultFrames: mode === "unusable" ? 3 : 4, selectedFrames: mode === "unusable" ? 2 : 3,
          matchingFrames: mode === "unusable" ? 1 : 2, decodedFrames: mode === "unusable" ? 0 : 1,
          protection: mode === "unusable" ? "clear" : "mixed", clearResultShape: "scalar" });
      session.close();
      assert.deepEqual(session.controlReceiptEvidence(), evidence);
      assert.equal(session.stats.mediaStartAttempts, 0);
    } finally { session.close(); context.mock.timers.reset(); }
  });
}
