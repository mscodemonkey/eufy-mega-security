/**
 * Exercises cloud queue and identity ownership with synthetic encrypted servers.
 * The fixtures own all keys and temporary sessions, and never contact Eufy.
 */
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { MegaClient } from "../src/mega/client.js";
import { credentialVerifier, decryptEnvelope, encryptEnvelope, presetKey, sharedAesKey, sharedSigningKey, requestSignature } from "../src/mega/crypto.js";

const host = "app-openapi-eu-pr.eufy.com";
const sharedKey = "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100";

async function fixture(fetcher: typeof fetch, withIdentity = true, interval = 0): Promise<{ client: MegaClient; dispose: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "mega-ownership-"));
  await writeFile(join(directory, "mega-session.json"), JSON.stringify({
    version: 2, country: "au", openUdid: "synthetic-device",
    credentialVerifier: credentialVerifier("synthetic-device", "user@example.invalid", "password"),
    authToken: "synthetic-token", tokenExpiresAt: 2_000_000_000, userId: "synthetic-user",
    megaDomain: "mega-eu-pr.eufy.com", domains: { eufy_security: "security-app-eu.eufylife.com" },
    identities: withIdentity ? {
      [host]: { keyIdent: "original", sharedKey, clientPublicKey: "public" },
      "security-app-eu.eufylife.com": { keyIdent: "security", sharedKey, clientPublicKey: "public" },
    } : {},
  }));
  const client = new MegaClient({
    email: "user@example.invalid", password: "password", country: "AU", persistentDirectory: directory,
    minimumRequestIntervalMs: interval, fetch: fetcher,
  });
  await client.connect();
  return { client, dispose: async () => { client.cancelPendingRequests(); await rm(directory, { recursive: true, force: true }); } };
}

function encrypted(data: unknown, key = sharedKey): Response {
  return new Response(JSON.stringify({ code: 0, data: encryptEnvelope(JSON.stringify(data), sharedAesKey(key)) }));
}

test("simultaneous startup readers exchange one identity and dispatch with spacing", async () => {
  let exchanges = 0;
  let key = "";
  const starts: number[] = [];
  const f = await fixture(async (input, init) => {
    starts.push(Date.now());
    const path = new URL(String(input)).pathname;
    if (path === "/openapi/oauth/key/exchange") {
      exchanges++;
      const body = JSON.parse(String(init?.body));
      const publicKey = decryptEnvelope(body.client_public_key, presetKey());
      const server = createECDH("prime256v1");
      server.generateKeys();
      key = server.computeSecret(Buffer.from(publicKey, "hex")).toString("hex");
      await delay(10);
      return new Response(JSON.stringify({ code: 0, data: { server_public_key: encryptEnvelope(server.getPublicKey("hex"), presetKey()) } }));
    }
    return encrypted({ device_dsks: [] }, key);
  }, false, 30);
  try {
    await Promise.all([f.client.dskKeys(["synthetic-a"]), f.client.dskKeys(["synthetic-b"]), f.client.dskKeys(["synthetic-c"])]);
    assert.equal(exchanges, 1);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! >= 25);
  } finally { await f.dispose(); }
});

test("an identity rejection refreshes only its host and keeps queued responses on their original key", async () => {
  let rejected = false;
  let replacement = "";
  const keys: string[] = [];
  const f = await fixture(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const headers = new Headers(init?.headers);
    if (path === "/openapi/oauth/key/exchange") {
      const publicKey = decryptEnvelope(JSON.parse(String(init?.body)).client_public_key, presetKey());
      const server = createECDH("prime256v1"); server.generateKeys();
      replacement = server.computeSecret(Buffer.from(publicKey, "hex")).toString("hex");
      return new Response(JSON.stringify({ code: 0, data: { server_public_key: encryptEnvelope(server.getPublicKey("hex"), presetKey()) } }));
    }
    keys.push(headers.get("x-key-ident")!);
    if (!rejected) { rejected = true; return new Response(JSON.stringify({ code: 4404 })); }
    const key = headers.get("x-key-ident") === "original" ? sharedKey : replacement;
    return encrypted({ device_dsks: [] }, key);
  });
  try {
    assert.deepEqual(await Promise.all([f.client.dskKeys(["synthetic-a"]), f.client.dskKeys(["synthetic-b"])]), [{}, {}]);
    assert.equal(keys.filter((key) => key === "original").length, 2);
  } finally { await f.dispose(); }
});

test("HTTP failures and malformed bodies stay private and do not poison the request queue", async () => {
  const replies = [new Response('{"code":0,"data":{}}', { status: 503 }), new Response('private-token private-device'), new Response('{"code":"0"}'), encrypted({ device_dsks: [] })];
  const f = await fixture(async () => replies.shift()!);
  try {
    await assert.rejects(f.client.dskKeys([]), /^Error: Mega request failed \(HTTP 503\)$/);
    await assert.rejects(f.client.dskKeys([]), /^Error: Mega response validation failed \(JSON\)$/);
    await assert.rejects(f.client.dskKeys([]), /^Error: Mega response validation failed \(envelope\)$/);
    assert.deepEqual(await f.client.dskKeys([]), {});
  } finally { await f.dispose(); }
});

