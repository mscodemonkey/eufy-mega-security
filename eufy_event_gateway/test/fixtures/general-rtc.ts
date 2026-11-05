/**
 * Supplies bounded synthetic SDP to the general RTC wire and real-peer tests.
 * Fixtures own all addresses, credentials and source identifiers, with no I/O.
 */

/** Build bounded synthetic SDP with one declared video source and unused sections. */
export function syntheticGeneralOffer(): string {
  const common = ["c=IN IP4 0.0.0.0", "a=ice-ufrag:abcd", "a=ice-pwd:abcdefghijklmnopqrstuvwx",
    `a=fingerprint:sha-256 ${Array(32).fill("AA").join(":")}`, "a=setup:actpass"];
  return ["v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0 1 2",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111", ...common, "a=mid:0", "a=sendrecv", "a=rtpmap:111 opus/48000/2",
    "m=video 9 UDP/TLS/RTP/SAVPF 99 125 126", ...common, "a=mid:1", "a=sendrecv", "a=rtcp-mux",
    "a=rtpmap:99 H264/90000", "a=fmtp:99 packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1",
    "a=rtpmap:125 rtx/90000", "a=fmtp:125 apt=99", "a=rtcp-fb:125 nack", "a=rtpmap:126 red/90000", "a=ssrc:12345 cname:synthetic",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", ...common, "a=mid:2", "a=sctp-port:5000", ""].join("\r\n");
}
