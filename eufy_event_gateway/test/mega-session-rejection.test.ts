/**
 * Qualifies native HTTP authentication refusals using fixture-owned responses.
 * Tests own the synthetic session, HTTPS transport and private response text.
 * MegaClient may classify a rejected token but must leave recovery to its caller
 * and must never expose response text, credentials or token echoes in errors.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MegaClient } from "../src/mega/client.js";
import { credentialVerifier } from "../src/mega/crypto.js";

/** Build only a private fixture session and a refusing native API transport. */
async function fixture(t: TestContext, body: unknown, status = 401, token = "SYNTHETIC_TOKEN") {
  const directory = await mkdtemp(join(tmpdir(), "mega-session-refusal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "mega-session.json"), JSON.stringify({
    version: 2, country: "au", openUdid: "fixture-device",
    credentialVerifier: credentialVerifier("fixture-device", "user@example.invalid", "fixture-password"),
    authToken: token, tokenExpiresAt: 2_000_000_000, userId: token ? "fixture-user" : "",
    megaDomain: "mega-eu-pr.eufy.com", domains: {}, identities: {
      "app-openapi-eu-pr.eufy.com": { keyIdent: "fixture", clientPublicKey: "fixture",
        sharedKey: "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100" },
    },
  }));
  const paths: string[] = [];
  const client = new MegaClient({ email: "user@example.invalid", password: "fixture-password", country: "AU",
    persistentDirectory: directory, minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000,
    fetch: async (url, options) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === "/passport/estimate_domain") {
        assert.equal(new Headers(options?.headers).has("x-auth-token"), false);
        return new Response("", { status: 503 });
      }
      assert.equal(new Headers(options?.headers).get("x-auth-token"), token || null);
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    } });
  return { client, paths, directory };
}

test("authenticated token refusals are classified without clearing or relogging the client", async t => {
  for (const [code, msg, rejected] of [
    [26084, "PRIVATE SERVER MESSAGE", true],
    [26884, "PRIVATE SERVER MESSAGE", true],
    [401, "token error", true],
    [401, "token not exist, token = SYNTHETIC_TOKEN", true],
    [401, "token does not exist because it was kicked out", true],
    [401, "token = SYNTHETIC_TOKEN, gtoken not equal userid error", false],
    [401, "gtoken error", false],
    [401, "request not authorized for this resource", false],
    [100056, "too many attempts", false],
    [401, "rate limit", false],
  ] as const) {
    await t.test(`${code}-${msg}`, async context => {
      const f = await fixture(context, { code, msg });
      assert.equal((await f.client.connect()).state, "authenticated");
      await assert.rejects(f.client.inventory(), error => {
        assert.equal(f.client.isSessionInvalidError(error), rejected);
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /SYNTHETIC_TOKEN|PRIVATE|fixture-password|gtoken|not authorized/);
        return true;
      });
      assert.equal((await f.client.connect()).state, "authenticated");
      assert.deepEqual(f.paths, ["/app/house/get_devs_list"]);
    });
  }
});

test("empty, non-JSON and non-401 refusals preserve the saved session", async t => {
  for (const [name, body, status] of [["empty", "", 401], ["non-json", "PRIVATE_HTML", 401],
    ["permission", { code: 26084, msg: "PRIVATE" }, 403]] as const) {
    await t.test(name, async context => {
      const f = await fixture(context, body, status);
      await f.client.connect();
      await assert.rejects(f.client.inventory(), error => {
        assert.equal(f.client.isSessionInvalidError(error), false);
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /PRIVATE/);
        return true;
      });
      assert.deepEqual(f.paths, ["/app/house/get_devs_list"]);
    });
  }
});

test("a format check with no authenticated token cannot authorize session replacement", async t => {
  const f = await fixture(t, { code: 26084, msg: "PRIVATE SERVER MESSAGE" }, 401, "");
  await assert.rejects(f.client.connect(), error => {
    assert.equal(f.client.isSessionInvalidError(error), false);
    return true;
  });
  assert.deepEqual(f.paths, ["/passport/validate_email"]);
});


test("failed forced renewal retires the rejected token without replacing the device identity", async t => {
  const f = await fixture(t, { code: 26084, msg: "PRIVATE" });
  await f.client.connect();
  await assert.rejects(f.client.connect(undefined, undefined, true));
  const saved = JSON.parse(await readFile(join(f.directory, "mega-session.json"), "utf8"));
  assert.equal(saved.openUdid, "fixture-device");
  assert.equal(saved.authToken, "");
  assert.deepEqual(saved.identities, {});
  assert.equal(f.client.isAuthenticated, false);
  assert.deepEqual(f.paths, ["/passport/estimate_domain"]);
});
