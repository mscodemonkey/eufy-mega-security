/**
 * Refuse unsupported browser media contracts before allocating a live peer.
 * Generated SDP contains no candidates or household identity and opens no sockets.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { c31LiveRtcOffer, c31LiveRtcOfferDiagnostic } from "../src/stream/c31-live-rtc.js";

/** Describe a generated receive-video and send/receive-audio peer, without live candidates. */
function offer(): string {
  const common = ["c=IN IP4 0.0.0.0", "a=ice-ufrag:abcd", "a=ice-pwd:abcdefghijklmnopqrstuvwx",
    `a=fingerprint:sha-256 ${Array(32).fill("AA").join(":")}`, "a=setup:actpass", "a=rtcp-mux"];
  return ["v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0 1",
    "m=video 9 UDP/TLS/RTP/SAVPF 96", ...common, "a=mid:0", "a=recvonly", "a=rtpmap:96 H264/90000",
    "a=fmtp:96 packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1",
    "m=audio 9 UDP/TLS/RTP/SAVPF 0", ...common, "a=mid:1", "a=sendrecv", "a=rtpmap:0 PCMU/8000", ""].join("\r\n");
}


test("C31 microphone negotiation distinguishes a receive-only viewer", () => {
  assert.deepEqual(c31LiveRtcOffer(offer()), { receiveMicrophone: true });
  assert.deepEqual(c31LiveRtcOffer(offer().replace("a=sendrecv", "a=recvonly")), { receiveMicrophone: false });
});

for (const [name, change] of [
  ["no video", (sdp: string) => sdp.replace("m=video", "m=application")],
  ["duplicate audio", (sdp: string) => sdp.replace("m=video", "m=audio")],
  ["disabled video", (sdp: string) => sdp.replace("m=video 9", "m=video 0")],
  ["send-only video", (sdp: string) => sdp.replace("a=recvonly", "a=sendonly")],
  ["wrong audio codec", (sdp: string) => sdp.replace("PCMU/8000", "opus/48000/2")],
  ["send-only audio", (sdp: string) => sdp.replace("a=sendrecv", "a=sendonly")],
  ["missing rtcp mux", (sdp: string) => sdp.replace("a=rtcp-mux", "a=rtcp:9")],
  ["wrong H264 profile", (sdp: string) => sdp.replace("42e01f", "64001f")],
  ["unlisted H264", (sdp: string) => sdp.replace("SAVPF 96", "SAVPF 97")],
  ["oversized SDP", (sdp: string) => sdp + "x".repeat(65536)],
  ["long repeated payload token", (sdp: string) => sdp.replace("SAVPF 96", "SAVPF " + "0".repeat(10000))],
  ["duplicate codec fields", (sdp: string) => sdp.replace("SAVPF 96", "SAVPF " + Array(33).fill("96").join(" "))],
  ["payload space overflow", (sdp: string) => sdp.replace("SAVPF 96", "SAVPF " + Array(129).fill("96").join(" "))],
  ["invalid port", (sdp: string) => sdp.replace("m=video 9", "m=video 65536")],
  ["invalid codec number", (sdp: string) => sdp.replace("SAVPF 96", "SAVPF 999")],
  ["null byte", (sdp: string) => sdp + "\0"],
] as const) test(`C31 refuses ${name} before peer allocation`, () => {
  assert.throws(() => c31LiveRtcOffer(change(offer())), { code: "offer" });
});


test("refused-offer diagnostics expose media declarations without private connection content", () => {
  const sdp = offer().replace("a=ice-ufrag:abcd", "a=ice-ufrag:PRIVATE-USER-CANARY")
    + "a=candidate:PRIVATE-CANDIDATE-CANARY 1 UDP 1 192.168.99.99 12345 typ host\r\n";
  const summary = c31LiveRtcOfferDiagnostic(sdp);
  assert.match(summary, /media_count=2 media=video,audio/);
  assert.match(summary, /video_dir=recvonly audio_dir=sendrecv/);
  assert.match(summary, /h264_profiles=42e01f h264_payloads=96 pcmu=implicit_mono/);
  assert.doesNotMatch(summary, /PRIVATE|192\.168|12345|abcdefghijkl|fingerprint/);
  assert.equal(c31LiveRtcOfferDiagnostic("x".repeat(65537)), "shape=invalid");
});

for (const [detail, change] of [
  ["layout", (sdp: string) => sdp.replace("m=video", "m=audio")],
  ["video_line", (sdp: string) => sdp.replace("m=video 9", "m=video 0")],
  ["audio_codec", (sdp: string) => sdp.replace("PCMU/8000", "PCMU/8000/1")],
  ["video_codec", (sdp: string) => sdp.replace("42e01f", "42e033")],
  ["audio_direction", (sdp: string) => sdp.replace("a=sendrecv", "a=sendonly")],
] as const) test(`C31 refusal names the exact ${detail} check`, () => {
  assert.throws(() => c31LiveRtcOffer(change(offer())), { code: "offer", detail });
});


for (const mode of ["recvonly", "sendrecv"]) test(`native browser media list is accepted with audio ${mode}`, () => {
  const sdp = readFileSync(new URL(`./fixtures/c31-browser-audio-first-${mode}.sdp`, import.meta.url), "utf8");
  assert.ok(sdp.split(/\r?\n/).find(line => line.startsWith("m=video "))!.split(" ").length > 35);
  assert.deepEqual(c31LiveRtcOffer(sdp), { receiveMicrophone: mode === "sendrecv" });
});
