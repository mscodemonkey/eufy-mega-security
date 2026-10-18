/**
 * Verifies RTC login-key validation and account binding with offline synthetic
 * P-256 pairs. Tests own temporary session files and never use a real account.
 */
import assert from "node:assert/strict";
import { createECDH, createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureGeneralRtcIdentity, generalRtcCipher, parseGeneralRtcIdentity } from "../src/mega/general-rtc-identity.js";
import { MegaSessionStore } from "../src/mega/session-store.js";
import type { MegaSession } from "../src/mega/types.js";
import { MegaClient } from "../src/mega/client.js";
import { credentialVerifier, decryptEnvelope, sharedAesKey } from "../src/mega/crypto.js";

const scalar = "1".padStart(64, "0");
const pair = createECDH("prime256v1");
pair.setPrivateKey(Buffer.from(scalar, "hex"));
const clientPublicKey = pair.getPublicKey("hex");
const securityHost = "security-app-ie.eufylife.com";
const session: MegaSession = { version: 2, country: "au", openUdid: "synthetic-client", credentialVerifier: "a".repeat(64),
  authToken: "synthetic-token", tokenExpiresAt: 9e9, userId: "synthetic-owner", verificationPending: false,
  megaDomain: "mega-eu-pr.eufy.com", domains: { eufy_security: securityHost }, identities: {} };

test("leading-zero scalar and uppercase valid server key capture a bound identity", () => {
  const identity = captureGeneralRtcIdentity(session, securityHost, scalar, clientPublicKey, clientPublicKey.toUpperCase());
  assert.ok(identity);
  assert.equal(identity.scalar.length, 64);
  assert.equal(identity.serverKey, clientPublicKey);
  assert.equal(identity.serverKeySource, "login");
  assert.equal(identity.tokenDigest, createHash("sha256").update(session.authToken).digest("hex"));
});

for (const value of [undefined, ""]) test(`absent server key uses the attested fallback: ${String(value)}`, () => {
  const identity = captureGeneralRtcIdentity(session, securityHost, scalar, clientPublicKey, value);
  assert.equal(identity?.serverKey, "login_default");
  assert.equal(identity?.serverKeySource, "login_default");
});

for (const value of [null, 1, {}, "bad", "04" + "0".repeat(128)]) test(`malformed server key is refused: ${typeof value}`, () => {
  assert.equal(captureGeneralRtcIdentity(session, securityHost, scalar, clientPublicKey, value), null);
});

