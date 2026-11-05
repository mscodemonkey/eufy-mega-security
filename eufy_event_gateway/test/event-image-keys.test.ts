/**
 * Verifies owner-scoped picture-key reads against synthetic HTTPS responses.
 * Each test owns its temporary session and fake network. No real key, account,
 * device or remote service is used, and live cipher lookup is never substituted.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MegaClient } from "../src/mega/client.js";
import { credentialVerifier, decryptEnvelope, sharedAesKey } from "../src/mega/crypto.js";

/** Supply one cached fake session and a request observer to the test owner. */
async function fixture(run: (client: MegaClient, state: {
  data: unknown; code: number; calls: Array<{ path: string; body: unknown }>;
  beforeResponse?: () => void | Promise<void>;
}) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "picture-keys-"));
  const sharedKey = Buffer.alloc(32, 7).toString("hex");
  const state: Parameters<typeof run>[1] = { data: {}, code: 0, calls: [] };
  try {
    await writeFile(join(directory, "mega-session.json"), JSON.stringify({
      version: 2, country: "au", openUdid: "synthetic-client",
      credentialVerifier: credentialVerifier("synthetic-client", "test@example.invalid", "synthetic-password"),
      authToken: "synthetic-token", tokenExpiresAt: 2_000_000_000, userId: "synthetic-owner",
      megaDomain: "mega-eu-pr.eufy.com", domains: { eufy_security: "security-app-eu.eufylife.com" },
      identities: { "security-app-eu.eufylife.com": { keyIdent: "synthetic-identity", sharedKey, clientPublicKey: "synthetic-public" } },
    }));
    const client = new MegaClient({
      email: "test@example.invalid", password: "synthetic-password", country: "AU", persistentDirectory: directory,
      minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.hostname, "security-app-eu.eufylife.com");
        assert.equal(new Headers(init?.headers).get("x-key-ident"), "synthetic-identity");
        assert.ok(new Headers(init?.headers).get("x-signature"));
        assert.equal(init?.redirect, "error");
        assert.ok(init?.signal);
        state.calls.push({ path: url.pathname, body: JSON.parse(decryptEnvelope(String(init?.body), sharedAesKey(sharedKey))) });
        await state.beforeResponse?.();
        return new Response(JSON.stringify({ code: state.code, data: state.data }));
      },
    });
    await client.connect();
    await run(client, state);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("picture key uses the account key list and exact signed read", async () => {
  await fixture(async (client, state) => {
    state.data = { simple_security_keys: [null, { pincode_id: 4 }, { pincode_id: 10, private_key: "01".repeat(32) }] };
    const key = await client.getEventImageKey(10, "synthetic-owner");
    assert.deepEqual(key, Buffer.alloc(32, 1));
    key.fill(0);
    assert.deepEqual(state.calls, [{ path: "/v2/commerce/get_current_subscription", body: {
      new_etoe_version: 1, service_code: "all.service", is_new_version: 1,
      has_eufy_protection_pro: 2, transaction: "1700000000000",
    } }]);
  });
});

test("picture key rejects wrong owners and invalid selectors before dispatch", async () => {
  await fixture(async (client, state) => {
    for (const id of [0, 1, 256, -1, 2.5, NaN]) {
      await assert.rejects(client.getEventImageKey(id, "synthetic-owner"), /^Error: Event picture key unavailable$/);
    }
    for (const owner of ["", "another-owner"]) {
      await assert.rejects(client.getEventImageKey(10, owner), /key unavailable/);
    }
    assert.equal(state.calls.length, 0);
  });
});

test("picture key rejects absent, duplicate, protected and malformed metadata", async () => {
  await fixture(async (client, state) => {
    const row = { pincode_id: 10, private_key: "01".repeat(32) };
    for (const data of [null, {}, { simple_security_keys: "[]" }, { simple_security_keys: [] },
      { simple_security_keys: Array(257).fill(row) }, { simple_security_keys: [row, row] },
      { simple_security_keys: [{ ...row, pincode_id: "10" }] },
      ...["1".repeat(63), "1".repeat(65), "z".repeat(64), "protected-private-value"].map(private_key =>
        ({ simple_security_keys: [{ ...row, private_key }] }))]) {
      state.data = data;
      await assert.rejects(client.getEventImageKey(10, "synthetic-owner"), /^Error: Event picture key unavailable$/);
    }
  });
});

test("picture key has no automatic identity retry and discards cancelled work", async () => {
  await fixture(async (client, state) => {
    state.code = 4404;
    await assert.rejects(client.getEventImageKey(10, "synthetic-owner"), /^Error: Event picture key lookup failed$/);
    assert.equal(state.calls.length, 1);
    state.code = 0;
    state.data = { simple_security_keys: [{ pincode_id: 10, private_key: "01".repeat(32) }] };
    state.beforeResponse = () => client.cancelPendingRequests();
    await assert.rejects(client.getEventImageKey(10, "synthetic-owner"), /^Error: Event picture key lookup failed$/);
    assert.equal(state.calls.length, 2);
  });
});

test("burst picture reads are serialized and return separate caller-owned buffers", async () => {
  await fixture(async (client, state) => {
    let active = 0, maximum = 0;
    state.data = { simple_security_keys: [{ pincode_id: 10, private_key: "01".repeat(32) }] };
    state.beforeResponse = async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise<void>(resolve => setImmediate(resolve));
      --active;
    };
    const keys = await Promise.all(Array.from({ length: 4 }, () => client.getEventImageKey(10, "synthetic-owner")));
    assert.equal(maximum, 1);
    assert.equal(state.calls.length, 4);
    keys[0]!.fill(0);
    assert.deepEqual(keys[1], Buffer.alloc(32, 1));
    for (const key of keys) key.fill(0);
  });
});
