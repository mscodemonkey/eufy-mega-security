/**
 * Exercises the native doorbell trial against local WebSocket and WebRTC peers.
 * Synthetic FFmpeg video is packetized over real RTP and decoded after delivery.
 * Tests own all peers and media, contact no Eufy account and claim no hardware
 * result. Full multi-section offer rewriting is covered by the offer tests.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { RTCPeerConnection, RTCSessionDescription, MediaStreamTrack, RtpPacket, RtpHeader, useH264 } from "werift";
import { DoorbellRtcSession } from "../src/stream/doorbell-rtc-session.js";
import { DoorbellRtcError } from "../src/stream/doorbell-rtc-offer.js";

/** Split generated Annex-B video into complete AUD-delimited frames. */
function frames(data: Buffer): Buffer[][] {
  const starts: { at: number; bytes: number }[] = [];
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) { starts.push({ at: i, bytes: 4 }); i += 3; }
    else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) { starts.push({ at: i, bytes: 3 }); i += 2; }
  }
  const result: Buffer[][] = []; let current: Buffer[] = [];
  for (let i = 0; i < starts.length; i++) {
    const nal = data.subarray(starts[i]!.at + starts[i]!.bytes, starts[i + 1]?.at ?? data.length);
    if ((nal[0]! & 31) === 9 && current.length) { result.push(current); current = []; }
    current.push(nal);
  }
  if (current.length) result.push(current);
  return result;
}

/** Build standard single-NAL and FU-A payloads with one marker per frame. */
function payloads(unit: readonly Buffer[]): Buffer[] {
  const result: Buffer[] = [];
  for (const nal of unit) {
    if (nal.length <= 1000) { result.push(nal); continue; }
    for (let i = 1; i < nal.length; i += 998) {
      const end = Math.min(i + 998, nal.length);
      result.push(Buffer.concat([Buffer.from([(nal[0]! & 0x60) | 28,
        (nal[0]! & 31) | (i === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0)]), nal.subarray(i, end)]));
    }
  }
  return result;
}

