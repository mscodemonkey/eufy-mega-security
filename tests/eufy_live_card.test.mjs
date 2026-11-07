// Exercise the live view card's request flow without a browser.
//
// tests/test_live_card.py runs this file with Node's test runner. The card
// module is loaded from its source text, so no package.json or DOM is needed.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../custom_components/eufy_event_gateway/frontend/eufy-live-card.js", import.meta.url), "utf8");
const card = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const text = card.strings(undefined);

function fakeHass() {
  const entities = {};
  const states = {};
  const add = (entityId, translationKey, device, state = "unknown", extra = {}) => {
    entities[entityId] = { entity_id: entityId, platform: "eufy_event_gateway", device_id: device, translation_key: translationKey, ...extra };
    states[entityId] = { entity_id: entityId, state, attributes: { friendly_name: extra.name ?? entityId } };
  };
  add("camera.office", undefined, "s350", "idle", { name: "Office" });
  add("camera.office_event_image", "event_image", "s350", "idle", { name: "Office Event image", hidden: true });
  for (const dir of ["left", "right", "up", "down"]) add(`button.office_${dir}`, `nvr_${dir}`, "s350");
  for (const level of [1, 2, 3]) add(`button.office_zoom_${level}`, `nvr_zoom_${level}`, "s350");
  add("select.office_night", "camera_night_vision", "s350", "auto_infrared");
  add("button.office_tracking_on", "camera_ai_tracking_on", "s350");
  add("button.office_tracking_off", "camera_ai_tracking_off", "s350");
  add("button.office_preset_2", "camera_preset", "s350", "unknown", { name: "Office Preset 2" });
  add("button.office_preset_10", "camera_preset", "s350", "unknown", { name: "Office Preset 10" });
  add("button.office_home", "camera_preset_default", "s350", "unknown", { name: "Office Home" });
  add("camera.drive", undefined, "s4", "streaming", { name: "Drive" });
  add("button.drive_left", "nvr_left", "s4");
  add("button.drive_zoom_2", "nvr_zoom_2", "s4", "unavailable");
  add("select.drive_view", "nvr_camera_view", "s4", "movable");
  add("siren.drive", "camera_siren", "s4");
  add("switch.drive_ai", "camera_ai_tracking", "s4", "off");
  entities["button.other"] = { entity_id: "button.other", platform: "demo", device_id: "s350", translation_key: "nvr_left" };
  states["button.other"] = { entity_id: "button.other", state: "unknown", attributes: {} };
  add("camera.not_loaded", undefined, "x");
  delete states["camera.not_loaded"];
  return { entities, states };
}

function clock() {
  let time = 0;
  return { now: () => time, wait: async (ms) => { time += ms; } };
}

function controller(overrides = {}) {
  const calls = [];
  const events = [];
  const time = clock();
  const instance = new card.LiveController({
    callService: async (...args) => {
      calls.push(args);
      if (overrides.callService) return overrides.callService(...args);
    },
    cameraState: overrides.cameraState ?? (() => "idle"),
    startVideo: () => events.push("start"),
    stopVideo: () => events.push("stop"),
    onChange: () => {},
    text,
    wait: overrides.wait ?? time.wait,
    now: time.now,
  });
  return { instance, calls, events, time };
}

test("finds only this camera's available controls by translation key", () => {
  const hass = fakeHass();
  const office = card.findControls(hass, "camera.office");
  assert.deepEqual(office.pan, { left: "button.office_left", right: "button.office_right", up: "button.office_up", down: "button.office_down" });
  assert.deepEqual(office.zoom, { 1: "button.office_zoom_1", 2: "button.office_zoom_2", 3: "button.office_zoom_3" });
  assert.equal(office.night, "select.office_night");
  assert.equal(office.trackingOn, "button.office_tracking_on");
  assert.equal(office.view, undefined);
  assert.deepEqual(office.presets.map((preset) => preset.entityId), ["button.office_home", "button.office_preset_2", "button.office_preset_10"]);

  const drive = card.findControls(hass, "camera.drive");
  assert.deepEqual(drive.pan, { left: "button.drive_left" });
  assert.deepEqual(drive.zoom, {}, "an unavailable zoom (Fixed lens) is not offered");
  assert.equal(drive.view, "select.drive_view");
  assert.equal(drive.siren, "siren.drive");
  assert.equal(drive.tracking, "switch.drive_ai");
  assert.deepEqual(card.findControls(hass, "camera.missing"), { pan: {}, zoom: {}, presets: [] });
});

