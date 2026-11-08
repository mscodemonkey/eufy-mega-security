/**
 * Splits checked Annex-B viewer chunks into access units for a container clock.
 * A chunk may hold several pictures, such as parameter sets and a retained
 * group for a joining viewer. The end of a chunk ends its last unit. The caller
 * owns timing; this boundary keeps no state and copies no media.
 */
import type { VideoCodec } from "../domain/types.js";

/**
 * Units in decoder order, and whether the first continues the previous chunk's
 * picture: it starts with a later slice, or with bytes before any start code.
 */
export interface AnnexBAccessUnits {
  readonly units: Buffer[];
  readonly continuesPrevious: boolean;
}

/**
 * Cut before the first delimiter, parameter set, prefix SEI or new picture's
 * first slice that follows a coded slice, as in H.264 7.4.1.2.3 and H.265
 * 7.4.2.4.4. Bytes before the first start code stay with the first unit.
 */
export function splitAccessUnits(data: Buffer, codec: VideoCodec): AnnexBAccessUnits {
  const cuts: number[] = [];
  let continuesPrevious = data.length > 0 && !(data[0] === 0 && data[1] === 0 && (data[2] === 1 || data[2] === 0 && data[3] === 1));

  // Leading bytes are the tail of the previous picture, so the next picture starts a unit.
  let sliceSeen = continuesPrevious, first = true;
  for (let offset = 0; offset + 3 < data.length; offset++) {
    if (data[offset] !== 0 || data[offset + 1] !== 0 || data[offset + 2] !== 1) continue;
    const start = offset > 0 && data[offset - 1] === 0 ? offset - 1 : offset;
    const header = offset + 3;
    offset = header;
    const kind = nalKind(data, header, codec);
    if (kind === "unknown") continue;
    if (first) {
      first = false;
      continuesPrevious ||= kind === "slice";
    }
    if (kind === "slice") sliceSeen = true;
    else if (kind === "opening" || kind === "picture") {
      if (sliceSeen) cuts.push(start);
      sliceSeen = kind === "picture";
    }
  }
  const units: Buffer[] = [];
  let begin = 0;
  for (const cut of cuts) {
    if (cut > begin) units.push(data.subarray(begin, cut));
    begin = cut;
  }
  if (begin < data.length) units.push(data.subarray(begin));
  return { units, continuesPrevious };
}

/**
 * "picture" is a coded slice that starts a picture, "slice" one that continues
 * it, "opening" a NAL unit that can only begin an access unit, and "other" one
 * that stays with its picture.
 */
function nalKind(data: Buffer, header: number, codec: VideoCodec): "picture" | "slice" | "opening" | "other" | "unknown" {
  const byte = data[header];
  if (byte === undefined || (byte & 0x80) !== 0) return "unknown";
  if (codec === "h264") {
    const type = byte & 0x1f;
    if (type >= 1 && type <= 5) {
      const next = data[header + 1];
      if (next === undefined) return "unknown";

      // first_mb_in_slice is ue(v); a leading 1 bit encodes zero, the first slice.
      return (next & 0x80) !== 0 ? "picture" : "slice";
    }
    return type === 6 || type === 7 || type === 8 || type === 9 || (type >= 14 && type <= 18) ? "opening" : "other";
  }
  const type = (byte >> 1) & 0x3f;
  if (type <= 31) {
    const next = data[header + 2];
    if (next === undefined) return "unknown";
    return (next & 0x80) !== 0 ? "picture" : "slice";
  }
  return type === 32 || type === 33 || type === 34 || type === 35 || type === 39 || (type >= 41 && type <= 44)
    || (type >= 48 && type <= 55) ? "opening" : "other";
}
