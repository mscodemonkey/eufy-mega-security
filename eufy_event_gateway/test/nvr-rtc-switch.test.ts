/**
 * Moves one NVR call between cameras against local synthetic signalling and real
 * WebRTC peers. Never contacts Eufy or claims physical NVR behaviour.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import type { PassThrough } from 'node:stream';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { RTCPeerConnection, RTCSessionDescription } from 'werift';
import { NvrRtcSession, type NvrSwitchTarget } from '../src/stream/nvr-rtc-session.js';
import { nvrApplication, nvrPackets } from '../src/stream/nvr-protocol.js';
import { NvrPtcsReassembler } from '../src/stream/nvr-ptcs-reassembly.js';

function application(command: number, segment: number, body: Buffer): Buffer {
  const frame = Buffer.alloc(16 + body.length);
  frame.write('XZYH'); frame.writeUInt16LE(command, 4); frame.writeUInt32LE(body.length, 6);
  frame[11] = segment; frame[12] = 255; frame[15] = 2; body.copy(frame, 16);
  return frame;
}

type Mode = 'video' | 'silent-second-camera' | 'wrong-second-camera';

async function fixture(mode: Mode) {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const peer = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false });
  peer.createDataChannel('synthetic-offer', { negotiated: true, id: 12 });
  await peer.setLocalDescription(await peer.createOffer());
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '1', '-frames:v', '1', '-f', 'h264', 'pipe:1']);
  assert.equal(generated.status, 0, generated.stderr.toString());
  const requests: { command: number; channel?: number; sensor?: number; at: number }[] = [], receiver = new NvrPtcsReassembler();
  let reply = 0, transport = 0, videoSequence = 0, starts = 0, sender: NodeJS.Timeout | undefined;
  peer.onDataChannel.subscribe(channel => {
    if (channel.label !== 'WebrtcDataChannel') return;
    channel.onmessage = event => {
      if (!Buffer.isBuffer(event.data) || event.data[4] !== 3) return;
      const assembled = receiver.push(event.data, Math.floor(performance.now()));
      if (assembled.status !== 'complete') return;
      const request = nvrApplication(assembled.frame), body = JSON.parse(request.payload.toString());
      const selected = body.payload.chn_list?.[0];
      requests.push({ command: body.cmd, channel: selected?.chn, sensor: selected?.sensor, at: performance.now() });
      const rows = [{ sn: 'synthetic-camera', ch: 3, dev_type: 301 }, { sn: mode === 'wrong-second-camera' ? 'synthetic-other' : 'synthetic-next', ch: 8, dev_type: 303 }];
      const response = body.cmd === 9100
        ? application(1351, request.segment, Buffer.from(JSON.stringify({ cmd: 9100, payload: { dev_list: rows } })))
        : application(1350, request.segment, Buffer.alloc(4));
      for (const packet of nvrPackets(response, reply++, 1)) channel.send(packet);
      if (body.cmd === 1004) clearInterval(sender);
      if (body.cmd !== 1003 || mode === 'silent-second-camera' && ++starts > 1) return;

      // Each camera's encoder and transport start again from zero.
      videoSequence = 0; transport = 0;
      sender = setInterval(() => {
        const media = Buffer.alloc(22 + generated.stdout.length); media.writeUInt32LE(generated.stdout.length, 0);
        media[4] = 1; media.writeUInt16LE(videoSequence, 6); media[8] = 10; media.writeUInt16LE(320, 10); media.writeUInt16LE(180, 12);
        media.writeBigUInt64LE(BigInt(videoSequence++) * 2000n, 14); generated.stdout.copy(media, 22);
        const frame = application(1300, 0, media); frame[12] = 101; frame[14] = 1;
        for (const packet of nvrPackets(frame, transport++, Date.now(), 2)) channel.send(packet);
      }, 50);
    };
  });
  server.on('connection', connection => {
    const send = (value: Record<string, unknown>): void => { connection.send(JSON.stringify({ data: JSON.stringify(value) })); };
    connection.on('message', async raw => {
      const message = JSON.parse(JSON.parse(raw.toString()).data);
      if (message.action === 1) send({ action: 1, code: 200 });
      else if (message.dataType === 'call') {
        send({ action: 3, sessionId: 'synthetic-sign', sn: 'synthetic-station', channelId: 0, dataType: 'call', data: JSON.stringify({ status: 200 }) });
        send({ action: 3, sessionId: 'synthetic-sign', sn: 'synthetic-station', channelId: 0, dataType: 'info', data: JSON.stringify({ format: 'SDP', value: peer.localDescription!.sdp }) });
      } else if (message.dataType === 'info') {
        const data = JSON.parse(message.data);
        if (data.sdp) await peer.setRemoteDescription(new RTCSessionDescription(data.sdp, 'answer'));
        else if (data.candidate) await peer.addIceCandidate({ candidate: data.candidate, sdpMid: '0', sdpMLineIndex: 0 });
      }
    });
  });
  const first = new AbortController(), second = new AbortController();
  let firstCurrent = true;
  const firstOutputs: PassThrough[] = [];
  const session = new NvrRtcSession({ station: 'synthetic-station', camera: 'synthetic-camera', channel: 3, cameraType: 301, sensor: 1,
    administrator: 'synthetic-administrator', context: { host: 'security-smart-ie.eufylife.com', region: 'IE', authToken: 'synthetic-token', gtoken: 'synthetic-gtoken', sign: 'synthetic-sign' },
    signal: first.signal, current: () => firstCurrent, maximumLifetimeMilliseconds: null, ready: output => { firstOutputs.push(output); output.resume(); } }, {
    socket: (_url, protocols, options) => new WebSocket(`ws://127.0.0.1:${port}`, protocols, options),
    peer: servers => new RTCPeerConnection({ iceServers: servers, iceUseIpv6: false }),
  });
  const started = async (): Promise<void> => {
    await session.start();
    while (!session.switchable) await new Promise(resolve => setTimeout(resolve, 20));
  };
  const target = (ready: NvrSwitchTarget['ready']): NvrSwitchTarget => ({ camera: 'synthetic-next', channel: 8, cameraType: 303, sensor: 0,
    signal: second.signal, current: () => true, ready });
  return { session, requests, firstOutputs, started, target, first, second, stale: () => { firstCurrent = false; },
    close: async () => { clearInterval(sender); await session.close(); await peer.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('a switch ends the old output, restarts framing and reports the new camera after its first picture', { timeout: 30000 }, async () => {
  const value = await fixture('video');
  try {
    await value.started();
    const old = value.firstOutputs[0]!;
    const ended = once(old, 'end');
    const reported: PassThrough[] = [];
    const moved = value.session.switchCamera(value.target(output => { reported.push(output); output.resume(); }));
    assert.notEqual(value.session.output, old);
    assert.equal(value.session.switchable, false);

    // Ownership moved at once, so retiring the first owner cannot touch this call.
    value.stale(); value.first.abort();
    await ended;
    const picture = await moved;
    assert.ok(picture >= 0);
    assert.deepEqual(reported, [value.session.output]);
    assert.deepEqual(value.requests.map(row => row.command), [9100, 1003, 1004, 9100, 1003]);
    const start = value.requests.at(-1)!, stop = value.requests.find(row => row.command === 1004)!;
    assert.deepEqual([start.channel, start.sensor], [8, 0]);
    assert.ok(start.at - stop.at >= 280);
    assert.equal(value.session.codec, 'h264');

    // The sequence numbers restarted, so none of this may read as a recovery or a replay.
    assert.equal(value.session.stats.applicationSequenceRecoveries, 0);
    assert.equal(value.session.stats.videoSequenceRecoveries, 0);
    assert.equal(value.session.stats.rejected, 0);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(value.session.switchable, true);
  } finally { await value.close(); }
});

test('a camera that sends no picture fails the switch without reporting a source', { timeout: 30000 }, async context => {
  const value = await fixture('silent-second-camera');
  const schedule = globalThis.setTimeout;
  context.mock.method(globalThis, 'setTimeout', ((callback: () => void, delay?: number) => schedule(callback, delay === 8_000 ? 50 : delay)) as typeof setTimeout);
  try {
    await value.started();
    await assert.rejects(value.session.switchCamera(value.target(() => assert.fail('No picture arrived'))), { stage: 'video', reason: 'switch_no_picture' });
  } finally { await value.close(); }
});

test('a channel that no longer holds the requested camera refuses the switch', { timeout: 30000 }, async () => {
  const value = await fixture('wrong-second-camera');
  try {
    await value.started();
    await assert.rejects(value.session.switchCamera(value.target(() => assert.fail('The camera did not match'))), { stage: 'identity_unmatched' });
    assert.equal(value.requests.filter(row => row.command === 1003).length, 1);
  } finally { await value.close(); }
});

test('a call that has not delivered video cannot switch', async () => {
  const session = new NvrRtcSession({ station: 'synthetic-station', camera: 'synthetic-camera', channel: 3, administrator: 'synthetic-administrator',
    context: { host: 'security-smart-ie.eufylife.com', region: 'IE', authToken: 'synthetic-token', gtoken: 'synthetic-gtoken', sign: 'synthetic-sign' },
    signal: new AbortController().signal, current: () => true, maximumLifetimeMilliseconds: null, ready: () => {} });
  assert.equal(session.switchable, false);
  await assert.rejects(session.switchCamera({ camera: 'next', channel: 8, signal: new AbortController().signal, current: () => true, ready: () => {} }), { stage: 'admission' });
  await session.close();
});
