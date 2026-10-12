/**
 * Exercises the experimental connection against local synthetic signalling and
 * real WebRTC peers. Each test owns and closes its sockets and peers, and never
 * contacts Eufy or claims physical NVR behaviour.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { GatewayState } from '../src/domain/gateway-state.js';
import { LiveStreamManager } from '../src/stream/live-stream-manager.js';
import WebSocket, { WebSocketServer } from 'ws';
import { RTCPeerConnection, RTCSessionDescription } from 'werift';
import { NvrRtcSession } from '../src/stream/nvr-rtc-session.js';
import { nvrApplication, nvrPackets } from '../src/stream/nvr-protocol.js';
import { NvrPtcsReassembler } from '../src/stream/nvr-ptcs-reassembly.js';

function application(command: number, segment: number, body: Buffer): Buffer {
  const frame = Buffer.alloc(16 + body.length);
  frame.write('XZYH'); frame.writeUInt16LE(command, 4); frame.writeUInt32LE(body.length, 6);
  frame[11] = segment; frame[12] = 255; frame[15] = 2; body.copy(frame, 16);
  return frame;
}

for (const scenario of ['h264', 'h265', 'identity', 'wrong-channel', 'wrong-type', 'fingerprint', 'unknown-channel', 'cancel-start'] as const) test(`real peers exercise ${scenario} with bounded cleanup`, { timeout: 45000 }, async () => {
  const codec = scenario === 'h265' ? 'h265' : 'h264';
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const address = server.address(); assert.equal(typeof address, 'object');
  const peer = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false });
  peer.createDataChannel('synthetic-offer', scenario === 'unknown-channel' ? {} : { negotiated: true, id: 12 });
  const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '2', '-c:v', codec === 'h264' ? 'libx264' : 'libx265', '-preset', 'ultrafast', '-g', '10', '-f', codec === 'h264' ? 'h264' : 'hevc', 'pipe:1'], { maxBuffer: 4 * 1024 * 1024 });
  assert.equal(generated.status, 0, generated.stderr.toString());
  const commands: number[] = [], receiver = new NvrPtcsReassembler();
  let sequence = 0, videoSequence = 0, socket: WebSocket | undefined, sendVideo: NodeJS.Timeout | undefined;
  peer.onDataChannel.subscribe(channel => {
    if (channel.label !== 'WebrtcDataChannel') return;
    channel.onmessage = event => {
      if (!Buffer.isBuffer(event.data) || event.data[4] !== 3) return;
      const assembled = receiver.push(event.data, Math.floor(performance.now()));
      if (assembled.status !== 'complete') return;
      const request = nvrApplication(assembled.frame), body = JSON.parse(request.payload.toString());
      commands.push(body.cmd);
      const response = body.cmd === 9100
        ? application(1351, request.segment, Buffer.from(JSON.stringify({ cmd: 9100,
          payload: { dev_list: [{ sn: scenario === 'identity' ? 'synthetic-other' : 'synthetic-camera', ch: scenario === 'wrong-channel' ? 4 : 3, dev_type: scenario === 'wrong-type' ? 302 : 301 }] } })))
        : application(1350, request.segment, Buffer.alloc(4));
      for (const packet of nvrPackets(response, sequence++, 1)) channel.send(packet);
      if (body.cmd === 1003) sendVideo = setInterval(() => {
        const media = Buffer.alloc(22 + generated.stdout.length); media.writeUInt32LE(generated.stdout.length, 0);
        media[4] = 1; media[5] = codec === 'h264' ? 0 : 1; media.writeUInt16LE(videoSequence, 6);
        media[8] = 10; media.writeUInt16LE(320, 10); media.writeUInt16LE(180, 12); media.writeBigUInt64LE(BigInt(videoSequence) * 2000n, 14);
        generated.stdout.copy(media, 22);
        const frame = application(1300, 0, media); frame[12] = 3; frame[14] = 1;
        for (const packet of nvrPackets(frame, videoSequence++, 1, 1)) channel.send(packet);
      }, 100);
      if (body.cmd === 1004 && sendVideo) clearInterval(sendVideo);
    };
  });
  server.on('connection', connection => {
    socket = connection;
    const send = (value: Record<string, unknown>): void => { connection.send(JSON.stringify({ data: JSON.stringify(value) })); };
    const info = (value: Record<string, unknown>): void => send({ action: 3, sessionId: 'synthetic-sign', sn: 'synthetic-station', channelId: 0, dataType: 'info', data: JSON.stringify(value) });
    connection.on('message', async raw => {
      const message = JSON.parse(JSON.parse(raw.toString()).data);
      if (message.action === 1) { if (scenario === 'cancel-start') controller.abort(); else send({ action: 1, code: 200 }); }
      else if (message.dataType === 'call') {
        send({ action: 3, sessionId: 'synthetic-sign', sn: 'synthetic-station', channelId: 0,
          dataType: 'call', data: JSON.stringify({ status: 200 }) });
        info({ format: 'SDP', value: scenario === 'fingerprint' ? peer.localDescription!.sdp.replace(/a=fingerprint:sha-256 [^\r\n]+/, 'a=fingerprint:sha-256 ' + Array(32).fill('AA').join(':')) : peer.localDescription!.sdp });
      } else if (message.dataType === 'info') {
        const data = JSON.parse(message.data);
        if (data.sdp) await peer.setRemoteDescription(new RTCSessionDescription(data.sdp, 'answer'));
        else if (data.candidate) await peer.addIceCandidate({ candidate: data.candidate, sdpMid: '0', sdpMLineIndex: 0 });
      }
    });
  });
  const controller = new AbortController();
  let attached = 0;
  const state = new GatewayState(); state.registerCamera({ serial: 'synthetic-camera', name: 'Synthetic', model: 'T8E00', stationSerial: 'synthetic-station', streamSupported: false, doorbellSupported: false });
  let snapshots = 0, extractors = 0, diagnosticMedia = 0;
  const manager = new LiveStreamManager(state, { write: async () => { snapshots++; } } as never, { startStream: async () => session.start(), stopStream: async () => session.close() }, 5, undefined, undefined, (() => { extractors++; throw new Error("Unexpected snapshot extractor"); }) as never);
  manager.on("diagnostic-media", () => diagnosticMedia++);
  manager.on('warning', () => {});
  const session = new NvrRtcSession({ station: 'synthetic-station', camera: 'synthetic-camera', channel: 3,
    administrator: 'synthetic-administrator', context: { host: 'security-smart-ie.eufylife.com', region: 'IE',
      authToken: 'synthetic-token', gtoken: 'synthetic-gtoken', sign: 'synthetic-sign' },
    signal: controller.signal, current: () => true, ready: (output, hint) => { attached++; manager.attachSource('synthetic-camera', output, hint); } }, {
    socket: (url, protocols, options) => {
      assert.equal(url, 'wss://security-smart-ie.eufylife.com/v1/rtc/ws/join?reqtype=nvr');
      assert.equal(options.followRedirects, false); assert.equal(options.maxPayload, 65536);
      return new WebSocket(`ws://127.0.0.1:${(address as { port: number }).port}`, protocols, options);
    }, peer: () => new RTCPeerConnection({ iceServers: [], iceUseIpv6: false }),
  });
  try {
    if (['identity', 'wrong-channel', 'wrong-type', 'fingerprint', 'unknown-channel', 'cancel-start'].includes(scenario)) {
      const deadline = setTimeout(() => controller.abort(), 5000);
      try { await assert.rejects(session.start(), error => {
        assert.equal((error as { stage: string }).stage, ['identity', 'wrong-channel', 'wrong-type'].includes(scenario) ? 'identity_unmatched' : scenario === 'unknown-channel' ? 'channel' : scenario === 'cancel-start' ? 'cancelled' : 'negotiation'); return true;
      }); } finally { clearTimeout(deadline); }
      assert.equal(commands.includes(1003), false); return;
    }
    const clip = await manager.recordClip('synthetic-camera', 10, 75000, true);
    const decoded = spawnSync('ffmpeg', ['-v', 'error', '-xerror', '-i', 'pipe:0', '-f', 'null', '-'], { input: clip });
    assert.equal(decoded.status, 0, decoded.stderr.toString()); assert.ok(clip.length > 1000); assert.equal(session.codec, codec); assert.equal(snapshots, 0); assert.equal(extractors, 0); assert.equal(diagnosticMedia, 0); assert.equal(attached, 1); assert.deepEqual(commands, [9100, 1003, 1004]);
    controller.abort(); await session.close(); await session.close();
    assert.deepEqual(commands, [9100, 1003, 1004]); assert.equal(session.stats.stopUnconfirmed, 0);
  } finally {
    if (sendVideo) clearInterval(sendVideo); await session.close(); await manager.close(); socket?.terminate(); await peer.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
