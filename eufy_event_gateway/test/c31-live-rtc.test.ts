/**
 * Tests a real local WebRTC peer with generated video and microphone RTP.
 * Tests own sockets and FFmpeg children. No account, camera or host microphone
 * is opened. The existing native sender is qualified separately.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket } from "werift";
import { C31LiveRtc, c31LiveRtcOffer, type C31LiveRtcSummary } from "../src/stream/c31-live-rtc.js";
import { DoorbellH264Assembler } from "../src/stream/doorbell-rtp.js";
import { c31TalkbackFrames, C31TalkbackSender } from "../src/stream/c31-talkback.js";

/** Wait for an observed condition without retaining a success timeout. */
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 8_000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("Synthetic RTC condition unavailable");
    await delay(20);
  }
}


for (const finishMicrophone of [true, false]) test(`local C31 RTC decodes video and retires its microphone, finish=${finishMicrophone}`, { timeout: 20_000 }, async () => {
  const codecs = {
    video: [new RTCRtpCodecParameters({ mimeType: "video/H264", clockRate: 90000, payloadType: 102,
      parameters: "packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1" })],
    audio: [new RTCRtpCodecParameters({ mimeType: "audio/PCMU", clockRate: 8000, payloadType: 0, channels: 1 })],
  };
  const browser = new RTCPeerConnection({ iceServers: [], codecs });
  browser.addTransceiver("video", { direction: "recvonly" });
  const microphone = new MediaStreamTrack({ kind: "audio" });
  browser.addTransceiver(microphone, { direction: "sendrecv" });
  const transports = [...browser.dtlsTransports];
  const video: Buffer[] = [], assembler = new DoorbellH264Assembler();
  let receivedAudio = 0, nativeFrames = 0, activeSpeaker = false, speakerCompleted = false, sourceEnded = false;
  let source: ReturnType<typeof spawn> | undefined;
  let sourceClosed: Promise<void> = Promise.resolve();
  const finished: C31LiveRtcSummary[] = [];
  browser.onTrack.subscribe(track => track.onReceiveRtp.subscribe(packet => {
    if (track.kind === "video") {
      assert.equal(packet.header.payloadType, 102);
      const frame = assembler.push({ sequenceNumber: packet.header.sequenceNumber, timestamp: packet.header.timestamp,
        marker: packet.header.marker, payload: packet.payload });
      if (frame) video.push(frame);
    } else receivedAudio++;
  }));
  const broker = new C31LiveRtc({ admitted: serial => serial === "synthetic", microphoneReady: () => true,
    source: async (_serial, input) => {
      source = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=10",
        "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "8", "-c:v", "libx264", "-preset", "ultrafast",
        "-tune", "zerolatency", "-g", "10", "-c:a", "aac", "-ar", "16000", "-ac", "1", "-flush_packets", "1", "-f", "mpegts", "pipe:1"],
      { stdio: ["ignore", "pipe", "pipe"] });
      const child = source;
      sourceClosed = new Promise(resolve => child.once("close", () => { sourceEnded = true; resolve(); }));
      child.stderr?.resume(); child.stdout!.pipe(input);
      input.once("close", () => child.kill("SIGTERM"));
    },
    speaker: async (_serial, frames, signal) => {
      activeSpeaker = true;
      try {
        const sender = new C31TalkbackSender({ start: () => {}, stop: () => {}, send: frame => {
          assert.equal(c31TalkbackFrames(frame).length, 1);
          const sequence = nativeFrames++; queueMicrotask(() => sender.acknowledge(sequence)); return sequence;
        } });
        await sender.stream(frames, signal); speakerCompleted = true;
      } finally { activeSpeaker = false; }
    },
    finished: summary => finished.push(summary),
  });
  try {
    await browser.setLocalDescription(await browser.createOffer());
    const offer = browser.localDescription!.sdp;
    assert.equal(c31LiveRtcOffer(offer).receiveMicrophone, true);
    const result = await broker.offer("synthetic", offer);
    assert.equal(broker.has("synthetic"), true);
    await assert.rejects(broker.offer("synthetic", offer), { code: "busy" });
    await assert.rejects(broker.close("other", result.sessionId));
    await browser.setRemoteDescription({ type: "answer", sdp: result.sdp });
    await until(() => video.length > 0 && receivedAudio > 0);
    for (let index = 0; index < 60; index++) {
      microphone.writeRtp(new RtpPacket(new RtpHeader({ sequenceNumber: index, timestamp: index * 160,
        payloadType: 0, ssrc: 12345 }), Buffer.alloc(160, 0xff)));
      await delay(20);
    }
    if (finishMicrophone) {
      await until(() => speakerCompleted);
      assert.equal(activeSpeaker, false);
    } else await until(() => nativeFrames > 2);
    await broker.close("synthetic", result.sessionId); await sourceClosed;
    assert.equal(activeSpeaker, false); assert.equal(sourceEnded, true); assert.equal(broker.has("synthetic"), false);
    assert.equal(finished.length, 1); assert.equal(finished[0]!.speakerFailures, 0); assert.equal(finished[0]!.outcome, "client_closed"); assert.ok(finished[0]!.microphonePackets > 20); assert.ok(finished[0]!.encodedFrames > 2);
    const progress = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "h264", "-i", "pipe:0",
      "-progress", "pipe:1", "-f", "null", "-"], { input: Buffer.concat(video), timeout: 5_000 }).toString();
    assert.match(progress, /frame=[1-9]\d*/);
  } finally { await broker.closeAll(); await browser.close(); await Promise.all(transports.map(transport => transport.stop())); microphone.stop(); source?.kill("SIGTERM"); await sourceClosed; }
});
