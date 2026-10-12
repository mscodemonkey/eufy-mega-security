/**
 * Checks subprocess cancellation with a local synthetic ffmpeg executable.
 * Tests own the temporary executable and process, restore PATH, and never use
 * customer media. The real-codec RTC suite separately verifies decoding.
 */
import assert from 'node:assert/strict';
import { getEventListeners, EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { remuxVideoToMp4, terminateMediaProcess } from '../src/stream/live-stream-manager.js';

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { return Number(await readFile(path, 'utf8')); } catch { await new Promise<void>(resolve => setImmediate(resolve)); }
  }
  throw Error('Synthetic media process did not start');
}

for (const ignoreTerm of [false, true]) test(`remux abort reaps a child ignoring SIGTERM=${ignoreTerm} before settling`, { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nvr-remux-')), pidPath = join(directory, 'pid');
  const originalPath = process.env.PATH;
  await writeFile(join(directory, 'ffmpeg'), `#!${process.execPath}\nconst fs=require('node:fs');${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ''}fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.stderr.write('private vendor detail');process.stdin.resume();setInterval(()=>{},100);\n`, { mode: 0o700 });
  process.env.PATH = directory;
  const controller = new AbortController(); let pid: number | undefined;
  try {
    const pending = remuxVideoToMp4(Buffer.from('synthetic'), 'h264', undefined, controller.signal); void pending.catch(() => {});
    pid = await waitForPid(pidPath); const started = performance.now(); controller.abort('private hostile reason');
    await assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR', message: 'Media operation cancelled' });
    assert.ok(performance.now() - started < 3500); assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0); controller.abort();
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    process.env.PATH = originalPath; await rm(directory, { recursive: true, force: true });
  }
});

test('pre-aborted remux never spawns and exited media children need no signalling', async () => {
  const controller = new AbortController(); controller.abort('private hostile reason');
  await assert.rejects(remuxVideoToMp4(Buffer.alloc(0), 'h264', undefined, controller.signal), { name: 'AbortError', code: 'ABORT_ERR' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  let kills = 0; const child = Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null, kill: () => { kills++; return true; } });
  terminateMediaProcess(child as never); assert.equal(kills, 0);
});
