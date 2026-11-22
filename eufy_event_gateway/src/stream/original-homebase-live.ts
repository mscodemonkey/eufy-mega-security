/**
 * Defines the live-video protocol of the original HomeBase (T8001) and HomeBase E (T8002).
 *
 * These stations predate the ECC/AES-GCM media start used by later HomeBases. They can
 * return gateway info in the clear and take an integer or JSON start protected with
 * AES-128-ECB at most. The wire shapes here follow eufy-security-client 4.1.1-1 (MIT),
 * the library used by homebridge-eufy-security 4.7.2. They are not yet hardware-confirmed
 * in this gateway. The PPCS session owns sockets, sequencing, timers and cleanup. This
 * module only selects the route, derives the command key and builds command bodies.
 */

import { constants, createCipheriv, createDecipheriv, createPrivateKey, privateDecrypt, type KeyObject } from "node:crypto";

/** Firmware from which v4 wraps the start in command 1350 instead of sending 1003 directly. */
const WRAPPED_START_FIRMWARE = [2, 0, 9, 7] as const;

/** Fixed chunk width of string fields in integer command bodies. */
const STRING_FIELD_BYTES = 128;

/** Inventory and lifecycle facts required before the older protocol may replace level-two media. */
export interface OriginalHomeBaseRoute {
  readonly cameraModel: string;
  readonly cameraDeviceType?: number | null | undefined;
  readonly stationModel?: string | undefined;
  readonly stationDeviceType?: number | null | undefined;
  readonly channel: number;
  readonly homeBaseAttached?: boolean | undefined;
  readonly purpose?: "media" | "control" | "passive" | undefined;
}

/**
 * Admit only T8111 media through a T8001 or T8002.
 * T8010 shares numeric type 0, so the station model is required. Control sessions are
 * excluded because none of their writes have been qualified on this protocol.
 */
export function usesOriginalHomeBaseLive(route: OriginalHomeBaseRoute): boolean {
  return route.homeBaseAttached === true
    && (route.stationModel === "T8001" || route.stationModel === "T8002") && route.stationDeviceType === 0
    && route.cameraModel === "T8111" && route.cameraDeviceType === 1
    && Number.isInteger(route.channel) && route.channel >= 0 && route.channel < 255
    && (route.purpose === undefined || route.purpose === "media");
}

/** Privacy-safe reason for the selected command key. */
export type OriginalHomeBaseKeyReason =
  | "rsa_unwrapped" | "key_size" | "empty_key_field" | "gateway_short" | "lookup_failed" | "no_rsa_key" | "key_invalid" | "unwrap_failed";

/** Sign code zero is clear, one uses the derived key, and two uses the RSA-delivered key. */
export type OriginalHomeBaseSeal = (
  | { readonly signCode: 0; readonly key: null }
  | { readonly signCode: 1 | 2; readonly key: Buffer }
) & { readonly reason: OriginalHomeBaseKeyReason };

/** Parse a cloud key as v4 does, where an RSA PEM label may enclose PKCS#8 bytes. */
function parsePrivateKey(value: string): KeyObject | null {
  const der = Buffer.from(value.replace(/-----(?:BEGIN|END)[A-Z ]+-----/g, "").replace(/\s/g, ""), "base64");
  for (const type of ["pkcs8", "pkcs1"] as const) {
    try {
      return createPrivateKey({ key: der, format: "der", type });
    } catch {

      // The other DER container is tried before the key is reported invalid.
    }
  }
  return null;
}

/**
 * Select the command key from decrypted gateway info and candidate RSA private keys.
 *
 * The body is a two-byte cipher ID, two reserved bytes, then one RSA block. The complete
 * block is read because ciphertext may contain zero bytes. PKCS#1 padding is checked over
 * the raw result: OpenSSL's implicit rejection would otherwise return random bytes for a
 * wrong key. Every failure selects the derived level-one key, matching v4's fallback.
 */
