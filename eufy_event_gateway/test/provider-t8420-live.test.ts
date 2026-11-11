/**
 * Exercises T8420 opt-in and key-absence classification through the real provider.
 * Synthetic inventory, a mocked UDP peer and test-owned gateway bytes replace
 * account access. The provider and session retain their normal cleanup owners.
 */
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { Socket } from "node:dgram";
import test, { type TestContext } from "node:test";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";

/** Own a synthetic exact-model provider and capture only its emitted test packets. */
async function fixture(context: TestContext, mode: string) {
  let socket!: Socket;
  let sequence = 0;
  const packets: Buffer[] = [];
  const cameras: import("../src/domain/types.js").CameraIdentity[] = [];
  const remote = { address: "127.0.0.1", port: 12345 };
  const gateway = Buffer.alloc(144); gateway.writeUInt16LE(65433);
  const cipher = createCipheriv("aes-128-ecb", Buffer.from("1234567-12345678"), null); cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(gateway), cipher.final()]);
  context.mock.method(Socket.prototype, "bind", function(this: Socket) {
    socket = this; queueMicrotask(() => this.emit("message", Buffer.from([0xf1, 0x42, 0, 0]), remote)); return this;
  });
  context.mock.method(Socket.prototype, "close", function(this: Socket) { return this; });
  context.mock.method(Socket.prototype, "send", (packet: Buffer, ...args: unknown[]) => {
    packets.push(Buffer.from(packet));
    const callback = args.at(-1); if (typeof callback === "function") queueMicrotask(() => callback());
    if (mode === "cached-only" || packet.length < 24 || packet.subarray(8, 12).toString() !== "XZYH"
      || packet.readUInt16LE(12) !== 1100) return;
    queueMicrotask(() => {
      const frame = Buffer.alloc(24 + encrypted.length);
      frame.set([0xf1, 0xd0], 0); frame.writeUInt16BE(frame.length - 4, 2);
      frame.set([0xd1, 0], 4); frame.writeUInt16BE(sequence++, 6);
      frame.write("XZYH", 8); frame.writeUInt16LE(1100, 12); frame.writeUInt32LE(encrypted.length, 14);
      frame[21] = 1; encrypted.copy(frame, 24); socket.emit("message", frame, remote);
    });
  });
  context.mock.method(globalThis, "fetch", async () => { assert.fail("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ device_sn: "fixture 1234567",
    device_model: "T8420", device_type: 3, category: "eufy_security", device_channel: 0,
    p2p_did: "TEST-12345678-TEST", p2p_conn: "synthetic-route", member: { admin_user_id: "synthetic-owner" } }] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({ "fixture 1234567": { key: "synthetic", expiresAt: null } }));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => undefined);
  context.mock.method(MegaClient.prototype, "getCiphers", async () => {
    if (mode === "error") throw new Error("synthetic lookup failure");
    if (mode === "empty" || mode === "disabled" || mode === "no-auth" || mode === "cached-only") return [];
    const row = { cipher_id: 65433, ecc_private_key: mode === "nonstring" ? 42 : "" };
    return (mode === "duplicate" ? [row, row] : [row]) as never;
  });
  const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU",
    persistentDirectory: "/nonexistent/synthetic", maxStreamSeconds: 120,
    experimentalT8420Live: mode !== "disabled", apiAuthenticationConfigured: mode !== "no-auth" });
  context.after(async () => { await provider.close(); });
  const events = new Proxy({}, { get: (_target, key) => key === "streamStarted"
    ? (_serial: string, output: NodeJS.ReadableStream) => output.resume()
    : key === "camera" ? (identity: import("../src/domain/types.js").CameraIdentity) => cameras.push(identity) : () => {} }) as ProviderEvents;
  await provider.start(events);
  await provider.startStream("fixture 1234567");
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  return { provider, packets, cameras };
}

for (const mode of ["empty", "duplicate", "nonstring", "empty-entry", "error", "disabled", "no-auth", "cached-only"]) {
  test(`the provider qualifies the T8420 alternate only for a successful empty lookup: ${mode}`, async context => {
    const f = await fixture(context, mode);
    assert.equal(f.cameras.at(-1)!.startupSnapshotSupported, mode === "disabled" ? undefined : false);
    const starts = f.packets.filter(packet => packet.length >= 24 && packet.readUInt16LE(12) === 1350);
    assert.equal(starts.length, mode === "empty" ? 1 : 0);
    await f.provider.stopStream("fixture 1234567");
    const stops = f.packets.filter(packet => packet.length >= 24 && packet.readUInt16LE(12) === 1004);
    assert.equal(stops.length, mode === "empty" ? 1 : 0);
  });
}
