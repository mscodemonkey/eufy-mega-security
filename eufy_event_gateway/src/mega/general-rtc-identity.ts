/**
 * Validates the optional login identity used by the general portal RTC trial.
 * MegaClient owns persistence and account binding. This pure boundary retains
 * secrets only inside the returned cipher and performs no network operations.
 */
import { createCipheriv, createDecipheriv, createECDH, createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { LOGIN_SERVER_PUBLIC_KEY } from "./crypto.js";
import type { MegaSession } from "./types.js";

/** Private schema stored only when the owner has enabled the RTC experiment. */
export interface GeneralRtcIdentity {
  readonly version: 1;
  readonly scalar: string;
  readonly clientPublicKey: string;
  readonly serverKey: string;
  readonly serverKeySource: "login" | "login_default";
  readonly userId: string;
  readonly openUdid: string;
  readonly tokenDigest: string;
  readonly securityHost: string;
}

/** Bound message encryption exposed without exporting the private login scalar. */
export interface GeneralRtcCipher {
  readonly bindingKey: string;

  /** Encode one bounded UTF-8 portal message with the login ECDH secret. */
  encrypt(plaintext: string): string;

  /** Decode a canonical base64 portal message, rejecting malformed UTF-8. */
  decrypt(ciphertext: string): string;
}

const publicKeyPattern = /^04[0-9a-f]{128}$/;
const identifierPattern = /^[A-Za-z0-9_-]{1,255}$/;

function validPublicKey(value: string): boolean {
  if (!publicKeyPattern.test(value)) return false;
  try {
    const probe = createECDH("prime256v1");
    probe.generateKeys();
    probe.computeSecret(Buffer.from(value, "hex"));
    return true;
  } catch { return false; }
}

/** Parse the private optional field without invalidating an otherwise valid session. */
export function parseGeneralRtcIdentity(value: unknown): GeneralRtcIdentity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || typeof row.scalar !== "string" || !/^[0-9a-f]{64}$/.test(row.scalar)
    || typeof row.clientPublicKey !== "string" || !validPublicKey(row.clientPublicKey)
    || typeof row.serverKey !== "string"
    || row.serverKey !== "login_default" && !validPublicKey(row.serverKey)
    || row.serverKeySource !== "login" && row.serverKeySource !== "login_default"
    || (row.serverKey === "login_default") !== (row.serverKeySource === "login_default")
    || typeof row.userId !== "string" || !identifierPattern.test(row.userId)
    || typeof row.openUdid !== "string" || !identifierPattern.test(row.openUdid)
    || typeof row.tokenDigest !== "string" || !/^[0-9a-f]{64}$/.test(row.tokenDigest)
    || typeof row.securityHost !== "string" || !/^security-app(?:-(?:eu|ie))?\.eufylife\.com$/.test(row.securityHost)) return null;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(row.scalar, "hex"));
    if (ecdh.getPublicKey("hex") !== row.clientPublicKey) return null;
  } catch { return null; }
  return { version: 1, scalar: row.scalar, clientPublicKey: row.clientPublicKey, serverKey: row.serverKey,
    serverKeySource: row.serverKeySource, userId: row.userId, openUdid: row.openUdid,
    tokenDigest: row.tokenDigest, securityHost: row.securityHost };
}

/** Capture only the final successful login pair, refusing malformed supplied server keys. */
export function captureGeneralRtcIdentity(session: MegaSession, securityHost: string,
  scalar: string, clientPublicKey: string, suppliedServerKey: unknown): GeneralRtcIdentity | null {
  const absent = suppliedServerKey === undefined || suppliedServerKey === "";
  const serverKey = absent ? "login_default" : typeof suppliedServerKey === "string" ? suppliedServerKey.toLowerCase() : "";
  return parseGeneralRtcIdentity({ version: 1, scalar, clientPublicKey, serverKey,
    serverKeySource: absent ? "login_default" : "login", userId: session.userId, openUdid: session.openUdid,
    tokenDigest: createHash("sha256").update(session.authToken).digest("hex"), securityHost });
}

/** Revalidate identity and current account binding before exposing a closure-owned cipher. */
export function generalRtcCipher(session: MegaSession, securityHost: string): GeneralRtcCipher | null {
  const identity = parseGeneralRtcIdentity(session.generalRtcIdentity);
  const digest = createHash("sha256").update(session.authToken).digest("hex");
  if (!identity || session.verificationPending || !session.authToken || identity.userId !== session.userId
    || identity.openUdid !== session.openUdid || identity.tokenDigest !== digest || identity.securityHost !== securityHost) return null;
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(identity.scalar, "hex"));
  const secret = ecdh.computeSecret(Buffer.from(identity.serverKey === "login_default" ? LOGIN_SERVER_PUBLIC_KEY : identity.serverKey, "hex"));
  const bindingKey = createHash("sha256").update(JSON.stringify([identity.clientPublicKey, identity.serverKey,
    identity.userId, identity.openUdid, digest, securityHost])).digest("hex");
  return {
    bindingKey,
    encrypt(plaintext) {
      if (Buffer.byteLength(plaintext) > 65536) throw new Error("Invalid RTC message");
      const cipher = createCipheriv("aes-256-cbc", secret, secret.subarray(0, 16));
      return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
    },
    decrypt(ciphertext) {
      if (ciphertext.length > 90000 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(ciphertext)) throw new Error("Invalid RTC message");
      const normalized = ciphertext.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
      const bytes = Buffer.from(normalized, "base64");
      const canonical = bytes.toString("base64");
      if (!bytes.length || bytes.length % 16 || canonical.replace(/=+$/, "") !== normalized
        || ciphertext.endsWith("=") && ciphertext.replace(/-/g, "+").replace(/_/g, "/") !== canonical) throw new Error("Invalid RTC message");
      try {
        const decipher = createDecipheriv("aes-256-cbc", secret, secret.subarray(0, 16));
        return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat([decipher.update(bytes), decipher.final()]));
      } catch { throw new Error("Invalid RTC message"); }
    },
  };
}
