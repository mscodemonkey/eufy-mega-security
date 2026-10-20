/**
 * Checks user-driven login challenges through synthetic encrypted HTTP requests.
 * Each case owns a fake session directory and client, and never contacts Eufy.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MegaClient } from "../src/mega/client.js";
import { credentialVerifier, decryptEnvelope, sharedAesKey } from "../src/mega/crypto.js";

const sharedKey = "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100";

/** Build a private fake session whose signing key is unrelated to vendor keys. */
async function fixture(fetcher: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), "mega-captcha-"));
  await writeFile(join(directory, "mega-session.json"), JSON.stringify({
    version: 2, country: "au", openUdid: "fixture", credentialVerifier: credentialVerifier("fixture", "fixture@example.invalid", "redacted"),
    authToken: "", tokenExpiresAt: 0, userId: "", megaDomain: "mega-eu-pr.eufy.com", domains: {},
    identities: { "app-openapi-eu-pr.eufy.com": { keyIdent: "fixture", sharedKey, clientPublicKey: "fixture" } },
  }));
  const client = new MegaClient({ email: "fixture@example.invalid", password: "redacted", country: "AU", persistentDirectory: directory,
    minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000, fetch: fetcher });
  return { client, close: async () => { client.cancelPendingRequests(); await rm(directory, { recursive: true, force: true }); } };
}

test("login CAPTCHA uses an empty native request and the current challenge id", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let logins = 0, challenges = 0;
  const f = await fixture(async (url, options) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(decryptEnvelope(String(options?.body), sharedAesKey(sharedKey))) as Record<string, unknown>;
    requests.push({ path, body });
    if (path === "/passport/generate/captcha") {
      assert.deepEqual(body, {});
      return new Response(JSON.stringify({ code: 0, data: { captcha_id: `challenge-${++challenges}`, item: "data:image/png;base64,AA==" } }));
    }
    assert.equal(path, "/passport/login");
    if (++logins < 3) return new Response(JSON.stringify({ code: 100032, data: {} }));
    return new Response(JSON.stringify({ code: 0, data: { auth_token: "fixture", user_id: "fixture", token_expires_at: 2_000_000_000 } }));
  });
  try {
    assert.deepEqual(await f.client.connect(), { state: "captcha-required", captcha: { id: "challenge-1", image: "data:image/png;base64,AA==" } });
    assert.deepEqual(await f.client.connect(undefined, "A1"), { state: "captcha-required", captcha: { id: "challenge-2", image: "data:image/png;base64,AA==" } });
    assert.deepEqual(await f.client.connect(undefined, "B2"), { state: "authenticated" });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(requests.map(r => r.path), ["/passport/login", "/passport/generate/captcha", "/passport/login", "/passport/generate/captcha", "/passport/login"]);
    assert.deepEqual(requests.filter(r => r.path === "/passport/login").map(r => [r.body.answer, r.body.captcha_id]),
      [["", ""], ["A1", "challenge-1"], ["B2", "challenge-2"]]);
    assert.equal(challenges, 2);
  } finally { await f.close(); }
});

for (const data of [null, {}, { captcha_id: "fixture" }, { item: "fixture" }]) {
  test(`malformed login challenge ${JSON.stringify(data)} stays an error`, async () => {
    const paths: string[] = [];
    const f = await fixture(async (url, options) => {
      const path = new URL(String(url)).pathname; paths.push(path);
      if (path === "/passport/login") return new Response(JSON.stringify({ code: 100032, data: {} }));
      assert.equal(path, "/passport/generate/captcha");
      assert.deepEqual(JSON.parse(decryptEnvelope(String(options?.body), sharedAesKey(sharedKey))), {});
      return new Response(JSON.stringify({ code: 0, data }));
    });
    try {
      await assert.rejects(f.client.connect(), /Mega returned an (?:invalid|incomplete) CAPTCHA challenge/);
      assert.deepEqual(paths, ["/passport/login", "/passport/generate/captcha"]);
    } finally { await f.close(); }
  });
}

test("26108 remains a terminal login rejection without CAPTCHA or retries", async () => {
  const paths: string[] = [];
  const f = await fixture(async url => {
    paths.push(new URL(String(url)).pathname);
    return new Response(JSON.stringify({ code: 26108, msg: "PRIVATE SERVER MESSAGE", data: "PRIVATE_DATA_STRING" }));
  });
  try {
    await assert.rejects(f.client.connect(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Mega request failed (26108: Eufy rejected the login, which the official app reports as an incorrect email or password) operation=login");
      for (const privateValue of ["PRIVATE", "fixture@example.invalid", "redacted"]) {
        assert.equal(error.message.includes(privateValue), false);
      }
      assert.equal(f.client.isSessionInvalidError(error), false);
      assert.equal(f.client.captcha, null);
      return true;
    });
    assert.deepEqual(paths, ["/passport/login"]);
  } finally { await f.close(); }
});

test("other login codes retain the generic safe error", async () => {
  const paths: string[] = [];
  const f = await fixture(async url => {
    paths.push(new URL(String(url)).pathname);
    return new Response(JSON.stringify({ code: 26109, msg: "PRIVATE SERVER MESSAGE", data: "PRIVATE_DATA_STRING" }));
  });
  try {
    await assert.rejects(f.client.connect(), { message: "Mega request failed (26109: application error) operation=login" });
    assert.deepEqual(paths, ["/passport/login"]);
  } finally { await f.close(); }
});

test("credential-rejection text never depends on the server message", async () => {
  const f = await fixture(async () => new Response(JSON.stringify({ code: 26108, msg: "Failed to login.", data: {} })));
  try {
    await assert.rejects(f.client.connect(), {
      message: "Mega request failed (26108: Eufy rejected the login, which the official app reports as an incorrect email or password) operation=login",
    });
  } finally { await f.close(); }
});

test("26108 on the CAPTCHA endpoint remains unclassified", async () => {
  const paths: string[] = [];
  const f = await fixture(async url => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    return new Response(JSON.stringify(path === "/passport/login"
      ? { code: 100032, data: {} }
      : { code: 26108, msg: "PRIVATE SERVER MESSAGE", data: "PRIVATE_DATA_STRING" }));
  });
  try {
    await assert.rejects(f.client.connect(), { message: "Mega request failed (26108: application error) operation=captcha" });
    assert.deepEqual(paths, ["/passport/login", "/passport/generate/captcha"]);
  } finally { await f.close(); }
});
