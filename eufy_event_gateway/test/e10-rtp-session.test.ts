/**
 * Exercises viewer-owned and finite E10 H.264 sessions with local signalling and real RTP peers.
 * Tests own synthetic media and cleanup. The unused data section is rejected,
 * and no Eufy account, device or setting is accessed. Hardware playback stays unconfirmed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { RTCPeerConnection, RTCSessionDescription, MediaStreamTrack, RtpPacket, RtpHeader, useH264 } from "werift";
import { NvrRtcSession } from "../src/stream/nvr-rtc-session.js";
import { NvrTrialError } from "../src/stream/nvr-protocol.js";

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

for (const scenario of ["video", "loss", "unused-data", "cancel-offer", "finite-deadline", "continuous-video", "continuous-stall", "continuous-cancel",
  "continuous-malformed-outer", "continuous-malformed-inner", "continuous-malformed-payload"]) {
  test(`E10 RTP ${scenario} preserves its media lifetime and cleanup`, { timeout: 20_000 }, async context => {
    const continuous = scenario.startsWith("continuous-");
    let videoNow = 0;
    const scheduled: { delay: number; fire: () => void }[] = [];
    const schedule = globalThis.setTimeout;
    context.mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const handle = schedule(callback, delay, ...args);
      if (delay === 45_000 || delay === 10_000) {
        scheduled.push({ delay, fire: () => { clearTimeout(handle); callback(...args); } });
      }
      return handle;
    }) as typeof setTimeout);
    const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10",
      "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-x264-params", "aud=1:repeat-headers=1:keyint=5",
      "-f", "h264", "pipe:1"], { maxBuffer: 4 * 1024 * 1024 });
    assert.equal(generated.status, 0);
    const units = frames(generated.stdout); assert.equal(units.length, 10);
    const server = new WebSocketServer({ port: 0, handleProtocols: protocols => protocols.has("v1") ? "v1" : false });
    await once(server, "listening");
    const address = server.address() as { port: number };
    const camera = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false,
      codecs: { audio: [], video: [useH264({ payloadType: 99 })] } });
    const track = new MediaStreamTrack({ kind: "video" });
    camera.addTransceiver(track, { direction: "sendonly" });
    await camera.setLocalDescription(await camera.createOffer());

    // The test peer cannot parse rejected SCTP sections. Supply a synthetic
    // unused section on the wire, assert its rejection, then give the video-only
    // answer to the real RTP camera peer. No data channel is negotiated.
    const originalOffer = camera.localDescription!.sdp;
    const wireOffer = scenario === "unused-data" ? originalOffer.replace(/a=group:BUNDLE ([^\r\n]+)/,
      (_line, mids: string) => `a=group:BUNDLE ${mids} unused`) + [
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0", "a=mid:unused", "a=sctp-port:5000",
        ...originalOffer.split(/\r?\n/).filter(line => /^a=(?:ice-ufrag|ice-pwd|fingerprint|setup):/.test(line)), "",
      ].join("\r\n") : originalOffer;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = null;
    let counter = 0, sequence = 65500, hangups = 0, answers = 0, acknowledgements = 0, peerCount = 0;
    let peer: RTCPeerConnection | null = null;
    let signallingConnection: WebSocket | undefined;
    let entered!: () => void, finish!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const chunks: Buffer[] = [];
    const serverErrors: unknown[] = [];
    camera.connectionStateChange.subscribe(state => {
      if (state !== "connected" || timer) return;
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
    server.on("connection", (connection, request) => {
      signallingConnection = connection;
      const protocols = request.headers["sec-websocket-protocol"]!.split(/,\s*/);
      assert.equal(protocols.length, 2);
      assert.equal(protocols[0], "v1");
      assert.match(protocols[1]!, /^[A-Za-z0-9_-]+$/);
      assert.deepEqual(JSON.parse(Buffer.from(protocols[1]!, "base64url").toString("utf8")), {
        region: "EU", type: "NVR", sn: "synthetic-station", token: "synthetic-token",
        gtoken: "synthetic-gtoken", sign: "synthetic-sign", appName: "eufy_mega", modelType: "WEB",
      });
      const send = (value: Record<string, unknown>): void => { connection.send(JSON.stringify({ data: JSON.stringify(value) })); };
      const reply = (kind: string, data: Record<string, unknown>): void => send({ action: 3, code: 200,
        sessionId: "synthetic-sign", sn: "synthetic-station",
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
            reply("call", { status: 200 });
            reply("info", { format: "SDP", value: wireOffer });
          } else if (inner.dataType === "hangup") hangups++;
          else if (inner.dataType === "ack") acknowledgements++;
          else if (inner.dataType === "info" && data.sdp) {
            answers++;
            if (scenario === "unused-data") assert.match(data.sdp, /m=application 0 /);
            await camera.setRemoteDescription(new RTCSessionDescription(scenario === "unused-data"
              ? data.sdp.slice(0, data.sdp.indexOf("m=application ")) : data.sdp, "answer"));
          } else if (inner.dataType === "info" && data.candidate) {
            await camera.addIceCandidate({ candidate: data.candidate, sdpMid: "0", sdpMLineIndex: 0 });
          }
        })().catch(error => { serverErrors.push(error); connection.terminate(); });
      });
    });
    const session = new NvrRtcSession({ station: "synthetic-station", camera: "synthetic-station", cameraType: 314, channel: 0, e10RtpTrial: true, maximumLifetimeMilliseconds: continuous ? null : 10000, videoProgressNow: () => videoNow, administrator: "synthetic-owner",
      context: { host: "security-smart-eu.eufylife.com", region: "EU", authToken: "synthetic-token", gtoken: "synthetic-gtoken", sign: "synthetic-sign" },
      signal: controller.signal, current: () => true, 
      ready: output => { output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk))); },
    }, {
      socket: (url, protocols, options) => {
        assert.equal(url, "wss://security-smart-eu.eufylife.com/v1/rtc/ws/join?reqtype=nvr");
        assert.equal(options.followRedirects, false);
        return new WebSocket(`ws://127.0.0.1:${address.port}`, protocols);
      },
      peer: (_servers, offer) => {
        peerCount++;
        peer = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false,
          codecs: { audio: [], video: [useH264({ payloadType: offer!.payloadType, parameters: offer!.parameters })] } });
        context.mock.method(peer, "createDataChannel", () => assert.fail("RTP clip must not create a data channel"));
        if (scenario === "cancel-offer") {
          const original = peer.setRemoteDescription.bind(peer);
          context.mock.method(peer, "setRemoteDescription", async (...args: Parameters<typeof original>) => {
            entered(); await pending; return original(...args);
          });
        }
        return peer;
      },
    });
    const errors: NvrTrialError[] = [];
    session.output.on("error", error => { errors.push(error as NvrTrialError); });
    try {
      if (scenario === "cancel-offer") {
        const stopped = assert.rejects(session.start(), error => error instanceof NvrTrialError && error.stage === "cancelled");
        await entering; controller.abort(); await stopped; finish();
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(answers, 0); assert.equal(chunks.length, 0);
      } else {
        await session.start().catch(error => { assert.deepEqual(serverErrors, []); throw error; });
        await new Promise(resolve => setTimeout(resolve, 1400));
        if (continuous) {
          assert.ok(scheduled.some(timer => timer.delay === 45_000));
          assert.equal(scheduled.some(timer => timer.delay === 10_000), false);
          scheduled.find(timer => timer.delay === 45_000)!.fire();
          assert.equal(session.output.destroyed, false);
          for (let step = 0; step < 11; step++) {
            videoNow += 30_000;
            const before = session.stats.video;
            await new Promise(resolve => setTimeout(resolve, 250));
            assert.ok(session.stats.video > before);
            assert.equal(session.remainingLifetimeMilliseconds, 45_000);
            assert.equal(session.output.destroyed, false);
          }
          assert.equal(videoNow, 330_000);
          if (scenario === "continuous-stall") {
            if (timer) clearInterval(timer);
            await new Promise(resolve => setTimeout(resolve, 150));
            scheduled.filter(timer => timer.delay === 45_000).at(-1)!.fire();
          } else if (scenario === "continuous-cancel") controller.abort();
          else if (scenario.startsWith("continuous-malformed-")) {
            assert.ok(signallingConnection);
            const message = scenario.endsWith("outer") ? "synthetic-not-json"
              : scenario.endsWith("inner") ? JSON.stringify({ data: null })
                : JSON.stringify({ data: JSON.stringify({ action: 3, code: 200, sessionId: "synthetic-sign",
                  sn: "synthetic-station", channelId: 0, dataType: "info", data: "[" }) });
            signallingConnection.send(message);
            await new Promise<void>(resolve => session.output.destroyed ? resolve() : session.output.once("close", resolve));
          }
        } else if (scenario === "finite-deadline") {
          assert.equal(scheduled.some(timer => timer.delay === 45_000), false);
          scheduled.find(timer => timer.delay === 10_000)!.fire();
        }
        await session.close(); await session.close();
        const closedChunks = chunks.length;
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(chunks.length, closedChunks);
        if (scenario === "continuous-stall") assert.deepEqual(errors.map(error => [error.stage, error.reason]), [["video", "video_progress_timeout"]]);
        else if (scenario === "finite-deadline") assert.equal(errors[0]?.stage, "deadline");
        else if (scenario === "continuous-cancel") assert.equal(errors[0]?.stage, "cancelled");
        else if (scenario.startsWith("continuous-malformed-")) {
          const expected = scenario.endsWith("outer") ? "e10_signal_outer_json"
            : scenario.endsWith("inner") ? "e10_signal_inner_shape" : "e10_signal_payload_json";
          assert.deepEqual(errors.map(error => [error.stage, error.reason]), [["framing", expected]]);
        }
        else assert.deepEqual(errors, []);
        const decoded = spawnSync("ffmpeg", ["-v", "error", "-xerror", "-err_detect", "explode", "-f", "h264", "-i", "pipe:0",
          "-progress", "pipe:1", "-f", "null", "-"], { input: Buffer.concat(chunks), timeout: 5000 });
        assert.equal(decoded.status, 0, decoded.stderr?.toString());
        const counts = [...decoded.stdout.toString().matchAll(/^frame=(\d+)$/gm)];
        assert.ok(Number(counts.at(-1)?.[1]) >= 6);
        assert.equal(answers, 1); assert.equal(peerCount, 1);
        assert.equal(acknowledgements, 1);
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



for (const changes of [{ cameraType: 301 }, { channel: 1 }, { station: "other-parent" }, { sensor: 1 },
  { audio: true }, { liveControls: true }, { powerTrial: true }, { guardTrial: true }] as const) {
  for (const lifetime of [75_000, null]) test(`the E10 RTP candidate refuses incompatible ownership ${JSON.stringify(changes)} lifetime=${lifetime}`, () => {
    assert.throws(() => new NvrRtcSession({ station: "synthetic-camera", camera: "synthetic-camera", cameraType: 314,
      channel: 0, e10RtpTrial: true, maximumLifetimeMilliseconds: lifetime, administrator: "synthetic-account", signal: new AbortController().signal,
      current: () => true, ready: () => undefined,
      context: { host: "security-smart-eu.eufylife.com", region: "EU", authToken: "synthetic-token", gtoken: "synthetic", sign: "synthetic-sign" },
      ...changes }), NvrTrialError);
  });
}
