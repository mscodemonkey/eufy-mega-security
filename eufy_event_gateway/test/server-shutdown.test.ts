/**
 * Exercises gateway shutdown through real local HTTP. Home Assistant keeps the
 * event stream open with no timeout, so closing the server must not wait for
 * it: shutdown closes the provider afterwards, within the Supervisor's stop
 * timeout, and only the provider can hang up open NVR calls.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";

test("closing the server ends an open event stream instead of waiting for it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "server-shutdown-"));
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "fixture" },
    new GatewayState(), new SnapshotStore(directory), {} as LiveStreamManager, {} as CameraProvider, null);
  let closing: Promise<void> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    await server.listen();
    const events = await fetch(`http://127.0.0.1:${server.port}/api/events`, { headers: { authorization: "Bearer fixture" } });
    assert.equal(events.status, 200);
    reader = events.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /^event: ready\n/);

    closing = server.close();
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([closing.then(() => "closed"),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve("waiting"), 2_000); })]);
    clearTimeout(timer);
    assert.equal(outcome, "closed");

    // The client sees its stream end, so Home Assistant reconnects to the next process.
    const ended = await reader.read().then(result => result.done, () => true);
    assert.equal(ended, true);
  } finally {
    await reader?.cancel().catch(() => undefined);
    await (closing ?? server.close());
    await rm(directory, { recursive: true, force: true });
  }
});
