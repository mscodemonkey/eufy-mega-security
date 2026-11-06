/**
 * Frames qualified H.264 or H.265 and AAC as MPEG-TS using the viewer's media clock.
 * One viewer owns each writer and its packet counters. Source admission,
 * timing, byte limits and disconnect cleanup belong to the owning muxer.
 * The writer retains no media, process, socket or asynchronous callback.
 */
import type { VideoCodec } from "../domain/types.js";
import { parseAdtsAccessUnits } from "./ppcs-audio.js";

const VIDEO_PID = 0x100;
const AUDIO_PID = 0x101;
const PMT_PID = 0x1000;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const AUD = Buffer.from([0, 0, 0, 1, 9, 0xf0]);

// An H.265 access unit delimiter allowing I, P and B slices.
const HEVC_AUD = Buffer.from([0, 0, 0, 1, 0x46, 0x01, 0x50]);

/**
 * Own one program's continuity counters until its viewer closes.
 * The supplied output consumes complete TS packets synchronously. Video units
 * must already be complete Annex-B access units of the fixed codec, without
 * B-frame clock reordering. Audio is a fixed startup choice, and every batch is
 * independently validated.
 */
export class ClockedTransportWriter {
  readonly #counters = new Map<number, number>();
  #started = false;

  /** Bind the owning viewer's bounded output, immutable audio admission and video codec. */
  constructor(private readonly output: (data: Buffer) => void, private readonly withAudio: boolean,
    private readonly codec: VideoCodec = "h264") {}

  /** Publish a complete video unit with PCR before its media and unchanged presentation time. */
  video(data: Buffer, milliseconds: number): void {
    this.#validate(data, milliseconds);
    this.#tables();
    this.#started = true;
    this.#pes(VIDEO_PID, 0xe0, this.codec === "h265" ? hevcDelimited(data) : Buffer.concat([AUD, data]), Math.round(milliseconds * 90), true);
  }

  /** Publish checked ADTS frames on their declared sample intervals, including multi-frame batches. */
  audio(data: Buffer, milliseconds: number): void {
    this.#validate(data, milliseconds);
    const units = parseAdtsAccessUnits(data);
    if (!this.withAudio || !units) throw new Error("Clocked transport audio unavailable");
    let ticks = milliseconds * 90;
    if (!this.#started) {
      this.#tables();
      this.#initialClock(Math.round(ticks));
      this.#started = true;
    }
    let offset = 0;
    for (const unit of units) {
      const size = ((data[offset + 3]! & 3) << 11) | (data[offset + 4]! << 3) | (data[offset + 5]! >> 5);
      this.#pes(AUDIO_PID, 0xc0, data.subarray(offset, offset + size), Math.round(ticks), false);
      ticks += unit.samples * 90_000 / unit.sampleRate;
      offset += size;
    }
  }

  #validate(data: Buffer, milliseconds: number): void {
    if (!data.length || data.length > MAX_INPUT_BYTES || !Number.isFinite(milliseconds)
        || milliseconds < 0 || milliseconds >= 86_400_000) throw new Error("Clocked transport input invalid");
  }

  #tables(): void {
    const pat = Buffer.from([0, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0]);
    this.#pack(0, Buffer.concat([Buffer.from([0]), pat, sectionChecksum(pat)]));
    const streams = [this.codec === "h265" ? 0x24 : 0x1b, 0xe1, 0, 0xf0, 0];
    if (this.withAudio) streams.push(0x0f, 0xe1, 1, 0xf0, 0);
    const pmt = Buffer.from([2, 0xb0, 13 + streams.length, 0, 1, 0xc1, 0, 0, 0xe1, 0, 0xf0, 0, ...streams]);
    this.#pack(PMT_PID, Buffer.concat([Buffer.from([0]), pmt, sectionChecksum(pmt)]));
  }

  #initialClock(ticks: number): void {
    const packet = Buffer.alloc(188, 0xff);
    packet.set([0x47, VIDEO_PID >> 8, VIDEO_PID & 0xff, 0x20 | (this.#counters.get(VIDEO_PID) ?? 0), 183, 0x10]);
    clockReference(ticks).copy(packet, 6);
    this.output(packet);
  }

  #pes(pid: number, stream: number, data: Buffer, ticks: number, clock: boolean): void {
    const header = Buffer.alloc(9);
    header.set([0, 0, 1, stream]);
    header.writeUInt16BE(stream === 0xe0 ? 0 : data.length + 8, 4);
    header.set([0x80, 0x80, 5], 6);
    this.#pack(pid, Buffer.concat([header, presentationTimestamp(ticks), data]), clock ? ticks : undefined);
  }

  #pack(pid: number, data: Buffer, clock?: number): void {
    const packets: Buffer[] = [];
    let offset = 0;
    while (offset < data.length) {
      const first = offset === 0;
      const withClock = first && clock !== undefined;
      const bytes = Math.min(data.length - offset, withClock ? 176 : 184);
      const adaptation = bytes < 184;
      const packet = Buffer.alloc(188, 0xff);
      const counter = this.#counters.get(pid) ?? 0;
      this.#counters.set(pid, (counter + 1) & 15);
      packet.set([0x47, (first ? 0x40 : 0) | ((pid >> 8) & 31), pid & 255, (adaptation ? 0x30 : 0x10) | counter]);
      let start = 4;
      if (adaptation) {
        const size = 183 - bytes;
        packet[4] = size;
        start = 5 + size;
        if (size) {
          packet[5] = withClock ? 0x10 : 0;
          if (withClock) clockReference(clock!).copy(packet, 6);
        }
      }
      data.copy(packet, start, offset, offset + bytes);
      packets.push(packet);
      offset += bytes;
      if (packets.length === 256) {
        this.output(Buffer.concat(packets));
        packets.length = 0;
      }
    }
    if (packets.length) this.output(Buffer.concat(packets));
  }
}

/** Start an H.265 unit with one delimiter, keeping a delimiter the camera already sent. */
function hevcDelimited(data: Buffer): Buffer {
  const header = data[2] === 1 ? 3 : data[2] === 0 && data[3] === 1 ? 4 : 0;
  return data[0] === 0 && data[1] === 0 && header && ((data[header]! >> 1) & 0x3f) === 35 ? data : Buffer.concat([HEVC_AUD, data]);
}

function sectionChecksum(data: Buffer): Buffer {
  let crc = 0xffff_ffff;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000_0000 ? (crc << 1) ^ 0x04c1_1db7 : crc << 1;
  }
  const result = Buffer.alloc(4);
  result.writeUInt32BE(crc >>> 0);
  return result;
}

function presentationTimestamp(ticks: number): Buffer {
  const time = BigInt(ticks) & 0x1_ffff_ffffn;
  return Buffer.from([0x21 | Number((time >> 29n) & 14n), Number((time >> 22n) & 255n),
    Number((time >> 14n) & 254n) | 1, Number((time >> 7n) & 255n), Number((time << 1n) & 254n) | 1]);
}

function clockReference(ticks: number): Buffer {
  const time = BigInt(ticks) & 0x1_ffff_ffffn;
  return Buffer.from([Number((time >> 25n) & 255n), Number((time >> 17n) & 255n), Number((time >> 9n) & 255n),
    Number((time >> 1n) & 255n), Number((time & 1n) << 7n) | 0x7e, 0]);
}
