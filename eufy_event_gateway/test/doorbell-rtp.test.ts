/**
 * Exercises bounded doorbell RTP assembly and native SDP selection with synthetic
 * values. Tests own all packet state and open no sockets. The neighboring RTC
 * session tests separately establish local media delivery and cleanup.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DoorbellH264Assembler } from "../src/stream/doorbell-rtp.js";
import { doorbellRtcOffer, doorbellRtcAnswer, DoorbellRtcError } from "../src/stream/doorbell-rtc-offer.js";

const prefix = Buffer.from([0, 0, 0, 1]);
const packet = (sequenceNumber: number, timestamp: number, payload: number[] | Buffer, marker = false) =>
  ({ sequenceNumber, timestamp, payload: Buffer.from(payload), marker });

/** Build a native offer whose private values are fixed test strings. */
function offer(): string {
  const common = ["c=IN IP4 0.0.0.0", "a=ice-ufrag:abcd", "a=ice-pwd:abcdefghijklmnopqrstuvwx",
    `a=fingerprint:sha-256 ${Array(32).fill("AA").join(":")}`, "a=setup:actpass"];
  return ["v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0 1 2",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111", ...common, "a=mid:0", "a=sendrecv", "a=rtpmap:111 opus/48000/2",
    "m=video 9 UDP/TLS/RTP/SAVPF 99 125", ...common, "a=mid:1", "a=sendonly", "a=rtcp-mux",
    "a=rtpmap:99 H264/90000", "a=fmtp:99 packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1", "a=rtpmap:125 rtx/90000",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", ...common, "a=mid:2", "a=sctp-port:5000", ""].join("\r\n");
}

test("assembles STAP-A headers and FU-A video across sequence wrap", () => {
  const decoder = new DoorbellH264Assembler();
  assert.equal(decoder.push(packet(65534, 100, [24, 0, 2, 0x67, 1, 0, 2, 0x68, 2])), null);
  assert.equal(decoder.push(packet(65535, 100, [0x7c, 0x85, 3, 4])), null);
  assert.deepEqual(decoder.push(packet(0, 100, [0x7c, 0x45, 5, 6], true)),
    Buffer.concat([prefix, Buffer.from([0x67, 1]), prefix, Buffer.from([0x68, 2]), prefix, Buffer.from([0x65, 3, 4, 5, 6])]));
});

test("drops lost and incomplete units without joining frames", () => {
  const decoder = new DoorbellH264Assembler();
  decoder.push(packet(1, 100, [0x7c, 0x85, 1]));
  assert.equal(decoder.push(packet(3, 100, [0x7c, 0x45, 2], true)), null);
  assert.deepEqual(decoder.push(packet(4, 200, [0x65, 3], true)), Buffer.concat([prefix, Buffer.from([0x65, 3])]));
  assert.equal(decoder.push(packet(5, 300, [0x7c, 0x85, 1], true)), null);
  assert.equal(decoder.push(packet(6, 300, [0x65, 2], true)), null);
  assert.deepEqual(decoder.push(packet(7, 400, [0x65, 4], true)), Buffer.concat([prefix, Buffer.from([0x65, 4])]));
});

test("a timestamp change without a marker requires fresh decoder startup", () => {
  let losses = 0;
  const decoder = new DoorbellH264Assembler(() => { losses++; });
  decoder.push(packet(1, 100, [0x41, 1]));
  decoder.push(packet(2, 200, [0x41, 2], true));
  assert.equal(losses, 1);
  decoder.push(packet(3, 300, [0x65, 3], true));
  assert.equal(losses, 1);
});

test("rejects malformed packets and recovers on a new timestamp", () => {
  for (const payload of [[24, 0, 5, 0x67], [24, 0, 0], [24, 0, 1, 28], [0x80, 1], [0x7c, 0xc5, 1], [0x7c, 0x45, 1], [29, 1]]) {
    const decoder = new DoorbellH264Assembler();
    assert.equal(decoder.push(packet(1, 100, payload, true)), null);
    assert.deepEqual(decoder.push(packet(2, 200, [0x65, 4], true)), Buffer.concat([prefix, Buffer.from([0x65, 4])]));
  }
});

test("bounds unfinished video and erases it on retirement", () => {
  const decoder = new DoorbellH264Assembler();
  decoder.push(packet(1, 100, [0x7c, 0x85, 1])); decoder.clear();
  assert.equal(decoder.push(packet(2, 100, [0x7c, 0x45, 2], true)), null);
  const chunk = Buffer.alloc(65_000, 1); chunk[0] = 0x7c; chunk[1] = 0x85;
  decoder.push(packet(3, 200, chunk)); chunk[1] = 0x05;
  for (let index = 4; index < 70; index++) assert.equal(decoder.push(packet(index, 200, chunk)), null);
  chunk[1] = 0x45; assert.equal(decoder.push(packet(70, 200, chunk, true)), null);
  assert.deepEqual(decoder.push(packet(71, 300, [0x65, 4], true)), Buffer.concat([prefix, Buffer.from([0x65, 4])]));
});

test("selects H.264 and rejects unused audio and SCTP", () => {
  const result = doorbellRtcOffer(offer());
  assert.equal(result.mid, "1"); assert.equal(result.index, 1); assert.equal(result.payloadType, 99);
  assert.match(result.sdp, /a=group:BUNDLE 1\r\n/);
  assert.doesNotMatch(result.sdp, /m=audio|m=application|a=sctp-port/);
  const answer = doorbellRtcAnswer(result, result.sdp.replace("a=setup:active", "a=setup:passive"));
  assert.match(answer, /m=audio 0 /); assert.match(answer, /m=application 0 /);
  assert.doesNotMatch(answer, /a=sctp-port/); assert.match(answer, /a=setup:passive/);
});

test("accepts one bounded SCTP token without widening the rejected application section", () => {
  for (const token of ["0", "1024", "65535"]) {
    const result = doorbellRtcOffer(offer().replace("webrtc-datachannel", `webrtc-datachannel ${token}`));
    assert.doesNotMatch(result.sdp, /m=application|webrtc-datachannel/);
    const answer = doorbellRtcAnswer(result, result.sdp.replace("a=setup:active", "a=setup:passive"));
    assert.match(answer, new RegExp(`m=application 0 UDP/DTLS/SCTP webrtc-datachannel ${token}`));
    assert.match(answer, /a=mid:2\r\na=inactive/);
  }
  for (const suffix of ["65536", "-1", "+1", "1.5", "1024 2048", "private"]) {
    assert.throws(() => doorbellRtcOffer(offer().replace("webrtc-datachannel", `webrtc-datachannel ${suffix}`)), error => {
      assert.ok(error instanceof DoorbellRtcError); assert.equal(error.stage, "offer");
      assert.equal(error.reason, "media_shape"); return true;
    });
  }
});

test("offer failures contain no received values", () => {
  for (const [invalid, reason] of [[offer().replace("H264/90000", "H265/90000"), "codec"], [offer().replace("a=sendonly", "a=sendrecv"), "video_shape"],
    [offer().replace("packetization-mode=1", "packetization-mode=2"), "fmtp"], [offer().replaceAll("a=ice-ufrag:abcd", "a=ice-ufrag:PRIVATE VALUE"), "transport_field"],
    [offer().replace("a=mid:1", "a=mid:0"), "mid"], [offer().replace("a=rtcp-mux", "a=rtcp-mux\r\na=candidate:PRIVATE VALUE"), "candidate"], ["x".repeat(32769), "offer_text"]] as const) {
    assert.throws(() => doorbellRtcOffer(invalid), error => {
      assert.ok(error instanceof DoorbellRtcError); assert.equal(error.stage, "offer");
      assert.equal(error.reason, reason);
      assert.equal(error.message.includes("PRIVATE"), false); return true;
    });
  }
});
