/**
 * Exercises thumbnail ownership, authenticated receive envelopes and cancellation.
 * Invented peers and locally encoded JPEGs own the fixtures. No physical device,
 * account, recording or private reference material enters these tests.
 */
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import test from "node:test";
import { encode } from "jpeg-js";
import { EventPictureReader, decodeEventPictureReply, decodeLegacyEventPictureReply, eventPictureReceiveKey, projectEventPictureSummary } from "../src/stream/homebase-event-picture.js";
import { supportsEventPictureHistory, type MegaInventoryDevice } from "../src/provider/eufy-provider.js";

const serial = "invented-child", station = "InventedParent01", date = "2026-11-02", file = "/recordings/camera0/fixture.jpg";
const jpeg = encode({ width: 8, height: 4, data: Buffer.alloc(8 * 4 * 4, 127) }, 50).data;

/** Build one independent GCM receive envelope using the documented account/peer transform. */
function encrypted(clear: Buffer, account = "inventedaccount", owner = station): Buffer {
  const key = Buffer.alloc(32);
  Buffer.from(account).copy(key, 0, 0, 32); Buffer.from(owner.slice(-7)).copy(key);
  const nonce = Buffer.alloc(12, 9), cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("eufy security"));
  const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]); key.fill(0);
  return Buffer.concat([cipher.getAuthTag(), nonce, ciphertext]);
}

/** Own one synthetic reader and expose its sent requests to adversarial reply tests. */
function fixture(cameraType: 8 | 94 = 8) {
  let transaction = "", sent: string | null = null, imageCalls = 0;
  const reader = new EventPictureReader({ serial, stationSerial: station,
    query: value => { transaction = value; }, image: value => { sent = value; imageCalls++; },
    decodeHistory: value => Buffer.from(value), decodeImage: value => Buffer.from(value) }, cameraType);
  const row = { record_id: 123, device_sn: serial, station_sn: station, device_type: cameraType,
    start_time: `${date} 09:20:00`, time_zone: "+1000", thumb_path: file };
  const frame = (command: number, value: unknown, channel = 255, suffix = Buffer.alloc(0)) => {
    const header = Buffer.alloc(16); header.writeUInt16LE(command, 4); header[12] = channel; header[13] = 1;
    return reader.handleFrame(header, Buffer.concat([Buffer.from(JSON.stringify(value)), suffix]));
  };
  return { reader, row, frame, sent: () => sent, imageCalls: () => imageCalls,
    page: (rows: Record<string, unknown>[] = [row], tx = transaction) => frame(1306, { cmd: 10011, table: "history_record_info", transaction: tx,
      mIntRet: 0, data: [{ table_name: "history_record_info", payload: rows }] }) };
}

test("receive protection uses the account/peer bootstrap key and authenticates the complete reply", () => {
  const clear = Buffer.from('{"content":"invented"}'), payload = encrypted(clear);
  assert.deepEqual(decodeEventPictureReply(payload, 1, "inventedaccount", station), clear);
  assert.equal(decodeEventPictureReply(payload, 1, "differentaccount", station), null);
  assert.equal(decodeEventPictureReply(payload, 1, "inventedaccount", "OtherParent02"), null);
  assert.equal(decodeEventPictureReply(payload, 0, "inventedaccount", station), null);
  const damaged = Buffer.from(payload); damaged[damaged.length - 1]! ^= 1;
  assert.equal(decodeEventPictureReply(damaged, 1, "inventedaccount", station), null);
  assert.notDeepEqual(eventPictureReceiveKey("inventedaccount", station), Buffer.alloc(32));
});

test("an exact history record leads to one file read and only decoded image counts", async () => {
  const f = fixture(), result = f.reader.read(date, "0", "123");
  f.page(); assert.equal(f.sent(), file); assert.equal(f.imageCalls(), 1);
  assert.equal(f.frame(1308, { file: "/other.jpg", content: jpeg.toString("base64url") }), false);
  f.frame(1308, { file, content: jpeg.toString("base64url") });
  assert.deepEqual(await result, { scope: "one_history_thumbnail", records: 1, imageBytes: jpeg.length, width: 8, height: 4 });
  await assert.rejects(f.reader.read(date, "0"), /unavailable/);
});

test("sibling records, a different day and an absent requested record cannot supply the picture", async () => {
  for (const change of [{ device_sn: "sibling" }, { start_time: "2026-11-01 09:20:00" }, { record_id: 124 }]) {
    const f = fixture(), result = f.reader.read(date, "0", "123");
    f.page([{ ...f.row, ...change }]); await assert.rejects(result, /unavailable/); assert.equal(f.imageCalls(), 0);
  }
});

test("changed ownership, duplicate IDs, wrong types and traversal reject before file dispatch", async () => {
  for (const rows of [(row: ReturnType<typeof fixture>["row"]) => [{ ...row, station_sn: "other" }],
    (row: ReturnType<typeof fixture>["row"]) => [row, row], (row: ReturnType<typeof fixture>["row"]) => [{ ...row, device_type: 7 }],
    (row: ReturnType<typeof fixture>["row"]) => [{ ...row, thumb_path: "/recordings/../secret" }]]) {
    const f = fixture(), result = f.reader.read(date, "0");
    f.page(rows(f.row)); await assert.rejects(result, /invalid_response/); assert.equal(f.imageCalls(), 0);
  }
});

test("unrelated history transactions and channels remain available to their owner", async () => {
  const f = fixture(), result = f.reader.read(date, "0");
  assert.equal(f.page([f.row], "different"), false); assert.equal(f.imageCalls(), 0);
  assert.equal(f.frame(1308, {}, 0), false);
  f.reader.close(); await assert.rejects(result, /cancelled/);
});

