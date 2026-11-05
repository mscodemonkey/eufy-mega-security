/**
 * Exercises C37 query ownership and encrypted writes through a fake UDP peer.
 * The test owns all socket effects and injects synthetic responses. It verifies
 * software framing and acknowledgement handling, never hardware behaviour.
 */
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { Socket } from "node:dgram";
import test from "node:test";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("C37 queries and writes require their channel and send the model's own payload once", { timeout: 5000 }, async context => {
  let socket!: Socket;
  const sent: { commandType: number; data: Record<string, unknown> }[] = [];
  let sequence = 0;
  context.mock.method(Socket.prototype, "bind", function(this: Socket) {
    socket = this;
    queueMicrotask(() => this.emit("message", Buffer.from([0xf1, 0x42, 0, 0]), { address: "127.0.0.1", port: 12345 }));
    return this;
  });
  context.mock.method(Socket.prototype, "close", function(this: Socket) { return this; });
  context.mock.method(Socket.prototype, "send", (packet: Buffer, _port: number, _host: string, callback?: (error: Error | null) => void) => {
    const offset = packet.indexOf("XZYH");
    if (offset >= 0 && packet.readUInt16LE(offset + 4) === 1700) {
      const length = packet.readUInt32LE(offset + 6);
      const encrypted = packet.subarray(offset + 16, offset + 16 + length);
      const decipher = createDecipheriv("aes-128-ecb", Buffer.from("1234567-12345678"), null);
      decipher.setAutoPadding(false);
      const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString().replace(/\0+$/, "");
      sent.push(JSON.parse(plain));
    }
    callback?.(null);
  });
  const deliver = (command: number, channel: number, body: Buffer, result = false): void => {
    const header = Buffer.alloc(16);
    header.write("XZYH"); header.writeUInt16LE(command, 4); header.writeUInt32LE(body.length, 6);
    header[12] = channel; header[14] = result ? 1 : 0;
    const packet = Buffer.from([0xf1, 0xd0, 0, 0, 0xd1, 0, sequence >> 8, sequence & 255]);
    sequence++;
    socket.emit("message", Buffer.concat([packet, header, body]), { address: "127.0.0.1", port: 12345 });
  };
  const session = new FirstPartyPpcsSession({ stationSerial: "SYNTHETIC1234567", p2pDid: "TEST-12345678-TEST",
    appConnection: "", dskKey: "synthetic", channel: 0, homeBaseAttached: false,
    cameraModel: "T814X", accountId: "synthetic-owner", purpose: "control", maxSeconds: 30 });
  try {
    await session.start();
    let queryDone = false;
    const query = session.queryPresetPositions().then(value => { queryDone = true; return value; });
    void query.catch(() => {});
    await tick();
    assert.deepEqual(sent, [{ commandType: 6034, data: { value: 0 } }]);
    const reply = Buffer.from(JSON.stringify({ cmd: 6034, payload: { points: [{ enable: 1, isdefault: 1 }] } }));
    deliver(1351, 1, reply);
    await tick();
    assert.equal(queryDone, false);
    deliver(1351, 0, reply);
    assert.deepEqual(await query, [{ index: 0, enabled: true, isDefault: true }]);

    let writeDone = false;
    const tracking = session.writeModelControlTrial({ action: "aiTracking", enabled: false }, {
      model: "T814X", deviceType: 10037, channel: 0, homeBaseAttached: false, peerModel: "T814X", selfPeer: true,
    }).then(() => { writeDone = true; });
    void tracking.catch(() => {});
    await tick();
    assert.equal(sent.length, 2);
    assert.equal(sent[1]!.commandType, 6016);
    assert.deepEqual(Object.keys(sent[1]!.data).sort(), ["transaction", "value"]);
    assert.equal(sent[1]!.data.value, 0);
    deliver(1700, 1, Buffer.alloc(4), true);
    await tick();
    assert.equal(writeDone, false);
    deliver(1700, 0, Buffer.alloc(4), true);
    await tracking;
    assert.equal(sent.length, 2);

    const moving = session.selectPresetPosition(0);
    void moving.catch(() => {});
    await tick();
    assert.equal(sent.length, 3);
    assert.equal(sent[2]!.commandType, 6035);
    assert.equal(sent[2]!.data.value, 0);
    deliver(1700, 0, Buffer.alloc(4), true);
    await moving;
    assert.equal(sent.length, 3);

    await assert.rejects(session.selectPresetPosition(0, () => { throw Error("retired owner"); }), /retired owner/);
    assert.equal(sent.length, 3);
  } finally { session.close(); await session.waitUntilClosed(); }
});
