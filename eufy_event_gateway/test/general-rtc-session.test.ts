/**
 * Exercises encrypted RTC wire sequencing with synthetic sockets and peers.
 * Fixtures own clocks, keys, messages and RTP. They never contact an account,
 * and a successful fixture proves lifecycle behaviour rather than hardware support.
 */
import assert from "node:assert/strict";
import { createECDH, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import test, { type TestContext } from "node:test";
import WebSocket from "ws";
import type { RTCPeerConnection } from "werift";
import { captureGeneralRtcIdentity, generalRtcCipher } from "../src/mega/general-rtc-identity.js";
import type { MegaSession } from "../src/mega/types.js";
import { GeneralRtcSession } from "../src/stream/general-rtc-session.js";
import { GeneralRtcError } from "../src/stream/general-rtc-protocol.js";
import { syntheticGeneralOffer } from "./fixtures/general-rtc.js";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

/** Minimal test socket owns its listeners and records bytes until immediate close. */
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: Record<string, unknown>[] = [];
  terminated = false;
  send(text: string): void { this.sent.push(JSON.parse(text) as Record<string, unknown>); }
  open(): void { this.readyState = WebSocket.OPEN; this.emit("open"); }
  close(): void { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  terminate(): void { this.terminated = true; this.close(); }
}

/** One fixture-owned subscription source models werift's event boundary. */
class Signal<T> {
  readonly #listeners: ((value: T) => void)[] = [];
  subscribe(listener: (value: T) => void): void { this.#listeners.push(listener); }
  emit(value: T): void { for (const listener of this.#listeners) listener(value); }
}

/** Fake peer owns negotiation ordering and can hold a transition for cancellation tests. */
class FakePeer {
  readonly connectionStateChange = new Signal<string>();
  readonly onIceCandidate = new Signal<{ candidate: string }>();
  readonly onTrack = new Signal<unknown>();
  readonly transitions: string[] = [];
  localDescription: { sdp: string } | null = null;
  remote = "";
  gate: Promise<void> | null = null;
  closed = 0;
  async setRemoteDescription(value: { sdp: string }): Promise<void> { this.transitions.push("remote"); this.remote = value.sdp; if (this.gate) await this.gate; }
  async createAnswer(): Promise<{ sdp: string }> { this.transitions.push("answer"); return { sdp: this.remote.replace("a=sendonly", "a=recvonly") }; }
  async setLocalDescription(value: { sdp: string }): Promise<void> { this.transitions.push("local"); this.localDescription = value; }
  async close(): Promise<void> { this.closed++; }
}

/** Create one real cipher with synthetic identity and no external network owner. */
function fixture(context: TestContext) {
  const scalar = "1".padStart(64, "0"), pair = createECDH("prime256v1"); pair.setPrivateKey(Buffer.from(scalar, "hex"));
  const native: MegaSession = { version: 2, country: "au", openUdid: "synthetic", credentialVerifier: "a".repeat(64),
    authToken: "SENTINEL_TOKEN", userId: "synthetic-owner", tokenExpiresAt: 9e9, verificationPending: false,
    megaDomain: "mega-eu-pr.eufy.com", domains: {}, identities: {} };
  const identity = captureGeneralRtcIdentity(native, "security-app-ie.eufylife.com", scalar, pair.getPublicKey("hex"), undefined)!;
  const cipher = generalRtcCipher({ ...native, generalRtcIdentity: identity }, "security-app-ie.eufylife.com")!;
  const socket = new FakeSocket(), peer = new FakePeer(), controller = new AbortController();
  let now = 0, peerCount = 0, attached = 0, current = true;
  const chunks: Buffer[] = [], servers: unknown[] = [];
  const session = new GeneralRtcSession({ host: "security-smart-ie.eufylife.com", token: native.authToken, sign: "SENTINEL_SIGN",
    pin: "12+/&?", parent: "synthetic-parent", child: "synthetic-child", administrator: native.userId, channel: 7,
    cipher, signal: controller.signal, current: () => current, ready: output => { attached++; output.on("data", chunk => chunks.push(Buffer.from(chunk))); } }, {
    socket: (url, protocols, options) => {
      assert.equal(url, "wss://security-smart-ie.eufylife.com/v1/smart/ws/join?sign=SENTINEL_SIGN&pin=12%2B%2F%26%3F");
      assert.deepEqual(protocols, [native.authToken]); assert.deepEqual(options.headers, { Origin: "https://mysecurity.eufylife.com" });
      assert.equal(options.followRedirects, false); assert.equal(options.maxPayload, 65536); assert.equal(options.handshakeTimeout, 10000);
      assert.equal(options.perMessageDeflate, false); assert.notEqual(options.rejectUnauthorized, false);
      return socket as unknown as WebSocket;
    }, peer: (relays) => { peerCount++; servers.push(relays); return peer as unknown as RTCPeerConnection; }, now: () => now, epoch: () => 1_700_000_000_000,
  });
  context.after(() => session.close());
  const pending = session.start(); void pending.catch(() => undefined); socket.open();
  const receive = async (inner: Record<string, unknown>, outer: Record<string, unknown> = {}) => {
    socket.emit("message", Buffer.from(JSON.stringify({ ...outer, data: cipher.encrypt(JSON.stringify(inner)) })), false); await flush();
  };
  const camera = async (kind: string, data: Record<string, unknown>) => receive({ action: 3, dataType: kind, data: JSON.stringify(data) });
  const sent = () => socket.sent.filter(row => typeof row.data === "string").map(row => ({ outer: row,
    inner: JSON.parse(cipher.decrypt(row.data as string)) as Record<string, unknown> }));
  return { socket, peer, controller, session, pending, receive, camera, sent, chunks, servers,
    counts: () => ({ peerCount, attached }), invalidate: () => { current = false; },
    advance: async (ms: number) => { now += ms; context.mock.timers.tick(ms); await flush(); } };
}

const relay = { turn_addr: "8.8.8.8", turn_port: 3478, turn_user: "synthetic", turn_password: "synthetic" };

test("golden encrypted frames use the general account proof and retire hangup before plain logout", async context => {
  const f = fixture(context);
  assert.deepEqual(f.sent()[0]?.inner, { code: 200, action: 1, data: "SENTINEL_SIGN" }); assert.equal(f.sent()[0]?.outer.msgid, "0");
  await f.receive({ action: 1 });
  assert.deepEqual(f.sent()[1]?.inner, { action: 2, data: '{"source":"SMART"}', code: 200 });
  const call = f.sent()[2]!;
  assert.match(String(call.outer.msgid), /^SENTINEL_TOKEN_/);
  assert.deepEqual(call.inner, { code: 200, action: 3, sessionId: "SENTINEL_SIGN", sn: "synthetic-parent", subSn: "synthetic-child",
    channelId: 7, is_response: 0, dataType: "call", source: "WEB", ts: 1_700_000_000,
    data: JSON.stringify({ timestamp: 1_700_000_000, account: createHash("md5").update("7synthetic-owner1700000000").digest("hex") }) });
  await f.session.close();
  const last = f.socket.sent.slice(-2);
  assert.equal(JSON.parse(f.sent().at(-1)!.inner.data as string).timestamp, 1_700_000_000);
  assert.equal(f.sent().at(-1)!.inner.dataType, "hangup");
  assert.deepEqual(last[1], { code: 200, msgid: "0", action: 4 });
  assert.equal(f.session.close(), f.session.close());
  await assert.rejects(f.pending, GeneralRtcError);
});

test("timeouts share one four-call budget and a 486 retry is paced by at least three seconds", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(context); await f.receive({ action: 1 });
  await f.camera("call", { status: 486 });
  await f.advance(2999); assert.equal(f.sent().filter(row => row.inner.dataType === "call").length, 1);
  await f.advance(1); assert.equal(f.sent().filter(row => row.inner.dataType === "call").length, 2);
  await f.advance(5000); await f.camera("call", { status: 486 }); await f.advance(3000);
  assert.equal(f.sent().filter(row => row.inner.dataType === "call").length, 4);
  await f.advance(5000); await assert.rejects(f.pending, (error: unknown) => error instanceof GeneralRtcError && error.reason === "call_limit");
});

test("ping is first sent on auth, then ten seconds after acknowledgement and never resent", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(context); await f.receive({ action: 1 }); await f.camera("call", { status: 200 });
  await f.receive({ action: 2 }); await f.advance(9999);
  assert.equal(f.sent().filter(row => row.inner.action === 2).length, 1);
  await f.advance(1); assert.equal(f.sent().filter(row => row.inner.action === 2).length, 2);
  await f.advance(30_000);
  await assert.rejects(f.pending, GeneralRtcError);
  assert.equal(f.sent().filter(row => row.inner.action === 2).length, 2);
});

for (const contradiction of [{ sn: "other" }, { subSn: "other" }, { channelId: 8 }, { sessionId: "other" }, { code: 201 }]) {
  test(`contradictory incoming binding is terminal ${Object.keys(contradiction)[0]}`, async context => {
    const f = fixture(context); await f.receive({ action: 1 }); await f.receive({ action: 2, ...contradiction });
    await assert.rejects(f.pending, GeneralRtcError);
  });
}

test("binary, undecryptable and pre-auth camera frames terminate without raw error content", async context => {
  for (const kind of ["binary", "cipher", "early"] as const) {
    const f = fixture(context);
    if (kind === "early") await f.camera("call", { status: 200 });
    else f.socket.emit("message", Buffer.from(kind === "binary" ? "SENTINEL_PIN" : '{"data":"SENTINEL_PIN"}'), kind === "binary");
    await assert.rejects(f.pending, (error: unknown) => error instanceof GeneralRtcError && !error.message.includes("SENTINEL"));
  }
});

test("unknown actions have a finite allowance and 408 never retries", async context => {
  const f = fixture(context); await f.receive({ action: 1 });
  for (let i = 0; i < 16; i++) await f.receive({ action: 999 });
  assert.equal(f.socket.readyState, WebSocket.OPEN);
  await f.receive({ action: 999 }); await assert.rejects(f.pending, GeneralRtcError);
  const second = fixture(context); await second.receive({ action: 1 }); await second.camera("call", { status: 408 });
  await assert.rejects(second.pending, GeneralRtcError);
  assert.equal(second.sent().filter(row => row.inner.dataType === "call").length, 1);
});

test("early offer waits for validated TURN, repeats are harmless, negotiation is sequential and RTP owns one source", async context => {
  const f = fixture(context); await f.receive({ action: 1 }); await f.camera("call", { status: 200 });
  await f.camera("info", { format: "SDP", value: syntheticGeneralOffer() }); assert.equal(f.counts().peerCount, 0);
  await f.camera("call", { status: 100, turn: relay }); await f.camera("call", { status: 100, turn: relay });
  await f.camera("info", { format: "SDP", value: syntheticGeneralOffer() });
  assert.equal(f.counts().peerCount, 1); assert.deepEqual(f.peer.transitions, ["remote", "answer", "local"]);
  assert.deepEqual(f.servers[0], [{ urls: "turn:8.8.8.8:3478?transport=udp", username: "synthetic", credential: "synthetic" }]);
  const rtp = new Signal<unknown>();
  f.peer.onTrack.emit({ kind: "video", codec: { payloadType: 99 }, ssrc: 12345, onReceiveRtp: rtp });
  rtp.emit({ header: { payloadType: 99, ssrc: 12345, sequenceNumber: 1, timestamp: 0, marker: true },
    payload: Buffer.from([24, 0, 2, 0x67, 1, 0, 2, 0x68, 2, 0, 2, 0x65, 0x80]) });
  assert.equal(f.counts().attached, 1); await f.pending; assert.ok(Buffer.concat(f.chunks).length > 0);
  await f.camera("call", { status: 100, turn: { ...relay, turn_port: 3479 } });
  assert.equal(f.socket.readyState, WebSocket.CLOSED); assert.equal(f.peer.closed, 1);
});

test("cancellation between peer transitions cannot send an answer or create a replacement peer", async context => {
  const f = fixture(context); let release!: () => void;
  f.peer.gate = new Promise<void>(resolve => { release = resolve; });
  await f.receive({ action: 1 }); await f.camera("call", { status: 100, turn: relay }); await f.camera("call", { status: 200 });
  await f.camera("info", { format: "SDP", value: syntheticGeneralOffer() });
  assert.deepEqual(f.peer.transitions, ["remote"]); f.controller.abort();
  await assert.rejects(f.pending, GeneralRtcError); release(); await flush();
  assert.deepEqual(f.peer.transitions, ["remote"]); assert.equal(f.counts().peerCount, 1);
  assert.equal(f.sent().filter(row => row.inner.dataType === "info").length, 0);
});

test("a missing heartbeat acknowledgement fails at thirty seconds without a resend", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(context); await f.receive({ action: 1 }); await f.camera("call", { status: 200 });
  await f.advance(29_999); assert.equal(f.socket.readyState, WebSocket.OPEN);
  await f.advance(1);
  await assert.rejects(f.pending, (error: unknown) => error instanceof GeneralRtcError && error.reason === "heartbeat");
  assert.equal(f.sent().filter(row => row.inner.action === 2).length, 1);
});

test("an accepted early offer without TURN expires at the shared startup deadline", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(context); await f.receive({ action: 1 }); await f.receive({ action: 2 });
  await f.camera("call", { status: 200 }); await f.camera("info", { format: "SDP", value: syntheticGeneralOffer() });
  await f.advance(34_999); assert.equal(f.socket.readyState, WebSocket.OPEN);
  await f.advance(1);
  await assert.rejects(f.pending, (error: unknown) => error instanceof GeneralRtcError && error.stage === "turn" && error.reason === "timeout");
  assert.equal(f.counts().peerCount, 0);
});

test("the incoming queue is capped while negotiation is blocked and late frames cannot restart it", async context => {
  const f = fixture(context); let release!: () => void;
  f.peer.gate = new Promise<void>(resolve => { release = resolve; });
  await f.receive({ action: 1 }); await f.camera("call", { status: 100, turn: relay }); await f.camera("call", { status: 200 });
  await f.camera("info", { format: "SDP", value: syntheticGeneralOffer() });
  for (let i = 0; i < 32; i++) f.socket.emit("message", Buffer.from('{"data":"unused"}'), false);
  await assert.rejects(f.pending, (error: unknown) => error instanceof GeneralRtcError && error.reason === "frame");
  release(); await flush(); await f.receive({ action: 1 });
  assert.equal(f.counts().peerCount, 1); assert.deepEqual(f.peer.transitions, ["remote"]);
});
