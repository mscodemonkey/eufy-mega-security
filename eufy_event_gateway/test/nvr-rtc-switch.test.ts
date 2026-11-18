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
import { NvrRtcSession, type NvrRtcOptions, type NvrSwitchTarget } from '../src/stream/nvr-rtc-session.js';
import { NvrTrialError, nvrApplication, nvrPackets } from '../src/stream/nvr-protocol.js';
import { NvrPtcsReassembler } from '../src/stream/nvr-ptcs-reassembly.js';

function application(command: number, segment: number, body: Buffer): Buffer {
  const frame = Buffer.alloc(16 + body.length);
  frame.write('XZYH'); frame.writeUInt16LE(command, 4); frame.writeUInt32LE(body.length, 6);
  frame[11] = segment; frame[12] = 255; frame[15] = 2; body.copy(frame, 16);
  return frame;
}

type Mode = 'video' | 'silent-second-camera' | 'wrong-second-camera';

async function fixture(mode: Mode, observer = false) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const peer = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false });
  peer.createDataChannel('synthetic-offer', { negotiated: true, id: 12 });
  await peer.setLocalDescription(await peer.createOffer());
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '1', '-frames:v', '1', '-f', 'h264', 'pipe:1']);
  assert.equal(generated.status, 0, generated.stderr.toString());
  const requests: { command: number; channel?: number; sensor?: number; at: number; start?: Record<string, unknown> }[] = [], receiver = new NvrPtcsReassembler();
  let reply = 0, transport = 0, videoSequence = 0, starts = 0, sender: NodeJS.Timeout | undefined;
  peer.onDataChannel.subscribe(channel => {
    if (channel.label !== 'WebrtcDataChannel') return;
    channel.onmessage = event => {
      if (!Buffer.isBuffer(event.data) || event.data[4] !== 3) return;
      const assembled = receiver.push(event.data, Math.floor(performance.now()));
      if (assembled.status !== 'complete') return;
      const request = nvrApplication(assembled.frame), body = JSON.parse(request.payload.toString());
      const selected = body.payload.chn_list?.[0];
      requests.push({ command: body.cmd, channel: selected?.chn, sensor: selected?.sensor, at: performance.now(), ...body.cmd === 1003 ? { start: body.payload } : {} });
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
  let signalling: WebSocket | undefined;
  server.on('connection', connection => {
    signalling = connection;
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
  const firstOutputs: PassThrough[] = [], observed: unknown[] = [];
  const session = new NvrRtcSession({ station: 'synthetic-station', camera: 'synthetic-camera', channel: 3, cameraType: 301, ...observer ? {} : { sensor: 1 },
    administrator: 'synthetic-administrator', context: { host: 'security-smart-ie.eufylife.com', region: 'IE', authToken: 'synthetic-token', gtoken: 'synthetic-gtoken', sign: 'synthetic-sign' },
    signal: first.signal, current: () => firstCurrent, maximumLifetimeMilliseconds: null, ready: output => { firstOutputs.push(output); output.resume(); },
    ...observer ? { modeObserver: true, onEffectiveMode: (value: unknown) => { observed.push(value); } } : {} }, {
    socket: (_url, protocols, options) => new WebSocket(`ws://127.0.0.1:${port}`, protocols, options),
    peer: servers => new RTCPeerConnection({ iceServers: servers, iceUseIpv6: false }),
  });
  const started = async (): Promise<void> => {
    await session.start();
    while (!session.switchable) await new Promise(resolve => setTimeout(resolve, 20));
  };
  const target = (ready: NvrSwitchTarget['ready']): NvrSwitchTarget => ({ camera: 'synthetic-next', channel: 8, cameraType: 303, sensor: 0,
    signal: second.signal, current: () => true, ready });
  const listening = async (): Promise<void> => {
    await session.observeEffectiveMode();
    while (!session.canTakeOver('synthetic-station')) await new Promise(resolve => setTimeout(resolve, 20));
  };
  return { session, requests, firstOutputs, observed, started, listening, target, first, second, stale: () => { firstCurrent = false; },
    dropSignalling: () => signalling?.close(),
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
    assert.deepEqual(value.requests.map(row => row.command), [9100, 1003, 1004, 1003]);
    const start = value.requests.at(-1)!, stop = value.requests.find(row => row.command === 1004)!;
    assert.deepEqual([start.channel, start.sensor], [8, 0]);
    assert.ok(start.at > stop.at);
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

test('an idle mode observer call becomes a view without a stop or a new call', { timeout: 30000 }, async () => {
  const value = await fixture('video', true);
  try {
    await value.listening();
    assert.equal(value.session.canTakeOver('synthetic-other-station'), false);
    assert.equal(value.session.switchable, false);
    const reported: PassThrough[] = [];
    const moved = value.session.switchCamera(value.target(output => { reported.push(output); output.resume(); }));

    // Ownership moved at once, so retiring the observer cannot touch this call.
    assert.equal(value.session.canTakeOver('synthetic-station'), false);
    value.stale(); value.first.abort();
    assert.ok(await moved >= 0);
    assert.deepEqual(reported, [value.session.output]);
    assert.deepEqual(value.requests.map(row => row.command), [9100, 1003]);
    assert.deepEqual([value.requests.at(-1)!.channel, value.requests.at(-1)!.sensor], [8, 0]);
    assert.equal(value.session.codec, 'h264');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(value.session.switchable, true);

    // The view's options replace the observer's, including its mode callback.
    const options = Reflect.get(value.session, 'options') as NvrRtcOptions;
    assert.equal(options.modeObserver, false); assert.equal(options.onEffectiveMode, undefined);
    await value.session.close();
    assert.deepEqual(value.observed, []);
  } finally { await value.close(); }
});

test('a mode observer call that is not connected cannot be taken over', async () => {
  const session = new NvrRtcSession({ station: 'synthetic-station', camera: 'synthetic-camera', channel: 3, administrator: 'synthetic-administrator',
    context: { host: 'security-smart-ie.eufylife.com', region: 'IE', authToken: 'synthetic-token', gtoken: 'synthetic-gtoken', sign: 'synthetic-sign' },
    signal: new AbortController().signal, current: () => true, maximumLifetimeMilliseconds: null, modeObserver: true, onEffectiveMode: () => {}, ready: () => {} });
  assert.equal(session.canTakeOver('synthetic-station'), false);
  await assert.rejects(session.switchCamera({ camera: 'next', channel: 8, signal: new AbortController().signal, current: () => true, ready: () => {} }), { stage: 'admission' });
  await session.close();
});

test('an observer call whose signalling socket has gone is not taken over, because it could not hang up', { timeout: 30000 }, async () => {
  const value = await fixture('video', true);
  try {
    await value.listening();
    value.dropSignalling();
    for (let waited = 0; value.session.canTakeOver('synthetic-station') && waited < 2000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(value.session.canTakeOver('synthetic-station'), false);

    // The observer keeps listening on its channel, as before.
    assert.equal(value.session.output.destroyed, false);
    await assert.rejects(value.session.switchCamera(value.target(() => assert.fail('No takeover'))), { stage: 'admission' });
    assert.deepEqual(value.requests.map(row => row.command), [9100]);
  } finally { await value.close(); }
});

test('a parked call stops its camera, stays connected with no camera, and a view switches to it without another stop', { timeout: 30000 }, async () => {
  const value = await fixture('video');
  try {
    await value.started();
    const old = value.firstOutputs[0]!;
    const ended = once(old, 'end');
    const pool = new AbortController();
    await value.session.park({ signal: pool.signal, current: () => !pool.signal.aborted });
    await ended;
    assert.deepEqual(value.requests.map(row => row.command), [9100, 1003, 1004]);
    assert.equal(value.session.idle, true);
    assert.equal(value.session.switchable, false);

    // Ownership moved at once, so retiring the viewer cannot touch the parked call.
    value.stale(); value.first.abort();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(value.session.idle, true);
    assert.equal(value.session.output.readableLength, 0, 'no picture is kept while parked');
    const reported: PassThrough[] = [];
    const moved = value.session.switchCamera(value.target(output => { reported.push(output); output.resume(); }));
    assert.equal(value.session.idle, false);
    assert.ok(await moved >= 0);
    assert.deepEqual(reported, [value.session.output]);
    assert.deepEqual(value.requests.map(row => row.command), [9100, 1003, 1004, 1003]);
    assert.deepEqual([value.requests.at(-1)!.channel, value.requests.at(-1)!.sensor], [8, 0]);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(value.session.switchable, true);
  } finally { await value.close(); }
});

test('only a call delivering video can park, and a parked call ends with its pool', { timeout: 30000 }, async () => {
  const idle = new NvrRtcSession({ station: 'synthetic-station', camera: 'synthetic-camera', channel: 3, administrator: 'synthetic-administrator',
    context: { host: 'security-smart-ie.eufylife.com', region: 'IE', authToken: 'synthetic-token', gtoken: 'synthetic-gtoken', sign: 'synthetic-sign' },
    signal: new AbortController().signal, current: () => true, maximumLifetimeMilliseconds: null, ready: () => {} });
  await assert.rejects(idle.park({ signal: new AbortController().signal, current: () => true }), { stage: 'admission' });
  await idle.close();
  const value = await fixture('video');
  try {
    await value.started();
    const pool = new AbortController();
    await value.session.park({ signal: pool.signal, current: () => !pool.signal.aborted });
    const failed = once(value.session.output, 'error');
    pool.abort();
    await failed;
    assert.equal(value.session.idle, false);
  } finally { await value.close(); }
});

const stitchedTarget = (ready: NvrSwitchTarget['ready'], signal: AbortSignal, gone = false): NvrSwitchTarget => ({
  camera: 'synthetic-camera', channel: 3, cameraType: 301, signal, current: () => true, ready,
  sensor: { mode: 3, width: 3840, height: 2160, cells: [{ channel: 3, sensor: 0 }, { channel: gone ? 5 : 8, sensor: 0 }] },
  cells: [{ camera: 'synthetic-camera', channel: 3, cameraType: 301 }, gone ? { camera: 'synthetic-gone', channel: 5, cameraType: 104 } : { camera: 'synthetic-next', channel: 8, cameraType: 303 }],
});

test('a parked call switches to a stitched start, and from it back to one camera with no cells left over', { timeout: 30000 }, async () => {
  const value = await fixture('video');
  try {
    await value.started();
    const pool = new AbortController();
    await value.session.park({ signal: pool.signal, current: () => !pool.signal.aborted });
    value.stale(); value.first.abort();
    const reported: PassThrough[] = [];
    assert.ok(await value.session.switchCamera(stitchedTarget(output => { reported.push(output); output.resume(); }, value.second.signal)) >= 0);
    const stitched = value.requests.at(-1)!.start!;
    assert.equal(stitched.stitch_mode, 3);
    assert.deepEqual(stitched.chn_list, [{ index: 0, chn: 3, sensor: 0 }, { index: 1, chn: 8, sensor: 0 }]);
    assert.deepEqual(stitched.stitch_resolution, { width: 3840, height: 2160 });
    assert.equal(stitched.audio_chn, -1, 'a stitched call carries video only');
    assert.ok(value.requests.every(row => [9100, 1003, 1004].includes(row.command)),
      'only the camera list, starts and stops: no settings query or write reaches the NVR');
    assert.deepEqual(reported, [value.session.output]);
    while (!value.session.switchable) await new Promise(resolve => setTimeout(resolve, 20));
    await value.session.switchCamera(value.target(output => { output.resume(); }));
    const single = value.requests.at(-1)!.start!;
    assert.deepEqual([single.stitch_mode, single.chn_list], [1, [{ index: 0, chn: 8, sensor: 0 }]]);
    assert.equal((value.session as unknown as { options: { cells?: unknown } }).options.cells, undefined, 'the stitch\'s cells did not follow the call');
  } finally { await value.close(); }
});

test('a stitched cell whose camera is not in the call\'s camera list refuses the switch before any start', { timeout: 30000 }, async () => {
  const value = await fixture('video');
  try {
    await value.started();
    const pool = new AbortController();
    await value.session.park({ signal: pool.signal, current: () => !pool.signal.aborted });
    await assert.rejects(value.session.switchCamera(stitchedTarget(() => {}, value.second.signal, true)),
      (error: unknown) => error instanceof NvrTrialError && error.stage === 'identity_unmatched');
    assert.deepEqual(value.requests.map(row => row.command), [9100, 1003, 1004], 'no start was sent');
  } finally { await value.close(); }
});

test('a stitched call must name every cell\'s camera and ask for video only', () => {
  const base = { station: 'synthetic-station', camera: 'synthetic-camera', channel: 3, cameraType: 301, administrator: 'synthetic-administrator',
    context: { host: 'security-smart-ie.eufylife.com', region: 'IE' as const, authToken: 'synthetic-token', gtoken: 'synthetic-gtoken', sign: 'synthetic-sign' },
    signal: new AbortController().signal, current: () => true, ready: () => {}, maximumLifetimeMilliseconds: null } satisfies Partial<NvrRtcOptions>;
  const stitched = stitchedTarget(() => {}, base.signal), sensor = stitched.sensor!, cells = stitched.cells!;
  const admission = (error: unknown): boolean => error instanceof NvrTrialError && error.stage === 'admission';
  for (const wrong of [{ sensor }, { sensor, cells: cells.slice(0, 1) }, { sensor: 0 as const, cells }, { sensor, cells, audio: true },
    { sensor, cells, liveControls: true }, { sensor, cells: [...cells].reverse() }, { sensor, cells, camera: 'synthetic-next' }]) {
    assert.throws(() => new NvrRtcSession({ ...base, ...wrong } as NvrRtcOptions), admission, JSON.stringify(Object.keys(wrong)));
  }
  assert.doesNotThrow(() => new NvrRtcSession({ ...base, sensor, cells }));
});
