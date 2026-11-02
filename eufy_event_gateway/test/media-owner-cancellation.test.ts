/**
 * Exercises caller-owned media cancellation with private temporary sessions and
 * deterministic fake HTTP responses. Each test owns its reads and cleanup. The
 * client consumes those responses without contacting Eufy or changing devices.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MegaClient } from "../src/mega/client.js";
import { credentialVerifier } from "../src/mega/crypto.js";

const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/** Borrow a synthetic authenticated identity and retire its files after the test. */
async function mediaClient(context: TestContext, options: Partial<ConstructorParameters<typeof MegaClient>[0]>): Promise<MegaClient> {
  const directory = await mkdtemp(join(tmpdir(), "media-owner-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  await writeFile(join(directory, "mega-session.json"), JSON.stringify({
    version: 2, country: "au", openUdid: "device", credentialVerifier: credentialVerifier("device", "user@example.invalid", "password"),
    authToken: "synthetic-token", tokenExpiresAt: 2_000_000_000, userId: "user", megaDomain: "mega-eu-pr.eufy.com", domains: {}, identities: {},
  }));
  const client = new MegaClient({ email: "user@example.invalid", password: "password", country: "AU", persistentDirectory: directory,
    minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000, ...options });
  assert.deepEqual(await client.connect(), { state: "authenticated" });
  return client;
}

for (const method of ["download", "downloadWithMetadata"] as const) {
  test(`${method} refuses a retired owner before dispatch`, async context => {
    let requests = 0;
    const client = await mediaClient(context, { fetch: async () => { requests++; return new Response(image); } });
    const owner = new AbortController();
    owner.abort();
    await assert.rejects(client[method]("https://security-app-eu.eufylife.com/old", undefined, owner.signal), { name: "AbortError" });
    assert.equal(requests, 0);
    assert.deepEqual(await client.download("https://security-app-eu.eufylife.com/current"), image);
    assert.equal(requests, 1);
  });
}

test("retiring one owner stops its not-ready retry without retiring the client", async context => {
  let requests = 0, entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const client = await mediaClient(context, {
    fetch: async () => { requests++; return requests === 1 ? new Response(null, { status: 404 }) : new Response(image); },
    wait: async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); },
  });
  const owner = new AbortController();
  const pending = client.download("https://security-app-eu.eufylife.com/old", undefined, owner.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  try {
    await waiting;
    owner.abort();
    await rejected;
    assert.equal(requests, 1);
    assert.deepEqual(await client.download("https://security-app-eu.eufylife.com/current"), image);
    assert.equal(requests, 2);
  } finally { release?.(); }
});

test("retiring a streaming body cancels only its reader", async context => {
  let cancelled = false, reading!: () => void;
  const entered = new Promise<void>(resolve => { reading = resolve; });
  const client = await mediaClient(context, { fetch: async input => {
    if (String(input).endsWith("/current")) return new Response(image);
    return new Response(new ReadableStream<Uint8Array>({
      pull() { reading(); },
      cancel() { cancelled = true; },
    }));
  } });
  const owner = new AbortController();
  const pending = client.download("https://security-app-eu.eufylife.com/old", undefined, owner.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await entered;
  const unrelated = client.download("https://security-app-eu.eufylife.com/current");
  owner.abort();
  await rejected;
  assert.equal(cancelled, true);
  assert.deepEqual(await unrelated, image);
});
