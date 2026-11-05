/**
 * Drives the real S100 session with synthetic key negotiation and a mocked UDP
 * socket. Tests own every protocol reply and key and cannot contact hardware.
 */

import assert from "node:assert/strict";
import { createCipheriv, createECDH, createHmac } from "node:crypto";
import { Socket } from "node:dgram";
import test, { type TestContext } from "node:test";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { S100SirenTrialError } from "../src/provider/s100-siren-trial.js";



async function syntheticProvider(context: TestContext, mode: string) {
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
  context.mock.method(globalThis, "fetch", async () => { assert.fail("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ device_sn: "fixture 1234567", device_model: "T84A1", device_type: 151,
    category: "eufy_security", device_channel: 0, p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic-route", member: { admin_user_id: "synthetic-owner" } }] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ "fixture 1234567": { key: "synthetic", expiresAt: null } }));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
  context.mock.method(MegaClient.prototype, "isSessionInvalidError", () => { if(mode === "classifier-throws") throw Error("private-classifier"); return mode === "session-invalid"; });
  const lookups = context.mock.method(MegaClient.prototype, "getCiphers", async () => {
    if(mode === "request" || mode === "session-invalid" || mode === "classifier-throws") throw Error("private-owner-key-token");
    if(mode === "transport") throw new TypeError("private-owner-key-token");
    if(mode === "unknown") throw "private-owner-key-token";
    if(mode === "nonarray") return {} as never;
    if(mode === "zero") return [];
    const row = { cipher_id: 1, ecc_private_key: mode === "nonstring" ? 3 : mode === "empty" ? "" : recipient.getPrivateKey().toString("hex") };
    return (mode === "duplicate" ? [row, row] : [row]) as never;
  });
  const logs: string[] = [];
  const stderr = process.stderr.write.bind(process.stderr), stdout = process.stdout.write.bind(process.stdout);
  context.mock.method(process.stderr, "write", (v: string | Uint8Array) => {
    if(String(v).includes("component=")) { logs.push(String(v)); return true; } return stderr(v);
  });
  context.mock.method(process.stdout, "write", (v: string | Uint8Array) => {
    if(String(v).includes("component=")) { logs.push(String(v)); return true; } return stdout(v);
  });
  const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: "/nonexistent/synthetic",
    maxStreamSeconds: 120, experimentalModelControls: true });
  context.after(async () => { await provider.close(); });
  await provider.start(new Proxy({}, { get: () => () => undefined }) as ProviderEvents);
  const running = provider.performModelControlTrial("fixture 1234567", { action: "sirenConnection", enabled: false })
    .then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setImmediate(resolve));
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

  const encryptedGateway = Buffer.concat([legacy.update(gateway), legacy.final()]);
  incoming(1100, 0, encryptedGateway, 1, 0);
  const result = await running;
  return { provider, result, outgoing, controls, lookups, logs };

}


for (const mode of ["valid", "zero", "duplicate", "nonstring", "empty", "nonarray", "request", "transport", "unknown", "session-invalid", "classifier-throws"]) {
  test(`real provider and session classify cipher outcome ${mode} without exposing the source error`, async context => {
    const h = await syntheticProvider(context, mode);
    assert.equal(h.lookups.mock.callCount(), 1); assert.deepEqual(h.outgoing, [1100]); assert.deepEqual(h.controls, []);
    if(mode === "valid") { assert.ok("value" in h.result, JSON.stringify(h.result)); assert.equal(h.result.value.outcome, "prepared"); }
    else {
      assert.ok("error" in h.result); assert.ok(h.result.error instanceof S100SirenTrialError);
      const missing = ["zero", "duplicate", "nonstring", "empty"].includes(mode);
      assert.deepEqual(h.result.error.stages, ["session_cipher", missing ? "cipher_missing_key" : "cipher_lookup_error"]);
      const warnings = h.logs.filter(line => line.includes("event=cipher_lookup_unavailable"));
      assert.equal(warnings.length, missing ? 0 : 1);
      if(!missing) {
        const reason = mode === "session-invalid" ? "session_invalid" : ["transport", "nonarray"].includes(mode) ? "transport" : mode === "request" ? "request" : "unknown";
        assert.ok(warnings[0]!.includes(`reason=${reason}`));
      }
    }
    assert.equal(h.logs.some(line => /private-owner|private-classifier/.test(line)), false);
  });
}
