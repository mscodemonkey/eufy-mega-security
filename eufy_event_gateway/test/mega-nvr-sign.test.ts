/**
 * Checks bounded NVR sign requests against a restored synthetic Mega session.
 * Each test owns its private temporary store and injected fetch implementation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MegaClient } from '../src/mega/client.js';
import { credentialVerifier } from '../src/mega/crypto.js';

for (const mode of ['ie', 'eu', 'us', 'unknown', 'redirect', 'oversize', 'queued-cancel']) test(`NVR sign ${mode} reuses one session without redirects or login`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nvr-sign-'));
  let requests = 0, release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const region = mode === 'us' ? 'us' : mode === 'eu' ? 'eu' : 'ie';
  const securityHost = mode === 'unknown' ? 'unknown.example.invalid' : `security-app${region === 'us' ? '' : '-' + region}.eufylife.com`;
  await writeFile(join(directory, 'mega-session.json'), JSON.stringify({ version: 2, country: 'au', openUdid: 'device',
    credentialVerifier: credentialVerifier('device', 'user@example.invalid', 'password'), authToken: 'synthetic-token',
    tokenExpiresAt: 2_000_000_000, userId: 'synthetic-user', megaDomain: `mega-${region}-pr.eufy.com`, domains: { eufy_security: securityHost },
    identities: { [securityHost]: { keyIdent: 'synthetic', sharedKey: '00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100', clientPublicKey: 'public' } } }));
  const client = new MegaClient({ email: 'user@example.invalid', password: 'password', country: 'AU', persistentDirectory: directory,
    minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000, fetch: async (input, init) => {
      requests++; const url = new URL(String(input));
      if (mode === 'queued-cancel') { await waiting; return new Response(JSON.stringify({ code: 0, data: 'synthetic-sign' })); }
      assert.equal(url.hostname, `security-smart${region === 'us' ? '' : '-' + region}.eufylife.com`);
      assert.equal(url.pathname, '/v1/smart/nvr/ws/sign'); assert.equal(init?.redirect, 'manual');
      assert.equal(new Headers(init?.headers).get('x-auth-token'), 'synthetic-token');
      if (mode === 'redirect') return new Response('', { status: 302, headers: { location: 'https://unknown.example.invalid' } });
      return new Response(JSON.stringify({ code: 0, data: mode === 'oversize' ? 'x'.repeat(70000) : 'synthetic-sign' }));
    } });
  try {
    await client.connect();
    const controller = new AbortController();
    if (mode === 'queued-cancel') {
      const inventory = client.nvrSignallingContext('synthetic-first', 'auto', new AbortController().signal); void inventory.catch(() => {});
      await new Promise<void>(resolve => setImmediate(resolve));
      const pending = client.nvrSignallingContext('synthetic-station', 'auto', controller.signal);
      controller.abort(); await assert.rejects(pending, /cancelled/); assert.equal(requests, 1); release(); await inventory;
    } else if (['unknown', 'redirect', 'oversize'].includes(mode)) {
      await assert.rejects(client.nvrSignallingContext('synthetic-station', 'auto', controller.signal));
      assert.equal(requests, mode === 'unknown' ? 0 : 1); assert.equal(client.isAuthenticated, true);
    } else {
      const value = await client.nvrSignallingContext('synthetic-station', 'auto', controller.signal);
      assert.equal(value.region, region.toUpperCase()); assert.equal(value.sign, 'synthetic-sign'); assert.equal(requests, 1);
    }
  } finally { release(); client.cancelPendingRequests(); await rm(directory, { recursive: true, force: true }); }
});
