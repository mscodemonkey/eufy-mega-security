/**
 * Checks NVR live audio against local synthetic signalling and real WebRTC peers:
 * the start request asks for audio only when admitted, checked AAC reaches a
 * per-camera stream after the first picture, and a camera switch ends it with
 * the video. Never contacts Eufy or claims physical NVR behaviour.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import type { PassThrough } from 'node:stream';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { RTCPeerConnection, RTCSessionDescription } from 'werift';
import { NvrRtcSession, type NvrSwitchTarget } from '../src/stream/nvr-rtc-session.js';
import { nvrApplication, nvrAudio, nvrCommand, nvrPackets } from '../src/stream/nvr-protocol.js';
import { NvrPtcsReassembler } from '../src/stream/nvr-ptcs-reassembly.js';
import { sourceTime } from '../src/stream/media-source-clock.js';
import { parseAdtsAccessUnits } from '../src/stream/ppcs-audio.js';

function application(command: number, segment: number, body: Buffer, channel = 255): Buffer {
  const frame = Buffer.alloc(16 + body.length);
  frame.write('XZYH'); frame.writeUInt16LE(command, 4); frame.writeUInt32LE(body.length, 6);
  frame[11] = segment; frame[12] = channel; frame[15] = 2; body.copy(frame, 16);
  return frame;
}

/** A 1301 frame as the NVR sends it: length, 101, codec 0, sequence and a millisecond capture time, then one ADTS frame. */
function audioFrame(adts: Buffer, sequence: number): Buffer {
  const media = Buffer.alloc(16 + adts.length);
  media.writeUInt32LE(adts.length, 0); media[4] = 101; media.writeUInt16LE(sequence, 6);
  media.writeBigUInt64LE(1_790_000_000_000n + BigInt(sequence) * 64n, 8);
  adts.copy(media, 16);

  // The application header as an NVR S4 sends audio: byte 10 is 2, channel 101, stream 1, byte 15 zero.
  const frame = application(1301, 0, media, 101); frame[10] = 2; frame[14] = 1; frame[15] = 0;
  return frame;
}

const aac = (() => {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '1', '-ac', '1', '-c:a', 'aac', '-f', 'adts', 'pipe:1']);
  assert.equal(result.status, 0, result.stderr.toString());
  const size = ((result.stdout[3]! & 3) << 11) | (result.stdout[4]! << 3) | (result.stdout[5]! >> 5);
  return result.stdout.subarray(0, size);
})();

