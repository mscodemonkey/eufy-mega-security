/**
 * Reassembles station-split PPCS video payloads into complete access units.
 *
 * The PPCS session owns transport decoding and supplies raw command-1300
 * payloads here. This module owns only the media-unit boundary consumed by
 * the normaliser and downstream stream consumers. It retains one bounded
 * incomplete unit and reports structural drops without retaining media data.
 */

/** The fixed body size used by stations when splitting one access unit. */
export const PPCS_STATION_CHUNK_BYTES = 64_000;

/** The maximum decoded access-unit bytes retained while waiting for a tail. */
const MAX_ACCESS_UNIT_BYTES = 16 * 1024 * 1024;
const VIDEO_FRAME_HEADER_BYTES = 22;

/** Header fields repeated by every transport chunk belonging to one unit. */
export interface PpcsVideoFrameHeader {
  readonly payloadLength: number;
  readonly keyframe: boolean;
  readonly sequence: number;
  readonly width: number;
  readonly height: number;
  readonly timestamp: number;
}

/** One complete decoded access unit ready for media normalisation. */
export interface PpcsAccessUnit {
  readonly keyframe: boolean;
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

/** Structural information about an incomplete unit discarded by the assembler. */
export interface DroppedPpcsAccessUnit {
  readonly carriedBytes: number;
  readonly chunkCount: number;
  readonly totalDropped: number;
}

/** Parse the fixed metadata header from one raw command-1300 payload. */
export function parsePpcsVideoFrameHeader(payload: Buffer): PpcsVideoFrameHeader | undefined {
  if (payload.length < VIDEO_FRAME_HEADER_BYTES) return undefined;
  const flags = payload.readUInt8(4);
  return {
    payloadLength: payload.readUInt32LE(0),
    keyframe: (flags & 1) === 1,
    sequence: payload.readUInt16LE(6),
    width: payload.readInt16LE(10),
    height: payload.readInt16LE(12),
    timestamp: payload.readUInt32LE(14),
  };
}

/** Reassemble one station-split access unit while dropping incomplete media safely. */
export class PpcsAccessUnitAssembler {
  #open: { readonly header: PpcsVideoFrameHeader; readonly chunks: Buffer[]; carriedBytes: number } | undefined;
  #totalDropped = 0;

  /**
   * @param onDropped Receives structural drop counts without media bytes or identifiers.
   */
  constructor(private readonly onDropped?: (drop: DroppedPpcsAccessUnit) => void) {}

  /**
   * Feed one raw command-1300 payload and return any units completed by it.
   *
   * The decoder runs for every chunk, including continuations, because each
   * encrypted transport chunk carries its own framing and protection wrapper.
   */
  push(payload: Buffer, decode: (payload: Buffer) => Buffer | undefined): PpcsAccessUnit[] {
    const header = parsePpcsVideoFrameHeader(payload);
    const body = header ? decode(payload) : undefined;
    if (!header || !body || body.length !== header.payloadLength || body.length === 0) {
      this.#discard();
      return [];
    }

    const fullChunk = header.payloadLength === PPCS_STATION_CHUNK_BYTES;
    const open = this.#open;
    if (open && sameAccessUnit(open.header, header) && !beginsAccessUnit(body)) {
      const nextBytes = open.carriedBytes + body.length;
      if (nextBytes > MAX_ACCESS_UNIT_BYTES) {
        this.#discard();
        return fullChunk ? this.#openFull(header, body) : [unitOf(header, body)];
      }
      open.chunks.push(body);
      open.carriedBytes = nextBytes;
      if (fullChunk) return [];
      this.#open = undefined;
      return [unitOf(open.header, Buffer.concat(open.chunks))];
    }

    this.#discard();
    return fullChunk ? this.#openFull(header, body) : [unitOf(header, body)];
  }

  /** Drop an unfinished unit when the owning PPCS session closes or resets. */
  reset(): void {
    this.#discard();
  }

  #openFull(header: PpcsVideoFrameHeader, body: Buffer): PpcsAccessUnit[] {
    this.#open = { header, chunks: [body], carriedBytes: body.length };
    return [];
  }

  #discard(): void {
    const open = this.#open;
    if (!open) return;
    this.#open = undefined;
    this.#totalDropped++;
    this.onDropped?.({
      carriedBytes: open.carriedBytes,
      chunkCount: open.chunks.length,
      totalDropped: this.#totalDropped,
    });
  }
}

function sameAccessUnit(open: PpcsVideoFrameHeader, next: PpcsVideoFrameHeader): boolean {
  return open.sequence === next.sequence && open.timestamp === next.timestamp;
}

function beginsAccessUnit(body: Buffer): boolean {
  return body.length >= 4
    && body[0] === 0
    && body[1] === 0
    && (body[2] === 1 || (body[2] === 0 && body[3] === 1));
}

function unitOf(header: PpcsVideoFrameHeader, data: Buffer): PpcsAccessUnit {
  return { keyframe: header.keyframe, width: header.width, height: header.height, data };
}
