/**
 * Checks offer normalization with real local werift SDP negotiation and pure
 * malformed fixtures. Peers use no ICE servers and contact no Eufy endpoint.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { RTCPeerConnection, RTCSessionDescription, useH264 } from "werift";
import { generalRtcOffer, generalRtcAnswer } from "../src/stream/general-rtc-offer.js";
import { GeneralRtcError } from "../src/stream/general-rtc-protocol.js";
import { syntheticGeneralOffer } from "./fixtures/general-rtc.js";
import { createGeneralRtcPeer } from "../src/stream/general-rtc-session.js";
import { generalRtcRelays } from "../src/stream/general-rtc-network.js";

for (const direction of ["sendonly", "sendrecv"]) test(`real werift accepts stripped RTX/FEC ${direction} offer and rejects unused media in order`, async () => {
  const value = syntheticGeneralOffer().replace("a=mid:1\r\na=sendrecv", `a=mid:1\r\na=${direction}`);
  const offer = generalRtcOffer(value);
  assert.equal(offer.payloadType, 99); assert.equal(offer.ssrc, 12345);
  assert.doesNotMatch(offer.sdp, /m=audio|m=application|rtpmap:125|rtpmap:126|fmtp:125|rtcp-fb:125/);
  const peer = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false, codecs: { audio: [], video: [useH264({ payloadType: 99 })] } });
  try {
    await peer.setRemoteDescription(new RTCSessionDescription(offer.sdp, "offer"));
    const answer = await peer.createAnswer();
    const wire = generalRtcAnswer(offer, answer.sdp);
    assert.match(wire, /a=group:BUNDLE 1\r\n/); assert.match(wire, /a=recvonly/);
    assert.match(wire, /m=audio 0 /); assert.match(wire, /m=application 0 /);
    assert.ok(wire.indexOf("m=audio") < wire.indexOf("m=video") && wire.indexOf("m=video") < wire.indexOf("m=application"));
    assert.throws(() => generalRtcAnswer(offer, answer.sdp.replace("a=recvonly", "a=sendonly")), GeneralRtcError);
  } finally { await peer.close(); }
});

test("the first packetized H264 payload is selected from several choices", () => {
  const value = syntheticGeneralOffer().replace("m=video 9 UDP/TLS/RTP/SAVPF 99 125 126", "m=video 9 UDP/TLS/RTP/SAVPF 98 97 99 125 126")
    .replace("a=rtpmap:99 H264/90000", "a=rtpmap:98 H264/90000\r\na=fmtp:98 packetization-mode=0\r\na=rtpmap:97 H264/90000\r\na=fmtp:97 packetization-mode=1\r\na=rtpmap:99 H264/90000");
  const offer = generalRtcOffer(value); assert.equal(offer.payloadType, 97);
  assert.doesNotMatch(offer.sdp, /a=rtpmap:(98|99|125|126) /);
});

test("production peer construction replaces werift's default STUN and configures only checked TURN", async () => {
  const relays = generalRtcRelays({ turn_addr: "8.8.8.8", turn_port: 3478, turn_user: "synthetic", turn_password: "synthetic" });
  const peer = createGeneralRtcPeer(relays, generalRtcOffer(syntheticGeneralOffer()));
  try {
    assert.deepEqual(peer.config.iceServers, relays); assert.deepEqual(peer.config.codecs.audio, []);
    assert.ok(peer.config.codecs.video);
    assert.deepEqual(peer.config.codecs.video.map(codec => codec.mimeType), ["video/H264"]);
  } finally { await peer.close(); }
});

for (const [name, change] of [
  ["recvonly", (s: string) => s.replace("a=mid:1\r\na=sendrecv", "a=mid:1\r\na=recvonly")],
  ["inactive", (s: string) => s.replace("a=mid:1\r\na=sendrecv", "a=mid:1\r\na=inactive")],
  ["simulcast", (s: string) => s + "a=simulcast:send 1\r\n"], ["rid", (s: string) => s + "a=rid:1 send\r\n"],
  ["source group", (s: string) => s + "a=ssrc-group:FID 12345 23456\r\n"],
  ["two video sources", (s: string) => s.replace("a=ssrc:12345 cname:synthetic", "a=ssrc:12345 cname:synthetic\r\na=ssrc:23456 cname:other")],
  ["hostname candidate", (s: string) => s + "a=candidate:fixture 1 udp 123 camera.local 1234 typ host\r\n"],
  ["tab", (s: string) => s.replace("s=-", "s=\t")], ["embedded CR", (s: string) => s.replace("s=-", "s=-\rprivate")],
] as const) test(`general offer refuses ${name} without retaining received content`, () => {
  assert.throws(() => generalRtcOffer(change(syntheticGeneralOffer())), (error: unknown) => error instanceof GeneralRtcError && !error.message.includes("private"));
});