for (const scenario of ["video", "loss", "busy", "wrong-owner", "no-video", "cancel-offer"] as const) {
  test(`native doorbell ${scenario} has bounded media and cleanup`, { timeout: 20_000 }, async context => {
    const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10",
      "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-x264-params", "aud=1:repeat-headers=1:keyint=5",
      "-f", "h264", "pipe:1"], { maxBuffer: 4 * 1024 * 1024 });
    assert.equal(generated.status, 0);
    const units = frames(generated.stdout); assert.equal(units.length, 10);
    const server = new WebSocketServer({ port: 0 }); await once(server, "listening");
    const address = server.address() as { port: number };
    const camera = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false,
      codecs: { audio: [], video: [useH264({ payloadType: 99 })] } });
    const track = new MediaStreamTrack({ kind: "video" });
    camera.addTransceiver(track, { direction: "sendonly" });
    await camera.setLocalDescription(await camera.createOffer());
    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = null;
    let counter = 0, sequence = 65500, hangups = 0, answers = 0, peerCount = 0;
    let peer: RTCPeerConnection | null = null;
    let entered!: () => void, finish!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const chunks: Buffer[] = [];
    const serverErrors: unknown[] = [];
    camera.connectionStateChange.subscribe(state => {
      if (state !== "connected" || timer || scenario === "no-video") return;
      timer = setInterval(() => {
        const packets = payloads(units[counter % units.length]!);
        for (let i = 0; i < packets.length; i++) {
          const packet = new RtpPacket(new RtpHeader({ payloadType: 99, ssrc: 12345, sequenceNumber: sequence++ % 65536,
            timestamp: counter * 9000, marker: i === packets.length - 1 }), packets[i]!);
          if (scenario !== "loss" || counter !== 2 || i !== 0) track.writeRtp(packet);
        }
        counter++;
      }, 100);
    });
    server.on("connection", connection => {
      const send = (value: Record<string, unknown>): void => { connection.send(JSON.stringify({ data: JSON.stringify(value) })); };
      const reply = (kind: string, data: Record<string, unknown>): void => send({ action: 3, code: 200,
        sessionId: "synthetic-sign", sn: scenario === "wrong-owner" ? "other-station" : "synthetic-station",
        channelId: 0, dataType: kind, data: JSON.stringify(data) });
      connection.on("message", raw => {
        void (async () => {
          const inner = JSON.parse(JSON.parse(raw.toString()).data);
          if (inner.action === 1) { send({ action: 1, code: 200 }); return; }
          if (inner.action === 2) { send({ action: 2, code: 200 }); return; }
          const data = JSON.parse(inner.data);
          if (inner.dataType === "call") {
            assert.equal(inner.sn, "synthetic-station"); assert.equal(inner.channelId, 0);
            assert.equal(typeof data.account, "string");
            reply("call", { status: scenario === "busy" ? 486 : 200 });
            if (scenario !== "busy") reply("info", scenario === "loss"
              ? { sdp: camera.localDescription!.sdp } : { format: "SDP", value: camera.localDescription!.sdp });
          } else if (inner.dataType === "hangup") hangups++;
          else if (inner.dataType === "info" && data.sdp) {
            answers++;
            await camera.setRemoteDescription(new RTCSessionDescription(data.sdp, "answer"));
          } else if (inner.dataType === "info" && data.candidate) {
            await camera.addIceCandidate({ candidate: data.candidate, sdpMid: "0", sdpMLineIndex: 0 });
          }
        })().catch(error => { serverErrors.push(error); connection.terminate(); });
      });
    });
    const session = new DoorbellRtcSession({ station: "synthetic-station", administrator: "synthetic-owner",
      context: { host: "security-smart-eu.eufylife.com", region: "EU", authToken: "synthetic-token", gtoken: "synthetic-gtoken", sign: "synthetic-sign" },
      signal: controller.signal, current: () => true, startupTimeoutMilliseconds: scenario === "no-video" ? 1200 : 8000,
      ready: output => { output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk))); },
    }, {
      socket: (url, protocols, options) => {
        assert.equal(url, "wss://security-smart-eu.eufylife.com/v1/rtc/ws/join?reqtype=nvr");
        assert.deepEqual(protocols, ["synthetic-token"]); assert.equal(options.followRedirects, false);
        return new WebSocket(`ws://127.0.0.1:${address.port}`, protocols);
      },
      peer: (_servers, offer) => {
        peerCount++;
        peer = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false,
          codecs: { audio: [], video: [useH264({ payloadType: offer.payloadType, parameters: offer.parameters })] } });
        if (scenario === "cancel-offer") {
          const original = peer.setRemoteDescription.bind(peer);
          context.mock.method(peer, "setRemoteDescription", async (...args: Parameters<typeof original>) => {
            entered(); await pending; return original(...args);
          });
        }
        return peer;
      },
    });
    try {
      if (scenario === "busy" || scenario === "wrong-owner" || scenario === "no-video") {
        await assert.rejects(session.start(), error => error instanceof DoorbellRtcError
          && error.stage === (scenario === "busy" ? "busy" : scenario === "wrong-owner" ? "call" : "deadline"));
        assert.equal(chunks.length, 0);
        if (scenario !== "no-video") assert.equal(peerCount, 0);
      } else if (scenario === "cancel-offer") {
        const stopped = assert.rejects(session.start(), error => error instanceof DoorbellRtcError && error.stage === "cancelled");
        await entering; controller.abort(); await stopped; finish();
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(answers, 0); assert.equal(chunks.length, 0);
      } else {
        await session.start();
        await new Promise(resolve => setTimeout(resolve, 1400));
        await session.close(); await session.close();
        const decoded = spawnSync("ffmpeg", ["-v", "error", "-xerror", "-err_detect", "explode", "-f", "h264", "-i", "pipe:0",
          "-progress", "pipe:1", "-f", "null", "-"], { input: Buffer.concat(chunks), timeout: 5000 });
        assert.equal(decoded.status, 0, decoded.stderr?.toString());
        const counts = [...decoded.stdout.toString().matchAll(/^frame=(\d+)$/gm)];
        assert.ok(Number(counts.at(-1)?.[1]) >= 6);
        assert.equal(answers, 1); assert.equal(peerCount, 1);
        assert.equal(peer!.sctpTransport, undefined);
        assert.equal(hangups, 1);
      }
      assert.deepEqual(serverErrors, []);
    } finally {
      finish(); if (timer) clearInterval(timer);
      controller.abort(); await session.close().catch(() => undefined);
      for (const client of server.clients) client.terminate();
      await camera.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
