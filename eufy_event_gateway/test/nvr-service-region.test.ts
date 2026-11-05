/**
 * Verifies credential-free WEB discovery and signing on its independent region.
 * Tests own synthetic fetch responses and temporary session files. No real
 * account or camera is contacted, and the Mega client consumes the result.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverNvrServiceRegion } from "../src/mega/nvr-service-region.js";
import { MegaClient } from "../src/mega/client.js";
import { credentialVerifier } from "../src/mega/crypto.js";

test("WEB discovery accepts only exact service domains and sends no account identity", async () => {
  for (const region of ["ie", "eu", "us"] as const) {
    const value = await discoverNvrServiceRegion(async (input, init) => {
      assert.equal(String(input), "https://mega-eu-pr.eufy.com/passport/estimate_domain");
      assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), {
        "app-name": "eufy_mega", "content-type": "application/json", "model-type": "WEB",
      });
      assert.equal(init?.redirect, "manual");
      assert.equal(init?.body, JSON.stringify({ ab: "gb", mode: 1 }));
      return new Response(JSON.stringify({ code: 0, data: { domain: `mega-${region}-pr.eufy.com` } }));
    }, "GB", new AbortController().signal);
    assert.equal(value, region);
  }
});

test("discovery rejects redirects, untrusted domains, malformed and oversized replies", async () => {
  for (const response of [
    new Response("private body", { status: 302, headers: { location: "https://untrusted.invalid" } }),
    new Response("private body", { status: 503 }),
    new Response(JSON.stringify({ code: 401, data: { domain: "mega-ie-pr.eufy.com" } })),
    new Response(JSON.stringify({ code: 0, data: { domain: "mega-ie-pr.eufy.com.untrusted.invalid" } })),
    new Response("null"), new Response("[]"), new Response("{}"), new Response("not JSON"),
    new Response("x".repeat(65_537)),
  ]) {
    await assert.rejects(discoverNvrServiceRegion(async () => response, "GB", new AbortController().signal));
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverNvrServiceRegion(async () => assert.fail("cancelled discovery dispatched"), "US", controller.signal));
});

for (const mode of ["auto", "override", "untrusted", "cancelled"] as const) {
  test(`RTC ${mode} keeps WEB routing separate from the restored PHONE session`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "web-sign-region-"));
    const session = { version: 2, country: "gb", openUdid: "synthetic-device",
      credentialVerifier: credentialVerifier("synthetic-device", "user@example.invalid", "password"),
      authToken: "synthetic-token", tokenExpiresAt: 2_000_000_000, userId: "synthetic-user",
      megaDomain: "mega-eu-pr.eufy.com", domains: { eufy_security: "security-app-eu.eufylife.com" }, identities: {} };
    const path = join(directory, "mega-session.json");
    await writeFile(path, JSON.stringify(session));
    const calls: string[] = [], controller = new AbortController();
    const client = new MegaClient({ email: "user@example.invalid", password: "password", country: "GB",
      persistentDirectory: directory, minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000,
      fetch: async (input, init) => {
        const url = new URL(String(input)); calls.push(url.pathname);
        if (url.pathname === "/passport/estimate_domain") {
          assert.equal(new Headers(init?.headers).has("x-auth-token"), false);
          if (mode === "cancelled") controller.abort();
          return new Response(JSON.stringify({ code: 0, data: { domain: mode === "untrusted" ? "untrusted.invalid" : "mega-ie-pr.eufy.com" } }));
        }
        assert.equal(url.hostname, mode === "override" ? "security-smart-eu.eufylife.com" : "security-smart-ie.eufylife.com");
        assert.equal(new Headers(init?.headers).get("x-auth-token"), "synthetic-token");
        return new Response(JSON.stringify({ code: 0, data: "synthetic-sign" }));
      } });
    try {
      await client.connect();
      const result = client.nvrSignallingContext("synthetic-station", mode === "override" ? "eu" : "auto", controller.signal);
      if (mode === "untrusted" || mode === "cancelled") {
        await assert.rejects(result);
        assert.deepEqual(calls, ["/passport/estimate_domain"]);
      } else {
        assert.equal((await result).region, mode === "override" ? "EU" : "IE");
        assert.deepEqual(calls, mode === "override" ? ["/v1/smart/nvr/ws/sign"] : ["/passport/estimate_domain", "/v1/smart/nvr/ws/sign"]);
      }
      assert.equal(client.isAuthenticated, true);
    } finally {
      client.cancelPendingRequests();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