test("malformed base64, fake JPEG boundaries and invalid pixels cannot become successful images", async () => {
  for (const content of ["_-invalid!", "AAAA", Buffer.from([255, 216, 1, 255, 217]).toString("base64url")]) {
    const f = fixture(), result = f.reader.read(date, "0"); f.page(); f.frame(1308, { file, content });
    await assert.rejects(result, /invalid_response/);
  }
});

test("cancellation between history and image rejects late data and releases the read", async () => {
  const f = fixture(), controller = new AbortController(), result = f.reader.read(date, "0", undefined, controller.signal);
  f.page(); controller.abort(); await assert.rejects(result, /cancelled/);
  assert.equal(f.frame(1308, { file, content: jpeg.toString("base64url") }), false);
});

test("the exact type, parent and account role gate excludes superficially similar routes", () => {
  const parent = { serial: station, model: "T8030", deviceType: 18, category: "eufy_security", adminUserId: "owner" } as MegaInventoryDevice;
  const child = { serial, model: "T8113-Z", deviceType: 8, channel: 0, parentSerial: station,
    category: "eufy_security", adminUserId: "owner" } as MegaInventoryDevice;
  const route = { homeBaseAttached: true, peer: parent };
  assert.equal(supportsEventPictureHistory(child, route, true), true);
  assert.equal(supportsEventPictureHistory({ ...child, model: "T8214", deviceType: 94 }, route, true), true);
  assert.equal(supportsEventPictureHistory({ ...child, model: "T8214", deviceType: 8 }, route, true), false);
  for (const change of [{ deviceType: 7 }, { model: "T8113" }, { adminUserId: "guest" }, { parentSerial: "other" }]) {
    assert.equal(supportsEventPictureHistory({ ...child, ...change }, route, true), false);
  }
  assert.equal(supportsEventPictureHistory(child, { ...route, peer: { ...parent, model: "T8010" } }, true), false);
  assert.equal(supportsEventPictureHistory(child, route, false), false);
  assert.deepEqual(projectEventPictureSummary({ scope: "one_history_thumbnail", records: 1, imageBytes: jpeg.length,
    width: 8, height: 4, content: "PRIVATE-CANARY" }), { scope: "one_history_thumbnail", records: 1, imageBytes: jpeg.length, width: 8, height: 4 });
});

test("the captured single NUL terminator is accepted without admitting arbitrary trailing data", async () => {
  for (const tail of [Buffer.from([0]), Buffer.from([0, 0]), Buffer.from([1])]) {
    const f = fixture(), result = f.reader.read(date, "0"); f.page();
    f.frame(1308, { file, content: jpeg.toString("base64url") }, 255, tail);
    if (tail.length === 1 && tail[0] === 0) assert.equal((await result).imageBytes, jpeg.length);
    else await assert.rejects(result, /invalid_response/);
  }
});

test("legacy image replies accept only the captured final-block terminator and keep their ownership checks", () => {
  const key = Buffer.alloc(16, 5), value = Buffer.from('{"file":"/recordings/fixture.jpg","content":"invented"}');
  const protect = (plain: Buffer) => { const cipher = createCipheriv("aes-128-ecb", key, null); cipher.setAutoPadding(false); return Buffer.concat([cipher.update(plain), cipher.final()]); };
  const padding = Buffer.alloc(16 - value.length % 16, 0x5a); padding[0] = 0;
  const payload = protect(Buffer.concat([value, padding]));
  assert.deepEqual(decodeLegacyEventPictureReply(payload, 1, key), value);
  assert.equal(decodeLegacyEventPictureReply(payload, 0, key), null);
  assert.equal(decodeLegacyEventPictureReply(payload, 1, Buffer.alloc(16, 7)), null);
  const missing = Buffer.alloc(padding.length, 0x5a);
  assert.equal(decodeLegacyEventPictureReply(protect(Buffer.concat([value, missing])), 1, key), null);
  assert.equal(decodeLegacyEventPictureReply(protect(Buffer.concat([value, padding, Buffer.alloc(16)])), 1, key), null);
});

const recordingPath = "/zx/hdd_data0/Camera00/202611/20261102090000/20261102092000.zxvideo";

test("recovery transfers a private JPEG copy only after both opaque ID and complete recording path match", async () => {
  const f = fixture(), result = f.reader.recover({ id: "123", storagePath: recordingPath, triggerMilliseconds: 1_793_568_000_000 });
  f.page([{ ...f.row, storage_path: recordingPath }]);
  f.frame(1308, { file, content: jpeg.toString("base64url") });
  const recovered = await result; assert.deepEqual(recovered, jpeg); assert.notEqual(recovered, jpeg);
  recovered.fill(0); assert.equal(jpeg[0], 255);
});

test("an ID collision with a different recording path is refused before any thumbnail read", async () => {
  const f = fixture(), result = f.reader.recover({ id: "123", storagePath: recordingPath, triggerMilliseconds: 1_793_568_000_000 });
  f.page([{ ...f.row, storage_path: recordingPath.replace("092000", "092100") }]);
  await assert.rejects(result, /invalid_response/); assert.equal(f.imageCalls(), 0);
});

test("the E340 trial accepts only its selected type and exact notification recording", async () => {
  const f = fixture(94), result = f.reader.read(date, "0", "123");
  f.page(); assert.equal(f.imageCalls(), 1);
  f.frame(1308, { file, content: jpeg.toString("base64url") });
  assert.equal((await result).imageBytes, jpeg.length);
  for (const type of [8, 7, 97]) {
    const other = fixture(94), failed = other.reader.read(date, "0", "123");
    other.page([{ ...other.row, device_type: type }]);
    await assert.rejects(failed, /invalid_response/); assert.equal(other.imageCalls(), 0);
  }
});
