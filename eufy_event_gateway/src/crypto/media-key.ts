/**
 * Authenticates Eufy ECC media-key envelopes without network or retained state.
 * PPCS sessions and event-image decoders own keys and consume this pure boundary.
 */
import { createDecipheriv, createECDH, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Unwrap and authenticate the 32-byte media key carried by an ECC keyframe.
 *
 * The envelope contains a compressed P-256 ephemeral public key, an AES-CBC
 * IV and ciphertext, and an HMAC. Eufy's ECIES-compatible derivation expands
 * the ECDH shared secret into separate encryption and authentication material.
 * Authentication is checked before decryption, and malformed peer points or
 * padding failures are reported to the caller as an absent key.
 */
export function unwrapAuthenticatedMediaKey(envelope: Buffer, privateKey: Buffer): Buffer | undefined {
  if (envelope.length !== 129) return undefined;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(privateKey);
    const shared = ecdh.computeSecret(envelope.subarray(0, 33));
    const label = Buffer.from("ECIES", "utf8");
    const hmac = (key: Buffer, value: Buffer): Buffer => createHmac("sha256", key).update(value).digest();
    let previous: Buffer<ArrayBufferLike> = label;
    let derived: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    while (derived.length < 48) {
      previous = hmac(shared, previous);
      derived = Buffer.concat([derived, hmac(shared, Buffer.concat([previous, label]))]);
    }
    const expectedTag = hmac(derived.subarray(16, 48), envelope.subarray(33, 97));
    if (!timingSafeEqual(expectedTag, envelope.subarray(97, 129))) return undefined;
    const decipher = createDecipheriv("aes-128-cbc", derived.subarray(0, 16), envelope.subarray(33, 49));
    const plain = Buffer.concat([decipher.update(envelope.subarray(49, 97)), decipher.final()]);
    return plain.length === 32 ? plain : undefined;
  } catch {
    return undefined;
  }
}

