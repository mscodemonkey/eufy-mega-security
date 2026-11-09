/**
 * Exercises rejected-offer classification with synthetic transport values.
 * Tests own their SDP and errors, contact no camera, and verify that the RTC
 * boundary keeps rejecting every offer rather than enabling a new receiver.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { NvrRtcSession } from "../src/stream/nvr-rtc-session.js";
import { refineE10OfferFailure } from "../src/stream/e10-offer-diagnostic.js";
import { nvrOffer, NvrTrialError } from "../src/stream/nvr-protocol.js";

const binding = { cameraType: 314, station: "synthetic-camera", camera: "synthetic-camera", channel: 0 };

function offer(dataSection: boolean): string {
  const transport = ["c=IN IP4 0.0.0.0", "a=ice-ufrag:abcd", "a=ice-pwd:abcdefghijklmnopqrstuvwx",
    `a=fingerprint:sha-256 ${Array(32).fill("AA").join(":")}`, "a=setup:actpass"];
  return ["v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 1 2",
    "m=video 9 UDP/TLS/RTP/SAVPF 99", ...transport, "a=mid:1", "a=sendonly", "a=rtcp-mux",
    "a=rtpmap:99 H264/90000", "a=fmtp:99 packetization-mode=1;profile-level-id=42e01f",
    ...(dataSection ? ["m=application 9 UDP/DTLS/SCTP webrtc-datachannel", ...transport,
      "a=mid:2", "a=sctp-port:5000"] : []), ""].join("\r\n");
}

function failure(sdp: unknown, current = binding): NvrTrialError {
  try { nvrOffer(sdp); }
  catch (error) { return refineE10OfferFailure(error, sdp, current) as NvrTrialError; }
  throw new Error("The offer unexpectedly passed strict NVR admission");
}

test("E10 H.264 shapes remain rejected and distinguish a data section from track-only", () => {
  for (const data of [false, true]) {
    const result = failure(offer(data));
    assert.equal(result.stage, "negotiation");
    assert.equal(result.reason, data ? "offer_e10_h264_data_section" : "offer_e10_h264_no_data_section");
    assert.equal(JSON.stringify(result).includes("abcdefghijklmnopqrstuvwx"), false);
  }
});

test("unsupported or malformed track offers never acquire a qualified H.264 category", () => {
  assert.equal(failure(offer(false).replace("H264/90000", "H265/90000")).reason, "offer_e10_h265_declared");
  for (const sdp of [offer(false).replace("a=rtcp-mux", ""), offer(false).replace("a=sendonly", "a=sendrecv"),
    offer(false).replace("packetization-mode=1", "packetization-mode=0"), offer(false) + "x".repeat(32768)]) {
    assert.equal(failure(sdp).reason, "offer_e10_tracks_unqualified");
  }
});

test("other identities and failure classes retain their original closed error", () => {
  for (const current of [{ ...binding, cameraType: 301 }, { ...binding, channel: 1 },
    { ...binding, station: "synthetic-parent" }]) assert.equal(failure(offer(true), current).reason, "offer_media_tracks");
  const original = new NvrTrialError("negotiation", "offer_fingerprint");
  assert.equal(refineE10OfferFailure(original, offer(true), binding), original);
  const unknown = new Error("synthetic unrelated failure");
  assert.equal(refineE10OfferFailure(unknown, offer(true), binding), unknown);
});


test("the real session rejects E10 offers before creating a peer and preserves other models", { timeout: 10000 }, async () => {
  for (const [cameraType, data, expected] of [[314, false, "offer_e10_h264_no_data_section"],
    [314, true, "offer_e10_h264_data_section"], [301, true, "offer_media_tracks"]] as const) {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    const address = server.address() as { port: number };
    let peers = 0;
    server.on("connection", socket => {
      const send = (value: object): void => { socket.send(JSON.stringify({ data: JSON.stringify(value) })); };
      socket.on("message", raw => {
        const value = JSON.parse(JSON.parse(raw.toString()).data);
        if (value.action === 1) send({ action: 1, code: 200 });
        else if (value.dataType === "call") {
          const base = { action: 3, sessionId: "synthetic-sign", sn: binding.station, channelId: 0 };
          send({ ...base, dataType: "call", data: JSON.stringify({ status: 200 }) });
          send({ ...base, dataType: "info", data: JSON.stringify({ format: "SDP", value: offer(data) }) });
        }
      });
    });
    const session = new NvrRtcSession({ ...binding, cameraType, administrator: "synthetic-account",
      context: { host: "security-smart-eu.eufylife.com", region: "EU", authToken: "synthetic-token", gtoken: "synthetic", sign: "synthetic-sign" },
      signal: new AbortController().signal, current: () => true,
      ready: () => assert.fail("No rejected offer may expose media"),
    }, { socket: () => new WebSocket(`ws://127.0.0.1:${address.port}`),
      peer: () => { peers++; throw new Error("No rejected offer may construct a peer"); } });
    try {
      await assert.rejects(session.start(), error => error instanceof NvrTrialError && error.reason === expected);
      assert.equal(peers, 0);
    } finally {
      await session.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});
