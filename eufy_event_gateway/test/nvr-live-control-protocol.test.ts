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
  for (const value of [0, 1] as const) {
    const frame = nvrApplication(nvrLiveCommand("synthetic-owner", 9, 3, { kind: "tracking", value }));
    assert.equal(frame.command, 1700); assert.equal(frame.channel, 3); assert.equal(frame.segment, 9);
    const body = JSON.parse(frame.payload.toString());
    assert.match(body.data.transaction, /^\d{13}$/);
    assert.deepEqual(body, { account_id: "synthetic-owner", cmd: 6016, commandType: 6016, data: { value, transaction: body.data.transaction } });
  }
  assert.throws(() => nvrLiveCommand("synthetic-owner", 9, 3, { kind: "tracking", value: 2 as 1 }));
});

test("T8416 AI tracking reads one base64 digit from its channel row", () => {
  const read = (rows: unknown[], params: unknown[] = []) => nvrLiveSettings({ cmd: 1103, params, db_bypass_str: rows }, 3).tracking;
  assert.equal(read([{ channel: 3, param_type: 6016, param_value: "MQ==" }]), 1);
  assert.equal(read([{ channel: 3, param_type: 6016, param_value: "MA==" }]), 0);
  for (const value of ["Mg==", "1", 1, "MQ", "", null]) assert.equal(read([{ channel: 3, param_type: 6016, param_value: value }]), null);
  assert.equal(read([{ channel: 4, param_type: 6016, param_value: "MQ==" }]), null);
  assert.equal(read([{ channel: 3, param_type: 6016, param_value: "MQ==" }, { channel: 3, param_type: 6016, param_value: "MA==" }]), null);
  assert.equal(read([], [{ dev_type: 3, param_type: 6016, param_value: "MQ==" }]), null);
  assert.equal(read([{ channel: 3, param_type: 6016, param_value: "MQ==" }], [{ dev_type: 3, param_type: 6016, param_value: 1 }]), null);
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
  assert.deepEqual(nvrLiveSettings({ cmd: 1103, params: [], payload: { params: [] } }, 3), { night: null, quality: null, tracking: null });
  assert.equal(nvrLiveSettings({ cmd: 1103, payload: { params: [{ dev_type: 3, param_type: 2730, param_value: '{"web_video_quality":4}' }] } }, 3).quality, 4);
  assert.deepEqual(nvrLiveSettings({ cmd: 1103, payload: { params: [] } }, 3), { night: null, quality: null, tracking: null });
});

test("T8416 quality reads the current mode from its twice-encoded channel row", () => {
  const once = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
  const twice = (value: unknown) => Buffer.from(once(value)).toString("base64");
  const read = (value: unknown, extra: unknown[] = []) => nvrLiveSettings({ cmd: 1103, params: extra,
    db_bypass_str: [{ channel: 3, param_type: 2730, param_value: value }, { channel: 3, param_type: 2731, param_value: twice({ cur_mode: 0, mode_0: { quality: 4 } }) }] }, 3).quality;
  assert.equal(read(twice({ mode_0: { quality: 2 }, mode_1: { quality: 0 }, cur_mode: 0 })), 2);
  assert.equal(read(twice({ mode_0: { quality: 2 }, mode_1: { quality: 1 }, cur_mode: 1 })), 1);
  assert.equal(read(once({ mode_0: { quality: 3 }, cur_mode: 0 })), 3);
  for (const value of [twice({ mode_0: { quality: 2 }, cur_mode: 2 }), twice({ mode_1: { quality: 2 }, cur_mode: 0 }), twice({ mode_0: { quality: 5 }, cur_mode: 0 }),
    twice({ mode_0: { quality: "2" }, cur_mode: 0 }), twice({ web_video_quality: 2 }), "ZXlK", "not base64", 2]) assert.equal(read(value), null);
  assert.equal(read(twice({ mode_0: { quality: 2 }, cur_mode: 0 }), [{ dev_type: 3, param_type: 2730, param_value: '{"web_video_quality":4}' }]), null);
  assert.equal(nvrLiveSettings({ cmd: 1103, params: [], db_bypass_str: [{ channel: 4, param_type: 2730, param_value: twice({ mode_0: { quality: 2 }, cur_mode: 0 }) }] }, 3).quality, null);
});

test("exact model matrix excludes suffixes and cross types", () => {
  assert.deepEqual(nvrLiveProfile("T8E00", 301)?.quality.map(mode => mode.value), [0, 1, 3]);
  assert.equal(nvrLiveProfile("T8416", 104)?.defaultView, 0);
  assert.equal(nvrLiveProfile("T8416", 104)?.panReceiptOnly, true);
  assert.equal(nvrLiveProfile("T8E00", 301)?.panReceiptOnly, true);
  assert.equal(nvrLiveProfile("T8416", 104)?.aiTracking, true); assert.equal(nvrLiveProfile("T8E00", 301)?.aiTracking, false);
  assert.deepEqual(nvrLiveProfile("T8E00", 301)?.views, ["Fixed", "Movable", "Both"]);
  assert.equal(nvrLiveProfile("T8E00", 301)?.stackedView, 2); assert.equal(nvrLiveProfile("T8416", 104)?.stackedView, null);
  assert.equal(nvrLiveProfile("T8E00", 301)?.defaultView, 2);
  for (const [model, type] of [["T8416121", 104], ["T8416", 105], ["T8416", 301], ["T8E00121", 301]] as const) assert.equal(nvrLiveProfile(model, type), null);
});

test("the S1 profile is exact, pan-only and distinct from T8N00 settings", () => {
  const profile = nvrLiveProfile("T8E00", 301, "T9000", 27)!;
  assert.equal(profile.defaultView, 1);
  assert.equal(profile.movementView, 1);
  assert.equal(profile.stackedView, null);
  assert.equal(profile.opticalZoom, false);
  assert.deepEqual(profile.night, []);
  assert.deepEqual(profile.quality, []);
  for (const [model, type, stationType] of [["T8E00S", 301, 27], ["T8E00", 303, 27], ["T8E00", 301, 300], ["T8416", 104, 27]] as const) {
    assert.equal(nvrLiveProfile(model, type, "T9000", stationType), null);
  }
  assert.ok(nvrLiveProfile("T8E00", 301, "T8N00", 300)!.quality.length > 0);
});
