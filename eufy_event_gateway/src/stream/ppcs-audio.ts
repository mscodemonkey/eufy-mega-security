/**
 * Validates clear PPCS AAC audio frames for the provider's optional clip stream.
 * The owning camera session supplies channel and protection checks. This boundary
 * retains no state, keys or media after returning checked ADTS bytes to its caller.
 */

/**
 * Return complete AAC ADTS frames from a command-1301 payload, or reject it.
 * Codec 0/1 use the verified sixteen-byte metadata header. Other codecs,
 * truncated frames and unsupported sampling/channel configurations are excluded.
 */
export function decodePpcsAac(frame: Buffer): Buffer | null {
  if (frame.length < 23 || frame.length > 65552 || ![0, 1].includes(frame[5]!)) return null;
  if (frame.readUInt32LE(0) !== frame.length - 16) return null;
  const audio = frame.subarray(16);
  let offset = 0;
  while (offset < audio.length) {
    if (audio.length - offset < 7) return null;
    const header = audio.subarray(offset);
    if (header[0] !== 0xff || (header[1]! & 0xf6) !== 0xf0) return null;
    const frequency = (header[2]! >> 2) & 0x0f;
    const channels = ((header[2]! & 1) << 2) | (header[3]! >> 6);
    const size = ((header[3]! & 3) << 11) | (header[4]! << 3) | (header[5]! >> 5);
    const minimum = (header[1]! & 1) === 1 ? 7 : 9;
    if (frequency > 12 || channels < 1 || channels > 2 || size < minimum || size > audio.length - offset) return null;
    offset += size;
  }
  return Buffer.from(audio);
}
