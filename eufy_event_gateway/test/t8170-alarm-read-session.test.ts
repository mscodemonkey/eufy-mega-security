/**
 * Drives the real T8170 read session with synthetic key negotiation and a mocked UDP
 * socket. Tests own every protocol reply and key and cannot contact hardware.
 */

import assert from "node:assert/strict";
import { createCipheriv, createECDH, createHmac } from "node:crypto";
import { Socket } from "node:dgram";
import test, { type TestContext } from "node:test";
import { FirstPartyPpcsSession, type PpcsCipherKeyOutcome } from "../src/stream/first-party-ppcs.js";
import { closedAlarmStateResult, modelControlTrialActions, parseModelControlTrial, modelControlTrialCommand, runModelControlTrial } from "../src/provider/model-control-trials.js";
import { buildModelControlTrialPayload, buildC31CameraInfoQueryPayload } from "../src/stream/first-party-ppcs.js";


async function syntheticSession(context: TestContext, negotiated: boolean | "missing" | "short" | "resolver-throws" | "unwrap" | "bad-block" | "wrong-valid" | "sign" = true, outcome?: () => Promise<PpcsCipherKeyOutcome>) {
  let socket!: Socket, sequence = 0;
  const controls: { command: number; channel: number }[] = [];
  const outgoing: number[] = [];
  const queries: Buffer[] = [];
  let query: () => void = () => {};
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
    outgoing.push(command);
    if (command === 1103) { queries.push(Buffer.from(packet.subarray(14))); queueMicrotask(() => query()); }
    if (command !== 1201 && command !== 1202) return;
    controls.push({ command, channel });
    if (callbacks.failSend) throw Error("private-send-error");
    queueMicrotask(() => callbacks.control(command, channel));
  });
  const session = new FirstPartyPpcsSession({ stationSerial: "test fixture 1234567", p2pDid: "TEST-12345678-TEST", appConnection: "", dskKey: "synthetic", channel: 0,
    homeBaseAttached: false, cameraModel: "T8170", accountId: "synthetic-owner", purpose: "control", modelControlTrial: true, maxSeconds: 40,
    resolveCipherKey: async () => { if (negotiated === "resolver-throws") throw Error("private-resolver");
      if (negotiated === "wrong-valid") { const other = createECDH("prime256v1"); other.generateKeys(); return other.getPrivateKey().toString("hex"); }
      return negotiated === false ? undefined : recipient.getPrivateKey().toString("hex"); },
    ...(outcome ? { resolveCipherKeyOutcome: outcome } : {}) });
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
  if (negotiated === "unwrap") gateway.fill(0);
  const encryptedGateway = Buffer.concat([legacy.update(gateway), legacy.final()]);
  if (negotiated !== "missing") incoming(1100, 0, negotiated === "short" ? Buffer.alloc(16)
    : negotiated === "bad-block" ? Buffer.alloc(145) : encryptedGateway, negotiated === "sign" ? 0 : 1, 0);
  await new Promise(resolve => setImmediate(resolve));
  return { session, controls, outgoing, queries, onQuery: (f: () => void) => { query = f; }, callbacks, respond, incoming, encryptedGateway, key: recipient.getPrivateKey().toString("hex") };
}


const alarmRoute = { model: "T8170", deviceType: 48, peerModel: "T8170", selfPeer: true, homeBaseAttached: false, channel: 0 };

test("closed parser, route admission and every generic write boundary reject alarm writes", async () => {
  assert.deepEqual(parseModelControlTrial({ action: "alarmState", enabled: false }), { action: "alarmState", enabled: false });
  for (const enabled of [true, 0, "false", undefined]) assert.throws(() => parseModelControlTrial({ action: "alarmState", enabled }));
  assert.throws(() => parseModelControlTrial({ action: "alarmState", enabled: false, extra: 1 }));
  assert.deepEqual(modelControlTrialActions(alarmRoute), ["alarmState"]);
  for (const change of [{ homeBaseAttached: true }, { selfPeer: false }, { channel: 1 }, { deviceType: 49 }, { peerModel: "T8171" }, { model: "T8171" }])
    assert.equal(modelControlTrialActions({ ...alarmRoute, ...change }).includes("alarmState"), false);
  const request = { action: "alarmState", enabled: false } as const;
  assert.throws(() => modelControlTrialCommand(request, alarmRoute, "fixture", Date.now()));
  assert.throws(() => buildModelControlTrialPayload(request, alarmRoute, "fixture", Buffer.alloc(16), Buffer.alloc(32), 1, Date.now()));
  await assert.rejects(runModelControlTrial({ read: async () => { throw Error("forbidden"); }, write: async () => { throw Error("forbidden"); } }, request, () => {}), /cannot dispatch/);
});

