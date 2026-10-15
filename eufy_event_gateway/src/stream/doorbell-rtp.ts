/**
 * Assembles bounded H.264 RTP access units for the opt-in native doorbell trial.
 * The RTC session verifies track and payload ownership. This module owns only
 * one unfinished access unit, discards loss, and returns complete Annex-B bytes.
 */

/** Checked RTP fields passed by the session's negotiated video receiver. */
export interface DoorbellRtpPacket {
  readonly sequenceNumber: number;
  readonly timestamp: number;
  readonly marker: boolean;
  readonly payload: Buffer;
}

const START = Buffer.from([0, 0, 0, 1]);
const MAX_UNIT_BYTES = 4 * 1024 * 1024;
const MAX_NALS = 256;

/**
 * Owns one RTP timestamp and contiguous FU-A assembly until its marker arrives.
 * Missing packets poison only the current timestamp. A new timestamp can recover
 * without joining bytes across frames. No packet or media is retained on clear.
 */
export class DoorbellH264Assembler {
  #sequence: number | null = null;
  #timestamp: number | null = null;
  #discard = false;
  #nals: Buffer[] = [];
  #fragment: Buffer[] | null = null;
  #fragmentType = 0;
  #bytes = 0;

  /** Notify the session when a frame is lost so it can wait for a new keyframe. */
  constructor(private readonly onDiscontinuity: () => void = () => undefined) {}

  /** Release buffered video at retirement, including sequence ownership. */
  clear(): void {
    this.#sequence = null;
    this.#timestamp = null;
    this.#reset();
  }

  /** Consume one negotiated packet, returning only a marker-complete access unit. */
  push(packet: DoorbellRtpPacket): Buffer | null {
    if (!Number.isInteger(packet.sequenceNumber) || packet.sequenceNumber < 0 || packet.sequenceNumber > 65535
      || !Number.isInteger(packet.timestamp) || packet.timestamp < 0 || packet.timestamp > 0xffffffff
      || !Buffer.isBuffer(packet.payload) || packet.payload.length === 0 || packet.payload.length > 65_535) {
      this.#poison(); return null;
    }
    const gap = this.#sequence !== null && packet.sequenceNumber !== (this.#sequence + 1) % 65536;
    this.#sequence = packet.sequenceNumber;
    if (this.#timestamp !== packet.timestamp) {
      if (!this.#discard && (this.#fragment || this.#nals.length)) this.onDiscontinuity();
      this.#reset(); this.#timestamp = packet.timestamp;
    }
    if (gap) this.#poison();
    if (this.#discard) return null;
    const payload = packet.payload, kind = payload[0]! & 31;
    if (payload[0]! & 0x80) { this.#poison(); return null; }
    if (kind >= 1 && kind <= 23) {
      if (this.#fragment) this.#poison();
      else this.#append(payload);
    } else if (kind === 24) {
      if (this.#fragment) this.#poison();
      else {
        let offset = 1;
        while (offset < payload.length && !this.#discard) {
          if (offset + 2 > payload.length) { this.#poison(); break; }
          const length = payload.readUInt16BE(offset); offset += 2;
          if (!length || offset + length > payload.length) { this.#poison(); break; }
          const nal = payload.subarray(offset, offset + length), type = nal[0]! & 31;
          if (nal[0]! & 0x80 || type < 1 || type > 23) { this.#poison(); break; }
          this.#append(nal); offset += length;
        }
      }
    } else if (kind === 28 && payload.length > 2) {
      const header = payload[1]!, start = !!(header & 0x80), end = !!(header & 0x40), type = header & 31;
      if (header & 0x20 || type < 1 || type > 23 || start && end) this.#poison();
      else if (start) {
        if (this.#fragment) this.#poison();
        else {
          this.#fragmentType = (payload[0]! & 0x60) | type;
          this.#fragment = [Buffer.from([this.#fragmentType]), Buffer.from(payload.subarray(2))];
          this.#bytes += payload.length - 1;
        }
      } else if (!this.#fragment || this.#fragmentType !== ((payload[0]! & 0x60) | type)) this.#poison();
      else {
        this.#fragment.push(Buffer.from(payload.subarray(2)));
        this.#bytes += payload.length - 2;
        if (end) {
          const nal = Buffer.concat(this.#fragment);
          this.#fragment = null;
          this.#nals.push(nal);
        }
      }
    } else this.#poison();
    if (this.#bytes > MAX_UNIT_BYTES || this.#nals.length > MAX_NALS || (this.#fragment?.length ?? 0) > 8192) this.#poison();
    if (!packet.marker || this.#discard) return null;
    if (this.#fragment || !this.#nals.length) { this.#poison(); return null; }
    const unit = Buffer.concat(this.#nals.flatMap(nal => [START, nal]));
    this.#nals = []; this.#bytes = 0; this.#discard = true;
    return unit;
  }

  #append(nal: Buffer): void {
    this.#bytes += nal.length;
    if (this.#bytes > MAX_UNIT_BYTES || this.#nals.length >= MAX_NALS) this.#poison();
    else this.#nals.push(Buffer.from(nal));
  }

  #poison(): void {
    if (!this.#discard) this.onDiscontinuity();
    this.#discard = true; this.#nals = []; this.#fragment = null; this.#bytes = 0;
  }

  #reset(): void {
    this.#discard = false; this.#nals = []; this.#fragment = null; this.#bytes = 0;
  }
}
