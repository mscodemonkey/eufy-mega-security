/**
 * Drives the real S100 session with synthetic key negotiation and a mocked UDP
 * socket. Tests own every protocol reply and key and cannot contact hardware.
 */

import assert from "node:assert/strict";
import { createCipheriv, createECDH, createHmac } from "node:crypto";
import { Socket } from "node:dgram";
import test, { type TestContext } from "node:test";
import { FirstPartyPpcsSession, PpcsVideoFrameDecoder, type PpcsCipherKeyOutcome } from "../src/stream/first-party-ppcs.js";
import { S100SirenTrialError } from "../src/provider/s100-siren-trial.js";

const route = { model: "T84A1", deviceType: 151, peerModel: "T84A1", selfPeer: true, homeBaseAttached: false, channel: 0 };

async function syntheticSession(context: TestContext, negotiated: boolean | "missing" | "short" | "resolver-throws" | "unwrap" | "bad-block" | "wrong-valid" | "sign" = true, outcome?: () => Promise<PpcsCipherKeyOutcome>) {
  let socket!: Socket, sequence = 0;
  const controls: { command: number; channel: number }[] = [];
  const outgoing: number[] = [];
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
    if (command !== 1201 && command !== 1202) return;
    controls.push({ command, channel });
    if (callbacks.failSend) throw Error("private-send-error");
    queueMicrotask(() => callbacks.control(command, channel));
  });
  const session = new FirstPartyPpcsSession({ stationSerial: "test fixture 1234567", p2pDid: "TEST-12345678-TEST", appConnection: "", dskKey: "synthetic", channel: 0,
    homeBaseAttached: false, cameraModel: "T84A1", accountId: "synthetic-owner", purpose: "control", modelControlTrial: true, maxSeconds: 40,
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
  return { session, controls, outgoing, callbacks, respond, incoming, encryptedGateway, key: recipient.getPrivateKey().toString("hex") };
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


for (const mode of ["missing", "short", "resolver-throws", "unwrap", false] as const) {
  test(`connection preflight ${mode} reports a fixed stage and sends no controls`, async context => {
    const h = await syntheticSession(context, mode);
    try {
      context.mock.timers.enable({ apis: ["Date", "setTimeout"] });
      const running = h.session.prepareS100SirenTrial(route, false);
      const failure = assert.rejects(running, (error: unknown) => error instanceof S100SirenTrialError && error.stages.join() === (mode === "missing" ? "session_gateway" : mode === "resolver-throws" ? "session_cipher,cipher_lookup_error" : mode === "unwrap" ? "session_cipher,cipher_unwrap_failed" : mode === false ? "session_cipher,cipher_missing_key" : "session_cipher"));
      context.mock.timers.tick(20_000);
      await failure;
      assert.deepEqual(h.controls, []);
    } finally { h.session.close(); }
  });
}

test("closed negotiation is preparation failure rather than a missing gateway", async context => {
  const h = await syntheticSession(context, "missing");
  const running = h.session.prepareS100SirenTrial(route, false);
  h.session.close();
  await assert.rejects(running, (error: unknown) => error instanceof S100SirenTrialError && error.stages.join() === "session_prepare");
  assert.deepEqual(h.controls, []);
});

for (const [mode, phase] of [["bad-block", "gateway_decrypt"], ["resolver-throws", "cipher_lookup_error"], ["unwrap", "cipher_unwrap_failed"], [false, "cipher_missing_key"]] as const) {
  for (const enabled of [false, true]) test(`phase ${phase}, enabled=${enabled}, sends only the existing key-negotiation query`, async context => {
    const h = await syntheticSession(context, mode);
    try {
      await assert.rejects(h.session.prepareS100SirenTrial(route, enabled), (error: unknown) => error instanceof S100SirenTrialError
        && error.stages.join() === `session_cipher,${phase}`);
      assert.deepEqual(h.outgoing, [1100]);
      assert.equal(h.session.stats.level2Error?.includes("private"), false);
    } finally { h.session.close(); }
  });
}

for (const [kind, expected] of [["missing_key", "session_cipher,cipher_missing_key"], ["lookup_failed", "session_cipher,cipher_lookup_error"],
  ["retired", "session_prepare"], ["unknown", "session_cipher,cipher_lookup_error"]] as const) {
  test(`typed outcome ${kind} settles without waiting for the control deadline`, async context => {
    const h = await syntheticSession(context, true, async () => ({ kind } as PpcsCipherKeyOutcome));
    try {
      let settled = false;
      const result = assert.rejects(h.session.prepareS100SirenTrial(route, false), (error: unknown) =>
        error instanceof S100SirenTrialError && error.stages.join() === expected).then(() => { settled = true; });
      await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(settled, true); await result;
      assert.deepEqual(h.outgoing, [1100]);
    } finally { h.session.close(); }
  });
}

test("a wrong but valid private key is not authenticated by the legacy CBC envelope", async context => {
  const h = await syntheticSession(context, "wrong-valid");
  try { await h.session.prepareS100SirenTrial(route, false); assert.equal(h.session.stats.level2, 1); assert.deepEqual(h.outgoing, [1100]); }
  finally { h.session.close(); }
});

test("decoder key setup exceptions become a fixed unwrap phase", async context => {
  context.mock.method(PpcsVideoFrameDecoder.prototype, "setEccPrivateKey", () => { throw Error("private-decoder-marker"); });
  const h = await syntheticSession(context);
  try {
    await assert.rejects(h.session.prepareS100SirenTrial(route, false), (error: unknown) => error instanceof S100SirenTrialError
      && error.stages.join() === "session_cipher,cipher_unwrap_failed");
    assert.equal(h.session.stats.level2Error?.includes("private"), false); assert.deepEqual(h.outgoing, [1100]);
  } finally { h.session.close(); }
});

test("close prevents a late callback failure from rewriting key diagnostics", async context => {
  let fail!: () => void;
  const h = await syntheticSession(context, true, async () => await new Promise<never>((_resolve, reject) => { fail = () => reject(Error("private-late")); }));
  h.session.close(); const before = h.session.stats.level2Error; fail();
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(h.session.stats.level2Error, before);
});

test("retransmission retains the latest failure and a subsequent success clears its phase", async context => {
  let key: string | undefined;
  const h = await syntheticSession(context, true, async () => key ? { kind: "key", value: key } : { kind: "missing_key" });
  try {
    h.incoming(1100, 0, Buffer.alloc(145), 1, 0); await new Promise<void>(resolve => setImmediate(resolve));
    await assert.rejects(h.session.prepareS100SirenTrial(route, false), (error: unknown) => error instanceof S100SirenTrialError
      && error.stages.join() === "session_cipher,gateway_decrypt");
    key = h.key; h.incoming(1100, 0, h.encryptedGateway, 1, 0); await new Promise<void>(resolve => setImmediate(resolve));
    await h.session.prepareS100SirenTrial(route, false); assert.deepEqual(h.outgoing, [1100]);
  } finally { h.session.close(); }
});