test("lists main Eufy cameras only, by name", () => {
  assert.deepEqual(card.eufyCameras(fakeHass()), ["camera.drive", "camera.office"]);
});

test("reads failure codes from the integration's error wording", () => {
  assert.equal(card.failureCode({ message: "NVR control busy" }), "busy");
  assert.equal(card.failureCode({ message: "Could not change night-vision mode: NVR control outcome_unknown" }), "outcome_unknown");
  assert.equal(card.failureCode({ message: "Request outcome is unknown. Check Eufy before trying again." }), "outcome_unknown");
  assert.equal(card.failureCode({ message: "Movement outcome is unknown. Check the camera before trying again." }), "outcome_unknown");
  assert.equal(card.failureCode({ message: "Gateway returned HTTP 500" }), null);
  assert.equal(card.failureCode(undefined), null);
});

test("an accepted movement is reported as sent, never as moved", () => {
  const moved = card.describeOutcome("move", undefined, text);
  assert.equal(moved.tone, "sent");
  assert.match(moved.text, /^Request sent\. Check the picture to confirm/);
  assert.equal(card.describeOutcome("zoom", undefined, text).tone, "sent");
  assert.equal(card.describeOutcome("move", { message: "NVR control outcome_unknown" }, text).text, text.unknown_move);
  assert.equal(card.describeOutcome("setting", { message: "NVR control outcome_unknown" }, text).text, text.unknown_setting);
  assert.equal(card.describeOutcome("move", { message: "NVR control busy" }, text).text, text.busy);
  assert.equal(card.describeOutcome("setting", undefined, text, { name: "Night vision", value: "Infrared" }).text, "Night vision: Infrared");
  assert.equal(card.describeOutcome("action", { message: "boom" }, text).text, "That did not work: boom");
});

test("one request at a time, then the gateway's action gap", async () => {
  let release;
  const waits = [];
  const { instance, calls } = controller({
    callService: () => new Promise((resolve) => { release = resolve; }),
    wait: async (ms) => { waits.push(ms); },
  });
  const first = instance.press("move", "button.office_left");
  assert.equal(instance.busy, true);
  assert.equal(await instance.press("move", "button.office_right"), false, "a second press is refused while one runs");
  assert.equal(calls.length, 1);
  release();
  assert.equal(await first, true);
  assert.deepEqual(waits, [card.ACTION_GAP_MS]);
  assert.equal(instance.busy, false);
  assert.equal(instance.status.tone, "sent");
});

test("an unknown outcome is shown once and never retried", async () => {
  const { instance, calls } = controller({ callService: () => { throw { message: "NVR control outcome_unknown" }; } });
  await instance.press("move", "button.drive_left");
  assert.equal(calls.length, 1);
  assert.equal(instance.status.tone, "unknown");
});

test("a zoom level is remembered as requested only after acceptance", async () => {
  let fail = false;
  const { instance } = controller({ callService: () => { if (fail) throw { message: "NVR control outcome_unknown" }; } });
  await instance.press("zoom", "button.office_zoom_2", { zoomLevel: 2, camera: "camera.office" });
  assert.equal(instance.requestedZoom.get("camera.office"), 2);
  fail = true;
  await instance.press("zoom", "button.office_zoom_3", { zoomLevel: 3, camera: "camera.office" });
  assert.equal(instance.requestedZoom.has("camera.office"), false, "no level is claimed after an unknown outcome");
  await instance.press("zoom", "button.office_zoom_2", { zoomLevel: 2, camera: "camera.office" });
  instance.reset();
  assert.equal(instance.requestedZoom.size, 0);
});

test("the S4 lens change closes video, waits for idle, sends once, restarts", async () => {
  let polls = 0;
  const { instance, calls, events } = controller({ cameraState: () => (polls++ < 3 ? "streaming" : "idle") });
  assert.equal(await instance.changeLens("select.drive_view", "fixed", "Fixed"), true);
  assert.deepEqual(events, ["stop", "start"]);
  assert.deepEqual(calls, [["select", "select_option", { entity_id: "select.drive_view", option: "fixed" }]]);
  assert.equal(instance.status.tone, "done");
  assert.equal(instance.busy, false);
});

