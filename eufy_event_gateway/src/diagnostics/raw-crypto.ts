/**
 * Observes symmetric encryption and decryption for private retrospective replay. Protocol
 * owners still choose keys, IVs, padding and authentication. The optional journal
 * receives sensitive material only through its encrypted sink, never a logger.
 */
import { createCipheriv, createDecipheriv, randomUUID } from "node:crypto";
import { rawHistoryEnabled, recordRaw } from "./raw-history.js";

function bytes(value: unknown, encoding?: unknown): Buffer | undefined {
  if (typeof value === "string") return Buffer.from(value, typeof encoding === "string" ? encoding as BufferEncoding : "utf8");
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return undefined;
}

/**
 * Preserve Node's decipher API and exceptions while recording input, key/IV,
 * authentication settings and output under one operation ID. Output from update
 * remains unauthenticated until final succeeds. A failed final never proves a
 * decoded message. Disabled recording returns the original object unchanged.
 */
export const createRecordedDecipheriv: typeof createDecipheriv = ((...args: Parameters<typeof createDecipheriv>) =>
  observe(Reflect.apply(createDecipheriv, undefined, args) as ReturnType<typeof createDecipheriv>, args, "symmetric_decode")) as typeof createDecipheriv;

/** Preserve encryption inputs and outputs so attempted commands can be replayed privately. */
export const createRecordedCipheriv: typeof createCipheriv = ((...args: Parameters<typeof createCipheriv>) =>
  observe(Reflect.apply(createCipheriv, undefined, args) as ReturnType<typeof createCipheriv>, args, "symmetric_encode")) as typeof createCipheriv;

function observe<T extends object>(cipher: T, args: readonly unknown[], boundary: "symmetric_encode" | "symmetric_decode"): T {
  if (!rawHistoryEnabled()) return cipher;
  const connection = randomUUID();
  const direction = boundary === "symmetric_encode" ? "encode" : "decode";
  recordRaw({ boundary, connection, direction,
    metadata: { event: "created", algorithm: args[0], key: bytes(args[1]), iv: bytes(args[2]) } });
  const object = cipher as Record<string, unknown>;
  for (const name of ["update", "final", "setAAD", "setAuthTag", "getAuthTag", "setAutoPadding"]) {
    const original = object[name];
    if (typeof original !== "function") continue;
    object[name] = function(this: unknown, ...values: unknown[]): unknown {
      try {
        recordRaw({ boundary, connection, direction,
          metadata: { event: name, phase: "input", setting: typeof values[0] === "boolean" ? values[0] : undefined } }, bytes(values[0], values[1]));
      } catch {

        // Invalid encodings must still be judged by the original API.
      }
      try {
        const result: unknown = Reflect.apply(original, this, values);
        recordRaw({ boundary, connection, direction,
          metadata: { event: name, phase: "returned", authentication: direction === "decode" && name === "final"
            && /gcm|chacha20-poly1305/.test(String(args[0])) ? "verified" : "not_verified" } }, bytes(result, name === "update" ? values[2] : values[0]));
        return result;
      } catch (error) {
        recordRaw({ boundary, connection, direction, metadata: { event: name, phase: "failed" } });
        throw error;
      }
    };
  }
  return cipher;
}
