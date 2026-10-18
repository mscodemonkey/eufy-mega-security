/**
 * Contains the pure cryptographic primitives used by MegaClient.
 *
 * These functions reproduce the observed native-app formats for bootstrap
 * keys, ECDH identity exchange, request signatures, AES envelopes, encrypted
 * passwords, credential verifiers, and user tokens. They perform no I/O and
 * retain no session state. Fixtures can therefore test byte-for-byte protocol
 * behaviour without contacting Eufy, while MegaClient owns ordering,
 * persistence, rate limiting, and error interpretation.
 */
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  type ECDH,
} from "node:crypto";

import type { MegaIdentity } from "./types.js";

/** Preset key used to bootstrap identities on Mega hosts. */
export const MEGA_PRESET_KEY = "2500a7d5617812f9d52515b2c8f20a3d";

/** Preset key used by the older EufyLife host family. */
export const EUFYLIFE_PRESET_KEY = "118c12c81e211149304bd70a0c071d01";

/** Public key published by the Mega login service for password encryption. */
export const LOGIN_SERVER_PUBLIC_KEY =
  "04c5c00c4f8d1197cc7c3167c52bf7acb054d722f0ef08dcd7e0883236e0d72a3868d9750cb47fa4619248f3d83f0f662671dadc6e2d31c2f41db0161651c7c076";

/** Create the hex nonce format expected by Mega request headers. */
export function randomIdentifier(): string {
  return randomBytes(16).toString("hex");
}

/** Sign a clear or encrypted request body with Mega's HMAC format. */
export function requestSignature(key: string, timestamp: string, nonce: string, body?: string): string {
  const signed = body === undefined ? `${timestamp}+${nonce}` : `${timestamp}+${nonce}+${body}`;
  return createHmac("sha256", Buffer.from(key, "utf8")).update(signed).digest("hex");
}

/** Encrypt a Mega JSON envelope as base64 IV followed by AES-CBC bytes. */
export function encryptEnvelope(plaintext: string, key: Buffer, iv = randomBytes(16)): string {
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
}

/** Decrypt a base64 Mega envelope and return its UTF-8 JSON text. */
export function decryptEnvelope(envelope: string, key: Buffer): string {
  const bytes = Buffer.from(envelope, "base64");
  if (bytes.length < 32 || bytes.length % 16 !== 0) throw new Error("Invalid Mega encrypted envelope");
  const decipher = createDecipheriv("aes-128-cbc", key, bytes.subarray(0, 16));
  return Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString("utf8");
}

/** Return the Mega bootstrap key as bytes. */
export function presetKey(): Buffer {
  return Buffer.from(MEGA_PRESET_KEY, "hex");
}

/** Derive the AES key used to encrypt Mega request and response bodies. */
export function sharedAesKey(sharedKey: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(sharedKey)) throw new Error("Invalid Mega shared key");
  return Buffer.from(sharedKey.slice(0, 32), "hex");
}

/** Derive the HMAC signing key paired with a Mega shared identity. */
export function sharedSigningKey(sharedKey: string): string {
  if (!/^[0-9a-f]{64}$/i.test(sharedKey)) throw new Error("Invalid Mega shared key");
  return sharedKey.slice(0, 32);
}

/** Temporary ECDH state retained between request and response. */
export interface PendingKeyExchange {
  readonly ecdh: ECDH;
  readonly keyIdent: string;
  readonly clientPublicKey: string;
  readonly encryptedPublicKey: string;
}

/** Generate the client half of a Mega host identity exchange. */
export function beginKeyExchange(localKeyHex = MEGA_PRESET_KEY): PendingKeyExchange {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const clientPublicKey = ecdh.getPublicKey("hex");
  return {
    ecdh,
    keyIdent: randomIdentifier(),
    clientPublicKey,
    encryptedPublicKey: encryptEnvelope(clientPublicKey, Buffer.from(localKeyHex, "hex")),
  };
}

/** Finish an identity exchange and derive the shared request keys. */
export function finishKeyExchange(pending: PendingKeyExchange, encryptedServerPublicKey: string, localKeyHex = MEGA_PRESET_KEY): MegaIdentity {
  const serverPublicKey = decryptEnvelope(encryptedServerPublicKey, Buffer.from(localKeyHex, "hex"));
  if (!/^04[0-9a-f]{128}$/i.test(serverPublicKey)) throw new Error("Mega returned an invalid server public key");
  const sharedKey = pending.ecdh.computeSecret(Buffer.from(serverPublicKey, "hex")).toString("hex");
  return { keyIdent: pending.keyIdent, sharedKey, clientPublicKey: pending.clientPublicKey };
}

/** Encrypt a login password, optionally retaining its ephemeral scalar for the opt-in RTC trial. */
export function encryptPassword(password: string, captureScalar = false): { encrypted: string; clientPublicKey: string; scalar?: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const secret = ecdh.computeSecret(Buffer.from(LOGIN_SERVER_PUBLIC_KEY, "hex"));
  const cipher = createCipheriv("aes-256-cbc", secret, secret.subarray(0, 16));
  const encrypted = cipher.update(password, "utf8", "base64") + cipher.final("base64");
  const clientPublicKey = ecdh.getPublicKey("hex");
  if (!captureScalar) return { encrypted, clientPublicKey };
  const privateBytes = ecdh.getPrivateKey();
  const scalar = privateBytes.toString("hex").padStart(64, "0");
  privateBytes.fill(0);
  return { encrypted, clientPublicKey, scalar };
}

/** Derive a slow account-bound verifier used to reject sessions saved for different credentials. */
export function credentialVerifier(openUdid: string, email: string, password: string): string {
  const salt = `eufy-mega-session:${openUdid}:${email.toLowerCase()}`;
  return scryptSync(password, salt, 32).toString("hex");
}

/** Build Eufy's required MD5-formatted gtoken identifier from a public user ID. */
export function megaUserToken(userId: string): string {
  return createHash("md5").update(userId).digest("hex");
}