for (const channel of [0, 255]) test(`one read query accepts channel ${channel} without mutating legacy statistics`, async context => {
  const h = await syntheticSession(context);
  try {
    const before = { mode: h.session.stats.standaloneGuardMode, types: h.session.stats.cameraInfoParamTypes, battery: h.session.stats.batteryHistory };
    h.onQuery(() => h.incoming(1103, channel, Buffer.from(JSON.stringify({ params: [{ param_type: 1224, param_value: "63" }, { param_type: 3100, param_value: {} }] })), 0, 0));
    assert.deepEqual(await h.session.readT8170AlarmState(), { outcome: "decoded", parameterCount: 2, guardMode: 63 });
    assert.deepEqual(h.outgoing, [1100, 1103]);
    assert.deepEqual(h.queries, [Buffer.from("040000000100ff000000ff000000", "hex")]);
    assert.deepEqual(h.queries[0], buildC31CameraInfoQueryPayload());
    assert.deepEqual({ mode: h.session.stats.standaloneGuardMode, types: h.session.stats.cameraInfoParamTypes, battery: h.session.stats.batteryHistory }, before);
    h.incoming(1103, channel, Buffer.from('{"params":[{"param_type":1224,"param_value":0}]}'), 0, 0);
    assert.equal(h.session.stats.standaloneGuardMode, before.mode);
  } finally { h.session.close(); }
});

for (const value of [0, 1, 2, 3, 4, 5, 6, 47, 63, "0", "6", "47", "63", true, "01", -0, 7, {}, null]) {
  test(`raw guard mode ${JSON.stringify(value)} has strict enum semantics`, async context => {
    const h = await syntheticSession(context);
    try {

      // Preserve negative zero in JSON to exercise the decoder rather than JSON.stringify's normalization.
      const body = Object.is(value, -0) ? '{"params":[{"param_type":1224,"param_value":-0}]}' : JSON.stringify({ params: [{ param_type: 1224, param_value: value }] });
      h.onQuery(() => h.incoming(1103, 255, Buffer.from(body), 0, 0));
      const result = await h.session.readT8170AlarmState();
      const valid = !Object.is(value, -0) && (typeof value === "number" && [0,1,2,3,4,5,6,47,63].includes(value) || typeof value === "string" && /^(?:[0-6]|47|63)$/.test(value));
      assert.deepEqual(result, { outcome: "decoded", parameterCount: 1, ...(valid ? { guardMode: Number(value) } : {}) });
    } finally { h.session.close(); }
  });
}

test("duplicate nonprimitive guard rows disqualify mode while all distinct integer types count", async context => {
  const h = await syntheticSession(context);
  try {
    h.onQuery(() => h.incoming(1103, 0, Buffer.from(JSON.stringify({ params: [
      { param_type: 1224, param_value: 1 }, { param_type: 1224, param_value: {} }, { param_type: 2, param_value: [] },
      { param_type: 3, param_value: null }, { param_type: "4", param_value: 0 }, { param_type: 2.5, param_value: true }] })), 0, 0));
    assert.deepEqual(await h.session.readT8170AlarmState(), { outcome: "decoded", parameterCount: 3 });
  } finally { h.session.close(); }
});

