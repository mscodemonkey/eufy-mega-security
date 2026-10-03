/**
 * Recovers baseline JPEG geometry when an event wrapper hides its frame header.
 *
 * The image boundary supplies a known standard luma header and the untouched
 * chroma/scan tail. This module owns only bounded, synchronous scratch buffers.
 * It walks entropy codes before allocating pixels, rejects incomplete scans,
 * and returns a reconstructed header without re-encoding the camera's picture.
 */
import { decode } from "jpeg-js";

interface ScanTables {
  readonly tables: Map<number, Map<number, number>>;
  readonly scan: Buffer;
}

interface Geometry {
  readonly width: number;
  readonly height: number;
  readonly sampling: number;
  readonly score: number;
}

/**
 * Reconstruct one bounded event thumbnail, refusing malformed or ambiguous scans.
 *
 * The prefix must contain baseline standard luma tables. The tail must include
 * chroma tables, a three-component scan and its end marker. No identities,
 * transport keys or image contents are retained beyond this call.
 */
export function recoverJpegHeader(prefix: Buffer, tail: Buffer): Buffer | null {
  if (tail.length > 4 * 1024 * 1024) return null;
  try {
    const parsed = readTables(Buffer.concat([prefix, tail]));
    if (!parsed) return null;
    let best: Geometry | null = null;
    for (const sampling of [0x11, 0x21, 0x22]) {
      const luma = walkScan(parsed, sampling);
      if (!luma) continue;
      const stepX = 8 * (sampling >> 4);
      const stepY = 8 * (sampling & 15);
      for (let columns = 4; columns <= Math.min(luma.length, 1920 / stepX); columns++) {
        if (luma.length % columns !== 0) continue;
        const rows = luma.length / columns;
        const width = columns * stepX;
        const height = rows * stepY;
        if (height < 32 || height > 1080 || width / height < 0.75 || width / height > 3) continue;
        let discontinuity = 0;
        for (let i = columns; i < luma.length; i++) discontinuity += Math.abs(luma[i]! - luma[i - columns]!);
        const score = discontinuity / (luma.length - columns) + Math.abs(width / height - 4 / 3) * 0.001;
        if (!best || score < best.score) best = { width, height, sampling, score };
      }
    }
    if (!best) return null;
    const header = Buffer.from(prefix);
    const frame = header.indexOf(Buffer.from([0xff, 0xc0]));
    if (frame < 0) return null;
    header.writeUInt16BE(best.height, frame + 5);
    header.writeUInt16BE(best.width, frame + 7);
    header[frame + 11] = best.sampling;
    const candidate = Buffer.concat([header, tail]);
    const pixels = decode(candidate, { useTArray: true, tolerantDecoding: false, maxResolutionInMP: 2.1, maxMemoryUsageInMB: 48 });

    // Lost quantization tables can collapse contrast around neutral grey.
    // Recover a bounded scale from the spread, changing tables rather than pixels.
    const histogram = new Uint32Array(256);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const luminance = Math.round(0.299 * pixels.data[i]! + 0.587 * pixels.data[i + 1]! + 0.114 * pixels.data[i + 2]!);
      histogram[luminance]!++;
    }
    const count = pixels.width * pixels.height;
    let cumulative = 0;
    let low = 0;
    let high = 255;
    for (let i = 0; i < 256; i++) {
      cumulative += histogram[i]!;
      if (cumulative < count * 0.02) low = i;
      if (cumulative >= count * 0.98) { high = i; break; }
    }
    const scale = high - low >= 24 ? Math.min(6, Math.max(1, 220 / (high - low))) : 1;
    for (let offset = 2; offset < header.length;) {
      const marker = header[offset + 1];
      const length = header.readUInt16BE(offset + 2);
      if (marker === 0xdb) {
        for (let i = offset + 5; i < offset + 2 + length; i++) header[i] = Math.min(255, Math.round(header[i]! * scale));
      }
      offset += 2 + length;
    }
    return Buffer.concat([header, tail]);
  } catch {
    return null;
  }
}

