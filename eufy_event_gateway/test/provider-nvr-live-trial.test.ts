/**
 * Verifies provider admission and awaited NVR lease retirement using synthetic
 * inventory. Mocked transports never contact Eufy or report hardware support.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MegaClient } from '../src/mega/client.js';
import { MegaPushReceiver } from '../src/mega/push.js';
import { EufyProvider } from '../src/provider/eufy-provider.js';
import type { ProviderEvents } from '../src/provider/provider.js';
import { NvrRtcSession } from '../src/stream/nvr-rtc-session.js';
import { GatewayState } from '../src/domain/gateway-state.js';

for (const mode of ['valid', 'binding-change', 'valid-t9000', 'channel-zero', 'channel-last', 'equal-owner', 'close-failure', 'disabled', 'unauthenticated', 'wrong-camera', 'wrong-type', 'wrong-station', 'missing-channel', 'missing-owner', 'wrong-parent-type', 't9000-cross-type', 'suffix-parent', 'case-parent', 'child-owner-mismatch', 'channel-negative', 'channel-over', 'channel-fraction']) test(`NVR provider ${mode} admits only an explicit exact-model lease`, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'nvr-provider-'));
  context.mock.method(globalThis, 'fetch', async () => { assert.fail('Network forbidden'); });
  context.mock.method(MegaClient.prototype, 'connect', async () => ({ state: 'authenticated' }));
  context.mock.getter(MegaClient.prototype, 'isAuthenticated', () => mode !== 'unauthenticated');
  const valid = ['valid', 'binding-change', 'valid-t9000', 'channel-zero', 'channel-last', 'equal-owner', 'close-failure'].includes(mode);
  const parentModel = mode === 'wrong-station' ? 'T8030' : ['valid-t9000', 't9000-cross-type'].includes(mode) ? 'T9000' : mode === 'suffix-parent' ? 'T9000121' : mode === 'case-parent' ? 't9000' : 'T8N00';
  let parentType = ['valid-t9000', 'wrong-parent-type', 'suffix-parent', 'case-parent'].includes(mode) ? 27 : 300;
  const channels: Record<string, number | undefined> = { 'missing-channel': undefined, 'channel-zero': 0, 'channel-last': 254, 'channel-negative': -1, 'channel-over': 255, 'channel-fraction': 1.5 };
  const channel = Object.hasOwn(channels, mode) ? channels[mode] : 3;
  context.mock.method(MegaClient.prototype, 'inventory', async () => ({ devices: [
    { device_sn: 'synthetic-station', device_model: parentModel, device_type: parentType,
      category: 'eufy_security', member: mode === 'missing-owner' ? {} : { admin_user_id: 'synthetic-owner' } },
    { device_sn: 'synthetic-camera', device_model: mode === 'wrong-camera' ? 'T8416' : 'T8E00', device_type: mode === 'wrong-type' ? 105 : 301,
      category: 'eufy_security', parent_sn: 'synthetic-station', device_channel: channel, member: mode === 'child-owner-mismatch' ? { admin_user_id: 'synthetic-other-owner' } : mode === 'equal-owner' ? { admin_user_id: 'synthetic-owner' } : {} },
  ] }));
  context.mock.method(MegaPushReceiver.prototype, 'start', async () => {});
  const refreshes: (() => void)[] = [];
  context.mock.method(globalThis, 'setInterval', (callback: () => void) => { refreshes.push(callback); return { unref() {} } as unknown as NodeJS.Timeout; });
  let contexts = 0, starts = 0, closes = 0, finishClose!: () => void;
  const closing = new Promise<void>(resolve => { finishClose = resolve; });
  context.mock.method(MegaClient.prototype, 'nvrSignallingContext', async () => { contexts++; if (mode === 'binding-change') { parentType = 27; refreshes.at(-1)!(); await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve)); } return { host: 'security-smart-ie.eufylife.com', region: 'IE', authToken: 'synthetic', gtoken: 'synthetic', sign: 'synthetic' }; });
  context.mock.method(NvrRtcSession.prototype, 'start', async () => { starts++; });
  context.mock.method(NvrRtcSession.prototype, 'close', async () => { closes++; await closing; if (mode === 'close-failure') throw Error('Synthetic close failure'); });
  const state = new GatewayState();
  const events = new Proxy({ camera: (value: Parameters<ProviderEvents['camera']>[0]) => state.registerCamera(value) }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username: 'fixture', password: 'redacted', country: 'AU', persistentDirectory: directory, maxStreamSeconds: 120, experimentalNvrLive: mode !== 'disabled' });
  try {
    await provider.start(events);
    const controller = new AbortController();
    if (!valid) {
      assert.throws(() => provider.reserveNvrLiveTrial('synthetic-camera', controller.signal)); assert.equal(contexts, 0); assert.equal(starts, 0); return;
    }
    assert.equal(state.getCamera('synthetic-camera').streamSupported, false);
    assert.ok(Object.entries(state.getCamera('synthetic-camera')).filter(([key]) => key.endsWith('Supported')).every(([, value]) => value === false));
    await assert.rejects(provider.startStream('synthetic-camera')); assert.equal(contexts, 0);
    const release = provider.reserveNvrLiveTrial('synthetic-camera', controller.signal);
    assert.equal(contexts, 0);
    if (mode === 'binding-change') { await assert.rejects(provider.startStream('synthetic-camera')); assert.equal(starts, 0); assert.throws(() => provider.reserveNvrLiveTrial('synthetic-camera', new AbortController().signal)); return; }
    await provider.startStream('synthetic-camera'); assert.equal(contexts, 1); assert.equal(starts, 1);
    let released = false; const cleanup = release().then(() => { released = true; }); void cleanup.catch(() => {});
    await Promise.resolve(); assert.equal(released, false); assert.ok(closes >= 1);
    assert.throws(() => provider.reserveNvrLiveTrial('synthetic-camera', new AbortController().signal));
    finishClose(); if (mode === 'close-failure') await assert.rejects(cleanup); else await cleanup;
    const retry = provider.reserveNvrLiveTrial('synthetic-camera', new AbortController().signal); await retry();
  } finally { finishClose(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