export function selectOriginalHomeBaseSeal(
  gatewayInfo: Buffer,
  privateKeys: readonly string[] | null,
  derivedKey: Buffer,
): OriginalHomeBaseSeal {
  const fallback = (reason: OriginalHomeBaseKeyReason): OriginalHomeBaseSeal => ({ signCode: 1, key: derivedKey, reason });
  if (privateKeys === null) return fallback("lookup_failed");
  if (privateKeys.length === 0) return fallback("no_rsa_key");
  let failure: OriginalHomeBaseKeyReason = "key_invalid";
  let parsed = false;
  for (const value of privateKeys) {
    const privateKey = parsePrivateKey(value);
    const bits = privateKey?.asymmetricKeyDetails?.modulusLength;
    if (!privateKey || !bits) continue;
    parsed = true;
    const end = 4 + Math.ceil(bits / 8);
    if (gatewayInfo.length < end) { failure = "gateway_short"; continue; }
    let block: Buffer;
    try {
      block = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, gatewayInfo.subarray(4, end));
    } catch {
      failure = "unwrap_failed";
      continue;
    }
    const separator = block.indexOf(0, 2);
    if (block[0] !== 0 || block[1] !== 2 || separator < 10) { failure = "unwrap_failed"; continue; }
    const key = Buffer.from(block.subarray(separator + 1));
    block.fill(0);

    // v4 only encrypts with 16-byte keys and otherwise sends the command in the clear.
    return key.length === 16
      ? { signCode: 2, key, reason: "rsa_unwrapped" }
      : { signCode: 0, key: null, reason: "key_size" };
  }

  // v4 reads this field up to its first NUL. With a valid account key, an empty field
  // therefore means clear commands, which differs from a failed unwrap's level-one fallback.
  // This follows the full-block attempts so a ciphertext starting with zero can still succeed.
  if (parsed && (gatewayInfo.length <= 4 || gatewayInfo[4] === 0)) return { signCode: 0, key: null, reason: "empty_key_field" };
  return fallback(failure);
}

/** Choose the start generation, treating unreadable firmware as old exactly as v4 does. */
export function originalHomeBaseStartCommand(firmware: string | null | undefined): 1003 | 1350 {
  const actual = firmware?.match(/\d+(?:\.\d+)+/)?.[0].split(".").map(Number);
  if (!actual) return 1003;
  for (let index = 0; index < Math.min(actual.length, WRAPPED_START_FIRMWARE.length); index++) {
    if (actual[index] !== WRAPPED_START_FIRMWARE[index]) return actual[index]! > WRAPPED_START_FIRMWARE[index]! ? 1350 : 1003;
  }
  return actual.length >= WRAPPED_START_FIRMWARE.length ? 1350 : 1003;
}

/** Add the ten-byte command envelope and the selected ECB protection. */
function envelope(value: Buffer, channel: number, seal: OriginalHomeBaseSeal | null): Buffer {
  let body = value;
  let signCode = 0;
  if (seal?.key) {
    const padded = Buffer.alloc(Math.ceil(Math.max(value.length, 16) / 16) * 16);
    value.copy(padded);
    const cipher = createCipheriv("aes-128-ecb", seal.key, null);
    cipher.setAutoPadding(false);
    body = Buffer.concat([cipher.update(padded), cipher.final()]);
    signCode = seal.signCode;
  }
  const header = Buffer.alloc(10);
  header.writeUInt16LE(body.length, 0);
  header[4] = 1;
  header[6] = channel;
  header[7] = signCode;
  return Buffer.concat([header, body]);
}

/**
 * Build the H.264 start for one child camera.
 * Command 1003 is always clear and carries the channel and RSA modulus. Command 1350
 * carries JSON under the selected key and deliberately has no `mChannel` field.
 */
export function buildOriginalHomeBaseStart(
  command: 1003 | 1350,
  channel: number,
  accountId: string,
  modulus: string,
  seal: OriginalHomeBaseSeal,
): Buffer {
  if (command === 1003) {
    const value = Buffer.alloc(4 + Math.ceil(Math.max(modulus.length, 1) / STRING_FIELD_BYTES) * STRING_FIELD_BYTES);
    value.writeUInt32LE(channel, 0);
    value.write(modulus, 4);
    return envelope(value, channel, null);
  }
  const value = Buffer.from(JSON.stringify({
    account_id: accountId,
    cmd: 1003,
    mValue3: 1003,
    payload: { ClientOS: "Android", key: modulus, streamtype: 1 },
  }));
  return envelope(value, channel, seal);
}

/** Build command 1004, which carries only the child channel under the selected key. */
export function buildOriginalHomeBaseStop(channel: number, seal: OriginalHomeBaseSeal): Buffer {
  const value = Buffer.alloc(4);
  value.writeUInt32LE(channel, 0);
  return envelope(value, channel, seal);
}

/** Read the signed scalar from a start result, protected with the session key or clear. */
export function decodeOriginalHomeBaseResult(payload: Buffer, signCode: number, seal: OriginalHomeBaseSeal): number | null {
  if (payload.length < 4) return null;
  if (signCode === 0) return payload.readInt32LE(0);
  if (!seal.key || payload.length % 16 !== 0) return null;
  const decipher = createDecipheriv("aes-128-ecb", seal.key, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(payload), decipher.final()]).readInt32LE(0);
}
