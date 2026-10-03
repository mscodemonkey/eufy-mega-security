/**
 * Owns the conversion from Eufy's event-image variants to JPEG.
 *
 * The Mega notification may reference ordinary JPEG bytes, a
 * `v2_eufysecurity` wrapper whose JPEG tables need reconstruction, or an older
 * encrypted `eufysecurity` body keyed by the station's P2P DID. This module
 * accepts raw bytes and an optional DID, performs local decoding, and lets the
 * provider verify the final JPEG before handing it to SnapshotStore. It does
 * not download URLs or decide when a camera event should be retained.
 */
import { createDecipheriv, createHash } from "node:crypto";
import { recoverJpegHeader } from "./jpeg-header-recovery.js";

const V2_PREFIX = "v2_eufysecurity:";
const DC_CHROMA = Buffer.from([0xff, 0xc4, 0x00, 0x1f, 0x01]);
const JPEG_PREFIX = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffdb0043000503040404030504040405050506070c08070707070f0b0b090c110f1212110f111113161c1713141a1511111821181a1d1d1f1f1f13172224221e241c1e1f1effdb0043010505050706070e08080e1e1411141e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1effc000110800b0012003012200021101031101ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa",
  "hex",
);

/** Decode one raw event payload, returning JPEG bytes when the wrapper permits it. */
export function decodeEventImage(data: Buffer, p2pDid = ""): Buffer {
  if (isJpeg(data)) return data;
  if (data.subarray(0, V2_PREFIX.length).toString("latin1") === V2_PREFIX) {
    const payload = afterThirdColon(data);
    const cut = payload?.indexOf(DC_CHROMA) ?? -1;
    if (payload && cut >= 0) return recoverJpegHeader(JPEG_PREFIX, payload.subarray(cut)) ?? data;
  }
  if (data.subarray(0, 12).toString() !== "eufysecurity" || !p2pDid) return data;
  const serial = data.subarray(13, 29).toString();
  const code = data.subarray(30, 40).toString();
  const body = Buffer.from(data.subarray(41));
  const encrypted = body.subarray(0, 256);
  const decipher = createDecipheriv("aes-128-ecb", Buffer.from(imageKey(serial, p2pDid, code), "utf8").subarray(0, 16), null);
  decipher.setAutoPadding(false);
  Buffer.concat([decipher.update(encrypted), decipher.final()]).copy(body);
  return body;
}

/** Check the JPEG start marker without parsing or mutating the buffer. */
export function isJpeg(data: Buffer): boolean {
  return data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data.at(-2) === 0xff && data.at(-1) === 0xd9;
}

/**
 * Repair only event JPEGs carrying this gateway's old fixed reconstruction header.
 *
 * Ordinary camera JPEGs and current reconstructions remain unchanged. A failed
 * recovery leaves the retained bytes intact rather than deleting evidence.
 */
export function repairRetainedEventImage(data: Buffer): Buffer {
  if (!data.subarray(0, JPEG_PREFIX.length).equals(JPEG_PREFIX)) return data;
  return recoverJpegHeader(JPEG_PREFIX, data.subarray(JPEG_PREFIX.length)) ?? data;
}

function afterThirdColon(data: Buffer): Buffer | null {
  let colons = 0;
  for (let index = 0; index < data.length; index++) {
    if (data[index] !== 0x3a || ++colons !== 3) continue;
    return data.subarray(index + 1);
  }
  return null;
}

function imageKey(serial: string, p2pDid: string, code: string): string {
  const suffix = idSuffix(p2pDid);
  const offset = (Number.parseInt(serial.at(-1) ?? "0", 16) + 10) % 10;
  const base = `${serial.substring(offset)}${suffix}`;

  // MD5 is one fixed transformation inside Eufy's legacy image wire format;
  // it is not used here for password storage, signatures, or trust decisions.
  const seed = createHash("md5").update(`${1000 - suffix}${Number.parseInt(code.substring(2), 10)}`).digest("hex").toUpperCase();
  const bytes = [...createHash("sha256").update(`01${base}${seed}`).digest()];
  const start = bytes[10]!;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]!;
    const adjacent = index < bytes.length - 1 ? bytes[index + 1]! : start;
    if (index === bytes.length - 1 || (index & 1) !== 0) {
      if (byte > 126 || adjacent > 126) bytes[index] = byte < adjacent || byte === adjacent ? adjacent - byte : byte - adjacent;
    } else if (byte < 125 || adjacent < 125) {
      bytes[index] = adjacent + byte;
    }
  }
  return Buffer.from(bytes.slice(16)).toString("hex").toUpperCase();
}

function idSuffix(p2pDid: string): number {
  const match = /^[A-Z]+-(\d+)-[A-Z]+$/.exec(p2pDid);
  if (!match) return 0;
  const digits = match[1]!;
  const third = Number.parseInt(digits[3] ?? "0", 10);
  return Number.parseInt(digits[0] ?? "0", 10) + Number.parseInt(digits[1] ?? "0", 10) +
    third + (third < 5 ? third : 0) + Number.parseInt(digits[5] ?? "0", 10);
}