function readTables(jpeg: Buffer): ScanTables | null {
  const tables = new Map<number, Map<number, number>>();
  for (let offset = 2; offset + 4 <= jpeg.length;) {
    if (jpeg[offset] !== 0xff) return null;
    const marker = jpeg[offset + 1];
    const length = jpeg.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > jpeg.length) return null;
    if (marker === 0xda) {
      if (length !== 12 || jpeg[offset + 4] !== 3 || jpeg[end - 3] !== 0 || jpeg[end - 2] !== 63 || jpeg[end - 1] !== 0) return null;
      return { tables, scan: jpeg.subarray(end) };
    }
    if (marker === 0xc4) {
      let position = offset + 4;
      while (position < end) {
        const id = jpeg[position++]!;
        if (position + 16 > end) return null;
        const counts = jpeg.subarray(position, position + 16);
        position += 16;
        const table = new Map<number, number>();
        let code = 0;
        for (let bits = 1; bits <= 16; bits++) {
          for (let n = 0; n < counts[bits - 1]!; n++) {
            if (position >= end || code >= 2 ** bits) return null;
            table.set((1 << bits) | code++, jpeg[position++]!);
          }
          code *= 2;
        }
        tables.set(id, table);
      }
    }
    offset = end;
  }
  return null;
}

function walkScan(parsed: ScanTables, sampling: number): number[] | null {
  const bytes: number[] = [];
  let ended = false;
  for (let i = 0; i < parsed.scan.length; i++) {
    const byte = parsed.scan[i]!;
    if (byte !== 0xff) { bytes.push(byte); continue; }
    const marker = parsed.scan[++i];
    if (marker === 0) { bytes.push(0xff); continue; }
    if (marker === 0xd9 && i === parsed.scan.length - 1) { ended = true; break; }
    return null;
  }
  if (!ended || bytes.length === 0) return null;
  let bit = 0;
  const read = (count: number): number => {
    if (bit + count > bytes.length * 8) throw new Error("Incomplete JPEG scan");
    let value = 0;
    for (let i = 0; i < count; i++, bit++) value = value * 2 + ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1);
    return value;
  };
  const symbol = (id: number): number => {
    const table = parsed.tables.get(id);
    let code = 0;
    for (let bits = 1; bits <= 16; bits++) {
      code = code * 2 + read(1);
      const result = table?.get((1 << bits) | code);
      if (result !== undefined) return result;
    }
    throw new Error("Invalid JPEG entropy code");
  };
  const previous = [0, 0, 0];
  const luma: number[] = [];
  const blocks = (sampling >> 4) * (sampling & 15);
  try {
    while (luma.length < 32_400) {
      const remaining = bytes.length * 8 - bit;
      if (remaining <= 8) {
        if (remaining > 0 && read(remaining) !== 2 ** remaining - 1) return null;
        return luma.length > 0 ? luma : null;
      }
      let total = 0;
      for (let component = 0; component < 3; component++) {
        for (let block = 0; block < (component === 0 ? blocks : 1); block++) {
          const table = component === 0 ? 0 : 1;
          const size = symbol(table);
          if (size > 11) return null;
          const value = read(size);
          previous[component]! += size > 0 && value < 2 ** (size - 1) ? value + 1 - 2 ** size : value;
          if (component === 0) total += previous[component]!;
          for (let coefficient = 1; coefficient < 64;) {
            const code = symbol(0x10 | table);
            if (code === 0) break;
            const run = code >> 4;
            const magnitude = code & 15;
            if (magnitude === 0 && run !== 15 || magnitude > 10) return null;
            coefficient += magnitude === 0 ? 16 : run + 1;
            if (coefficient > 64) return null;
            read(magnitude);
          }
        }
      }
      luma.push(total / blocks);
    }
  } catch {
    return null;
  }
  return null;
}