for (const mode of ["timeout", "close", "bad-json", "bad-schema", "wrong-channel", "oversize", "encrypted-oversize", "rows", "send-failure"]) {
  test(`owned read ${mode} retires its slot without writes or shared-stat changes`, async context => {
    const h = await syntheticSession(context);
    try {
      context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
      let dispatched!: () => void; const sent = new Promise<void>(resolve => { dispatched = resolve; });
      h.onQuery(() => {
        if (mode === "close") h.session.close();
        if (mode === "bad-json") h.incoming(1103, 0, Buffer.from("{"), 0, 0);
        if (mode === "bad-schema") h.incoming(1103, 0, Buffer.from("{}"), 0, 0);
        if (mode === "wrong-channel") h.incoming(1103, 1, Buffer.from('{"params":[]}'), 0, 0);
        if (mode === "oversize") h.incoming(1103, 0, Buffer.alloc(262145), 0, 0);
        if (mode === "encrypted-oversize") h.incoming(1103, 0, Buffer.alloc(262177), 8, 0);
        if (mode === "rows") h.incoming(1103, 0, Buffer.from(JSON.stringify({ params: Array(65536).fill(0) })), 0, 0);
        dispatched();
      });
      if (mode === "send-failure") context.mock.method(Socket.prototype, "send", (packet: Buffer) => {
        if (packet.length >= 24 && packet.readUInt16LE(12) === 1103) { dispatched(); throw Error("private failure"); }
      });
      const running = h.session.readT8170AlarmState(); await sent;
      context.mock.timers.tick(10001);
      const result = await running;
      const size = ["oversize", "encrypted-oversize", "rows"].includes(mode);
      assert.deepEqual(result, { outcome: mode === "close" || mode === "send-failure" || size ? "unavailable" : "timeout",
        frames: size || mode === "bad-json" || mode === "bad-schema" ? 1 : 0,
        parseStage: size || mode === "bad-schema" ? "invalid_schema" : mode === "bad-json" ? "invalid_json" : "none", keyReady: true });
      assert.equal(h.session.stats.cameraInfoFrames, 0);
    } finally { h.session.close(); }
  });
}

test("slot is reserved before key await and unsolicited replies cannot settle it", async context => {
  const h = await syntheticSession(context, "missing");
  try {
    context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    let settled = false;
    const running = h.session.readT8170AlarmState().then(value => { settled = true; return value; });
    await assert.rejects(h.session.readCameraInfo(), /in progress/);
    await assert.rejects(h.session.writeModelControlTrial({ action: "motion", enabled: true }, alarmRoute), /owns|cannot/);
    await assert.rejects(h.session.writeMotionDetection(true), /owns/);
    h.incoming(1103, 0, Buffer.from('{"params":[]}'), 0, 0);
    await Promise.resolve(); assert.equal(settled, false);
    context.mock.timers.tick(10002);
    assert.deepEqual(await running, { outcome: "unavailable", frames: 0, parseStage: "none", keyReady: false });
    assert.deepEqual(h.outgoing, [1100]);
  } finally { h.session.close(); }
});

for (const mode of [false, "resolver-throws"] as const) test(`failed key ${mode} sends no read`, async context => {
  const h = await syntheticSession(context, mode);
  try {
    assert.deepEqual(await h.session.readT8170AlarmState(), { outcome: "unavailable", frames: 0, parseStage: "none", keyReady: false });
    assert.deepEqual(h.outgoing, [1100]);
  } finally { h.session.close(); }
});

test("closed result rebuild strips malformed and private additions", () => {
  for (const value of [{ outcome: "decoded", parameterCount: 1, guardMode: 0, private: "sentinel" },
    { outcome: "decoded", parameterCount: 65536 }, { outcome: "decoded", parameterCount: 1, guardMode: true },
    { outcome: "timeout", frames: 0, parseStage: "none", keyReady: false, private: "sentinel" }])
    assert.deepEqual(closedAlarmStateResult(value), { outcome: "unavailable", frames: 0, parseStage: "none", keyReady: false });
});

test("all public setting writers and control queries refuse the owned read slot", async context => {
  const h = await syntheticSession(context, "missing");
  try {
    const running = h.session.readT8170AlarmState();
    for (const name of Object.getOwnPropertyNames(FirstPartyPpcsSession.prototype).filter(name => name.startsWith("write"))) {
      const method = Reflect.get(h.session, name) as (...args: unknown[]) => Promise<unknown>;
      await assert.rejects(method.call(h.session, false, alarmRoute, () => undefined), /owns|cannot dispatch/);
    }
    await assert.rejects(h.session.queryPresetPositions(), /in flight|owns/);
    h.session.close();
    assert.deepEqual(await running, { outcome: "unavailable", frames: 0, parseStage: "none", keyReady: false });
    assert.deepEqual(h.outgoing, [1100]);
  } finally { h.session.close(); }
});

test("maximum session lifetime retires an outstanding dispatched read as unavailable", async context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const h = await syntheticSession(context);
  try {
    context.mock.timers.tick(35000);
    const running = h.session.readT8170AlarmState();
    await Promise.resolve();
    context.mock.timers.tick(40001);
    assert.deepEqual(await running, { outcome: "unavailable", frames: 0, parseStage: "none", keyReady: true });
    assert.deepEqual(h.outgoing, [1100, 1103]);
  } finally { h.session.close(); }
});
