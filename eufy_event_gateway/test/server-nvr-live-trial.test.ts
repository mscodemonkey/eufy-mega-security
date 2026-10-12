/**
 * Checks the private NVR endpoint with synthetic media and provider leases.
 * Each test owns the server and temporary store and uses no cloud credentials.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { GatewayState } from '../src/domain/gateway-state.js';
import type { CameraProvider } from '../src/provider/provider.js';
import { GatewayServer } from '../src/server.js';
import { SnapshotStore } from '../src/storage/snapshot-store.js';
import type { LiveStreamManager } from '../src/stream/live-stream-manager.js';
import { diagnosticsPage } from '../src/diagnostics/page.js';

for (const enabled of [false, true]) test(`NVR endpoint opt-in=${enabled} requires authentication and exact consent`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nvr-http-'));
  const state = new GatewayState();
  state.registerCamera({ serial: 'synthetic', name: 'Synthetic', model: 'T8E00', stationSerial: 'synthetic-station', streamSupported: false, doorbellSupported: false });
  let acquired = 0, released = 0, busy = false;
  const provider = { reserveNvrLiveTrial: () => { acquired++; return async () => { released++; }; } } as unknown as CameraProvider;
  const streams = { hasActiveSession: () => busy, recordClip: async (_camera: string, seconds: number, timeout: number) => {
    assert.equal(seconds, 10); assert.equal(timeout, 75000); return Buffer.from('synthetic-mp4');
  } } as unknown as LiveStreamManager;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: 'synthetic-secret', experimentalNvrLive: enabled }, state, new SnapshotStore(directory), streams, provider, null);
  try {
    await server.listen(); const url = `http://127.0.0.1:${server.port}/api/cameras/synthetic/nvr-live-trial`;
    const options = { method: 'POST', headers: { authorization: 'Bearer synthetic-secret', 'content-type': 'application/json' }, body: JSON.stringify({ consentPrivateMedia: true }) };
    assert.equal((await fetch(url, { ...options, headers: {} })).status, 401);
    if (!enabled) { assert.equal((await fetch(url, options)).status, 409); assert.equal(acquired, 0); return; }
    for (const body of [{}, { consentPrivateMedia: false }, { consentPrivateMedia: true, seconds: 120 }]) assert.equal((await fetch(url, { ...options, body: JSON.stringify(body) })).status, 400);
    assert.equal((await fetch(url, { ...options, headers: { authorization: 'Bearer synthetic-secret', 'content-type': 'text/plain' } })).status, 400);
    assert.equal(acquired, 0); busy = true; assert.equal((await fetch(url, options)).status, 409); busy = false;
    const response = await fetch(url, options); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(await response.text(), 'synthetic-mp4'); assert.equal(acquired, 1); assert.equal(released, 1);
    assert.equal(state.getCamera('synthetic').streamSupported, false);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('NVR Diagnostics has explicit private consent, cancellation and page-exit cleanup', () => {
  const page = diagnosticsPage();
  for (const text of ['nvr-live-trial', 'consentPrivateMedia', 'pagehide', 'revokeObjectURL', 'nvr-stop']) assert.ok(page.includes(text), text);
  new Function(page.split('<script>')[1]!.split('</script>')[0]!);
});

test('NVR disconnect cancels the connection and retains busy ownership through asynchronous close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nvr-disconnect-'));
  const state = new GatewayState(); state.registerCamera({ serial: 'synthetic', name: 'Synthetic', model: 'T8E00', stationSerial: 'synthetic-station', streamSupported: false, doorbellSupported: false });
  let entered!: () => void, disconnected!: () => void, finishClose!: () => void;
  const connected = new Promise<void>(resolve => { entered = resolve; }), cancelled = new Promise<void>(resolve => { disconnected = resolve; });
  const closing = new Promise<void>(resolve => { finishClose = resolve; });
  let signal: AbortSignal;
  const provider = { reserveNvrLiveTrial: (_camera: string, ownedSignal: AbortSignal) => { signal = ownedSignal; return async () => closing; } } as unknown as CameraProvider;
  const streams = { hasActiveSession: () => false, recordClip: async () => {
    entered(); await new Promise<void>(resolve => signal.addEventListener('abort', () => { disconnected(); resolve(); }, { once: true })); throw Error('Synthetic vendor detail');
  } } as unknown as LiveStreamManager;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: 'fixture', experimentalNvrLive: true }, state, new SnapshotStore(directory), streams, provider, null);
  const client = new AbortController();
  try {
    await server.listen(); const url = `http://127.0.0.1:${server.port}/api/cameras/synthetic/nvr-live-trial`;
    const options = { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: JSON.stringify({ consentPrivateMedia: true }) };
    const request = fetch(url, { ...options, signal: client.signal }); void request.catch(() => {});
    await connected; client.abort(); await assert.rejects(request); await cancelled;
    const busy = await fetch(url, options); assert.equal(busy.status, 409); assert.equal(busy.headers.get('cache-control'), 'no-store');
    finishClose();
  } finally { finishClose(); client.abort(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('NVR deadline aborts and rejected lease cleanup does not leak the global slot', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = await mkdtemp(join(tmpdir(), 'nvr-deadline-'));
  const state = new GatewayState(); state.registerCamera({ serial: 'synthetic', name: 'Synthetic', model: 'T8E00', stationSerial: 'synthetic-station', streamSupported: false, doorbellSupported: false });
  let acquired = 0, signal: AbortSignal, entered!: () => void;
  let started = new Promise<void>(resolve => { entered = resolve; });
  const provider = { reserveNvrLiveTrial: (_camera: string, ownedSignal: AbortSignal) => { acquired++; signal = ownedSignal; return async () => { throw Error('private vendor close detail'); }; } } as unknown as CameraProvider;
  const streams = { hasActiveSession: () => false, recordClip: async () => { entered(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); throw Error('private vendor media detail'); } } as unknown as LiveStreamManager;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: 'fixture', experimentalNvrLive: true }, state, new SnapshotStore(directory), streams, provider, null);
  try {
    await server.listen(); const url = `http://127.0.0.1:${server.port}/api/cameras/synthetic/nvr-live-trial`;
    const options = { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: JSON.stringify({ consentPrivateMedia: true }) };
    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = fetch(url, options); await started;
      context.mock.timers.tick(82000); const response = await pending;
      assert.equal(response.status, 409); const value = await response.json(); assert.equal(value.stage, 'cancelled');
      assert.ok(!JSON.stringify(value).includes('private vendor')); assert.equal(acquired, attempt + 1);
      started = new Promise<void>(resolve => { entered = resolve; });
    }
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});


for (const enabled of [false, true]) test(`NVR state endpoint opt-in=${enabled} keeps auth and exact read-only consent`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nvr-state-http-'));
  const state = new GatewayState(); state.registerCamera({ serial: 'synthetic', name: 'Synthetic', model: 'T8E00', stationSerial: 'synthetic-station', streamSupported: false, doorbellSupported: false });
  let calls = 0, busy = false;
  const provider = { readNvrStateTrial: async () => { calls++; return { configuredGuardMode: 2, effectiveGuardMode: 1, cameraPower: 'on', parameterCount: 3, queriedAt: new Date().toISOString() }; } } as unknown as CameraProvider;
  const streams = { hasActiveSession: () => busy, recordClip: () => { assert.fail('State reads cannot request media'); } } as unknown as LiveStreamManager;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: 'fixture', experimentalNvrLive: enabled }, state, new SnapshotStore(directory), streams, provider, null);
  try {
    await server.listen(); const url = `http://127.0.0.1:${server.port}/api/cameras/synthetic/nvr-state-trial`;
    const options = { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: JSON.stringify({ consentReadState: true }) };
    assert.equal((await fetch(url, { ...options, headers: { 'content-type': 'application/json' } })).status, 401);
    if (!enabled) { assert.equal((await fetch(url, options)).status, 409); assert.equal(calls, 0); return; }
    for (const body of [{}, { consentReadState: false }, { consentReadState: true, command: 1224 }, { consentPrivateMedia: true }]) assert.equal((await fetch(url, { ...options, body: JSON.stringify(body) })).status, 400);
    assert.equal((await fetch(url, { ...options, headers: { authorization: 'Bearer fixture', 'content-type': 'text/plain' } })).status, 400);
    busy = true; assert.equal((await fetch(url, options)).status, 409); busy = false;
    const response = await fetch(url, options); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json() as { cameraPower: string }).cameraPower, 'on'); assert.equal(calls, 1);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('NVR state deadline cancels and holds the shared video slot until read cleanup completes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nvr-state-cancel-'));
  const state = new GatewayState(); state.registerCamera({ serial: 'synthetic', name: 'Synthetic', model: 'T8E00', stationSerial: 'synthetic-station', streamSupported: false, doorbellSupported: false });
  let entered!: () => void, aborted!: () => void, finishClose!: () => void;
  const active = new Promise<void>(resolve => { entered = resolve; }), cancelled = new Promise<void>(resolve => { aborted = resolve; }), closing = new Promise<void>(resolve => { finishClose = resolve; });
  let calls = 0;
  const provider = { reserveNvrLiveTrial: () => { assert.fail('Shared slot must reject video before provider acquisition'); }, readNvrStateTrial: async (_camera: string, signal: AbortSignal) => {
    calls++; entered(); await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
    await closing; throw Error('Private vendor text must not escape');
  } } as unknown as CameraProvider;
  const streams = { hasActiveSession: () => false } as unknown as LiveStreamManager;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: 'fixture', experimentalNvrLive: true }, state, new SnapshotStore(directory), streams, provider, null, null, null, 50);
  try {
    await server.listen(); const base = `http://127.0.0.1:${server.port}/api/cameras/synthetic/`;
    const options = { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: JSON.stringify({ consentReadState: true }) };
    const response = fetch(base + 'nvr-state-trial', options);
    await active; await cancelled;
    assert.equal((await fetch(base + 'nvr-live-trial', { ...options, body: JSON.stringify({ consentPrivateMedia: true }) })).status, 409);
    assert.equal((await fetch(base + 'nvr-state-trial', options)).status, 409);
    finishClose(); const failed = await response; assert.equal(failed.status, 409);
    assert.equal((await failed.text()).includes('Private vendor'), false); assert.equal(calls, 1);
  } finally { finishClose(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
