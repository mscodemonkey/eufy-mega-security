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
import { observeLogEvents } from '../src/logging.js';
import { EufyProvider } from '../src/provider/eufy-provider.js';
import type { ProviderEvents } from '../src/provider/provider.js';
import { NvrTrialError } from '../src/stream/nvr-protocol.js';
import { NvrRtcSession } from '../src/stream/nvr-rtc-session.js';
import { GatewayState } from '../src/domain/gateway-state.js';

const additional = new Map<string, number>([['T8140', 14], ['T8140-Z', 14], ['T8113-V', 8], ['T8172', 89], ['T8162', 26], ['T8170', 48], ['T81A0', 10005], ['T8425', 47]]);

for (const mode of [...additional.keys(), 'state-read', 'state-read-failure', 'state-read-reason', 'live-reason', 'completed-log', 'cancelled-log', 'valid', 'pending-sign', 'binding-change', 'valid-t9000', 'channel-zero', 'channel-last', 'equal-owner', 'close-failure', 'disabled', 'unauthenticated', 'wrong-camera', 'wrong-type', 'wrong-station', 'missing-channel', 'missing-owner', 'wrong-parent-type', 't9000-cross-type', 'suffix-parent', 'case-parent', 'child-owner-mismatch', 'channel-negative', 'channel-over', 'channel-fraction']) test(`NVR provider ${mode} admits only an explicit exact-model lease`, async context => {
  const logLines: string[] = [];
  const logEvents: string[] = [];
  const stopObserving = mode.endsWith('-log') ? observeLogEvents((_component, event) => logEvents.push(event)) : () => {};
  if (mode.endsWith('-reason') || mode.endsWith('-log')) {
    context.mock.method(process.stderr, 'write', (chunk: unknown) => { logLines.push(String(chunk)); return true; });
  }
  const directory = await mkdtemp(join(tmpdir(), 'nvr-provider-'));
  context.mock.method(globalThis, 'fetch', async () => { assert.fail('Network forbidden'); });
  context.mock.method(MegaClient.prototype, 'connect', async () => ({ state: 'authenticated' }));
  context.mock.getter(MegaClient.prototype, 'isAuthenticated', () => mode !== 'unauthenticated');
  const valid = ['live-reason', 'completed-log', 'cancelled-log', 'valid', 'pending-sign', 'binding-change', 'valid-t9000', 'channel-zero', 'channel-last', 'equal-owner', 'close-failure'].includes(mode) || additional.has(mode) || mode.startsWith('state-read');
  const parentModel = mode === 'wrong-station' ? 'T8030' : (['valid-t9000', 't9000-cross-type'].includes(mode) || additional.has(mode)) ? 'T9000' : mode === 'suffix-parent' ? 'T9000121' : mode === 'case-parent' ? 't9000' : 'T8N00';
  let parentType = (['valid-t9000', 'wrong-parent-type', 'suffix-parent', 'case-parent'].includes(mode) || additional.has(mode)) ? 27 : 300;
  const channels: Record<string, number | undefined> = { 'missing-channel': undefined, 'channel-zero': 0, 'channel-last': 254, 'channel-negative': -1, 'channel-over': 255, 'channel-fraction': 1.5 };
  const channel = Object.hasOwn(channels, mode) ? channels[mode] : 3;
  context.mock.method(MegaClient.prototype, 'inventory', async () => ({ devices: [
    { device_sn: 'synthetic-station', device_model: parentModel, device_type: parentType,
      category: 'eufy_security', member: mode === 'missing-owner' ? {} : { admin_user_id: 'synthetic-owner' } },
    { device_sn: 'synthetic-camera', device_model: additional.has(mode) ? mode : mode === 'wrong-camera' ? 'T8416' : 'T8E00', device_type: additional.get(mode) ?? (mode === 'wrong-type' ? 105 : 301),
      category: 'eufy_security', parent_sn: 'synthetic-station', device_channel: channel, member: mode === 'child-owner-mismatch' ? { admin_user_id: 'synthetic-other-owner' } : mode === 'equal-owner' ? { admin_user_id: 'synthetic-owner' } : {} },
  ] }));
  context.mock.method(MegaPushReceiver.prototype, 'start', async () => {});
  const refreshes: (() => void)[] = [];
  context.mock.method(globalThis, 'setInterval', (callback: () => void) => { refreshes.push(callback); return { unref() {} } as unknown as NodeJS.Timeout; });
  let finishSign!: () => void, enterSign!: () => void;
  const signEntered = new Promise<void>(resolve => { enterSign = resolve; });
  const signDone = new Promise<void>(resolve => { finishSign = resolve; });
  let contexts = 0, starts = 0, closes = 0, finishClose!: () => void;
  const closing = new Promise<void>(resolve => { finishClose = resolve; });
  context.mock.method(MegaClient.prototype, 'nvrSignallingContext', async () => { contexts++; if (mode === 'pending-sign') { enterSign(); await signDone; } if (mode === 'binding-change') { parentType = 27; refreshes.at(-1)!(); await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve)); } return { host: 'security-smart-ie.eufylife.com', region: 'IE', authToken: 'synthetic', gtoken: 'synthetic', sign: 'synthetic' }; });
  let reads = 0, enterRead!: () => void, finishRead!: () => void;
  const reading = new Promise<void>(resolve => { enterRead = resolve; }), readDone = new Promise<void>(resolve => { finishRead = resolve; });
  context.mock.method(NvrRtcSession.prototype, 'readState', async () => { reads++; enterRead(); await readDone; if (mode === 'state-read-failure') throw Error('Synthetic private error'); if (mode === 'state-read-reason') throw new NvrTrialError('negotiation', 'offer_media'); return { configuredGuardMode: 2, effectiveGuardMode: 1, cameraPower: 'on', parameterCount: 3, queriedAt: new Date().toISOString() }; });
  context.mock.method(NvrRtcSession.prototype, 'start', async function(this: NvrRtcSession) {
    starts++;
    if (mode === 'live-reason') throw new NvrTrialError('negotiation', 'relay_fields');
    if (mode === 'completed-log' || mode === 'cancelled-log') {
      this.stats.video = mode === 'completed-log' ? 1 : 0;
      this.output.emit('error', new NvrTrialError('cancelled'));
    }
  });
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
    if (mode.startsWith('state-read')) {
      let settled = false;
      const result = provider.readNvrStateTrial('synthetic-camera', controller.signal);
      void result.then(() => { settled = true; }, () => { settled = true; });
      await reading;
      await assert.rejects(provider.startStream('synthetic-camera'));
      assert.equal(starts, 0); assert.equal(reads, 1);
      assert.throws(() => provider.reserveNvrLiveTrial('synthetic-camera', new AbortController().signal));
      finishRead(); await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(settled, false); assert.ok(closes >= 1);
      finishClose();
      if (mode === 'state-read-reason') {
        await assert.rejects(result, /NVR video test failed at negotiation/);
        assert.ok(logLines.some(line => line.includes('event=nvr_state_trial_failed stage=negotiation reason=offer_media')));
        assert.ok(logLines.every(line => !line.includes('synthetic-station') && !line.includes('synthetic-camera')));
      }
      else if (mode === 'state-read-failure') await assert.rejects(result, /NVR video test failed at state/);
      else assert.equal((await result).cameraPower, 'on');
      const retry = provider.reserveNvrLiveTrial('synthetic-camera', new AbortController().signal); await retry();
      return;
    }
    assert.equal(state.getCamera('synthetic-camera').streamSupported, false);
    if (!additional.has(mode)) assert.ok(Object.entries(state.getCamera('synthetic-camera')).filter(([key]) => key.endsWith('Supported')).every(([, value]) => value === false));
    await assert.rejects(provider.startStream('synthetic-camera')); assert.equal(contexts, 0);
    const release = provider.reserveNvrLiveTrial('synthetic-camera', controller.signal);
    assert.equal(contexts, 0);
    if (mode === 'pending-sign') {
      const failed = assert.rejects(provider.startStream('synthetic-camera'), /cancelled/);
      await signEntered; await provider.stopStream('synthetic-camera');
      const next = provider.reserveNvrLiveTrial('synthetic-camera', new AbortController().signal);
      finishSign(); await failed; await release(); assert.equal(starts, 0);
      assert.throws(() => provider.reserveNvrLiveTrial('synthetic-camera', new AbortController().signal));
      await next(); return;
    }
    if (mode === 'binding-change') { await assert.rejects(provider.startStream('synthetic-camera')); assert.equal(starts, 0); assert.throws(() => provider.reserveNvrLiveTrial('synthetic-camera', new AbortController().signal)); return; }
    if (mode === 'live-reason') {
      finishClose(); await assert.rejects(provider.startStream('synthetic-camera'), /NVR video test failed at negotiation/);
      assert.ok(logLines.some(line => line.includes('event=nvr_live_trial_failed stage=negotiation reason=relay_fields')));
      assert.ok(logLines.every(line => !line.includes('synthetic-station') && !line.includes('synthetic-camera')));
      const retry = provider.reserveNvrLiveTrial('synthetic-camera', new AbortController().signal); await retry(); return;
    }
    if (mode === 'completed-log' || mode === 'cancelled-log') {
      await provider.startStream('synthetic-camera');
      assert.ok(logEvents.includes(mode === 'completed-log' ? 'nvr_live_trial_completed' : 'nvr_live_trial_failed'));
      assert.ok(logLines.every(line => !line.includes('synthetic-station') && !line.includes('synthetic-camera')));
    }
    else await provider.startStream('synthetic-camera');
    assert.equal(contexts, 1); assert.equal(starts, 1);
    let released = false; const cleanup = release().then(() => { released = true; }); void cleanup.catch(() => {});
    await Promise.resolve(); assert.equal(released, false); assert.ok(closes >= 1);
    assert.throws(() => provider.reserveNvrLiveTrial('synthetic-camera', new AbortController().signal));
    finishClose(); if (mode === 'close-failure') await assert.rejects(cleanup); else await cleanup;
    const retry = provider.reserveNvrLiveTrial('synthetic-camera', new AbortController().signal); await retry();
  } finally { stopObserving(); finishSign(); finishRead(); finishClose(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});


