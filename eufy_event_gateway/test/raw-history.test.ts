/** Tests own temporary encrypted storage and synthetic transports, never devices. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { RawHistory, decodeRawSegment, setRawHistory } from "../src/diagnostics/raw-history.js";
import { observeRawFetch, observeRawSocket } from "../src/diagnostics/raw-network.js";

async function fixture(t: test.TestContext, limits = {}) {
  const directory = await mkdtemp(join(tmpdir(), "raw-history-"));
  const history = new RawHistory({ directory, reserveBytes: 1, ...limits });
  await history.initialize();
  t.after(async () => { setRawHistory(undefined); await history.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, history };
}
async function records(directory: string): Promise<unknown[]> {
  const key = await readFile(join(directory, "key")); const result: unknown[] = [];
  for (const file of (await readdir(directory)).filter(name => name.endsWith(".raw")).sort()) {
    result.push(...decodeRawSegment(await readFile(join(directory, file)), key).records);
  }
  return result;
}
const observation = { boundary: "test", connection: "local", direction: "receive" as const };

test("encrypted bytes survive restart and copies precede caller mutation", async t => {
  const { directory, history } = await fixture(t); const bytes = Buffer.from("synthetic private message {");
  history.record(observation, bytes); bytes.fill(0); await history.flush();
  const key = await readFile(join(directory, "key"));
  const file = (await readdir(directory)).find(name => name.endsWith(".raw"))!;
  const encrypted = await readFile(join(directory, file));
  assert.equal(encrypted.includes(Buffer.from("synthetic private")), false);
  const record = decodeRawSegment(encrypted, key).records[0] as { bytes: string };
  assert.equal(Buffer.from(record.bytes, "base64").toString(), "synthetic private message {");
  await history.close(); const restarted = new RawHistory({ directory, reserveBytes: 1 });
  await restarted.initialize(); restarted.record(observation, Buffer.from("next")); await restarted.close();
  assert.equal((await records(directory)).length, 2);
});
test("tampering is rejected and incomplete crash tails are reported", async t => {
  const { directory, history } = await fixture(t);
  history.record(observation, Buffer.from("one")); history.record(observation, Buffer.from("two")); await history.flush();
  const file = (await readdir(directory)).find(name => name.endsWith(".raw"))!;
  const encrypted = await readFile(join(directory, file)); const key = await readFile(join(directory, "key"));
  const truncated = decodeRawSegment(encrypted.subarray(0, -1), key);
  assert.equal(truncated.records.length, 1); assert.equal(truncated.incompleteTail, true);
  encrypted[encrypted.length - 1]! ^= 1; assert.throws(() => decodeRawSegment(encrypted, key));
});
test("retention and queue losses are counted", async t => {
  const { directory, history } = await fixture(t, { segmentBytes: 1024, maximumBytes: 2200, queueBytes: 10000 });
  for (let i = 0; i < 10; i++) { history.record(observation, Buffer.alloc(500, i)); await history.flush(); }
  assert.ok((await readdir(directory)).filter(name => name.endsWith(".raw")).length <= 2);
  history.record(observation, Buffer.alloc(5 * 1024 ** 2));
  assert.ok((history.status() as { dropped: number }).dropped >= 1);
  assert.ok((history.status() as { evictedFiles: number }).evictedFiles > 0);
  await writeFile(join(directory, "1-abc.raw"), "old"); await history.flush();
  assert.equal((await readdir(directory)).includes("1-abc.raw"), false);
});
test("symlink keys are refused", async t => {
  const directory = await mkdtemp(join(tmpdir(), "raw-history-")); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "other"), Buffer.alloc(32), { mode: 0o600 });
  await symlink(join(directory, "other"), join(directory, "key"));
  await assert.rejects(new RawHistory({ directory }).initialize());
});
test("taps precede parser rejection and preserve send return, this and callback", async t => {
  const { directory, history } = await fixture(t); setRawHistory(history); let called = false;
  class Socket extends EventEmitter {
    send(this: Socket, value: Buffer, callback: () => void): number { assert.equal(this, socket); assert.equal(value[0], 9); callback(); return 42; }
  }
  const socket = new Socket(); observeRawSocket(socket, "udp-test", "udp");
  socket.on("message", () => { throw new Error("parser refused"); });
  assert.throws(() => socket.emit("message", Buffer.from([0xff]), { address: "synthetic" }));
  assert.equal(socket.send(Buffer.from([9]), () => { called = true; }), 42); assert.equal(called, true);
  await history.flush(); const raw = await records(directory) as { direction: string; bytes: string }[];
  assert.ok(raw.some(record => record.direction === "receive" && record.bytes === "/w=="));
  assert.ok(raw.some(record => record.direction === "send" && record.bytes === "CQ=="));
});
test("fetch retains malformed data and marks cancelled bodies incomplete", async t => {
  const { directory, history } = await fixture(t); setRawHistory(history);
  const fetcher = observeRawFetch(async () => new Response("bad {", { status: 463 }));
  const response = await fetcher("https://synthetic.invalid/event", { method: "POST", body: "command" });
  assert.equal(response.status, 463); assert.equal(await response.text(), "bad {");
  const cancelled = await fetcher("https://synthetic.invalid/cancel"); await cancelled.body!.cancel();
  await history.flush(); const raw = JSON.stringify(await records(directory));
  assert.ok(raw.includes("body_complete")); assert.ok(raw.includes("body_cancelled_incomplete"));
});

test("symmetric replay retains key, IV and rejected authentication separately", async t => {
  const { directory, history } = await fixture(t); setRawHistory(history);
  const { createRecordedDecipheriv, createRecordedCipheriv: createCipheriv } = await import("../src/diagnostics/raw-crypto.js");
  const key = Buffer.alloc(32, 7), iv = Buffer.alloc(12, 8);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update("synthetic"), cipher.final()]);
  const decipher = createRecordedDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(cipher.getAuthTag());
  assert.equal(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(), "synthetic");
  const rejected = createRecordedDecipheriv("aes-256-gcm", key, iv);
  rejected.setAuthTag(Buffer.alloc(16)); rejected.update(ciphertext);
  assert.throws(() => rejected.final());
  await history.flush();
  const raw = await records(directory) as { connection: string; metadata?: { event?: string; phase?: string; authentication?: string } }[];
  assert.ok(raw.some(record => record.metadata?.authentication === "verified"));
  assert.ok(raw.some(record => record.metadata?.event === "final" && record.metadata.phase === "failed"));
});
