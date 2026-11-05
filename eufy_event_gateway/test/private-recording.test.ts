/**
 * Verifies private trial recordings cannot leak into shared consumers or capture.
 * Synthetic controllers own sources, and tests retire each manager on completion.
 */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { GatewayState } from '../src/domain/gateway-state.js';
import { LiveStreamManager } from '../src/stream/live-stream-manager.js';

for (const failure of ['start', 'timeout', 'ended', 'remux', 'state']) test(`private recording ${failure} releases ownership and allows retry`, async context => {
  const state = new GatewayState();
  state.registerCamera({ serial: 'synthetic', name: 'Synthetic', model: 'T8E00', stationSerial: 'synthetic-station', streamSupported: false, doorbellSupported: false });
  let source = new PassThrough(), starts = 0, stops = 0, media = 0, recovering = false;
  let manager: LiveStreamManager;
  manager = new LiveStreamManager(state, {} as never, {
    async startStream() {
      starts++;
      if (failure === 'start' && !recovering) throw Error('Synthetic start failed');
      source = new PassThrough(); manager.attachSource('synthetic', source);
      if (failure !== 'timeout' || recovering) source.write(Buffer.from('synthetic-video'));
      if (failure === 'ended' && !recovering) source.end();
    }, async stopStream() { stops++; source.end(); },
  }, 1, async () => { if (failure === 'remux' && !recovering) throw Error('Synthetic remux failed'); return Buffer.from('mp4'); });
  manager.on('diagnostic-media', () => media++); manager.on('warning', () => {});
  try {
    if (failure === 'state') {
      const original = state.updateStream.bind(state); let fail = true;
      context.mock.method(state, 'updateStream', (...args: Parameters<typeof original>) => { if (fail) { fail = false; throw Error('Synthetic state failed'); } return original(...args); });
    }
    await assert.rejects(manager.recordClip('synthetic', 1, 10, true));
    assert.equal(manager.hasActiveSession('synthetic'), false); assert.equal(media, 0);
    recovering = true;
    assert.equal((await manager.recordClip('synthetic', 1, 100, true)).toString(), 'mp4');
    assert.equal(manager.hasActiveSession('synthetic'), false); assert.equal(media, 0);
    assert.ok(starts >= 1); assert.ok(stops >= 1);
  } finally { await manager.close(); }
});

test('private recording rejects every normal consumer and duplicate before touching its source', async () => {
  const state = new GatewayState();
  state.registerCamera({ serial: 'synthetic', name: 'Synthetic', model: 'T8E00', stationSerial: 'synthetic-station', streamSupported: false, doorbellSupported: false });
  let unblock!: () => void, starts = 0;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const manager = new LiveStreamManager(state, {} as never, { async startStream() { starts++; await gate; throw Error('Synthetic cancellation'); }, async stopStream() {} }, 1);
  try {
    const pending = manager.recordClip('synthetic', 1, 1000, true); void pending.catch(() => {});
    for (const operation of [() => manager.recordClip('synthetic', 1, 1000, true), () => manager.recordClip('synthetic', 1),
      () => manager.captureSnapshot('synthetic'), () => manager.captureStartupSnapshot('synthetic'),
      () => manager.withLiveSource('synthetic', async () => {}), () => manager.addClient('synthetic', {} as never),
      () => manager.addTransportClient('synthetic', {} as never)]) await assert.rejects(operation(), /private video test/);
    assert.equal(starts, 1); unblock(); await assert.rejects(pending);
    assert.equal(manager.hasActiveSession('synthetic'), false);
  } finally { unblock(); await manager.close(); }
});

for (const lateFailure of [false, true]) test(`aborted private startup retains suppression through late settle failure=${lateFailure}`, async () => {
  const state = new GatewayState(); state.registerCamera({ serial: 'synthetic', name: 'Synthetic', model: 'T8E00', stationSerial: 'synthetic-station', streamSupported: false, doorbellSupported: false });
  let finish!: () => void, source = new PassThrough(), starts = 0, media = 0, extractors = 0;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let manager: LiveStreamManager;
  manager = new LiveStreamManager(state, {} as never, { async startStream() {
    starts++; if (starts === 1) { await gate; if (lateFailure) throw Error('Synthetic late failure'); }
    source = new PassThrough(); manager.attachSource('synthetic', source); source.write(Buffer.from('synthetic-video'));
  }, async stopStream() { source.end(); } }, 1, async () => Buffer.from('mp4'), undefined, (() => { extractors++; throw Error('Unexpected extractor'); }) as never);
  manager.on('diagnostic-media', () => media++);
  const controller = new AbortController();
  try {
    const pending = manager.recordClip('synthetic', 1, 10000, true, controller.signal); void pending.catch(() => {});
    controller.abort('private hostile reason'); await assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR' });
    await assert.rejects(manager.recordClip('synthetic', 1, 1000, true), /private video test/);
    finish(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(media, 0); assert.equal(extractors, 0); assert.equal(manager.hasActiveSession('synthetic'), false);
    assert.equal((await manager.recordClip('synthetic', 1, 1000, true)).toString(), 'mp4');
  } finally { finish(); await manager.close(); }
});

test('pre-aborted private recording never starts and collection cancellation removes its listener', async () => {
  const state = new GatewayState(); state.registerCamera({ serial: 'synthetic', name: 'Synthetic', model: 'T8E00', stationSerial: 'synthetic-station', streamSupported: false, doorbellSupported: false });
  let starts = 0, manager: LiveStreamManager;
  manager = new LiveStreamManager(state, {} as never, { async startStream() { starts++; manager.attachSource('synthetic', new PassThrough()); }, async stopStream() {} }, 1);
  const controller = new AbortController(); controller.abort('private hostile reason');
  try {
    await assert.rejects(manager.recordClip('synthetic', 1, 1000, true, controller.signal), { name: 'AbortError', code: 'ABORT_ERR' }); assert.equal(starts, 0);
    const collecting = new AbortController(), pending = manager.recordClip('synthetic', 1, 10000, true, collecting.signal);
    void pending.catch(() => {}); await Promise.resolve(); collecting.abort('private hostile reason');
    await assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR' }); assert.equal(manager.hasActiveSession('synthetic'), false);
  } finally { await manager.close(); }
});

for (const [frameCount, interval, expectedRate] of [[2, 100, undefined], [10, 100, 10], [10, 1, undefined]] as const) test(`private recording trusts sustained cadence only: ${frameCount} frames at ${interval} ms`, async context => {
  const state = new GatewayState();
  state.registerCamera({ serial: 'synthetic', name: 'Synthetic', model: 'T8E00', stationSerial: 'synthetic-station', streamSupported: false, doorbellSupported: false });
  let source = new PassThrough(), now = 0, receivedFrameRate: number | undefined;
  let manager: LiveStreamManager;
  manager = new LiveStreamManager(state, {} as never, {
    async startStream() {
      source = new PassThrough(); manager.attachSource('synthetic', source);
      for (let frame = 0; frame < frameCount; frame++) {
        now = frame * interval;
        source.write(Buffer.from(`frame-${frame}`));
      }
    },
    async stopStream() { source.end(); },
  }, 1, async (_video, _codec, _audio, _signal, frameRate) => {
    receivedFrameRate = frameRate;
    return Buffer.from('mp4');
  }, undefined, undefined, 30_000, () => now);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = manager.recordClip('synthetic', 1, 1000, true);
    await Promise.resolve();
    context.mock.timers.tick(1000);
    assert.equal((await pending).toString(), 'mp4');
    assert.equal(receivedFrameRate, expectedRate);
  } finally { await manager.close(); }
});