async function fixture(audio: boolean) {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const peer = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false });
  peer.createDataChannel('synthetic-offer', { negotiated: true, id: 12 });
  await peer.setLocalDescription(await peer.createOffer());
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '1', '-frames:v', '1', '-f', 'h264', 'pipe:1']);
  assert.equal(generated.status, 0, generated.stderr.toString());
  const starts: { channel: number; audio: number }[] = [], receiver = new NvrPtcsReassembler();
  let reply = 0, transport = 0, sequence = 0, sender: NodeJS.Timeout | undefined;
  let audioChannel: { send: (data: Buffer) => void } | undefined;
  peer.onDataChannel.subscribe(channel => {
    if (channel.label === 'audio') audioChannel = channel;
    if (channel.label !== 'WebrtcDataChannel') return;
    channel.onmessage = event => {
      if (!Buffer.isBuffer(event.data) || event.data[4] !== 3) return;
      const assembled = receiver.push(event.data, Math.floor(performance.now()));
      if (assembled.status !== 'complete') return;
      const request = nvrApplication(assembled.frame), body = JSON.parse(request.payload.toString());
      const rows = [{ sn: 'synthetic-camera', ch: 3, dev_type: 301 }, { sn: 'synthetic-next', ch: 8, dev_type: 303 }];
      const response = body.cmd === 9100
        ? application(1351, request.segment, Buffer.from(JSON.stringify({ cmd: 9100, payload: { dev_list: rows } })))
        : application(1350, request.segment, Buffer.alloc(4));
      for (const packet of nvrPackets(response, reply++, 1)) channel.send(packet);
      if (body.cmd === 1004) clearInterval(sender);
      if (body.cmd !== 1003) return;
      starts.push({ channel: body.payload.chn_list[0].chn, audio: body.payload.audio_chn });
      sequence = 0; transport = 0;
      const send = (frame: Buffer): void => { for (const packet of nvrPackets(frame, transport++, Date.now(), 2)) channel.send(packet); };

      // As an NVR S4 sends it: on the audio data channel, sharing video's transport channel and counter,
      // with the compressed bit set over a plain application frame.
      const sendAudio = (frame: Buffer): void => {
        for (const packet of nvrPackets(frame, transport++, Date.now(), 2)) {
          packet.writeUInt16LE(packet.readUInt16LE(18) | 0x0800, 18);
          (audioChannel ?? channel).send(packet);
        }
      };

      // Audio before the first picture, then a picture with each tick, good audio, and one damaged audio frame.
      sendAudio(audioFrame(aac, 0));
      sender = setInterval(() => {
        const media = Buffer.alloc(22 + generated.stdout.length); media.writeUInt32LE(generated.stdout.length, 0);
        media[4] = 1; media.writeUInt16LE(sequence, 6); media[8] = 10; media.writeUInt16LE(320, 10); media.writeUInt16LE(180, 12);
        media.writeBigUInt64LE(BigInt(sequence++) * 2000n, 14); generated.stdout.copy(media, 22);
        const frame = application(1300, 0, media, 101); frame[14] = 1;
        send(frame);
        sendAudio(audioFrame(sequence === 3 ? aac.subarray(0, aac.length - 1) : aac, sequence));
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
  const audioOutputs: (PassThrough | undefined)[] = [];
  const audioBytes: Buffer[] = [];
  const session = new NvrRtcSession({ station: 'synthetic-station', camera: 'synthetic-camera', channel: 3, cameraType: 301, sensor: 1, audio,
    administrator: 'synthetic-administrator', context: { host: 'security-smart-ie.eufylife.com', region: 'IE', authToken: 'synthetic-token', gtoken: 'synthetic-gtoken', sign: 'synthetic-sign' },
    signal: new AbortController().signal, current: () => true, maximumLifetimeMilliseconds: null,
    ready: (output, _codec, sound) => { output.resume(); audioOutputs.push(sound); sound?.on('data', (chunk: Buffer) => audioBytes.push(chunk)); } }, {
    socket: (_url, protocols, options) => new WebSocket(`ws://127.0.0.1:${port}`, protocols, options),
    peer: servers => new RTCPeerConnection({ iceServers: servers, iceUseIpv6: false }),
  });
  const started = async (): Promise<void> => {
    await session.start();
    for (let attempt = 0; attempt < 500 && (!session.switchable || session.stats.audio < 3); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(session.stats.audio >= 3, JSON.stringify(session.stats));
  };
  return { session, starts, audioOutputs, audioBytes, started,
    close: async () => { clearInterval(sender); await session.close(); await peer.close(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('an admitted camera asks for its audio and gets checked AAC after its first picture, also after a switch', { timeout: 30000 }, async () => {
  const value = await fixture(true);
  try {
    await value.started();
    assert.deepEqual(value.starts, [{ channel: 3, audio: 3 }]);
    const first = value.audioOutputs[0]!;
    assert.ok(first);
    assert.ok(value.audioBytes.every(chunk => chunk.equals(aac)));
    assert.ok(value.audioBytes.every(chunk => (sourceTime(chunk) ?? 0) >= 1_790_000_000_000));
    assert.ok(value.session.stats.ignoredAudio >= 1);
    assert.equal(value.session.stats.rejectedAudio, 1);

    const ended = once(first, 'end');
    const target: NvrSwitchTarget = { camera: 'synthetic-next', channel: 8, cameraType: 303, sensor: 0, audio: true,
      signal: new AbortController().signal, current: () => true,
      ready: (output, _codec, sound) => { output.resume(); value.audioOutputs.push(sound); sound?.resume(); } };
    await value.session.switchCamera(target);
    await ended;
    assert.deepEqual(value.starts.at(-1), { channel: 8, audio: 8 });
    const next = value.audioOutputs.at(-1)!;
    assert.ok(next && next !== first);
    const delivered = value.session.stats.audio;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(value.session.stats.audio > delivered);
  } finally { await value.close(); }
});

test('a camera without admitted audio asks for none and ignores audio frames', { timeout: 30000 }, async () => {
  const value = await fixture(false);
  try {
    await value.session.start();
    for (let attempt = 0; attempt < 500 && value.session.stats.ignoredAudio < 3; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(value.starts, [{ channel: 3, audio: -1 }]);
    assert.deepEqual(value.audioOutputs, [undefined]);
    assert.equal(value.session.stats.audio, 0);
  } finally { await value.close(); }
});

test('the audio check refuses everything but complete ADTS for this camera', () => {
  const frame = (body: Buffer, channel = 101) => nvrApplication(application(1301, 0, body, channel));
  const good = audioFrame(aac, 1).subarray(16);
  assert.ok(nvrAudio(frame(good), 3)?.bytes.equals(aac));
  assert.equal(nvrAudio(frame(good), 3)?.timestamp, 1_790_000_000_064);
  assert.ok(parseAdtsAccessUnits(nvrAudio(frame(good, 3), 3)!.bytes));
  assert.equal(nvrAudio(frame(good, 7), 3), null);
  const short = Buffer.from(good); short.writeUInt32LE(aac.length + 1, 0);
  assert.equal(nvrAudio(frame(short), 3), null);
  const damaged = Buffer.from(good); damaged[16] = 0;
  assert.equal(nvrAudio(frame(damaged), 3), null);
  const otherCodec = Buffer.from(good); otherCodec[5] = 1;
  assert.equal(nvrAudio(frame(otherCodec), 3), null);
  assert.equal(nvrAudio({ ...frame(good), command: 1300 }, 3), null);
  const video = application(1300, 0, Buffer.alloc(30)); video[10] = 2;
  assert.throws(() => nvrApplication(video), { stage: 'framing' });
  assert.throws(() => nvrCommand('synthetic', 1003, 1, 3, 1, 255));
  assert.throws(() => nvrCommand('synthetic', 1003, 1, 3, 1, -2));
  assert.equal(JSON.parse(nvrCommand('synthetic', 1003, 1, 3, 1).subarray(16).toString()).payload.audio_chn, -1);
});
