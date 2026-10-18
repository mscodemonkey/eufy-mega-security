/**
 * Checks finite source-derived frames and scoped observations offline.
 * Fixtures own synthetic identifiers and never contact cloud or hardware.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { nvrApplication } from "../src/stream/nvr-protocol.js";
import { nvrLiveCommand, nvrLivePanReply, nvrLiveReceipt, nvrLiveSettings } from "../src/stream/nvr-live-control-protocol.js";
import { nvrLiveProfile } from "../src/provider/nvr-live-controls.js";

test("finite wrappers use child scope and never continuous PTZ", () => {
  for (const [direction, value] of [["left", 1], ["right", 2], ["up", 3], ["down", 4]] as const) {
    const frame = nvrApplication(nvrLiveCommand("synthetic-owner", 7, 3, { kind: "pan", direction }));
    assert.equal(frame.command, 1700); assert.equal(frame.channel, 3); assert.equal(frame.segment, 7);
    assert.deepEqual(JSON.parse(frame.payload.toString()), { account_id: "synthetic-owner", cmd: 6030,
      commandType: 6030, data: { cmd_type: 1, rotate_type: value, zoom: 1 } });
  }
  for (const sensor of [0, 1] as const) {
    const frame = nvrApplication(nvrLiveCommand("synthetic-owner", 8, 3, { kind: "quality", value: 4, sensor }));
    assert.equal(frame.command, 1350); assert.equal(frame.channel, 3);
    assert.deepEqual(JSON.parse(frame.payload.toString()).payload, { mode: -1, quality: 4, primary_view: -1, sensor });
  }
  for (const value of [0, 1, 2, 3]) assert.deepEqual(JSON.parse(nvrApplication(nvrLiveCommand("synthetic-owner", 8, 3, { kind: "night", value })).payload.toString()).payload, { night_sion: value });
  for (const level of [1, 2, 3] as const) assert.deepEqual(JSON.parse(nvrApplication(nvrLiveCommand("synthetic-owner", 8, 3, { kind: "zoom", level })).payload.toString()).payload, { dstZoom: level });
  for (const segment of [0, 255, 1.5]) assert.throws(() => nvrLiveCommand("synthetic-owner", segment, 3, { kind: "pan", direction: "left" }));
});

test("bounded binary receipts and PTZ data reject unsupported shapes", () => {
  for (const length of [132]) assert.equal(nvrLiveReceipt(Buffer.alloc(length)), true);
  for (const length of [0, 3, 4, 131, 133, 256, 257]) assert.equal(nvrLiveReceipt(Buffer.alloc(length)), false);
  const failure = Buffer.alloc(132); failure.writeInt32LE(-1); assert.equal(nvrLiveReceipt(failure), false);
  assert.equal(nvrLiveReceipt(Buffer.from('{"status":0}')), false);
  for (const limit of [-1, 0, 1, 2, 3, 4]) assert.equal(nvrLivePanReply({ cmd: 6030, payload: { limit } }), true);
  for (const limit of [-2, 5, "1", null]) assert.equal(nvrLivePanReply({ cmd: 6030, payload: { limit } }), false);
  assert.equal(nvrLivePanReply({ cmd: 6030, mIntRet: -1, payload: { limit: 1 } }), false);
});

test("native reads reject missing, duplicate or malformed observations", () => {
  const read = (value: unknown, extra: object[] = []) => nvrLiveSettings({ cmd: 1103, payload: { params: [{ dev_type: 3, param_type: 1277, param_value: value }, ...extra] } }, 3);
  for (const value of [0, 1, 2, 3, "0", "1", "3"]) assert.equal(read(value).night, Number(value));
  for (const value of ["MQ==", "1.0", "01", "", NaN, [], -1]) assert.equal(read(value).night, null);
  assert.equal(read(1, [{ dev_type: 3, param_type: 1277, param_value: 1 }]).night, null);
  assert.equal(read(1, [{ dev_type: 3, channel: 4, param_type: 1277, param_value: 1 }]).night, null);
  assert.equal(read(1, [{ dev_type: 4, channel: 3, param_type: 1277, param_value: 1 }]).night, null);
  assert.deepEqual(nvrLiveSettings({ cmd: 1103, params: [], payload: { params: [] } }, 3), { night: null, quality: null });
  assert.equal(nvrLiveSettings({ cmd: 1103, payload: { params: [{ dev_type: 3, param_type: 2730, param_value: '{"web_video_quality":4}' }] } }, 3).quality, 4);
  assert.deepEqual(nvrLiveSettings({ cmd: 1103, payload: { params: [] } }, 3), { night: null, quality: null });
});

test("exact model matrix excludes suffixes and cross types", () => {
  assert.deepEqual(nvrLiveProfile("T8E00", 301)?.quality.map(mode => mode.value), [0, 1, 3]);
  assert.equal(nvrLiveProfile("T8416", 104)?.defaultView, 0);
  for (const [model, type] of [["T8416121", 104], ["T8416", 105], ["T8416", 301], ["T8E00121", 301]] as const) assert.equal(nvrLiveProfile(model, type), null);
});