test("cipher round trips portal base64 variants and rejects noncanonical or malformed input", () => {
  const identity = captureGeneralRtcIdentity(session, securityHost, scalar, clientPublicKey, clientPublicKey)!;
  const cipher = generalRtcCipher({ ...session, generalRtcIdentity: identity }, securityHost)!;
  assert.ok(cipher);
  const message = JSON.stringify({ action: 1, data: "synthetic-sign" });
  const encrypted = cipher.encrypt(message);
  assert.equal(cipher.decrypt(encrypted), message);
  assert.equal(cipher.decrypt(encrypted.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")), message);
  for (const invalid of ["", "!", "A", "AAAA", encrypted + "=", encrypted + "\n"]) {
    if (invalid === encrypted) continue;
    assert.throws(() => cipher.decrypt(invalid), /Invalid RTC message/);
  }
  assert.throws(() => cipher.encrypt("a".repeat(65537)), /Invalid RTC message/);
});

test("every account binding mismatch refuses the cipher", () => {
  const identity = captureGeneralRtcIdentity(session, securityHost, scalar, clientPublicKey, undefined)!;
  const bound = { ...session, generalRtcIdentity: identity };
  for (const change of [{ userId: "other-owner" }, { openUdid: "other-client" }, { authToken: "other-token" },
    { verificationPending: true }, { authToken: "" }]) assert.equal(generalRtcCipher({ ...bound, ...change }, securityHost), null);
  assert.equal(generalRtcCipher(bound, "security-app-eu.eufylife.com"), null);
  assert.equal(parseGeneralRtcIdentity({ ...identity, clientPublicKey: "04" + "0".repeat(128) }), null);
  assert.equal(parseGeneralRtcIdentity({ ...identity, scalar: "2".padStart(64, "0") }), null);
  assert.equal(parseGeneralRtcIdentity({ ...identity, serverKeySource: "login" }), null);
});

test("session store preserves optional identity with restrictive permissions and drops only invalid identity", async context => {
  const directory = await mkdtemp(join(tmpdir(), "rtc-identity-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session.json");
  const store = new MegaSessionStore(path);
  const identity = captureGeneralRtcIdentity(session, securityHost, scalar, clientPublicKey, undefined)!;
  await store.save({ ...session, generalRtcIdentity: identity });
  assert.deepEqual(await store.load(), { ...session, generalRtcIdentity: identity });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await store.save({ ...session, generalRtcIdentity: { ...identity, scalar: "bad" } });
  assert.deepEqual(await store.load(), session);
  assert.equal(JSON.parse(await readFile(path, "utf8")).generalRtcIdentity, undefined);
  await store.save(session);
  assert.deepEqual(await store.load(), session);
});

test("a valid restored session does not login or commit a new identity", async context => {
  const directory = await mkdtemp(join(tmpdir(), "rtc-restored-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const saved = { ...session, credentialVerifier: credentialVerifier(session.openUdid, "fixture@example.invalid", "redacted") };
  const path = join(directory, "mega-session.json");
  await writeFile(path, JSON.stringify(saved));
  let requests = 0;
  const client = new MegaClient({ email: "fixture@example.invalid", password: "redacted", country: "AU", persistentDirectory: directory,
    experimentalGeneralRtc: true, fetch: async () => { requests++; throw Error("Network forbidden"); } });
  assert.deepEqual(await client.connect(), { state: "authenticated" });
  assert.equal(requests, 0);
  assert.equal(client.generalRtcCipher(), null);
  assert.equal(JSON.parse(await readFile(path, "utf8")).generalRtcIdentity, undefined);
  client.cancelPendingRequests();
});

test("flag off removes an existing optional identity while preserving native authentication", async context => {
  const directory = await mkdtemp(join(tmpdir(), "rtc-disabled-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const identity = captureGeneralRtcIdentity(session, securityHost, scalar, clientPublicKey, undefined)!;
  const saved = { ...session, generalRtcIdentity: identity, credentialVerifier: credentialVerifier(session.openUdid, "fixture@example.invalid", "redacted") };
  const path = join(directory, "mega-session.json");
  await writeFile(path, JSON.stringify(saved));
  const client = new MegaClient({ email: "fixture@example.invalid", password: "redacted", country: "AU", persistentDirectory: directory,
    fetch: async () => { throw Error("Network forbidden"); } });
  assert.deepEqual(await client.connect(), { state: "authenticated" });
  const loaded = JSON.parse(await readFile(path, "utf8"));
  assert.equal(loaded.generalRtcIdentity, undefined);
  assert.equal(loaded.authToken, session.authToken);
  assert.equal(client.generalRtcAccount(), null);
  client.cancelPendingRequests();
});

for (const enabled of [false, true]) test(`natural CAPTCHA login commits only the final pair when enabled=${enabled}`, async context => {
  const directory = await mkdtemp(join(tmpdir(), "rtc-login-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sharedKey = "a".repeat(64);
  const saved = { ...session, tokenExpiresAt: 0,
    credentialVerifier: credentialVerifier(session.openUdid, "fixture@example.invalid", "redacted"),
    identities: { "app-openapi-eu-pr.eufy.com": { keyIdent: "fixture", sharedKey, clientPublicKey: "fixture" } } };
  const path = join(directory, "mega-session.json");
  await writeFile(path, JSON.stringify({ ...saved, generalRtcIdentity: captureGeneralRtcIdentity(saved, securityHost, scalar, clientPublicKey, undefined) }));
  const keys: string[] = [];
  const client = new MegaClient({ email: "fixture@example.invalid", password: "redacted", country: "AU", persistentDirectory: directory,
    experimentalGeneralRtc: enabled, minimumRequestIntervalMs: 0, fetch: async (url, options) => {
      const endpoint = new URL(String(url)).pathname;
      if (endpoint === "/passport/generate/captcha") return new Response(JSON.stringify({ code: 0, data: { captcha_id: "fixture", item: "data:image/png;base64,AA==" } }));
      assert.equal(endpoint, "/passport/login");
      const body = JSON.parse(decryptEnvelope(String(options?.body), sharedAesKey(sharedKey)));
      keys.push(body.client_secret_info.public_key);
      return new Response(JSON.stringify(keys.length === 1 ? { code: 100032 } : { code: 0,
        data: { auth_token: session.authToken, user_id: session.userId, token_expires_at: session.tokenExpiresAt } }));
    } });
  assert.equal((await client.connect()).state, "captcha-required");
  assert.equal(JSON.parse(await readFile(path, "utf8")).generalRtcIdentity, undefined);
  assert.equal((await client.connect(undefined, "A1")).state, "authenticated");
  assert.notEqual(keys[0], keys[1]);
  const loaded = JSON.parse(await readFile(path, "utf8"));
  assert.equal(loaded.generalRtcIdentity?.clientPublicKey, enabled ? keys[1] : undefined);
  assert.equal(!!client.generalRtcCipher(), enabled);
  client.cancelPendingRequests();
});

for (const mode of ["credentials", "force"] as const) test(`${mode} retirement removes only the optional identity even if subsequent discovery fails`, async context => {
  const directory = await mkdtemp(join(tmpdir(), "rtc-retire-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const saved = { ...session, credentialVerifier: credentialVerifier(session.openUdid, "fixture@example.invalid", "redacted") };
  const identity = captureGeneralRtcIdentity(saved, securityHost, scalar, clientPublicKey, undefined)!;
  const path = join(directory, "mega-session.json"); await writeFile(path, JSON.stringify({ ...saved, generalRtcIdentity: identity }));
  const client = new MegaClient({ email: "fixture@example.invalid", password: mode === "credentials" ? "changed-fixture-password" : "redacted",
    country: "AU", persistentDirectory: directory, experimentalGeneralRtc: true, fetch: async () => { throw Error("Synthetic discovery unavailable"); } });
  if (mode === "force") { assert.equal((await client.connect()).state, "authenticated"); assert.ok(client.generalRtcCipher()); }
  await assert.rejects(client.connect(undefined, undefined, mode === "force"));
  const loaded = JSON.parse(await readFile(path, "utf8"));
  assert.equal(loaded.generalRtcIdentity, undefined); assert.equal(loaded.authToken, saved.authToken);
  assert.equal(loaded.credentialVerifier, saved.credentialVerifier); assert.equal(client.generalRtcCipher(), null);
  client.cancelPendingRequests();
});
