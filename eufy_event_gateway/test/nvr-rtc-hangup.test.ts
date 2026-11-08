/**
 * Checks that retiring an NVR connection hangs up its call on local synthetic
 * signalling, so the station does not hold it, and that a connection which
 * never joined sends nothing more. Never contacts Eufy.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { NvrRtcSession } from '../src/stream/nvr-rtc-session.js';

type Reply = 'accepted' | 'unanswered' | 'busy' | 'not-joined';

async function signalling(reply: Reply): Promise<Record<string, unknown>[]> {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const controller = new AbortController();
  const received: Record<string, unknown>[] = [];
  const closed = new Promise<void>(resolve => server.on('connection', connection => {
    connection.once('close', () => resolve());
    const send = (value: Record<string, unknown>): void => { connection.send(JSON.stringify({ data: JSON.stringify(value) })); };
    connection.on('message', raw => {
      const message = JSON.parse(JSON.parse(raw.toString()).data) as Record<string, unknown>;
      received.push(message);
      if (message.action === 1) {
        if (reply === 'not-joined') controller.abort(); else send({ action: 1, code: 200 });
      } else if (message.dataType === 'call') {
        if (reply === 'accepted' || reply === 'busy') send({ action: 3, sessionId: 'synthetic-sign', sn: 'synthetic-station',
          channelId: 0, dataType: 'call', data: JSON.stringify({ status: reply === 'busy' ? 486 : 200 }) });
        if (reply !== 'busy') setTimeout(() => controller.abort(), 100);
      }
    });
  }));
  const session = new NvrRtcSession({ station: 'synthetic-station', camera: 'synthetic-camera', channel: 3,
    administrator: 'synthetic-administrator', context: { host: 'security-smart-ie.eufylife.com', region: 'IE',
      authToken: 'synthetic-token', gtoken: 'synthetic-gtoken', sign: 'synthetic-sign' },
    signal: controller.signal, current: () => true, ready: () => { throw new Error('No offer was sent'); } }, {
    socket: (_url, protocols, options) => new WebSocket(`ws://127.0.0.1:${port}`, protocols, options),
    peer: () => { throw new Error('No offer was sent'); },
  });
  try {
    await assert.rejects(session.start(), { stage: reply === 'busy' ? 'busy' : 'cancelled' });
    await session.close();
    await closed;
    return received;
  } finally { server.close(); }
}

for (const reply of ['accepted', 'unanswered', 'busy'] as const) test(`a retired ${reply} NVR call is hung up before the socket closes`, { timeout: 10000 }, async () => {
  const received = await signalling(reply);
  const kinds = received.map(message => message.dataType ?? `action${message.action}`);
  assert.deepEqual(kinds, reply === 'accepted' ? ['action1', 'call', 'ack', 'hangup'] : ['action1', 'call', 'hangup']);
  const hangup = received.at(-1)!;
  assert.equal(hangup.action, 3); assert.equal(hangup.sessionId, 'synthetic-sign'); assert.equal(hangup.sn, 'synthetic-station');
  assert.equal(hangup.channelId, 0); assert.equal(hangup.source, 'WEB');
  const data = JSON.parse(hangup.data as string) as Record<string, unknown>;
  assert.deepEqual(Object.keys(data).sort(), ['account', 'timestamp']);
});

test('a connection that never joined sends no hangup', { timeout: 10000 }, async () => {
  const received = await signalling('not-joined');
  assert.deepEqual(received.map(message => message.action), [1]);
});

test('a call keeps its signalling socket open with pings, so a long call can still hang up', { timeout: 10000 }, async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });

  // Fail rather than wait, so the local server still closes when a ping never comes.
  const within = <T>(promise: Promise<T>, label: string): Promise<T> => Promise.race([promise,
    new Promise<never>((_, reject) => { setTimeout(() => reject(new Error(label)), 2000).unref(); })]);
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const controller = new AbortController();
  const received: Record<string, unknown>[] = [];
  let accepted!: () => void;
  const answered = new Promise<void>(resolve => { accepted = resolve; });
  const pinged: (() => void)[] = [];
  const closed = new Promise<void>(resolve => server.on('connection', connection => {
    connection.once('close', () => resolve());
    const send = (value: Record<string, unknown>): void => { connection.send(JSON.stringify({ data: JSON.stringify(value) })); };
    connection.on('message', raw => {
      const outer = JSON.parse(raw.toString()) as Record<string, unknown>;
      const message = JSON.parse(outer.data as string) as Record<string, unknown>;
      received.push({ ...message, msgid: outer.msgid });
      if (message.action === 1) send({ action: 1, code: 200 });
      else if (message.action === 2) { send({ action: 2, code: 200 }); pinged.shift()?.(); }
      else if (message.dataType === 'call') send({ action: 3, sessionId: 'synthetic-sign', sn: 'synthetic-station',
        channelId: 0, dataType: 'call', data: JSON.stringify({ status: 200 }) });
      else if (message.dataType === 'ack') accepted();
    });
  }));
  const session = new NvrRtcSession({ station: 'synthetic-station', camera: 'synthetic-camera', channel: 3,
    administrator: 'synthetic-administrator', context: { host: 'security-smart-ie.eufylife.com', region: 'IE',
      authToken: 'synthetic-token', gtoken: 'synthetic-gtoken', sign: 'synthetic-sign' },
    signal: controller.signal, current: () => true, ready: () => { throw new Error('No offer was sent'); } }, {
    socket: (_url, protocols, options) => new WebSocket(`ws://127.0.0.1:${port}`, protocols, options),
    peer: () => { throw new Error('No offer was sent'); },
  });
  try {
    const starting = session.start();
    await within(answered, 'call not answered');
    for (let ping = 0; ping < 2; ping++) {
      const replied = new Promise<void>(resolve => pinged.push(resolve));
      context.mock.timers.tick(30_000);
      await within(replied, 'no ping');

      // The reply is read before the next ping, and must not end the call.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    controller.abort();
    await assert.rejects(starting, { stage: 'cancelled' });
    await session.close();
    await closed;
    assert.deepEqual(received.map(message => message.dataType ?? `action${message.action}`), ['action1', 'call', 'ack', 'action2', 'action2', 'hangup']);
    const ping = received[3]!;
    assert.equal(ping.msgid, '0'); assert.equal(ping.code, 200); assert.deepEqual(JSON.parse(ping.data as string), { source: 'WEB' });
  } finally { controller.abort(); await session.close(); server.close(); }
});
