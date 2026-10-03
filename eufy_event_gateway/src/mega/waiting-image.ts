/**
 * Supplies a neutral JPEG when a camera has never delivered a usable image.
 *
 * This module owns one process-local generated placeholder. The HTTP boundary
 * receives copies and must not store this image as a camera snapshot. A build
 * helper writes the same bytes into the HA integration for offline fallback.
 */
import { encode } from "jpeg-js";

const glyphs: Readonly<Record<string, readonly string[]>> = {
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  N: ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
};
const width = 320, height = 180;
const pixels = Buffer.alloc(width * height * 4);
for (let offset = 0; offset < pixels.length; offset += 4) {
  pixels.fill(48, offset, offset + 3);
  pixels[offset + 3] = 255;
}
const label = "WAITING FOR IMAGE";
const origin = Math.floor((width - label.length * 12) / 2);
for (let character = 0; character < label.length; character++) {
  const glyph = glyphs[label[character]!];
  if (!glyph) continue;
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 5; x++) {
      if (glyph[y]![x] !== "1") continue;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const offset = ((83 + y * 2 + dy) * width + origin + character * 12 + x * 2 + dx) * 4;
          pixels.fill(224, offset, offset + 3);
        }
      }
    }
  }
}
const jpeg = encode({ width, height, data: pixels }, 70).data;

/** Return a standalone image without granting callers ownership of cached bytes. */
export function waitingImage(): Buffer {
  return Buffer.from(jpeg);
}
