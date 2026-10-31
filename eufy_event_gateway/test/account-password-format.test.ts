/**
 * Exercises account-dependent password preparation through fake signed HTTPS.
 * Fixtures own all credentials, keys, responses and storage. The tests decrypt
 * the actual outgoing password envelope with captured fixture-only ephemeral
 * keys, while MegaClient owns format lookup, challenges and session reuse.
 */
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, ECDH } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MegaClient, megaOperation } from "../src/mega/client.js";
import { credentialVerifier, decryptEnvelope, encryptEnvelope, LOGIN_SERVER_PUBLIC_KEY, sharedAesKey } from "../src/mega/crypto.js";

/** Create a signed-out fixture with a reusable synthetic transport identity. */
async function fixture(t: TestContext, password: string, metadata: unknown, challenge = "none", code = 0) {
  const directory = await mkdtemp(join(tmpdir(), "mega-account-format-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionPath = join(directory, "mega-session.json");
  const sharedKey = "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100";
  await writeFile(sessionPath, JSON.stringify({
    version: 2, country: "au", openUdid: "fixture-device",
    credentialVerifier: credentialVerifier("fixture-device", "user@example.invalid", password),
    authToken: "", tokenExpiresAt: 0, userId: "", megaDomain: "mega-eu-pr.eufy.com", domains: {},
    identities: { "app-openapi-eu-pr.eufy.com": { keyIdent: "fixture", sharedKey, clientPublicKey: "fixture" } },
  }));
  const ephemeral = new Map<string, Buffer>();
  const generateKeys = ECDH.prototype.generateKeys;
  t.mock.method(ECDH.prototype, "generateKeys", function (this: ECDH) {
    const result = Reflect.apply(generateKeys, this, []) as Buffer;
    ephemeral.set(this.getPublicKey("hex"), this.getPrivateKey());
    return result;
  });
  t.after(() => { for (const value of ephemeral.values()) value.fill(0); ephemeral.clear(); });
  const controls: { onMetadata?: () => void; transportError?: boolean; loginCode: number } = { loginCode: 0 };
  const paths: string[] = [];
  const passwords: string[] = [];
  const requests: Record<string, unknown>[] = [];
  const fetchFixture: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, url.pathname === "/app/sendmsg/verify_code"
      ? "app-push-eu-pr.eufy.com" : "app-passport-eu-pr.eufy.com");
    paths.push(url.pathname);
    const body = JSON.parse(decryptEnvelope(String(init?.body), sharedAesKey(sharedKey))) as Record<string, unknown>;
    if (url.pathname === "/passport/validate_email") {
      assert.deepEqual(body, { email: "user@example.invalid" });
      controls.onMetadata?.();
      if (controls.transportError) throw new Error("Fixture transport failure");
      return new Response(JSON.stringify({ code, data: encryptEnvelope(JSON.stringify(metadata), sharedAesKey(sharedKey)) }));
    }
    if (url.pathname === "/passport/login") {
      requests.push(body);
      const publicKey = (body.client_secret_info as { public_key: string }).public_key;
      const scalar = ephemeral.get(publicKey);
      assert.ok(scalar);
      const decryptor = createECDH("prime256v1");
      decryptor.setPrivateKey(scalar);
      const secret = decryptor.computeSecret(Buffer.from(LOGIN_SERVER_PUBLIC_KEY, "hex"));
      const cipher = createDecipheriv("aes-256-cbc", secret, secret.subarray(0, 16));
      passwords.push(Buffer.concat([cipher.update(String(body.password), "base64"), cipher.final()]).toString("utf8"));
      secret.fill(0);
      if (passwords.length === 1 && challenge === "verification") {
        return new Response(JSON.stringify({ code: 26052, data: { auth_token: "pending", user_id: "fixture-user",
          token_expires_at: 2_000_000_000, fa_info: { step: 26052 } } }));
      }
      if (passwords.length === 1 && challenge === "captcha") return new Response(JSON.stringify({ code: 100032, data: {} }));
      return new Response(JSON.stringify({ code: controls.loginCode, data: { auth_token: "fixture-token", user_id: "fixture-user", token_expires_at: 2_000_000_000 } }));
    }
    if (url.pathname === "/app/sendmsg/verify_code") return new Response(JSON.stringify({ code: 0, data: {} }));
    if (url.pathname === "/passport/generate/captcha") {
      return new Response(JSON.stringify({ code: 0, data: { captcha_id: "fixture-challenge", item: "data:image/png;base64,AA==" } }));
    }
    throw new Error("Unexpected fixture request");
  };
  const client = new MegaClient({ email: "user@example.invalid", password, country: "AU", persistentDirectory: directory,
    fetch: fetchFixture, minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000 });
  return { client, paths, passwords, requests, sessionPath, directory, fetchFixture, controls };
}

