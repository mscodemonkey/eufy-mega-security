/**
 * Exercises media-key recovery with synthetic encrypted HTTPS responses.
 * Each test owns an isolated session directory and fake server. No account or
 * camera is contacted, and success proves client retry rules rather than video.
 */
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MegaClient } from "../src/mega/client.js";
import { credentialVerifier, decryptEnvelope, encryptEnvelope, sharedAesKey, EUFYLIFE_PRESET_KEY } from "../src/mega/crypto.js";

/** Isolate session persistence while exposing only counters and fake-clock controls. */
async function fixture(mode: "success" | "empty" | "limit" | "non-json" | "cancel", run: (state: {
  client: MegaClient; exchanges: () => number; reads: () => number; advance: () => void; saved: () => Promise<{ identities: { "security-app-eu.eufylife.com": { keyIdent: string } } }>;
}) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mega-cipher-recovery-"));
  const host = "security-app-eu.eufylife.com";
  let key = "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100";
  let clock = 1_700_000_000_000, exchanges = 0, reads = 0;
  const file = join(directory, "mega-session.json");
  let client: MegaClient;
  try {
    await writeFile(file, JSON.stringify({ version: 2, country: "au", openUdid: "device",
      credentialVerifier: credentialVerifier("device", "user@example.invalid", "password"),
      authToken: "retained-token", tokenExpiresAt: 2_000_000_000, userId: "user", megaDomain: "mega-eu-pr.eufy.com",
      domains: { eufy_security: "security-app.eufylife.com" },
      identities: { [host]: { keyIdent: "stale", sharedKey: key, clientPublicKey: "public" } },
    }));
    client = new MegaClient({ email: "user@example.invalid", password: "password", country: "AU",
      persistentDirectory: directory, minimumRequestIntervalMs: 0, now: () => clock,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("x-auth-token"), "retained-token");
        if (path === "/v3/openapi/oauth/key/exchange") {
          assert.equal(headers.get("content-type"), "application/json");
          assert.equal(headers.has("app-tab"), false);
          exchanges++;
          if (mode === "cancel") {
            client.cancelPendingRequests();
            throw new DOMException("Cancelled", "AbortError");
          }
          const point = decryptEnvelope(JSON.parse(String(init?.body)).client_public_key, Buffer.from(EUFYLIFE_PRESET_KEY, "hex"));
          const server = createECDH("prime256v1");
          server.generateKeys();
          key = server.computeSecret(Buffer.from(point, "hex")).toString("hex");
          return new Response(JSON.stringify({ code: 0, data: {
            server_public_key: encryptEnvelope(server.getPublicKey("hex"), Buffer.from(EUFYLIFE_PRESET_KEY, "hex")),
          } }));
        }
        assert.equal(path, "/v3/app/cipher/get_ciphers", "recovery cannot log in or send a device write");
        assert.equal(headers.get("content-type"), "text/plain");
        assert.equal(headers.get("app-tab"), "eufy_security");
        assert.equal(headers.get("app-name"), "eufy_mega");
        reads++;
        if (mode === "limit") return new Response(JSON.stringify({ code: 100028 }), { status: 463 });
        if (mode === "non-json") return new Response("not-json", { status: 463 });
        if (mode !== "success" || headers.get("x-key-ident") === "stale") return new Response("", { status: 463 });
        return new Response(JSON.stringify({ code: 0, data: encryptEnvelope("[]", sharedAesKey(key)) }));
      },
    });
    await client.connect();
    await run({ client, exchanges: () => exchanges, reads: () => reads, advance: () => { clock += 10 * 60_000; },
      saved: async () => JSON.parse(await readFile(file, "utf8")) });
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.authToken, "retained-token");
    assert.equal(saved.userId, "user");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("replays only the cipher read using renewed keys and the retained account token", async () => {
  await fixture("success", async ({ client, exchanges, reads, saved }) => {
    assert.deepEqual(await client.getCiphers([197], "user", "station"), []);
    assert.equal(exchanges(), 1);
    assert.equal(reads(), 2);
    assert.notEqual((await saved()).identities["security-app-eu.eufylife.com"].keyIdent, "stale");
  });
});

test("shares recovery including atomic persistence across concurrent rejected cameras", async () => {
  await fixture("success", async ({ client, exchanges, reads }) => {
    assert.deepEqual(await Promise.all([client.getCiphers([1], "user", "station"), client.getCiphers([2], "user", "station")]), [[], []]);
    assert.equal(exchanges(), 1);
    assert.equal(reads(), 4);
  });
});

test("limits a persistent empty rejection to one renewal per host cooldown", async () => {
  await fixture("empty", async ({ client, exchanges, reads, advance }) => {
    await assert.rejects(client.getCiphers([1], "user", "station"), /HTTP 463 response empty_or_truncated/);
    assert.equal(reads(), 2);
    await assert.rejects(client.getCiphers([2], "user", "station"));
    assert.equal(exchanges(), 1);
    assert.equal(reads(), 3);
    advance();
    await assert.rejects(client.getCiphers([3], "user", "station"));
    assert.equal(exchanges(), 2);
    assert.equal(reads(), 5);
  });
});

test("leaves login-limit and unrelated rejections terminal without changing identity", async () => {
  for (const mode of ["limit", "non-json"] as const) {
    await fixture(mode, async ({ client, exchanges, reads, saved }) => {
      await assert.rejects(client.getCiphers([1], "user", "station"));
      assert.equal(exchanges(), 0);
      assert.equal(reads(), 1);
      assert.equal((await saved()).identities["security-app-eu.eufylife.com"].keyIdent, "stale");
    });
  }
});

test("cancellation prevents recovery replay and persistence of a late identity", async () => {
  await fixture("cancel", async ({ client, exchanges, reads, saved }) => {
    await assert.rejects(client.getCiphers([1], "user", "station"));
    assert.equal(exchanges(), 1);
    assert.equal(reads(), 1);
    assert.equal((await saved()).identities["security-app-eu.eufylife.com"].keyIdent, "stale");
  });
});
