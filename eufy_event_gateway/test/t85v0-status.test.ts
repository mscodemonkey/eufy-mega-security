/**
 * Checks the read-only lock wire against independently generated OpenSSL vectors.
 * Synthetic identities and keys stay in this test, with no network or hardware.
 */
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import test from "node:test";
import { buildT85V0StatusQuery, decodeT85V0StatusReply, T85V0StatusError, validT85V0StatusIdentity } from "../src/provider/t85v0-status.js";

const identity = { serial: "SYNTHETICLOCK001", accountId: "synthetic-account", channel: 3 };
const time = 0x65010203, sequence = 7;

// OpenSSL AES-128-CBC with PKCS7, after independent zero alignment of the TLVs.
const queryVector = "ff093a0003000240228d47a0a053cb3e17b430c6bdcecc2de3425c42957b3ba089cd44575954d5332f9051e0e0330b0bde36ada73b9a2004925a";
const replyVector = "ff092a000300024822c0dc9806f1f1cc131506bfa0bb61a9b73793ef635fec3a764105b8a363517e34d2";

function envelope(frame: string, changes: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ cmd: 1940, payload: { apiCommand: 6012, time, seq_num: sequence, lock_payload: frame, ...changes } }));
}

function reply(plain: Buffer, opcode = 0x4822): string {
  const aligned = Buffer.alloc(Math.ceil(plain.length / 16) * 16); plain.copy(aligned);
  const suffix = Buffer.alloc(4); suffix.writeUInt32BE(time);
  const cipher = createCipheriv("aes-128-cbc", Buffer.concat([Buffer.from("etic-account"), suffix]), Buffer.from(identity.serial));
  const encrypted = Buffer.concat([cipher.update(aligned), cipher.final()]);
  const frame = Buffer.alloc(encrypted.length + 10); frame.set([255, 9]); frame.writeUInt16LE(frame.length, 2);
  frame.set([3, 0, 2], 4); frame.writeUInt16BE(opcode, 7); encrypted.copy(frame, 9);
  frame[frame.length - 1] = frame.subarray(0, -1).reduce((sum, byte) => sum ^ byte, 0);
  return frame.toString("hex");
}

test("query is exactly the independent opcode-34 frame and attached envelope", () => {
  const query = JSON.parse(buildT85V0StatusQuery(identity, time, sequence, 0x65000000).toString());
  assert.deepEqual(query, { account_id: identity.accountId, cmd: 1940, mChannel: 3, mValue3: 0,
    payload: { apiCommand: 6012, time, seq_num: sequence, lock_payload: queryVector } });
  assert.equal(Buffer.from(query.payload.lock_payload, "hex").readUInt16BE(7), 0x4022);
});

test("fixed reply requires correlated identity and preserves hardware uncertainty", () => {
  const expected = { reportedState: "locked", batteryPercent: 77, physicalConfirmationRequired: true };
  assert.deepEqual(decodeT85V0StatusReply(envelope(replyVector), identity, time, sequence), expected);
  assert.deepEqual(decodeT85V0StatusReply(envelope(replyVector, { time: "65010203", dev_sn: identity.serial }), identity, time, sequence), expected);
  for (const changes of [{ time: time + 1 }, { seq_num: 8 }, { seq_num: undefined }, { time: undefined }]) {
    assert.equal(decodeT85V0StatusReply(envelope(replyVector, changes), identity, time, sequence), null);
  }
  assert.equal(decodeT85V0StatusReply(Buffer.from('{"cmd":1829}'), identity, time, sequence), null);
  for (const changes of [{ apiCommand: 6018 }, { dev_sn: "ANOTHERLOCK00001" }, { lock_payload: "zz" }]) {
    assert.throws(() => decodeT85V0StatusReply(envelope(replyVector, changes), identity, time, sequence), T85V0StatusError);
  }
});

for (const state of [0, 1, 2, 3, 4, 255]) test(`state ${state} does not invent lock certainty`, () => {
  const decoded = decodeT85V0StatusReply(envelope(reply(Buffer.from([0, 0xa1, 1, 77, 0xa2, 1, state]))), identity, time, sequence);
  assert.equal(decoded?.reportedState, state === 4 ? "locked" : state === 3 ? "unlocked" : "unknown");
});

test("malformed TLVs, padding and status cannot escape", () => {
  for (const hex of ["00a10165a20104", "00a1014da20104a1014d", "00a1014da2020400", "00a1014da2ff04", "00a1014da201040001", "00a1014da20104" + "00".repeat(16)]) {
    assert.throws(() => decodeT85V0StatusReply(envelope(reply(Buffer.from(hex, "hex"))), identity, time, sequence), /malformed/);
  }
  assert.throws(() => decodeT85V0StatusReply(envelope(reply(Buffer.from("01a1014da20104", "hex"))), identity, time, sequence), /rejected/);
  assert.throws(() => decodeT85V0StatusReply(envelope(reply(Buffer.from("00a1014da20104", "hex"), 0x4823)), identity, time, sequence), /malformed/);
  for (const offset of [0, 1, 2, 4, 5, 6, 7, 9, 41]) {
    const frame = Buffer.from(replyVector, "hex"); frame[offset]! ^= 1;
    assert.throws(() => decodeT85V0StatusReply(envelope(frame.toString("hex")), identity, time, sequence), /malformed/);
  }
});

test("native ASCII identity bounds and uint32 counters reject ambiguous derivation", () => {
  for (const invalid of [{ ...identity, serial: "short" }, { ...identity, accountId: "é".repeat(12) },
    { ...identity, accountId: "a".repeat(256) }, { ...identity, accountId: "a".repeat(11) }, { ...identity, channel: 255 }]) {
    assert.equal(validT85V0StatusIdentity(invalid), false);
    assert.throws(() => buildT85V0StatusQuery(invalid, time, sequence, time), /admission/);
  }
  for (const invalid of [-1, 1.5, NaN, Infinity, 0x100000000]) {
    assert.throws(() => buildT85V0StatusQuery(identity, invalid, sequence, time), /admission/);
    assert.throws(() => buildT85V0StatusQuery(identity, time, invalid, time), /admission/);
  }
  assert.throws(() => decodeT85V0StatusReply(envelope(replyVector), { ...identity, accountId: "another-account" }, time, sequence), /malformed|rejected/);
});