test("account format controls the plaintext inside the actual password envelope", async t => {
  for (const [name, password, metadata, expected] of [
    ["sha2", " \tpassword\r\n", { enc_text: "sha2" }, "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8"],
    ["java-trim", "\u00a0pässword\u00a0", { enc_text: "sha2" }, "0aa718a68583fc3c7072449e2e7b106818aa6da2317fbdbb38f163d0b6ac5268"],
    ["legacy", " password ", {}, " password "],
    ["null", " password ", null, " password "],
    ["case-sensitive", " password ", { enc_text: "SHA2" }, " password "],
  ] as const) {
    await t.test(name, async context => {
      const f = await fixture(context, password, metadata);
      assert.deepEqual(await f.client.connect(), { state: "authenticated" });
      assert.deepEqual(f.paths, ["/passport/validate_email", "/passport/login"]);
      assert.deepEqual(f.passwords, [expected]);
      assert.equal((await f.client.connect()).state, "authenticated");
      const restored = new MegaClient({ email: "user@example.invalid", password, country: "AU", persistentDirectory: f.directory,
        fetch: async () => { throw new Error("A valid session must not perform account checks or login"); }, now: () => 1_700_000_000_000 });
      assert.equal((await restored.connect()).state, "authenticated");
      const saved = await readFile(f.sessionPath, "utf8");
      assert.doesNotMatch(saved, /enc_text|5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8/);
    });
  }
});

test("failed or invalid account metadata never submits a password or challenge", async t => {
  for (const code of [26006, 10019, 26052, 100032]) {
    await t.test(String(code), async context => {
      const f = await fixture(context, "fixture-password", {}, "none", code);
      await assert.rejects(f.client.connect(), /account format check failed/);
      assert.deepEqual(f.paths, ["/passport/validate_email"]);
      assert.deepEqual(f.passwords, []);
    });
  }
  const f = await fixture(t, "fixture-password", []);
  await assert.rejects(f.client.connect(), /invalid metadata/);
  assert.deepEqual(f.paths, ["/passport/validate_email"]);
  assert.equal(megaOperation("/passport/validate_email"), "account_check");
});


test("verification and CAPTCHA submissions recheck the format without hashing twice", async t => {
  for (const challenge of ["verification", "captcha"]) {
    await t.test(challenge, async context => {
      const f = await fixture(context, "password", { enc_text: "sha2" }, challenge);
      assert.equal((await f.client.connect()).state, challenge === "verification" ? "verification-required" : "captcha-required");
      const continued = challenge === "verification"
        ? new MegaClient({ email: "user@example.invalid", password: "password", country: "AU", persistentDirectory: f.directory,
          fetch: f.fetchFixture, minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000 }) : f.client;
      assert.equal((await continued.connect(challenge === "verification" ? "123456" : undefined,
        challenge === "captcha" ? "fixture-answer" : undefined)).state, "authenticated");
      assert.deepEqual(f.passwords, Array(2).fill("5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8"));
      assert.equal(f.paths.filter(path => path === "/passport/validate_email").length, 2);
      assert.equal(f.requests[1]?.verify_code, challenge === "verification" ? "123456" : "");
      assert.equal(f.requests[1]?.answer, challenge === "captcha" ? "fixture-answer" : "");
    });
  }
});

test("transport failure, cancellation and credential rejection never choose a fallback format", async t => {
  for (const failure of ["transport", "cancelled", "credentials"]) {
    await t.test(failure, async context => {
      const f = await fixture(context, "password", { enc_text: "sha2" });
      if (failure === "transport") f.controls.transportError = true;
      if (failure === "cancelled") f.controls.onMetadata = () => f.client.cancelPendingRequests();
      if (failure === "credentials") f.controls.loginCode = 26006;
      await assert.rejects(f.client.connect());
      assert.deepEqual(f.paths, failure === "credentials"
        ? ["/passport/validate_email", "/passport/login"] : ["/passport/validate_email"]);
      assert.equal(f.passwords.length, failure === "credentials" ? 1 : 0);
    });
  }
});
