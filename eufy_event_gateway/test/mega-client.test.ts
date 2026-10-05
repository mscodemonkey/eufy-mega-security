/**
 * Tests MegaClient against deterministic fake HTTPS responses.
 *
 * It protects domain discovery, encrypted request envelopes, login challenge
 * states, session reuse, inventory validation, DSK/cipher extraction, and
 * bounded media download without contacting Eufy.
 */
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach, afterEach } from "node:test";

import { MegaClient } from "../src/mega/client.js";
import { decryptEnvelope, encryptEnvelope, credentialVerifier, presetKey, sharedAesKey } from "../src/mega/crypto.js";

const unhandled: unknown[] = [];
const onUnhandled = (error: unknown): void => { unhandled.push(error); };
let networkCalls = 0;
beforeEach((context) => {
  networkCalls = 0;
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  if (!("mock" in context)) throw new Error("Expected test context");
  context.mock.method(globalThis, "fetch", async () => { ++networkCalls; throw new Error("Network forbidden"); });
});
afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, []);
  assert.equal(networkCalls, 0);
});

test("completes encrypted push registration and activation using one restored regional session", async () => {
  const sharedKey = "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100";
  const pushPath = "/app/push/register_push_token";
  const securityPath = "/v1/apppush/register_push_token";
  const activationPath = "/v1/app/review/app_push_check";
  for (const region of ["us", "eu", "ie"]) {
    for (const failedStep of [-1, 0, 1, 2]) {
      const directory = await mkdtemp(join(tmpdir(), "mega-push-registration-"));
      const openHost = `app-openapi-${region}-pr.eufy.com`;
      const securityHost = `security-app${region === "us" ? "" : `-${region}`}.eufylife.com`;
      const requests: Array<{ url: URL; body: unknown; headers: Headers }> = [];
      try {
        await writeFile(join(directory, "mega-session.json"), JSON.stringify({
          version: 2, country: "au", openUdid: "device",
          credentialVerifier: credentialVerifier("device", "user@example.invalid", "password"),
          authToken: "synthetic-token", tokenExpiresAt: 2_000_000_000, userId: "synthetic-user",
          megaDomain: `mega-${region}-pr.eufy.com`, domains: { eufy_security: securityHost },
          identities: {
            [openHost]: { keyIdent: "mega-identity", sharedKey, clientPublicKey: "public" },
            [securityHost]: { keyIdent: "security-identity", sharedKey, clientPublicKey: "public" },
          },
        }));
        const client = new MegaClient({
          email: "user@example.invalid", password: "password", country: "AU", persistentDirectory: directory,
          minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000,
          fetch: async (input, init) => {
            const url = new URL(String(input));
            const body = JSON.parse(decryptEnvelope(String(init?.body), sharedAesKey(sharedKey)));
            requests.push({ url, body, headers: new Headers(init?.headers) });
            return new Response(JSON.stringify({ code: requests.length - 1 === failedStep ? 9999 : 0, data: {} }));
          },
        });
        await client.connect();
        if (failedStep === -1) {
          assert.deepEqual(await client.registerPushToken("synthetic-fcm"), { activated: true, code: 0 });
        } else if (failedStep === 1 || failedStep === 2) {
          assert.deepEqual(await client.registerPushToken("synthetic-fcm"), {
            activated: false,
            code: 9999,
            failedSecurityStage: failedStep === 1 ? "registration" : "activation",
            megaRegistrationRestored: true,
          });
        } else {
          await assert.rejects(client.registerPushToken("synthetic-fcm"), /Mega push registration failed \(9999\)/);
        }
        const expectedPaths = failedStep === -1
          ? [pushPath, securityPath, activationPath]
          : failedStep === 0 ? [pushPath]
          : failedStep === 1 ? [pushPath, securityPath, pushPath]
          : [pushPath, securityPath, activationPath, pushPath];
        assert.deepEqual(requests.map(({ url }) => url.pathname), expectedPaths);
        assert.deepEqual(requests[0]?.body, { token: "synthetic-fcm", is_notification_enable: true, voip_token: "" });
        assert.equal(requests[0]?.url.hostname, `app-push-${region}-pr.eufy.com`);
        for (const request of requests.filter(({ url }) => url.pathname !== pushPath)) {
          assert.equal(request.url.hostname, securityHost);
          assert.equal(request.headers.get("x-auth-token"), "synthetic-token");
          assert.equal(request.headers.get("x-key-ident"), "security-identity");
          assert.equal(request.headers.has("x-signature"), true);
        }
        if (requests.some(({ url }) => url.pathname === securityPath)) assert.deepEqual(requests[1]?.body, {
          token: "synthetic-fcm", is_notification_enable: true, transaction: "1700000000000",
        });
        if (requests.some(({ url }) => url.pathname === activationPath)) assert.deepEqual(requests[2]?.body, {
          app_type: "eufySecurity", transaction: "1700000000000",
        });
        for (const request of requests.filter(({ url }) => url.pathname === pushPath)) {
          assert.equal(request.url.hostname, `app-push-${region}-pr.eufy.com`);
          assert.deepEqual(request.body, { token: "synthetic-fcm", is_notification_enable: true, voip_token: "" });
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

test("replaces and persists a stale Mega identity after error 4404", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mega-identity-recovery-"));
  const sessionPath = join(directory, "mega-session.json");
  const host = "app-openapi-eu-pr.eufy.com";
  const staleSharedKey = "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100";
  let refreshedSharedKey = "";
  const requests: Array<{ readonly path: string; readonly keyIdent: string | null }> = [];
  try {
    await writeFile(sessionPath, JSON.stringify({
      version: 2, country: "au", openUdid: "device",
      credentialVerifier: credentialVerifier("device", "user@example.invalid", "password"),
      authToken: "token", tokenExpiresAt: 2_000_000_000, userId: "user",
      megaDomain: "mega-eu-pr.eufy.com", domains: {},
      identities: { [host]: { keyIdent: "stale-identity", sharedKey: staleSharedKey, clientPublicKey: "public" } },
    }));
    const fakeFetch: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      const headers = new Headers(init?.headers);
      requests.push({ path, keyIdent: headers.get("x-key-ident") });
      if (path === "/app/house/get_devs_list" && requests.length === 1) {
        return new Response(JSON.stringify({ code: 4404, msg: "get identity error", data: {} }));
      }
      if (path === "/openapi/oauth/key/exchange") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { client_public_key?: string };
        const clientPublicKey = decryptEnvelope(body.client_public_key ?? "", presetKey());
        const server = createECDH("prime256v1");
        server.generateKeys();
        refreshedSharedKey = server.computeSecret(Buffer.from(clientPublicKey, "hex")).toString("hex");
        return new Response(JSON.stringify({
          code: 0,
          data: { server_public_key: encryptEnvelope(server.getPublicKey("hex"), presetKey(), Buffer.alloc(16, 2)) },
        }));
      }
      const responseValue = path === "/app/house/get_devs_list" ? { devices: [], groups: [] } : [];
      const data = encryptEnvelope(JSON.stringify(responseValue), sharedAesKey(refreshedSharedKey), Buffer.alloc(16, 3));
      return new Response(JSON.stringify({ code: 0, data }));
    };
    const client = new MegaClient({
      email: "user@example.invalid", password: "password", country: "AU", persistentDirectory: directory,
      minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000, fetch: fakeFetch,
    });

    assert.equal(client.isSessionInvalidError(new Error("Mega request failed (4404: get identity error)")), true);
    assert.deepEqual(await client.connect(), { state: "authenticated" });
    assert.deepEqual(await client.inventory(), { devices: [], groups: [] });
    assert.deepEqual(requests.map((request) => request.path), [
      "/app/house/get_devs_list",
      "/openapi/oauth/key/exchange",
      "/app/house/get_devs_list",
      "/v2/house/device_list",
    ]);
    const saved = JSON.parse(await readFile(sessionPath, "utf8")) as {
      identities: Record<string, { keyIdent: string }>;
    };
    assert.notEqual(saved.identities[host]?.keyIdent, "stale-identity");
    assert.equal(saved.identities[host]?.keyIdent, requests[1]?.keyIdent);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("authenticates only the Eufy leg of an allowlisted media redirect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mega-media-"));
  const requests: Headers[] = [];
  try {
    await writeFile(join(directory, "mega-session.json"), JSON.stringify({
      version: 2, country: "au", openUdid: "device", credentialVerifier: credentialVerifier("device", "user@example.invalid", "password"),
      authToken: "media-token", tokenExpiresAt: 2_000_000_000, userId: "user", megaDomain: "mega-eu-pr.eufy.com",
      domains: {}, identities: {},
    }));
    const client = new MegaClient({
      email: "user@example.invalid", password: "password", country: "AU", persistentDirectory: directory,
      minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000,
      fetch: async (_input, init) => {
        requests.push(new Headers(init?.headers));
        if (requests.length === 1) return new Response(null, {
          status: 302,
          headers: { location: "https://zhixin-security-au.s3.ap-southeast-2.amazonaws.com/private-image" },
        });
        return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200 });
      },
    });
    assert.deepEqual(await client.connect(), { state: "authenticated" });
    assert.equal((await client.download("https://security-app-eu.eufylife.com/image")).length, 4);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.get("x-auth-token"), "media-token");
    assert.match(requests[0]?.get("user-agent") ?? "", /^Dalvik\/2\.1\.0/);
    assert.equal(requests[1]?.get("x-auth-token"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retries a push thumbnail while Eufy's cloud object is not ready", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mega-media-retry-"));
  const waits: number[] = [];
  let requests = 0;
  try {
    await writeFile(join(directory, "mega-session.json"), JSON.stringify({
      version: 2, country: "au", openUdid: "device", credentialVerifier: credentialVerifier("device", "user@example.invalid", "password"),
      authToken: "media-token", tokenExpiresAt: 2_000_000_000, userId: "user", megaDomain: "mega-eu-pr.eufy.com",
      domains: {}, identities: {},
    }));
    const client = new MegaClient({
      email: "user@example.invalid", password: "password", country: "AU", persistentDirectory: directory,
      minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000,
      wait: async (milliseconds) => { waits.push(milliseconds); },
      fetch: async () => {
        requests += 1;
        if (requests < 3) return new Response(null, { status: 404 });
        return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200 });
      },
    });
    assert.deepEqual(await client.connect(), { state: "authenticated" });
    assert.equal((await client.download("https://security-app-eu.eufylife.com/image")).length, 4);
    assert.equal(requests, 3);
    assert.deepEqual(waits, [1_000, 2_000]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retains the limited verification session across an app restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mega-verification-"));
  const sessionPath = join(directory, "mega-session.json");
  const sharedKey = "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100";
  const host = "app-openapi-eu-pr.eufy.com";
  await writeFile(sessionPath, JSON.stringify({
    version: 2, country: "au", openUdid: "fresh-device",
    credentialVerifier: credentialVerifier("fresh-device", "user@example.invalid", "password"),
    authToken: "", tokenExpiresAt: 0, userId: "", megaDomain: "mega-eu-pr.eufy.com", domains: {},
    identities: { [host]: { keyIdent: "identity", sharedKey, clientPublicKey: "public" } },
  }));
  const requests: Array<{ path: string; token: string | null }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const token = new Headers(init?.headers).get("x-auth-token");
    requests.push({ path, token });
    if (path === "/passport/login" && !token) {
      return new Response(JSON.stringify({
        code: 26052,
        msg: "Verification required",
        data: {
          auth_token: "limited-token", user_id: "user", token_expires_at: 2_000_000_000,
          fa_info: { step: 26052 },
        },
      }));
    }
    if (path === "/app/sendmsg/verify_code") {
      return new Response(JSON.stringify({ code: 0, data: {} }));
    }
    if (path === "/passport/login") {
      return new Response(JSON.stringify({
        code: 0,
        data: { auth_token: "full-token", user_id: "user", token_expires_at: 2_000_000_000 },
      }));
    }
    throw new Error(`Unexpected Mega request: ${path}`);
  };

  try {
    const firstProcess = new MegaClient({
      email: "user@example.invalid", password: "password", country: "AU", persistentDirectory: directory,
      minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000, fetch: fakeFetch,
    });
    assert.deepEqual(await firstProcess.connect(), { state: "verification-required" });
    assert.equal(requests[1]?.token, "limited-token");
    assert.equal(JSON.parse(await readFile(sessionPath, "utf8")).authToken, "limited-token");
    assert.equal(JSON.parse(await readFile(sessionPath, "utf8")).verificationPending, true);

    const restartedProcess = new MegaClient({
      email: "user@example.invalid", password: "password", country: "AU", persistentDirectory: directory,
      minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000, fetch: fakeFetch,
    });
    assert.deepEqual(await restartedProcess.connect("123456"), { state: "authenticated" });
    assert.equal(requests.at(-1)?.token, "limited-token");
    assert.equal(JSON.parse(await readFile(sessionPath, "utf8")).authToken, "full-token");
    assert.equal(JSON.parse(await readFile(sessionPath, "utf8")).verificationPending, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ignores a stale configured verification code when a full session is valid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mega-stale-verification-"));
  const sessionPath = join(directory, "mega-session.json");
  await writeFile(sessionPath, JSON.stringify({
    version: 2, country: "au", openUdid: "device",
    credentialVerifier: credentialVerifier("device", "user@example.invalid", "password"),
    authToken: "full-token", tokenExpiresAt: 2_000_000_000, userId: "user",
    megaDomain: "mega-eu-pr.eufy.com", domains: {}, identities: {},
  }));

  try {
    const client = new MegaClient({
      email: "user@example.invalid", password: "password", country: "AU", persistentDirectory: directory,
      minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000,
      fetch: async () => { throw new Error("A valid restored session must not log in again"); },
    });
    assert.deepEqual(await client.connect("123456"), { state: "authenticated" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses the supported Mega inventory request and decrypts its response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mega-client-"));
  const sharedKey = "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100";
  const host = "app-openapi-eu-pr.eufy.com";
  const securityHost = "security-app-eu.eufylife.com";
  try {
    await writeFile(join(directory, "mega-session.json"), JSON.stringify({
      version: 2, country: "au", openUdid: "device", credentialVerifier: credentialVerifier("device", "user@example.invalid", "password"),
      authToken: "token", tokenExpiresAt: 2_000_000_000, userId: "user", megaDomain: "mega-eu-pr.eufy.com",
      domains: { eufy_security: "security-app.eufylife.com" }, identities: {
        [host]: { keyIdent: "identity", sharedKey, clientPublicKey: "public" },
        [securityHost]: { keyIdent: "security-identity", sharedKey, clientPublicKey: "public" },
      },
    }));
    const requests: Array<{ url: string; body: string; headers: Headers }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const body = String(init?.body ?? "");
      requests.push({ url: String(input), body, headers: new Headers(init?.headers) });
      const responseValue = String(input).endsWith("/v2/house/device_list")
        ? [{ device_sn: "camera", charging_days: 44 }]
        : { devices: [
          { device_sn: "camera", charging_days: 0 },
          { device_sn: "placeholder-only", charging_days: 0 },
        ], groups: [] };
      const data = encryptEnvelope(JSON.stringify(responseValue), sharedAesKey(sharedKey), Buffer.alloc(16, 1));
      return new Response(JSON.stringify({ code: 0, data }), { status: 200 });
    };
    const client = new MegaClient({
      email: "user@example.invalid", password: "password", country: "AU", persistentDirectory: directory,
      minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000, fetch: fakeFetch,
    });
    assert.deepEqual(await client.connect(), { state: "authenticated" });
    assert.deepEqual(await client.inventory(), { devices: [
      { device_sn: "camera", charging_days: 44 },
      { device_sn: "placeholder-only" },
    ], groups: [] });
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.url, "https://app-house-eu-pr.eufy.com/app/house/get_devs_list");
    assert.deepEqual(JSON.parse(decryptEnvelope(requests[0]!.body, sharedAesKey(sharedKey))), { house_id: "", device_sns: {} });
    assert.equal(requests[0]?.headers.get("x-key-ident"), "identity");
    assert.equal(requests[0]?.headers.has("x-signature"), true);
    assert.equal(requests[1]?.url, "https://security-app-eu.eufylife.com/v2/house/device_list");
    assert.equal(requests[1]?.headers.get("x-key-ident"), "security-identity");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fetches first-party PPCS DSK keys from the Mega device-relation API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mega-dsk-"));
  const sharedKey = "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100";
  const host = "app-openapi-eu-pr.eufy.com";
  try {
    await writeFile(join(directory, "mega-session.json"), JSON.stringify({
      version: 2, country: "au", openUdid: "device", credentialVerifier: credentialVerifier("device", "user@example.invalid", "password"),
      authToken: "token", tokenExpiresAt: 2_000_000_000, userId: "user", megaDomain: "mega-eu-pr.eufy.com",
      domains: {}, identities: { [host]: { keyIdent: "identity", sharedKey, clientPublicKey: "public" }, "app-devicerelation-eu-pr.eufy.com": { keyIdent: "identity", sharedKey, clientPublicKey: "public" } },
    }));
    const requests: string[] = [];
    const fakeFetch: typeof fetch = async (input, _init) => {
      requests.push(String(input));
      const data = encryptEnvelope(JSON.stringify({ device_dsks: [{ device_sn: "station", dsk_key: "dsk", expiration: 1_700_000_123 }] }), sharedAesKey(sharedKey), Buffer.alloc(16, 3));
      return new Response(JSON.stringify({ code: 0, data }), { status: 200 });
    };
    const client = new MegaClient({ email: "user@example.invalid", password: "password", country: "AU", persistentDirectory: directory, minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000, fetch: fakeFetch });
    await client.connect();
    assert.deepEqual(await client.dskKeys(["station"]), { station: { key: "dsk", expiresAt: 1_700_000_123_000 } });
    assert.equal(requests.at(-1), "https://app-devicerelation-eu-pr.eufy.com/app/devicerelation/get_dsk_keys");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fetches PPCS cipher keys through the regional eufy security API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mega-ciphers-"));
  const sharedKey = "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100";
  const host = "app-openapi-eu-pr.eufy.com";
  const securityHost = "security-app-eu.eufylife.com";
  try {
    await writeFile(join(directory, "mega-session.json"), JSON.stringify({
      version: 2, country: "au", openUdid: "device", credentialVerifier: credentialVerifier("device", "user@example.invalid", "password"),
      authToken: "token", tokenExpiresAt: 2_000_000_000, userId: "user", megaDomain: "mega-eu-pr.eufy.com",
      domains: { eufy_security: "security-app.eufylife.com" }, identities: {
        [host]: { keyIdent: "identity", sharedKey, clientPublicKey: "public" },
        [securityHost]: { keyIdent: "security-identity", sharedKey, clientPublicKey: "public" },
      },
    }));
    const requests: Array<{ url: string; headers: Headers }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      const data = encryptEnvelope(JSON.stringify([{ cipher_id: 197, ecc_private_key: "ecc", private_key: "private" }]), sharedAesKey(sharedKey), Buffer.alloc(16, 4));
      return new Response(JSON.stringify({ code: 0, data }), { status: 200 });
    };
    const client = new MegaClient({ email: "user@example.invalid", password: "password", country: "AU", persistentDirectory: directory, minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000, fetch: fakeFetch });
    await client.connect();
    assert.deepEqual(await client.getCiphers([197], "user", "station"), [{ cipher_id: 197, ecc_private_key: "ecc", private_key: "private" }]);
    assert.equal(requests.at(-1)?.url, "https://security-app-eu.eufylife.com/v3/app/cipher/get_ciphers");
    assert.equal(requests.at(-1)?.headers.get("content-type"), "application/json");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session recovery recognises only the exact HTTP401 request error", () => {
  const client = new MegaClient({ email: "fixture@example.invalid", password: "redacted", country: "AU", persistentDirectory: "/nonexistent/fixture" });
  for (const message of ["Mega request failed (HTTP 401)", "Mega request failed (4404: invalid)",
    "Mega request failed (26084: invalid)", "Mega request failed (26884: invalid)", "Mega request failed (401: token not exist)"]) {
    assert.equal(client.isSessionInvalidError(new Error(message)), true, message);
  }
  for (const value of [new Error("Mega request failed (HTTP 403)"), new Error("Mega request failed (HTTP 404)"),
    new Error("Mega request failed (HTTP 429)"), new Error("Mega request failed (HTTP 500)"),
    new Error("Mega media download failed (HTTP 401)"), new Error("prefix Mega request failed (HTTP 401)"),
    new Error("Mega request failed (HTTP 401) suffix"), "Mega request failed (HTTP 401)", { message: "Mega request failed (HTTP 401)" }, null]) {
    assert.equal(client.isSessionInvalidError(value), false);
  }
});

test("restored inventory and media HTTP401 retain distinct recovery decisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mega-http401-"));
  const host = "app-openapi-eu-pr.eufy.com";
  const session = { version: 2, country: "au", openUdid: "device",
    credentialVerifier: credentialVerifier("device", "fixture@example.invalid", "redacted"),
    authToken: "token", tokenExpiresAt: 2_000_000_000, userId: "user", megaDomain: "mega-eu-pr.eufy.com", domains: {},
    identities: { [host]: { keyIdent: "identity", sharedKey: "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100", clientPublicKey: "public" } } };
  const urls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => { urls.push(String(input)); return new Response("", { status: 401 }); };
  try {
    await writeFile(join(directory, "mega-session.json"), JSON.stringify(session));
    const client = new MegaClient({ email: "fixture@example.invalid", password: "redacted", country: "AU",
      persistentDirectory: directory, now: () => 1_700_000_000_000, minimumRequestIntervalMs: 0, fetch: fakeFetch });
    await client.connect();
    await assert.rejects(client.inventory(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Mega request failed (HTTP 401)");
      assert.equal(client.isSessionInvalidError(error), true);
      return true;
    });
    await assert.rejects(client.download("https://security-app.eufylife.com/fixture.jpg"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Mega media download failed (HTTP 401)");
      assert.equal(client.isSessionInvalidError(error), false);
      return true;
    });
    assert.equal(urls.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
