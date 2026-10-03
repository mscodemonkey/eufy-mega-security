/**
 * Owns on-disk persistence for the native Mega session.
 *
 * The store validates the current session schema before returning it and writes
 * restrictive, atomically replaced JSON. It stores session metadata and
 * derived host key material only; plaintext passwords, CAPTCHA answers,
 * verification codes, and media bytes are never persisted here.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { MegaIdentity, MegaSession } from "./types.js";

/**
 * Atomic file store for native Mega sessions.
 * It intentionally rejects older schemas whose credential guard used a fast
 * password hash, requiring one fresh login after the security upgrade.
 */
export class MegaSessionStore {

  /** Create a store for the current private session path. */
  constructor(private readonly path: string) {}

  /** Load a valid current session or return null for missing, malformed, or retired schemas. */
  async load(): Promise<MegaSession | null> {
    return parseSession(await readJson(this.path));
  }

  /** Recover only the non-secret device identifier from a retired version 1 session. */
  async loadRetiredOpenUdid(): Promise<string | null> {
    const value = await readJson(this.path);
    if (!isRecord(value) || value.version !== 1 || typeof value.openUdid !== "string") return null;
    return value.openUdid.length > 0 ? value.openUdid : null;
  }

  /** Persist a session with restrictive permissions and atomic replacement. */
  async save(session: MegaSession): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function parseSession(value: unknown): MegaSession | null {
  if (!isRecord(value) || value.version !== 2) return null;
  return validatedSession(value);
}

function validatedSession(value: Record<string, unknown>): MegaSession | null {
  const identities = parseIdentities(value.identities);
  if (
    typeof value.country !== "string" || typeof value.openUdid !== "string" ||
    typeof value.credentialVerifier !== "string" || !/^[0-9a-f]{64}$/i.test(value.credentialVerifier) ||
    typeof value.authToken !== "string" ||
    typeof value.tokenExpiresAt !== "number" || typeof value.userId !== "string" ||
    value.verificationPending !== undefined && typeof value.verificationPending !== "boolean" ||
    typeof value.megaDomain !== "string" || !isStringRecord(value.domains) || !identities
  ) return null;
  return {
    version: 2,
    country: value.country,
    openUdid: value.openUdid,
    credentialVerifier: value.credentialVerifier,
    authToken: value.authToken,
    tokenExpiresAt: value.tokenExpiresAt,
    userId: value.userId,
    verificationPending: value.verificationPending === true,
    megaDomain: value.megaDomain,
    domains: value.domains,
    identities,
  };
}

function parseIdentities(value: unknown): Record<string, MegaIdentity> | null {
  if (!isRecord(value)) return null;
  const parsed: Record<string, MegaIdentity> = {};
  for (const [host, identity] of Object.entries(value)) {
    if (!isRecord(identity) || typeof identity.keyIdent !== "string" ||
      typeof identity.sharedKey !== "string" || typeof identity.clientPublicKey !== "string") return null;
    parsed[host] = {
      keyIdent: identity.keyIdent,
      sharedKey: identity.sharedKey,
      clientPublicKey: identity.clientPublicKey,
    };
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}