test("the lens change repeats only after busy, which changes nothing", async () => {
  let attempts = 0;
  const { instance, calls } = controller({ callService: () => { if (++attempts < 3) throw { message: "NVR control busy" }; } });
  assert.equal(await instance.changeLens("select.drive_view", "fixed", "Fixed"), true);
  assert.equal(calls.length, 3);

  const unknown = controller({ callService: () => { throw { message: "NVR control outcome_unknown" }; } });
  assert.equal(await unknown.instance.changeLens("select.drive_view", "fixed", "Fixed"), false);
  assert.equal(unknown.calls.length, 1);
  assert.equal(unknown.instance.status.tone, "unknown");
  assert.deepEqual(unknown.events, ["stop", "start"]);
});

test("a camera held by another viewer gives up at the cap and restarts video", async () => {
  const { instance, calls, events, time } = controller({ cameraState: () => "streaming" });
  assert.equal(await instance.changeLens("select.drive_view", "fixed", "Fixed"), false);
  assert.equal(calls.length, 0);
  assert.equal(instance.status.text, text.lens_busy);
  assert.deepEqual(events, ["stop", "start"]);
  assert.ok(time.now() >= card.LENS_WAIT_MS);

  const held = controller({ callService: () => { throw { message: "NVR control busy" }; } });
  assert.equal(await held.instance.changeLens("select.drive_view", "fixed", "Fixed"), false);
  assert.equal(held.instance.status.text, text.lens_busy);
});

test("switching camera mid-change leaves the new camera's video alone", async () => {
  let instanceRef;
  let polls = 0;
  const { instance, events } = controller({
    cameraState: () => {
      if (polls++ === 1) instanceRef.reset();
      return "streaming";
    },
  });
  instanceRef = instance;
  assert.equal(await instance.changeLens("select.drive_view", "fixed", "Fixed"), false);
  assert.deepEqual(events, ["stop"]);
});

test("keeps the picture's shape while video is closed", () => {
  assert.equal(card.cssRatio(undefined), "16 / 9");
  assert.equal(card.cssRatio("4:3"), "4 / 3");
  assert.equal(card.cssRatio("16x9"), "16 / 9");
  assert.equal(card.cssRatio("56.25%"), "100 / 56.25");
  assert.equal(card.cssRatio("1.78"), "1.78");
  assert.equal(card.cssRatio("tall"), "16 / 9");
  assert.equal(card.cssRatio("0:9"), "16 / 9");
});

test("Both is one 8:9 picture, cover-fitted; other views keep the configured shape", () => {
  assert.deepEqual(card.pictureLayout("both", "4:3"), { stacked: true, aspectRatio: "8:9", fitMode: "cover" });
  assert.deepEqual(card.pictureLayout("movable", "4:3"), { stacked: false, aspectRatio: "4:3", fitMode: "contain" });
  assert.deepEqual(card.pictureLayout("fixed", undefined), { stacked: false, aspectRatio: "16:9", fitMode: "contain" });
  assert.deepEqual(card.pictureLayout(undefined, ""), { stacked: false, aspectRatio: "16:9", fitMode: "contain" });
  assert.equal(card.cssRatio(card.pictureLayout("both").aspectRatio), "8 / 9");
});

test("changing to Both says so and restarts video on the Both view", async () => {
  const starts = [];
  const time = clock();
  const instance = new card.LiveController({
    callService: async () => {},
    cameraState: () => "idle",
    startVideo: (view) => starts.push(view),
    stopVideo: () => {},
    onChange: () => {},
    text,
    wait: time.wait,
    now: time.now,
  });
  assert.equal(await instance.changeLens("select.drive_view", "both", "Both"), true);
  assert.equal(instance.status.text, text.both_done);
  assert.deepEqual(starts, ["both"]);
  assert.equal(await instance.changeLens("select.drive_view", "movable", "Movable"), true);
  assert.equal(instance.status.text, card.format(text.lens_done, { lens: "Movable" }));
  assert.deepEqual(starts, ["both", "movable"]);
});

test("the S350 and S4 offer their two lenses, 1x and 3x", () => {
  const zoom = { 1: "button.z1", 2: "button.z2", 3: "button.z3" };
  for (const model of ["T8416", "T8E00"]) {
    assert.deepEqual(card.lensChips(model, zoom), [
      { label: "1x", level: 1, entityId: "button.z1" },
      { label: "3x", level: 2, entityId: "button.z2" },
    ]);
  }
  assert.deepEqual(card.lensChips("T8E00", { 1: "button.z1" }), [{ label: "1x", level: 1, entityId: "button.z1" }], "a withdrawn step is not offered");
  assert.deepEqual(card.lensChips("T9999", zoom).map((chip) => chip.label), ["1x", "2x", "3x"]);
  assert.deepEqual(card.lensChips(undefined, {}), []);
});
