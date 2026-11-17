/**
 * Qualifies content-free MCS framing snapshots with generated wire bytes.
 * Each parser belongs to one test connection. No Firebase request, account or
 * notification identity leaves the fixture; PushClient consumes these snapshots.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { McsParser } from "../src/mega/android-push/parser.js";
import { MessageTag } from "../src/mega/android-push/message-tags.js";
import { mcsRoot } from "../src/mega/android-push/proto.js";

test("framing snapshots distinguish idle, split header, split size and incomplete body without consuming bytes", () => {
  const parser = new McsParser();
  let delivered = 0;
  parser.on("message", () => delivered++);
  assert.deepEqual(parser.diagnostic(), { state: "version", bufferedBytes: 0, pendingBodyBytes: 0 });
  parser.handleData(Buffer.from([41, MessageTag.LoginResponse, 0]));
  assert.deepEqual(parser.diagnostic(), { state: "idle", bufferedBytes: 0, pendingBodyBytes: 0 });
  const Stanza = mcsRoot().lookupType("mcs_proto.DataMessageStanza");
  const body = Stanza.encode({ id: "PRIVATE_".repeat(30) }).finish();
  const encoded = Stanza.encodeDelimited({ id: "PRIVATE_".repeat(30) }).finish();
  const sizeBytes = encoded.length - body.length;
  assert.equal(sizeBytes, 2);
  parser.handleData(Buffer.from([MessageTag.DataMessageStanza]));
  assert.deepEqual(parser.diagnostic(), { state: "header", bufferedBytes: 1, pendingBodyBytes: 0 });
  parser.handleData(Buffer.from(encoded.subarray(0, 1)));
  assert.deepEqual(parser.diagnostic(), { state: "size", bufferedBytes: 1, pendingBodyBytes: 0 });
  parser.handleData(Buffer.from(encoded.subarray(1, 2)));
  assert.deepEqual(parser.diagnostic(), { state: "body", bufferedBytes: 0, pendingBodyBytes: body.length });
  parser.handleData(Buffer.from(body.subarray(0, 5)));
  const snapshot = { state: "body", bufferedBytes: 5, pendingBodyBytes: body.length - 5 };
  assert.deepEqual(parser.diagnostic(), snapshot);
  assert.deepEqual(parser.diagnostic(), snapshot);
  assert.doesNotMatch(JSON.stringify(parser.diagnostic()), /PRIVATE|Buffer|data|id/);
  assert.equal(delivered, 1);
  parser.handleData(Buffer.from(body.subarray(5)));
  assert.equal(delivered, 2);
  assert.deepEqual(parser.diagnostic(), { state: "idle", bufferedBytes: 0, pendingBodyBytes: 0 });
  parser.handleData(Buffer.from([MessageTag.DataMessageStanza, 30, 8]));
  parser.reset();
  assert.deepEqual(parser.diagnostic(), { state: "version", bufferedBytes: 0, pendingBodyBytes: 0 });
});
