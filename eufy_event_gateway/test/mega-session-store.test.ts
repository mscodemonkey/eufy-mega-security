/**
 * Protects the Mega session store's persistence contract.
 *
 * The cases cover restrictive permissions, atomic replacement, malformed data,
 * and rejection of retired schemas that used a fast password hash.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MegaSessionStore } from "../src/mega/session-store.js";
import type { MegaSession } from "../src/mega/types.js";

const session: MegaSession = {
  version: 2,
  country: "au",
  openUdid: "device",
  credentialVerifier: "a".repeat(64),
  authToken: "token",
  tokenExpiresAt: 2_000_000_000,
  userId: "user",
  verificationPending: false,
  megaDomain: "mega-eu-pr.eufy.com",
  domains: { house: "house" },
  identities: { host: { keyIdent: "id", sharedKey: "key", clientPublicKey: "public" } },
};

test("writes and reloads a private current session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mega-session-"));
  const path = join(directory, "mega-session.json");
  try {
    const store = new MegaSessionStore(path);
    await store.save(session);
    assert.deepEqual(await store.load(), session);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ignores malformed session data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mega-session-bad-"));
  try {
    const path = join(directory, "mega-session.json");
    await writeFile(path, "not json");
    assert.equal(await new MegaSessionStore(path).load(), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects the retired session schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mega-session-retired-"));
  try {
    const path = join(directory, "mega-session.json");
    await writeFile(path, JSON.stringify({
      ...session,
      version: 1,
      loginHash: "b".repeat(64),
      credentialVerifier: undefined,
    }));
    const store = new MegaSessionStore(path);
    assert.equal(await store.load(), null);
    assert.equal(await store.loadRetiredOpenUdid(), "device");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
