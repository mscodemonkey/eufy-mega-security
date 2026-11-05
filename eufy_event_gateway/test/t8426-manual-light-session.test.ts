/**
 * Exercises T8426's native manual-light envelope through the real PPCS session.
 * Test-owned socket messages replace network I/O. The provider still owns fresh
 * setting readback, while this boundary must send once without media or motion.
 */
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { Socket } from "node:dgram";
import test from "node:test";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";

for (const mode of ["on", "off", "guard", "wrong-model", "wrong-type", "attached", "closed"] as const) {
  test(`T8426 native manual light ${mode}`, async context => {
    const sent: Buffer[] = [];
    context.mock.method(Socket.prototype, "bind", function(this: Socket) {
      queueMicrotask(() => this.emit("message", Buffer.from([0xf1, 0x42, 0, 0]), { address: "127.0.0.1", port: 12345 }));
      return this;
    });
    context.mock.method(Socket.prototype, "send", function(data: Buffer) { sent.push(Buffer.from(data)); });
    context.mock.method(Socket.prototype, "close", function(this: Socket) { return this; });
    const session = new FirstPartyPpcsSession({ stationSerial: "SYNTHETIC1234567", p2pDid: "TEST-12345678-TEST", appConnection: "",
      dskKey: "synthetic", channel: 0, homeBaseAttached: false, cameraModel: mode === "wrong-model" ? "T8426X" : "T8426",
      accountId: "synthetic-account", purpose: "control" });
    try {
      await session.start();
      if (mode === "closed") session.close();
      let dispatched = 0;
      const route = { model: "T8426", deviceType: mode === "wrong-type" ? 47 : 87, peerModel: "T8426", channel: 0,
        homeBaseAttached: mode === "attached", selfPeer: true };
      const operation = session.writeReviewedCameraSetting({ setting: "manualFloodlight", value: mode !== "off" }, route, () => {
        if (mode === "guard") throw Error("Account changed");
        dispatched++;
      });
      if (mode === "on" || mode === "off") await operation;
      else await assert.rejects(operation);
      const frames = sent.filter(bytes => { const at = bytes.indexOf(Buffer.from("XZYH")); return at >= 0 && bytes.readUInt16LE(at + 4) === 1700; });
      assert.equal(frames.length, mode === "on" || mode === "off" ? 1 : 0);
      assert.equal(dispatched, frames.length);
      if (frames[0]) {
        const at = frames[0].indexOf(Buffer.from("XZYH"));
        assert.equal(frames[0][at + 13], 1);
        assert.equal(frames[0][at + 12], 0);
        const decipher = createDecipheriv("aes-128-ecb", Buffer.from("1234567-12345678"), null);
        decipher.setAutoPadding(false);
        const clear = Buffer.concat([decipher.update(frames[0].subarray(at + 16)), decipher.final()]);
        const text = clear.toString().replace(/\x00+$/, "").trim();
        const value = mode === "on" ? 1 : 0;
        assert.deepEqual(JSON.parse(text), { commandType: 1400, data: { value, open: value, type: 2 } });
      }
      assert.equal(session.stats.mediaStartAttempts, 0);
    } finally { session.close(); }
  });
}
