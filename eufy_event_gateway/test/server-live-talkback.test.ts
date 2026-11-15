/**
 * Qualifies authenticated RTC admission and exact-session cleanup through HTTP.
 * Synthetic SDP opens no device source. Tests own all ephemeral servers and
 * negotiated transports, and refuse fallback speaker uploads while a peer owns it.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";

/** Describe a generated receive-video and send/receive-audio peer, without live candidates. */
function offer(): string {
  const common = ["c=IN IP4 0.0.0.0", "a=ice-ufrag:abcd", "a=ice-pwd:abcdefghijklmnopqrstuvwx",
    `a=fingerprint:sha-256 ${Array(32).fill("AA").join(":")}`, "a=setup:actpass", "a=rtcp-mux"];
  return ["v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0 1",
    "m=video 9 UDP/TLS/RTP/SAVPF 96", ...common, "a=mid:0", "a=recvonly", "a=rtpmap:96 H264/90000",
    "a=fmtp:96 packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1",
    "m=audio 9 UDP/TLS/RTP/SAVPF 0", ...common, "a=mid:1", "a=sendrecv", "a=rtpmap:0 PCMU/8000", ""].join("\r\n");
}

for (const enabled of [false, true]) {
  test(`live talkback HTTP admission and cleanup, enabled=${enabled}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "talkback-http-"));
    const state = new GatewayState();
    const camera = { serial: "synthetic", name: "Synthetic", model: "T817L", deviceType: 10031,
      stationSerial: "synthetic", doorbellSupported: false, streamSupported: true, liveAudioSupported: true, talkbackSupported: true,
      liveTalkbackEnabled: true, liveTalkbackSupported: true };
    state.registerCamera(camera);
    let sourceCalls = 0, speakerCalls = 0;
    const provider = { streamCameraAudio: async () => { speakerCalls++; }, playCameraAudio: async () => { speakerCalls++; } } as unknown as CameraProvider;
    const streams = { addTransportClient: async () => { sourceCalls++; } } as unknown as LiveStreamManager;
    const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "x".repeat(32), experimentalC31LiveTalkback: enabled },
      state, new SnapshotStore(directory), streams, provider, null);
    const headers = { authorization: `Bearer ${"x".repeat(32)}`, "content-type": "application/json" };
    try {
      await server.listen();
      const base = `http://127.0.0.1:${server.port}/api/cameras/synthetic/live-talkback`;
      const request = { method: "POST", headers, body: JSON.stringify({ sdp: offer() }) };
      assert.equal((await fetch(base, { ...request, headers: { "content-type": "application/json" } })).status, 401);
      if (!enabled) { assert.equal((await fetch(base, request)).status, 409); return; }
      const invalid = await fetch(base, { ...request, body: JSON.stringify({ sdp: "PRIVATE-SDP-CANARY" }) });
      assert.equal(invalid.status, 409); assert.doesNotMatch(await invalid.text(), /PRIVATE/);
      const response = await fetch(base, request); assert.equal(response.status, 200);
      const answer = await response.json() as { sessionId: string; sdp: string };
      assert.match(answer.sessionId, /^[a-f0-9]{32}$/); assert.match(answer.sdp, /^v=0/);
      assert.equal(sourceCalls, 0); assert.equal(speakerCalls, 0);
      assert.equal((await fetch(base, request)).status, 409);
      assert.equal((await fetch(`${base}/${"f".repeat(32)}`, { method: "DELETE", headers })).status, 409);
      const prepared = base.replace("live-talkback", "speaker-audio");
      assert.equal((await fetch(prepared, { method: "POST", headers: { ...headers, "content-type": "audio/aac" }, body: "invalid" })).status, 409);
      assert.equal((await fetch(`${base}/${answer.sessionId}`, { method: "PATCH", headers, body: JSON.stringify({ candidate: { candidate: "x", extra: true } }) })).status, 400);
      state.registerCamera({ ...camera, liveTalkbackEnabled: false, liveTalkbackSupported: false });
      assert.equal((await fetch(`${base}/${answer.sessionId}`, { method: "DELETE", headers })).status, 200);
      assert.equal(sourceCalls, 0); assert.equal(speakerCalls, 0);
    } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