test("cancelling active and queued work prevents late dispatch and permits a clean reconnect", async () => {
  let calls = 0;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const f = await fixture(async (_input, init) => {
    calls++;
    if (calls === 1) {
      started();
      await delay(10_000, undefined, { signal: init?.signal ?? undefined });
    }
    return encrypted({ device_dsks: [] });
  });
  try {
    const pending = Promise.allSettled([f.client.dskKeys([]), f.client.dskKeys([])]);
    await ready;
    f.client.cancelPendingRequests();
    assert.deepEqual((await pending).map((x) => x.status), ["rejected", "rejected"]);
    assert.equal(calls, 1);
    await f.client.connect();
    assert.deepEqual(await f.client.dskKeys([]), {});
    assert.equal(calls, 2);
  } finally { await f.dispose(); }
});

test("a present general-service signature is checked before encrypted response decoding", async () => {
  for (const valid of [false, true]) {
    const f = await fixture(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const data = encryptEnvelope(JSON.stringify([]), sharedAesKey(sharedKey));
      const signature = valid ? requestSignature(sharedSigningKey(sharedKey), headers.get("x-request-ts")!, headers.get("x-request-once")!, data) : "0".repeat(64);
      return new Response(JSON.stringify({ code: 0, data, signature }));
    });
    try {
      if (valid) assert.deepEqual(await f.client.getCiphers([1], "synthetic-owner", "synthetic-station"), []);
      else await assert.rejects(f.client.getCiphers([1], "synthetic-owner", "synthetic-station"), /validation failed \(signature\)/);
    } finally { await f.dispose(); }
  }
});


test("cloud history binds signed metadata to one camera and preserves shared ownership", async () => {
  for (const outcome of ["valid", "missing-signature", "wrong-camera", "empty", "null"]) {
    let requestBody: unknown;
    const f = await fixture(async (_input, init) => {
      requestBody = JSON.parse(decryptEnvelope(String(init?.body), sharedAesKey(sharedKey)));
      const data = encryptEnvelope(JSON.stringify(outcome === "null" ? null : outcome === "empty" ? [] : [{
        monitor_id: "record-1", device_sn: outcome === "wrong-camera" ? "other" : "synthetic-camera",
        start_time: 100, end_time: 120, cloud_path: "private-temporary-url", extra: "private-key-material",
        cipher_user_id: "guest", member: { action_user_id: "owner" },
      }]), sharedAesKey(sharedKey));
      const headers = new Headers(init?.headers);
      const signature = outcome === "missing-signature" ? undefined : requestSignature(
        sharedSigningKey(sharedKey), headers.get("x-request-ts")!, headers.get("x-request-once")!, data,
      );
      return new Response(JSON.stringify({ code: 0, data, signature }));
    });
    try {
      const query = { startTime: 90, endTime: 130, timezoneOffset: 36_000, cursor: 2, count: 50 };
      if (outcome === "missing-signature") await assert.rejects(f.client.cloudHistory("synthetic-camera", query), /signature/);
      else if (outcome === "wrong-camera") await assert.rejects(f.client.cloudHistory("synthetic-camera", query), /invalid record/);
      else {
        const records = await f.client.cloudHistory("synthetic-camera", query);
        assert.deepEqual(records, (outcome === "null" || outcome === "empty") ? [] : [{ id: "record-1", startTime: 100, endTime: 120, ownerId: "owner", hasCloudMedia: true }]);
        assert.doesNotMatch(JSON.stringify(records), /private/);
      }
      assert.deepEqual(requestBody, {
        device_sn: "synthetic-camera", start_time: 90, end_time: 130, offset: 36_000,
        id: 2, num: 50, pullup: true, shared: true, storage: 2,
      });
      await assert.rejects(f.client.cloudHistory("synthetic-camera", { startTime: 0, endTime: 99_999_999 }), /Invalid cloud history query/);
    } finally { await f.dispose(); }
  }
});

test("a restored verification-only session cannot fetch inventory or resend codes autonomously", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mega-limited-session-"));
  await writeFile(join(directory, "mega-session.json"), JSON.stringify({
    version: 2, country: "au", openUdid: "synthetic-device",
    credentialVerifier: credentialVerifier("synthetic-device", "user@example.invalid", "password"),
    authToken: "limited-token", tokenExpiresAt: 2_000_000_000, userId: "synthetic-user",
    verificationPending: true, megaDomain: "mega-eu-pr.eufy.com", domains: {}, identities: {},
  }));
  const client = new MegaClient({
    email: "user@example.invalid", password: "password", country: "AU", persistentDirectory: directory,
    minimumRequestIntervalMs: 0, fetch: async () => assert.fail("Verification still needs user input"),
  });
  try {
    assert.deepEqual(await client.connect(), { state: "verification-required" });
    assert.equal(client.isAuthenticated, false);
    await assert.rejects(client.inventory(), /authentication is required/);
    assert.deepEqual(await client.connect(), { state: "verification-required" });
  } finally { client.cancelPendingRequests(); await rm(directory, { recursive: true, force: true }); }
});


test("concurrent connect calls share restoration and conflicting challenge submissions are refused", async () => {
  const f = await fixture(async () => assert.fail("A valid session needs no login"));
  try {
    const connecting = f.client.connect();
    const duplicate = f.client.connect();
    await assert.rejects(f.client.connect("123456"), /authentication is already in progress/);
    assert.deepEqual(await Promise.all([connecting, duplicate]), [{ state: "authenticated" }, { state: "authenticated" }]);
  } finally { await f.dispose(); }
});
