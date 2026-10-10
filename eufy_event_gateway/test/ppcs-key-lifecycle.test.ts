/**
 * Reproduce a late cloud key lookup after a synthetic PPCS session closes.
 * Socket effects are mocked so this lifecycle test cannot contact hardware.
 */
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { Socket } from "node:dgram";
import test from "node:test";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";

test("late key resolution cannot restart a closed media session", async (context) => {
  let socket!: Socket;
  let closed = false;
  let release!: (key: string) => void;
  context.mock.method(Socket.prototype, "bind", function (this: Socket) {
    socket = this;
    queueMicrotask(() => this.emit("message", Buffer.from([0xf1, 0x42, 0, 0]), { address: "127.0.0.1", port: 12345 }));
    return this;
  });
  context.mock.method(Socket.prototype, "send", () => { assert.equal(closed, false); });
  context.mock.method(Socket.prototype, "close", function (this: Socket) { closed = true; return this; });
  const session = new FirstPartyPpcsSession({ stationSerial: "SYNTHETIC1234567", p2pDid: "TEST-12345678-TEST", appConnection: "", dskKey: "synthetic", channel: 0, homeBaseAttached: false, cameraModel: "T817L", accountId: null,
    resolveCipherKey: async () => await new Promise<string>((resolve) => { release = resolve; }),
  });
  await session.start();
  const plain = Buffer.alloc(144);
  plain.writeUInt16LE(1);
  const cipher = createCipheriv("aes-128-ecb", Buffer.from("1234567-12345678"), null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const frame = Buffer.alloc(16);
  frame.write("XZYH"); frame.writeUInt16LE(1100, 4); frame.writeUInt32LE(encrypted.length, 6); frame[13] = 1;
  socket.emit("message", Buffer.concat([Buffer.from([0xf1, 0xd0, 0, 0, 0xd1, 0, 0, 0]), frame, encrypted]), { address: "127.0.0.1", port: 12345 });
  assert.equal(typeof release, "function");
  session.close();
  const attempts = session.stats.mediaStartAttempts;
  release("unused-after-close");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.stats.level2, 0);
  assert.equal(session.stats.mediaStartAttempts, attempts);
});
