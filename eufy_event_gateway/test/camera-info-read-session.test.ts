/**
 * Drives camera-info failures through the real PPCS response owner.
 * Mock UDP replies and timers own every external effect. No hardware is used.
 */
import assert from "node:assert/strict";
import { Socket } from "node:dgram";
import test, { type TestContext } from "node:test";
import { CameraInfoReadError, cameraInfoFailureReason } from "../src/stream/camera-info-failure.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";

async function fixture(context: TestContext) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let socket!: Socket, sequence = 0, queries = 0;
  const remote = { address: "127.0.0.1", port: 12345 };
  context.mock.method(Socket.prototype, "bind", function(this: Socket) {
    socket = this;
    queueMicrotask(() => this.emit("message", Buffer.from([0xf1, 0x42, 0, 0]), remote));
    return this;
  });
  context.mock.method(Socket.prototype, "close", function(this: Socket) { return this; });
  context.mock.method(Socket.prototype, "send", (packet: Buffer) => {
    if (packet.length >= 24 && packet.subarray(8, 12).toString() === "XZYH"
      && packet.readUInt16LE(12) === 1103) queries++;
  });
  const reply = (body: string, sign = 0): void => {
    const payload = Buffer.from(body), header = Buffer.alloc(16);
    header.write("XZYH"); header.writeUInt16LE(1103, 4);
    header.writeUInt32LE(payload.length, 6); header[13] = sign;
    const outer = Buffer.from([0xf1, 0xd0, 0, 0, 0xd1, 0, 0, 0]);
    outer.writeUInt16BE(sequence++, 6);
    socket.emit("message", Buffer.concat([outer, header, payload]), remote);
  };
  const session = new FirstPartyPpcsSession({ stationSerial: "test fixture 1234567",
    p2pDid: "TEST-12345678-TEST", appConnection: "", dskKey: "synthetic", channel: 0,
    homeBaseAttached: false, cameraModel: "T8110", accountId: "synthetic-owner",
    purpose: "control", modelControlTrial: true, maxSeconds: 40 });
  await session.start();
  return { session, reply, queryCount: () => queries };
}

for (const reason of ["no_reply", "not_decoded", "invalid_json", "invalid_schema"] as const) {
  test(`camera-info read reports ${reason} and retires its response slot`, async context => {
    const f = await fixture(context);
    try {
      const reading = f.session.readCameraInfo();
      const rejected = assert.rejects(reading, error => error instanceof CameraInfoReadError
        && error.reason === reason && !error.message.includes("private-response"));
      if (reason === "not_decoded") f.reply("private-response", 8);
      if (reason === "invalid_json") f.reply("private-response");
      if (reason === "invalid_schema") f.reply('{"params":"private-response"}');
      context.mock.timers.tick(10_000);
      await rejected;
      const next = f.session.readCameraInfo();
      f.reply('{"params":[{"param_type":1400,"param_value":"0"}]}');
      assert.deepEqual(await next, [{ param_type: 1400, param_value: "0" }]);
      assert.equal(f.queryCount(), 2);
    } finally { f.session.close(); }
  });
}

test("an earlier unsolicited parsed reply cannot explain a later unanswered query", async context => {
  const f = await fixture(context);
  try {
    f.reply('{"params":[{"param_type":1400,"param_value":"1"}]}');
    assert.equal(f.session.stats.cameraInfoParseStage, "parsed");
    const rejected = assert.rejects(f.session.readCameraInfo(), error =>
      error instanceof CameraInfoReadError && error.reason === "no_reply");
    context.mock.timers.tick(10_000);
    await rejected;
  } finally { f.session.close(); }
});

test("close retires a pending read and refuses another query", async context => {
  const f = await fixture(context);
  const rejected = assert.rejects(f.session.readCameraInfo(), error =>
    error instanceof CameraInfoReadError && error.reason === "unavailable");
  f.session.close();
  await rejected;
  const closed = assert.rejects(f.session.readCameraInfo(), error =>
    error instanceof CameraInfoReadError && error.reason === "unavailable");
  context.mock.timers.tick(10_000);
  await closed;
  assert.equal(f.queryCount(), 1);
});

test("a spoofed read reason cannot introduce arbitrary diagnostic text", () => {
  const error = new CameraInfoReadError("no_reply");
  Object.defineProperty(error, "reason", { value: "private-response" });
  assert.equal(cameraInfoFailureReason(error), "unavailable");
  assert.equal(cameraInfoFailureReason(Error("private-response")), "unavailable");
  assert.doesNotMatch(new CameraInfoReadError("private-response" as never).message, /private-response/);
});
