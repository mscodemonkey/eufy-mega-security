/**
 * Covers the structural boundary between Eufy's wrapped event thumbnails and
 * the reconstructed JPEG passed to Home Assistant's snapshot store.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { encode, decode } from "jpeg-js";

import { decodeEventImage } from "../src/mega/image.js";

test("refuses a chroma marker without a complete scan rather than fabricating a picture", () => {
  const wrapper = Buffer.concat([
    Buffer.from("v2_eufysecurity:camera:event:"),
    Buffer.from([0xff, 0xc4, 0x00, 0x1f, 0x01, 0xff, 0xd9]),
  ]);
  const jpeg = decodeEventImage(wrapper);
  assert.equal(jpeg, wrapper);
});

test("recovers non-default dimensions and sampling from an independently generated scan", () => {
  const width = 176, height = 144;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset] = Math.round(x * 255 / width);
      pixels[offset + 1] = Math.round(y * 255 / height);
      pixels[offset + 2] = Math.round((x + y) * 255 / (width + height));
      pixels[offset + 3] = 255;
    }
  }
  const source = encode({ width, height, data: pixels }, 50).data;
  const dht = source.indexOf(Buffer.from([0xff, 0xc4]));
  assert.ok(dht > 0);
  const tables: Buffer[] = [];
  const end = dht + 2 + source.readUInt16BE(dht + 2);
  for (let position = dht + 4; position < end;) {
    const size = 17 + [...source.subarray(position + 1, position + 17)].reduce((a, b) => a + b, 0);
    if (source[position] === 1 || source[position] === 0x11) {
      const marker = Buffer.from([0xff, 0xc4, 0, 0]);
      marker.writeUInt16BE(size + 2, 2);
      tables.push(Buffer.concat([marker, source.subarray(position, position + size)]));
    }
    position += size;
  }
  const wrapper = Buffer.concat([Buffer.from("v2_eufysecurity:synthetic:event:"), ...tables, source.subarray(end)]);
  const recovered = decodeEventImage(wrapper);
  assert.notEqual(recovered, wrapper);
  const result = decode(recovered, { tolerantDecoding: false });
  assert.equal(result.width, width);
  assert.equal(result.height, height);
  const frame = recovered.indexOf(Buffer.from([0xff, 0xc0]));
  assert.equal(recovered[frame + 11], 0x11);
  assert.equal(decodeEventImage(wrapper.subarray(0, wrapper.length - 30)).subarray(0, 16).toString(), "v2_eufysecurity:");
});

test("recovers a v2 scan whose encrypted prefix includes the chroma tables", () => {
  const width = 160, height = 120;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset] = Math.round(x * 255 / width);
      pixels[offset + 1] = Math.round(y * 255 / height);
      pixels[offset + 2] = Math.round((x + y) * 255 / (width + height));
      pixels[offset + 3] = 255;
    }
  }
  const source = encode({ width, height, data: pixels }, 85).data;
  const sosHeader = Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03]);
  const sos = source.lastIndexOf(sosHeader);
  assert.ok(sos > 0);
  const dri = Buffer.from([0xff, 0xdd, 0x00, 0x04, 0x00, 0x00]);
  const decoys = Buffer.concat([
    Buffer.alloc(96, 0x3c),
    dri,
    Buffer.alloc(32, 0x5a),
    dri,
    sosHeader,
    Buffer.alloc(64, 0x7e),
  ]);
  const wrapper = Buffer.concat([
    Buffer.from("v2_eufysecurity:synthetic:event:"),
    decoys,
    dri,
    source.subarray(sos),
  ]);

  const recovered = decodeEventImage(wrapper);
  assert.notEqual(recovered, wrapper);
  const result = decode(recovered, { tolerantDecoding: false });
  assert.equal(result.width, width);
  assert.equal(result.height, height);
  assert.ok(recovered.includes(Buffer.concat([dri, sosHeader])));
});

test("refuses the encrypted-chroma fallback without a DRI immediately before the final scan", () => {
  const scan = Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00]);
  for (const payload of [
    Buffer.concat([Buffer.from([0xff, 0xdd, 0x00, 0x04, 0x00, 0x00, 0x01]), scan]),
    scan,
  ]) {
    const wrapper = Buffer.concat([Buffer.from("v2_eufysecurity:synthetic:event:"), payload]);
    assert.equal(decodeEventImage(wrapper), wrapper);
  }
});