for (const scenario of ["fresh", "child_channel", "child_model", "child_type", "child_parent", "child_owner", "child_category", "station_model", "station_type", "station_owner", "removed", "duplicate", "after_read", "abort_inventory", "abort_read", "expired", "cleanup"]) {
  test(`read-only NVR state rejects retired or rebound inventory: ${scenario}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "nvr-state-contract-"));
    context.mock.method(globalThis, "fetch", async () => { assert.fail("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.getter(MegaClient.prototype, "isAuthenticated", () => true);
    context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
    const controller = new AbortController();
    let inventories = 0, joins = 0, closes = 0;
    const baseline = () => [
      { device_sn: "synthetic-station", device_model: "T8N00", device_type: 300, category: "eufy_security",
        member: { admin_user_id: "synthetic-owner" }, params: [{ param_type: 1224, param_value: "2" }] },
      { device_sn: "synthetic-camera", device_model: "T8E00", device_type: 301, category: "eufy_security",
        parent_sn: "synthetic-station", device_channel: 3, member: { admin_user_id: "synthetic-owner" } },
    ];
    context.mock.method(MegaClient.prototype, "inventory", async (signal?: AbortSignal) => {
      inventories++;
      const rows = baseline();
      if (inventories > 1) {
        assert.ok(signal instanceof AbortSignal);
        if (scenario === "abort_inventory") controller.abort();
        if (scenario === "fresh") rows[0]!.params![0]!.param_value = inventories === 2 ? "1" : "3";
        const change = inventories === 2 || scenario === "after_read";
        if (change) {
          if (scenario === "child_channel" || scenario === "after_read" && inventories === 3) rows[1]!.device_channel = 4;
          if (scenario === "child_model") rows[1]!.device_model = "T8416";
          if (scenario === "child_type") rows[1]!.device_type = 105;
          if (scenario === "child_parent") rows[1]!.parent_sn = "synthetic-other";
          if (scenario === "child_owner") rows[1]!.member.admin_user_id = "synthetic-other";
          if (scenario === "child_category") rows[1]!.category = "other";
          if (scenario === "station_model") rows[0]!.device_model = "T9000";
          if (scenario === "station_type") rows[0]!.device_type = 27;
          if (scenario === "station_owner") rows[0]!.member.admin_user_id = "synthetic-other";
          if (scenario === "removed") rows.pop();
          if (scenario === "duplicate") rows.push({ ...rows[1]! });
        }
      }
      return { devices: rows };
    });
    context.mock.method(MegaClient.prototype, "nvrSignallingContext", async () => {
      joins++;
      return { host: "security-smart-ie.eufylife.com", region: "IE", authToken: "synthetic", gtoken: "synthetic", sign: "synthetic" };
    });
    context.mock.method(NvrRtcSession.prototype, "readState", async () => {
      if (scenario === "abort_read") controller.abort();
      if (scenario === "expired") { const later = Date.now() + 46_000; context.mock.method(Date, "now", () => later); }
      return { configuredGuardMode: 0, effectiveGuardMode: 1, cameraPower: "on" as const, parameterCount: 101, queriedAt: new Date().toISOString() };
    });
    context.mock.method(NvrRtcSession.prototype, "close", async () => { closes++; if (scenario === "cleanup") throw Error("Synthetic cleanup failure"); });
    const events = new Proxy({}, { get: () => () => {} }) as ProviderEvents;
    const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: directory,
      maxStreamSeconds: 120, experimentalNvrLive: true });
    try {
      await provider.start(events);
      const result = provider.readNvrStateTrial("synthetic-camera", controller.signal);
      if (scenario === "fresh") {
        const value = await result;
        assert.equal(value.configuredGuardMode, 3, "the final inventory overrides both startup and query policy values");
        assert.equal(value.configuredGuardModeSource, "inventory");
        assert.equal(value.cameraPowerSource, "query");
        assert.equal(value.effectiveGuardMode, null, "camera-only query must not masquerade as effective station state");
        assert.equal(inventories, 3);
      } else {
        await assert.rejects(result, error => {
          assert.ok(error instanceof NvrTrialError);
          assert.equal(error.stage, scenario.startsWith("abort") ? "cancelled" : "state");
          if (!["abort_inventory", "abort_read", "cleanup"].includes(scenario)) assert.equal(error.reason, scenario === "expired" ? "state_inventory_expired" : "state_binding_changed");
          return true;
        });
      }
      assert.equal(joins, ["fresh", "after_read", "abort_read", "expired", "cleanup"].includes(scenario) ? 1 : 0);
      if (joins) assert.ok(closes >= 1);
      if (!controller.signal.aborted) { const release = provider.reserveNvrLiveTrial("synthetic-camera", new AbortController().signal); await release(); }
    } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
