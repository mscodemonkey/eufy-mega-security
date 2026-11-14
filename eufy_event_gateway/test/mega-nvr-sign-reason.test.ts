/**
 * Exercises the real signing queue and response reader with synthetic failures.
 * Tests own abort clocks, private temporary sessions and injected HTTP responses.
 * No vendor request, authentication refresh or camera operation is performed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MegaClient } from "../src/mega/client.js";
import { credentialVerifier } from "../src/mega/crypto.js";
import { NvrTrialError } from "../src/stream/nvr-protocol.js";

/** Restore one authenticated fixture without permitting a login or session renewal. */
async function fixture(fetch: typeof globalThis.fetch): Promise<{ client: MegaClient; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "nvr-sign-reason-"));
  await writeFile(join(directory, "mega-session.json"), JSON.stringify({ version: 2, country: "au", openUdid: "device",
    credentialVerifier: credentialVerifier("device", "user@example.invalid", "password"), authToken: "synthetic-token",
    tokenExpiresAt: 2_000_000_000, userId: "synthetic-user", megaDomain: "mega-us-pr.eufy.com",
    domains: { eufy_security: "security-app.eufylife.com" }, identities: { "security-app.eufylife.com": {
      keyIdent: "synthetic", sharedKey: "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100", clientPublicKey: "public" } } }));
  const client = new MegaClient({ email: "user@example.invalid", password: "password", country: "AU",
    persistentDirectory: directory, minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000, fetch });
  await client.connect();
  return { client, directory };
}

for (const phase of ["region", "request", "body"] as const) {
  test(`sign deadline identifies the existing ${phase} boundary without a retry`, async context => {
    const deadline = new AbortController();
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    context.mock.method(AbortSignal, "timeout", (milliseconds: number) => milliseconds === 10_000 ? deadline.signal : nativeTimeout(milliseconds));
    let entered!: () => void, requests = 0;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const { client, directory } = await fixture(async (input, init) => {
      const url = new URL(String(input)); requests++;
      assert.equal(url.pathname, phase === "region" ? "/passport/estimate_domain" : "/v1/smart/nvr/ws/sign");
      if (phase === "body") return new Response(new ReadableStream({ start() { entered(); } }));
      entered();
      return await new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    });
    try {
      const operation = client.nvrSignallingContext("synthetic-station", phase === "region" ? "auto" : "us", new AbortController().signal);
      const rejected = assert.rejects(operation, error => {
        assert.ok(error instanceof NvrTrialError); assert.equal(error.stage, "sign");
        assert.equal(error.reason, `sign_${phase}_timeout`); assert.doesNotMatch(error.message, /PRIVATE|synthetic-token/); return true;
      });
      await ready; await new Promise(resolve => setImmediate(resolve));
      deadline.abort(new DOMException("PRIVATE_TIMEOUT_TEXT", "TimeoutError"));
      await rejected; assert.equal(requests, 1); assert.equal(client.isAuthenticated, true);
    } finally { client.cancelPendingRequests(); await rm(directory, { recursive: true, force: true }); }
  });
}

test("a deadline in the sign queue sends no second request", async context => {
  const clocks: AbortController[] = [];
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    if (milliseconds !== 10_000) return nativeTimeout(milliseconds);
    const clock = new AbortController(); clocks.push(clock); return clock.signal;
  });
  let entered!: () => void, release!: (response: Response) => void, requests = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const { client, directory } = await fixture(async () => {
    requests++; entered(); return await new Promise<Response>(resolve => { release = resolve; });
  });
  try {
    const first = client.nvrSignallingContext("synthetic-first", "us", new AbortController().signal);
    await ready;
    const second = client.nvrSignallingContext("synthetic-second", "us", new AbortController().signal);
    const rejected = assert.rejects(second, error => {
      assert.ok(error instanceof NvrTrialError); assert.equal(error.stage, "sign");
      assert.equal(error.reason, "sign_queue_timeout"); return true;
    });
    clocks[1]!.abort(new DOMException("PRIVATE", "TimeoutError")); await rejected;
    release(new Response(JSON.stringify({ code: 0, data: "synthetic-sign" }))); await first;
    await new Promise(resolve => setImmediate(resolve)); assert.equal(requests, 1);
  } finally { client.cancelPendingRequests(); await rm(directory, { recursive: true, force: true }); }
});

for (const mode of ["transport", "body", "cancel"] as const) {
  test(`sign failure preserves ${mode} and discards private error text`, async () => {
    const cancellation = new AbortController();
    const { client, directory } = await fixture(async () => {
      if (mode === "body") return new Response("PRIVATE_INVALID_JSON");
      if (mode === "cancel") cancellation.abort();
      throw new TypeError("PRIVATE_URL_TOKEN_VENDOR_TEXT");
    });
    try {
      await assert.rejects(client.nvrSignallingContext("synthetic-station", "us", cancellation.signal), error => {
        assert.ok(error instanceof NvrTrialError); assert.equal(error.stage, mode === "cancel" ? "cancelled" : "sign");
        assert.equal(error.reason, mode === "cancel" ? "unspecified" : mode === "body" ? "sign_body_failed" : "sign_request_failed");
        assert.doesNotMatch(error.message, /PRIVATE|synthetic/); return true;
      });
    } finally { client.cancelPendingRequests(); await rm(directory, { recursive: true, force: true }); }
  });
}
