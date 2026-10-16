/**
 * Exercises the experimental connection against local synthetic signalling and
 * real WebRTC peers. Each test owns and closes its sockets and peers, and never
 * contacts Eufy or claims physical NVR behaviour.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { zstdCompressSync } from 'node:zlib';
import { GatewayState } from '../src/domain/gateway-state.js';
import { LiveStreamManager } from '../src/stream/live-stream-manager.js';
import WebSocket, { WebSocketServer } from 'ws';
import { RTCPeerConnection, RTCSessionDescription } from 'werift';
import { NvrRtcSession } from '../src/stream/nvr-rtc-session.js';
import { nvrApplication, nvrHeartbeat, nvrPackets, NvrTrialError } from '../src/stream/nvr-protocol.js';
import { NvrPtcsReassembler } from '../src/stream/nvr-ptcs-reassembly.js';

function application(command: number, segment: number, body: Buffer): Buffer {
  const frame = Buffer.alloc(16 + body.length);
  frame.write('XZYH'); frame.writeUInt16LE(command, 4); frame.writeUInt32LE(body.length, 6);
  frame[11] = segment; frame[12] = 255; frame[15] = 2; body.copy(frame, 16);
  return frame;
}

function receivePackets(frame: Buffer, sequence: number, channel: number): Buffer[] {
  const wire = zstdCompressSync(frame);
  const count = Math.ceil(wire.length / 1000);
  return Array.from({ length: count }, (_, index) => {
    const length = Math.min(1000, wire.length - index * 1000);
    const packet = Buffer.alloc(28 + length);
    packet.write('PTCS'); packet[4] = 3; packet[5] = channel;
    packet.writeUInt16LE(sequence, 6); packet.writeUInt32LE(77, 8);
    packet.writeUInt32LE(wire.length, 12); packet.writeUInt16LE(index, 16);
    packet.writeUInt16LE(0x4800 | (index === count - 1 ? 0x0400 : 0) | length, 18);
    Buffer.from('receive!').copy(packet, 20); wire.copy(packet, 28, index * 1000, index * 1000 + length);
    return packet;
  });
}

function keyframePackets(frame: Buffer, sequence: number): Buffer[] {
  const count = Math.ceil(frame.length / 800);
  return Array.from({ length: count }, (_, index) => {
    const data = frame.subarray(index * 800, (index + 1) * 800), packet = Buffer.alloc(28 + data.length);
    packet.write('PTCS'); packet[4] = 3; packet[5] = 5;
    packet.writeUInt16LE(sequence, 6); packet.writeUInt32LE(77, 8);
    packet.writeUInt32LE(frame.length, 12); packet.writeUInt16LE(index, 16);
    packet.writeUInt16LE(0x6000 | (index === count - 1 ? 0x0400 : 0) | data.length, 18);
    data.copy(packet, 28); return packet;
  });
}

for (const scenario of ['h264', 'h265', 'sequence-gap', 'legacy-first-lens', 'state-read', 'state-bad-ack-padding', 'state-cancel', 'identity', 'wrong-channel', 'wrong-type', 'fingerprint', 'unknown-channel', 'cancel-start', 'framing-flags', 'heartbeat-changed', 'heartbeat-short', 'heartbeat-long'] as const) test(`real peers exercise ${scenario} with bounded cleanup`, { timeout: 45000 }, async () => {
  const codec = scenario === 'h265' || scenario === 'sequence-gap' ? 'h265' : 'h264';
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
      if (Buffer.isBuffer(event.data) && event.data.equals(nvrHeartbeat())) {
        if (scenario === 'h265') for (let index = 0; index < 40; index++) channel.send(event.data);
        return;
      }
      if (!Buffer.isBuffer(event.data) || event.data[4] !== 3) return;
      const assembled = receiver.push(event.data, Math.floor(performance.now()));
      if (assembled.status !== 'complete') return;
      const request = nvrApplication(assembled.frame), body = JSON.parse(request.payload.toString());
      commands.push(body.cmd);
      if (body.cmd === 1103) {
        assert.deepEqual(body.payload.channel_info, { array_size: 2, channel_array: [255, 3] });
        const ackBody = Buffer.alloc(132);
        if (scenario === 'state-bad-ack-padding') ackBody[131] = 1;
        const ack = application(1350, request.segment, ackBody);
        for (const packet of nvrPackets(ack, sequence++, 1)) channel.send(packet);
        const wrong = application(1351, request.segment, Buffer.from(JSON.stringify({ cmd: 9100, params: [] })));
        for (const packet of nvrPackets(wrong, sequence++, 1)) channel.send(packet);
        const wrongChannel = application(1351, request.segment, Buffer.from(JSON.stringify({ cmd: 1103, params: [] })));
        wrongChannel[12] = 101;
        for (const packet of nvrPackets(wrongChannel, sequence++, 1)) channel.send(packet);
        if (scenario === 'state-cancel') { controller.abort(); return; }
        setTimeout(() => {
          const data = application(1351, request.segment, Buffer.from(JSON.stringify({ cmd: 1103, params: [
            { dev_type: 255, param_type: 1224, param_value: '2' }, { channel: 255, param_type: 1151, param_value: 1 },
            { channel: 3, param_type: 6250, param_value: 'MA==' },
          ] })));
          for (const packet of nvrPackets(data, sequence++, 1)) channel.send(packet);
        }, 20);
        return;
      }
      const response = body.cmd === 9100
        ? application(1351, request.segment, Buffer.from(JSON.stringify({ cmd: 9100,
          payload: { dev_list: [{ sn: scenario === 'identity' ? 'synthetic-other' : 'synthetic-camera', ch: scenario === 'wrong-channel' ? 4 : 3, dev_type: scenario === 'legacy-first-lens' ? 14 : scenario === 'wrong-type' ? 302 : 301 }] } })))
        : application(1350, request.segment, Buffer.alloc(4));
      if ((scenario === 'state-read' || scenario === 'state-bad-ack-padding') && body.cmd === 9100) response[10] = 1;
      const responsePackets = (scenario === 'state-read' || scenario === 'state-bad-ack-padding') && body.cmd === 9100
        ? receivePackets(response, sequence++, 1)
        : nvrPackets(response, sequence++, 1);
      if (scenario === 'framing-flags' && body.cmd === 9100) {
        const malformed = responsePackets[0]!;
        malformed.writeUInt16LE(malformed.readUInt16LE(18) | 0x8000, 18);
        for (let index = 0; index < 32; index++) channel.send(malformed);
        return;
      }
      if (scenario.startsWith('heartbeat-') && body.cmd === 9100) {
        let malformed = nvrHeartbeat();
        if (scenario === 'heartbeat-changed') malformed[35] = 3;
        else if (scenario === 'heartbeat-short') malformed = malformed.subarray(0, 27);
        else malformed = Buffer.concat([malformed, Buffer.from([0])]);
        for (let index = 0; index < 32; index++) channel.send(malformed);
        return;
      }
      for (const packet of responsePackets) channel.send(packet);
      if (body.cmd === 1003) {
        assert.equal(body.payload.chn_list[0].sensor, scenario === 'legacy-first-lens' ? 0 : 1);
        sendVideo = setInterval(() => {
        if (scenario === 'sequence-gap' && videoSequence === 3) videoSequence += 20;
        const media = Buffer.alloc(22 + generated.stdout.length); media.writeUInt32LE(generated.stdout.length, 0);
        media[4] = 1; media[5] = codec === 'h264' ? 0 : 1; media.writeUInt16LE(videoSequence, 6);
        media[8] = 10; media.writeUInt16LE(320, 10); media.writeUInt16LE(180, 12); media.writeBigUInt64LE(BigInt(videoSequence) * 2000n, 14);
        generated.stdout.copy(media, 22);
        const frame = application(1300, 0, media); frame[12] = codec === 'h265' ? 101 : 3; frame[14] = 1;
        const parts = codec === 'h265' ? keyframePackets(frame, videoSequence++) : nvrPackets(frame, videoSequence++, 1, 1);
        for (const packet of parts) channel.send(packet);
      }, 100);
      }
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
    cameraType: scenario === 'legacy-first-lens' ? 14 : 301, sensor: scenario === 'legacy-first-lens' ? 0 : 1,
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
    if (['identity', 'wrong-channel', 'wrong-type', 'fingerprint', 'unknown-channel', 'cancel-start', 'framing-flags'].includes(scenario) || scenario.startsWith('heartbeat-')) {
      const deadline = setTimeout(() => controller.abort(), 5000);
      try { await assert.rejects(session.start(), error => {
        assert.equal((error as { stage: string }).stage, ['identity', 'wrong-channel', 'wrong-type'].includes(scenario) ? 'identity_unmatched' : scenario === 'unknown-channel' ? 'channel' : scenario === 'cancel-start' ? 'cancelled' : scenario === 'framing-flags' || scenario.startsWith('heartbeat-') ? 'framing' : 'negotiation');
        if (scenario === 'framing-flags') {
          assert.equal((error as NvrTrialError).reason, 'ptcs_flags');
          assert.deepEqual(session.framingRejections, { flags: 32 });
        }
        if (scenario.startsWith('heartbeat-')) {
          assert.equal((error as NvrTrialError).reason, scenario === 'heartbeat-short' ? 'ptcs_packet_geometry' : 'ptcs_magic');
          assert.equal(session.stats.rejected, 32);
          assert.equal(session.stats.controlPackets, 0);
        }
        return true;
      }); } finally { clearTimeout(deadline); }
      assert.equal(commands.includes(1003), false); return;
    }
    if (scenario === 'state-read' || scenario === 'state-bad-ack-padding' || scenario === 'state-cancel') {
      if (scenario === 'state-cancel') await assert.rejects(session.readState(), error => {
        assert.equal((error as { stage: string }).stage, 'cancelled'); return true;
      });
      else {
        const result = await session.readState();
        assert.equal(result.configuredGuardMode, 2); assert.equal(result.effectiveGuardMode, 1); assert.equal(result.cameraPower, 'on');
        assert.equal(session.stats.staleReplies, scenario === 'state-bad-ack-padding' ? 3 : 2);
      }
      assert.deepEqual(commands, [9100, 1103]); assert.equal(attached, 0); assert.equal(snapshots, 0); assert.equal(diagnosticMedia, 0);
      await session.close(); return;
    }
    const clip = await manager.recordClip('synthetic-camera', 10, 75000, true);
    const decoded = spawnSync('ffmpeg', ['-v', 'error', '-xerror', '-i', 'pipe:0', '-f', 'null', '-'], { input: clip });
    assert.equal(decoded.status, 0, decoded.stderr.toString()); assert.ok(clip.length > 1000); assert.equal(session.codec, codec); assert.equal(snapshots, 0); assert.equal(extractors, 0); assert.equal(diagnosticMedia, 0); assert.equal(attached, 1); assert.deepEqual(commands, [9100, 1003, 1004]);
    controller.abort(); await session.close(); await session.close();
    assert.deepEqual(commands, [9100, 1003, 1004]); assert.equal(session.stats.stopUnconfirmed, 0);
    if (scenario === 'h265' || scenario === 'sequence-gap') {
      assert.ok(session.stats.channel5Frames > 0);
      if (scenario === 'h265') assert.ok(session.stats.controlPackets >= 40);
      assert.equal(session.stats.rejected, 0);
      assert.deepEqual(session.framingRejections, {});
    }
    if (scenario === 'sequence-gap') {
      assert.equal(session.stats.applicationSequenceRecoveries, 1);
      assert.equal(session.stats.videoSequenceRecoveries, 1);
    }
  } finally {
    if (sendVideo) clearInterval(sendVideo); await session.close(); await manager.close(); socket?.terminate(); await peer.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});


for (const reason of ['session_mismatch', 'station_mismatch', 'channel_mismatch', 'relay_shape', 'relay_fields', 'offer_order', 'peer_setup', 'remote_description'] as const) {
  test(`early NVR negotiation preserves ${reason} and retires the socket`, { timeout: 5000 }, async context => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, 'listening');
    const address = server.address() as { port: number };
    let socket: WebSocket | undefined, peer: RTCPeerConnection | undefined;
    const sdp = ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:0',
      'a=ice-ufrag:synthetic', 'a=ice-pwd:syntheticPasswordAtLeast22', 'a=setup:actpass',
      'a=fingerprint:sha-256 ' + Array(32).fill('AA').join(':'), 'a=sctp-port:5000', 'a=max-message-size:262144', ''].join('\r\n');
    server.on('connection', connection => {
      socket = connection;
      const send = (value: Record<string, unknown>): void => { connection.send(JSON.stringify({ data: JSON.stringify(value) })); };
      const response = (dataType: string, data: Record<string, unknown>): void => send({ action: 3,
        sessionId: reason === 'session_mismatch' ? 'private-other-session' : 'synthetic-sign',
        sn: reason === 'station_mismatch' ? 'private-other-station' : 'synthetic-station',
        channelId: reason === 'channel_mismatch' ? 1 : 0, dataType, data: JSON.stringify(data) });
      connection.on('message', raw => {
        const message = JSON.parse(JSON.parse(raw.toString()).data);
        if (message.action === 1) send({ action: 1, code: 200 });
        else if (message.dataType === 'call') {
          if (reason === 'relay_shape') response('call', { status: 100, turn: 'private-relay' });
          else if (reason === 'relay_fields') response('call', { status: 100, turn: { host: 'private.local', username: 'private-user', credential: 'private-password' } });
          else {
            if (reason !== 'offer_order') response('call', { status: 200 });
            response('info', { format: 'SDP', value: sdp });
          }
        }
      });
    });
    const controller = new AbortController();
    const session = new NvrRtcSession({ station: 'synthetic-station', camera: 'synthetic-camera', channel: 3,
      administrator: 'synthetic-owner', context: { host: 'security-smart-eu.eufylife.com', region: 'EU',
        authToken: 'synthetic-token', gtoken: 'synthetic-gtoken', sign: 'synthetic-sign' },
      signal: controller.signal, current: () => true, ready: () => assert.fail('Must not start media') }, {
      socket: (_url, protocols, options) => new WebSocket(`ws://127.0.0.1:${address.port}`, protocols, options),
      peer: () => {
        if (reason === 'peer_setup') throw new Error('private-library-error');
        peer = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false });
        context.mock.method(peer, 'setRemoteDescription', async () => { throw new Error('private-library-error'); });
        return peer;
      },
    });
    let outputError: unknown;
    session.output.once('error', error => { outputError = error; });
    try {
      await assert.rejects(session.start(), error => {
        assert.ok(error instanceof NvrTrialError); assert.equal(error.stage, 'negotiation'); assert.equal(error.reason, reason);
        assert.equal(error.message.includes('private'), false); assert.equal(error.cause, undefined); return true;
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.ok(outputError instanceof NvrTrialError); assert.equal(outputError.reason, reason);
      assert.equal(session.stats.packets, 0); assert.equal(session.stats.video, 0);
    } finally {
      await session.close(); socket?.terminate(); await peer?.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
