/**
 * Decodes authenticated V8 event pictures using caller-owned account keys.
 * The provider owns inventory binding and key retrieval. This module retains
 * no state, performs no requests, and never reports private header fields.
 */
import { createDecipheriv } from "node:crypto";
import { unwrapAuthenticatedMediaKey } from "../crypto/media-key.js";
import { isJpeg } from "./image.js";

/** Parsed private V8 fields, borrowed from the caller's immutable image body. */
export interface V8EventImage {
  /** Private header identity that the provider must bind to its inventory. */
  readonly stationSerial: string;

  /** Native one-byte identifier in the account picture-key namespace. */
  readonly keyId: number;
  readonly wrappedKey: Buffer;
  readonly nonce: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

/**
 * Parse the fixed native V8 header before any account-key request.
 * Non-V8 inputs return null. Malformed V8 and the unimplemented selector-one
 * key scheme fail explicitly rather than falling through to a JPEG decoder.
 */
export function parseV8EventImage(data: Buffer): V8EventImage | null {
  if (data.subarray(0, 16).toString("ascii") !== "v8_eufysecurity:") return null;
  if (data.length <= 191 || data.length > 2 * 1024 * 1024 || data[32] !== 0x3a) {
    throw new Error("event image decode failed: format=v8 result=invalid_header");
  }
  const stationSerial = data.subarray(16, 32).toString("latin1");
  if (!/^[A-Za-z0-9]{16}$/.test(stationSerial)) {
    throw new Error("event image decode failed: format=v8 result=invalid_header");
  }
  const keyId = data[33]!;
  if (keyId === 1) throw new Error("event image decode failed: format=v8 result=unsupported_key_scheme");
  if (keyId === 0 || (data[34] !== 2 && data[34] !== 3)) {
    throw new Error("event image decode failed: format=v8 result=invalid_header");
  }
  return { stationSerial, keyId, wrappedKey: data.subarray(34, 163),
    nonce: data.subarray(163, 175), tag: data.subarray(175, 191), ciphertext: data.subarray(191) };
}

/**
 * Authenticate the wrapped ECC key and complete image before returning JPEG.
 * The caller supplies only the inventory owner's matching private key. All
 * failures use fixed messages, and temporary plaintext key bytes are cleared.
 */
export function decodeV8EventImage(image: V8EventImage, privateKey: Buffer): Buffer {
  const key = unwrapAuthenticatedMediaKey(image.wrappedKey, privateKey);
  if (!key) throw new Error("event image decode failed: format=v8 result=key_authentication_failed");
  let plain: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, image.nonce);
    decipher.setAAD(Buffer.from("eufy security", "utf8"));
    decipher.setAuthTag(image.tag);
    plain = decipher.update(image.ciphertext);
    const final = decipher.final();
    const decoded = Buffer.concat([plain, final]);
    plain.fill(0);
    if (!isJpeg(decoded)) {
      decoded.fill(0);
      throw new Error("invalid image");
    }
    return decoded;
  } catch {
    plain?.fill(0);
    throw new Error("event image decode failed: format=v8 result=image_authentication_failed");
  } finally {
    key.fill(0);
  }
}
