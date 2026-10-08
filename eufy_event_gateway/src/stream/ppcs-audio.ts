/**
 * Validates clear PPCS AAC and ADTS access units for optional recorded and live audio.
 * The owning camera session supplies channel and protection checks. This boundary
 * retains no state, keys or media after returning checked ADTS bytes to its caller.
 */

/** One checked ADTS access unit. Payload shares the caller-owned input until its consumer copies it. */
export interface AdtsAccessUnit {
  readonly payload: Buffer;
  readonly sampleRate: number;
  readonly channels: number;
  readonly configuration: number;
  readonly samples: number;
}

/** Parse a complete ADTS batch without accepting truncated frames or implicit channel configuration. */
export function parseAdtsAccessUnits(audio: Buffer): readonly AdtsAccessUnit[] | null {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const units: AdtsAccessUnit[] = [];
  let offset = 0;
  while (offset < audio.length) {
    if (audio.length - offset < 7) return null;
    const header = audio.subarray(offset);
    if (header[0] !== 0xff || (header[1]! & 0xf6) !== 0xf0) return null;
    const frequency = (header[2]! >> 2) & 0x0f;
    const channels = ((header[2]! & 1) << 2) | (header[3]! >> 6);
    const size = ((header[3]! & 3) << 11) | (header[4]! << 3) | (header[5]! >> 5);
    const minimum = (header[1]! & 1) === 1 ? 7 : 9;
    if (frequency > 12 || channels < 1 || channels > 2 || size <= minimum || size > audio.length - offset) return null;
    const profile = (header[2]! >> 6) + 1;
    units.push({ payload: audio.subarray(offset + minimum, offset + size), sampleRate: rates[frequency]!, channels,
      configuration: (profile << 11) | (frequency << 7) | (channels << 3), samples: 1024 * ((header[6]! & 3) + 1) });
    offset += size;
  }
  return units.length ? units : null;
}

/**
 * Return complete AAC ADTS frames from a command-1301 payload, or reject it.
 * Codec 0/1 use the verified sixteen-byte metadata header. Other codecs,
 * truncated frames and unsupported sampling/channel configurations are excluded.
 */
export function decodePpcsAac(frame: Buffer): Buffer | null {
  if (frame.length < 23 || frame.length > 65552 || ![0, 1].includes(frame[5]!)) return null;
  if (frame.readUInt32LE(0) !== frame.length - 16) return null;
  const audio = frame.subarray(16);
  if (!parseAdtsAccessUnits(audio)) return null;
  return Buffer.from(audio);
}
