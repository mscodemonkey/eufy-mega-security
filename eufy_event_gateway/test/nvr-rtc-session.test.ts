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

for (const scenario of ['h264', 'h265', 'sequence-gap', 'legacy-first-lens', 'power', 'power-noop', 'power-cancel', 'guard', 'legacy-zero-segment', 'power-unordered', 'power-undefined', 'state-read', 'state-bad-ack-padding', 'state-cancel', 'state-uncorrelated-push', 'state-uncorrelated-error', 'state-matching-error', 'state-uncorrelated-cancel', 'state-uncorrelated-timeout', 'zero-segment-lifecycle', 'identity', 'wrong-channel', 'wrong-type', 'fingerprint', 'unknown-channel', 'cancel-start', 'framing-flags', 'heartbeat-changed', 'heartbeat-short', 'heartbeat-long'] as const) test(`real peers exercise ${scenario} with bounded cleanup`, { timeout: 45000 }, async context => {
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
  let powerValue = 0, guardReadVariant = 0;
  let cancelPower = (): void => {};
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
      if (body.cmd === 6250) {
        assert.ok(scenario.startsWith('power'));
        assert.equal(request.channel,3); assert.ok(request.segment > 0);
        assert.deepEqual(Object.keys(body).sort(),['account_id','cmd','payload']);
        assert.deepEqual(Object.keys(body.payload),['switch']); assert.ok([0,1].includes(body.payload.switch));
        assert.equal(body.payload.switch, commands.filter(command=>command===6250).length === 1 && scenario !== 'power-noop' ? 1 : 0);
        powerValue=body.payload.switch;
        if(scenario === 'power-cancel' && commands.filter(command=>command===6250).length===1) cancelPower();
        for(const [length,ch,seg] of [[131,3,request.segment],[132,255,request.segment],[132,3,0],[132,3,request.segment-1]]) {
          const wrong=application(1350,seg!,Buffer.alloc(length!,0x55));wrong[12]=ch!;
          for(const packet of nvrPackets(wrong,sequence++,1))channel.send(packet);
        }
        const jsonReceipt=application(1350,request.segment,Buffer.from(JSON.stringify({status:0}).padEnd(132,' ')));jsonReceipt[12]=3;
        for(const packet of nvrPackets(jsonReceipt,sequence++,1))channel.send(packet);
        setTimeout(()=>{
          const receipt=application(1350,request.segment,Buffer.alloc(132,0x55));receipt[12]=3;
          for(const packet of nvrPackets(receipt,sequence++,1))channel.send(packet);
        },20);
        return;
      }
      if (body.cmd === 1224) {
        assert.equal(scenario, 'guard'); assert.equal(request.channel, 255); assert.ok(request.segment > 0);
        assert.deepEqual(body, { account_id: 'synthetic-administrator', cmd: 1224, mValue3: 0,
          payload: { mode_type: commands.filter(command => command === 1224).length === 1 ? 1 : 2,
            user_name: 'Synthetic' } });
        const wrong = application(1350, request.segment, Buffer.alloc(132, 0x55)); wrong[12] = 3;
        for (const packet of nvrPackets(wrong, sequence++, 1)) channel.send(packet);
        const receipt = application(1350, request.segment, Buffer.alloc(132, 0x55));
        for (const packet of nvrPackets(receipt, sequence++, 1)) channel.send(packet);
        const effective = application(1151, 0, Buffer.alloc(4));
        effective.writeInt32LE(body.payload.mode_type === 1 ? 1 : 0, 16);
        for (const packet of nvrPackets(effective, sequence++, 1)) channel.send(packet);
        return;
      }
      if (body.cmd === 1103) {
        assert.deepEqual(body.payload.channel_info, { array_size: 2, channel_array: [255, 3] });
        if (scenario === 'guard') {
          const effective = commands.filter(command => command === 1224).length === 1 ? 1 : 0;
          const params: Array<Record<string, number>> = [{ dev_type: 255, param_type: 1151, param_value: effective }];
          if (guardReadVariant === 0) params.push({ ...params[0]! });
          if (guardReadVariant === 1) params.push({ dev_type: 3, param_type: 6250, param_value: 0 }, { dev_type: 3, param_type: 6250, param_value: 0 });
          if (guardReadVariant === 2) params.push({ dev_type: 3.5, channel: 3, param_type: 6250, param_value: 0 });
          guardReadVariant++;
          const result = { cmd: 1103, payload: { params } };
          for (const segment of [0, request.segment - 1]) {
            const stale = application(1351, segment, Buffer.from(JSON.stringify({ cmd: 1103,
              payload: { params: [{ dev_type: 255, param_type: 1151, param_value: 1 }] } })));
            for (const packet of nvrPackets(stale, sequence++, 1)) channel.send(packet);
          }
          const wrongChannel = application(1351, request.segment, Buffer.from(JSON.stringify(result))); wrongChannel[12] = 3;
          for (const packet of nvrPackets(wrongChannel, sequence++, 1)) channel.send(packet);
          for (const packet of nvrPackets(application(1351, request.segment, Buffer.from(JSON.stringify(result))), sequence++, 1)) channel.send(packet);
          return;
        }
        assert.deepEqual(body.payload.channel_info, { array_size: 2, channel_array: [255, 3] });
        if (scenario === 'state-matching-error') {
          const negative = Buffer.alloc(132); negative.writeInt32LE(-1);
          for (const packet of nvrPackets(application(1350, request.segment, negative), sequence++, 1)) channel.send(packet);
          return;
        }
        if (scenario === 'state-uncorrelated-error') {
          const negative = Buffer.alloc(132); negative.writeInt32LE(-1);
          for (const packet of nvrPackets(application(1350, 0, negative), sequence++, 1)) channel.send(packet);
          for (const packet of nvrPackets(application(1351, 0, Buffer.from(JSON.stringify({ cmd: 1103, mIntRet: -1 }))), sequence++, 1)) channel.send(packet);
        }
        if (['state-uncorrelated-push', 'state-uncorrelated-cancel', 'state-uncorrelated-timeout'].includes(scenario)) {
          const unsolicited = application(1351, 0, Buffer.from(JSON.stringify({ cmd: 1103, params: [
            { dev_type: 255, param_type: 1224, param_value: '1' }, { channel: 255, param_type: 1151, param_value: 0 },
            { channel: 3, param_type: 6250, param_value: 'MQ==' },
          ] })));
          for (const packet of nvrPackets(unsolicited, sequence++, 1)) channel.send(packet);
          if (scenario === 'state-uncorrelated-cancel') { setTimeout(() => controller.abort(), 100); return; }
          if (scenario === 'state-uncorrelated-timeout') return;
        }
        const ackBody = Buffer.alloc(132);
        if (scenario === 'state-bad-ack-padding') ackBody[131] = 1;
        const ack = application(1350, request.segment, ackBody);
        for (const packet of nvrPackets(ack, sequence++, 1)) channel.send(packet);
        const wrong = application(1351, request.segment, Buffer.from(JSON.stringify({ cmd: 9100, params: [] })));
        for (const packet of nvrPackets(wrong, sequence++, 1)) channel.send(packet);
        const wrongChannel = application(1351, request.segment, Buffer.from(JSON.stringify({ cmd: 1103, params: [] })));
        wrongChannel[12] = 101;
        for (const packet of nvrPackets(wrongChannel, sequence++, 1)) channel.send(packet);
        if(scenario.startsWith('power')) {
          for(const segment of [0,request.segment-1]) {
            const stale=application(1351,segment,Buffer.from(JSON.stringify({cmd:1103,params:[{channel:3,param_type:6250,param_value:1-powerValue}]})));
            for(const packet of nvrPackets(stale,sequence++,1))channel.send(packet);
          }
        }
        if (scenario === 'state-cancel') { controller.abort(); return; }
        setTimeout(() => {
          const data = application(1351, request.segment, Buffer.from(JSON.stringify({ cmd: 1103, params: [
            { dev_type: 255, param_type: 1224, param_value: '2' }, { channel: 255, param_type: 1151, param_value: 1 },
            { channel: 3, param_type: 6250, param_value: Buffer.from(String(powerValue)).toString('base64') },
          ] })));
          for (const packet of nvrPackets(data, sequence++, 1)) channel.send(packet);
        }, 20);
        return;
      }
      const replySegment = scenario === 'zero-segment-lifecycle' ? 0 : request.segment;
      const response = body.cmd === 9100
        ? application(1351, replySegment, Buffer.from(JSON.stringify({ cmd: 9100,
          payload: { dev_list: [{ sn: scenario === 'identity' ? 'synthetic-other' : 'synthetic-camera', ch: scenario === 'wrong-channel' ? 4 : 3, dev_type: scenario === 'legacy-first-lens' ? 14 : scenario === 'wrong-type' ? 302 : 301 }] } })))
        : application(1350, replySegment, Buffer.alloc(4));
      if (scenario === 'legacy-zero-segment') response[11] = 0;
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
  if (scenario === 'power-unordered' || scenario === 'power-undefined') {
    const create = RTCPeerConnection.prototype.createDataChannel;
    context.mock.method(RTCPeerConnection.prototype, 'createDataChannel', function (this: RTCPeerConnection, label: string, options: Parameters<RTCPeerConnection["createDataChannel"]>[1]) {
      const channel = create.call(this, label, { ...options, ordered: false });
      if (scenario === 'power-undefined') Object.defineProperty(channel, 'ordered', { value: undefined });
      return channel;
    });
  }
  const session = new NvrRtcSession({ station: 'synthetic-station', camera: 'synthetic-camera', channel: 3,
    powerTrial: scenario.startsWith('power'),
    guardTrial: scenario === 'guard', ...(scenario === 'guard' ? { userName: 'Synthetic' } : {}),
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
    if(scenario.startsWith('power')) {
      if(scenario === 'power-unordered' || scenario === 'power-undefined') {
        await assert.rejects(session.preparePowerTrial(), /identity/);
        assert.equal(commands.includes(6250), false); await session.close(); return;
      }
      await session.preparePowerTrial();
      let dispatched=0;
      let phase=new AbortController();
      cancelPower=()=>phase.abort();
      if(scenario === 'power-cancel') {
        await assert.rejects(session.writePowerTrial('off',phase.signal,()=>{dispatched++;}),/cancelled/);
        phase=new AbortController();
      } else await session.writePowerTrial(scenario === 'power-noop' ? 'on' : 'off',phase.signal,()=>{dispatched++;});
      assert.equal(await session.readPowerTrial(phase.signal),scenario === 'power-noop' ? 'on' : 'off');
      await session.writePowerTrial('on',phase.signal,()=>{dispatched++;});
      assert.equal(await session.readPowerTrial(phase.signal),'on');
      assert.equal(dispatched,2);assert.deepEqual(commands,[9100,6250,1103,6250,1103]);
      assert.equal(attached,0);assert.equal(snapshots,0);assert.equal(diagnosticMedia,0);
      assert.ok(session.stats.staleReplies >= 14);
      await session.close();return;
    }
    if (scenario === 'guard') {
      await session.prepareGuardTrial();
      const phase = new AbortController(); let dispatched = 0;
      await session.validateGuardTrial(phase.signal);
      await session.writeGuardTrial(1, phase.signal, () => { dispatched++; });
      for (let index = 0; index < 3; index++) await assert.rejects(session.confirmGuardEffectiveTrial(1, phase.signal));
      await session.confirmGuardEffectiveTrial(1, phase.signal);
      for (let index = 0; index < 27; index++) await session.confirmGuardEffectiveTrial(1, phase.signal);
      await assert.rejects(session.confirmGuardEffectiveTrial(1, phase.signal));
      await session.validateGuardTrial(phase.signal, true);
      await session.writeGuardTrial(2, phase.signal, () => { dispatched++; });
      await session.confirmGuardEffectiveTrial(0, phase.signal);
      for (let index = 0; index < 186; index++) await session.confirmGuardEffectiveTrial(0, phase.signal);
      await assert.rejects(session.confirmGuardEffectiveTrial(0, phase.signal));
      assert.equal(dispatched, 2); assert.equal(commands.filter(command => command === 1224).length, 2);
      assert.equal(commands.filter(command => command === 1103).length, 218);
      assert.equal(attached, 0); assert.equal(snapshots, 0); assert.equal(diagnosticMedia, 0);
      assert.ok(session.stats.staleReplies >= 2);
      await session.close(); return;
    }
    if (scenario.startsWith('state-')) {
      if (['state-cancel', 'state-uncorrelated-cancel', 'state-uncorrelated-timeout', 'state-matching-error'].includes(scenario)) {
        await assert.rejects(session.readState(), error => {
          assert.equal((error as { stage: string }).stage, scenario.includes('cancel') ? 'cancelled' : 'state'); return true;
        });
        assert.equal(session.stats.staleReplies, scenario === 'state-matching-error' ? 0 : scenario === 'state-cancel' ? 0 : 1);
      }
      else {
        const result = await session.readState();
        assert.equal(result.configuredGuardMode, 2); assert.equal(result.effectiveGuardMode, 1); assert.equal(result.cameraPower, 'on');
        assert.equal(session.stats.staleReplies, scenario === 'state-bad-ack-padding' || scenario === 'state-uncorrelated-push' ? 3 : scenario === 'state-uncorrelated-error' ? 4 : 2);
      }
      assert.equal(session.stats.segmentNotEchoed, 0);
      assert.ok(session.output.writableEnded || session.output.destroyed);
      assert.deepEqual(commands, [9100, 1103]); assert.equal(attached, 0); assert.equal(snapshots, 0); assert.equal(diagnosticMedia, 0);
      await session.close(); return;
    }
    const clip = await manager.recordClip('synthetic-camera', 10, 75000, true);
    const decoded = spawnSync('ffmpeg', ['-v', 'error', '-xerror', '-i', 'pipe:0', '-f', 'null', '-'], { input: clip });
    assert.equal(decoded.status, 0, decoded.stderr.toString()); assert.ok(clip.length > 1000); assert.equal(session.codec, codec); assert.equal(snapshots, 0); assert.equal(extractors, 0); assert.equal(diagnosticMedia, 0); assert.equal(attached, 1); assert.deepEqual(commands, [9100, 1003, 1004]);
    controller.abort(); await session.close(); await session.close();
    assert.deepEqual(commands, [9100, 1003, 1004]); assert.equal(session.stats.stopUnconfirmed, 0);
    if (scenario === 'zero-segment-lifecycle') assert.equal(session.stats.segmentNotEchoed, 3);
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
