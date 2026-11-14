/**
 * Exercises captured-shape live-quality requests with synthetic identities only.
 * The tests own controller clocks, requests and authenticated-reply stand-ins.
 * They establish correlation and retirement, never physical camera behaviour.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isT8171SessionQualityRoute, T8171SessionQuality, t8171SessionQualityValue } from "../src/provider/t8171-session-quality.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";

const route = { model: "T8171", deviceType: 88, peerModel: "T8030", peerDeviceType: 18,
  channel: 1, homeBaseAttached: true, selfPeer: false };

test("attached quality excludes adjacent models, parent generations and invalid child channels", () => {
  assert.equal(isT8171SessionQualityRoute(route), true);
  for (const change of [{ model: "T8170" }, { model: "T8171E" }, { deviceType: 48 }, { peerModel: "T8010" },
    { peerDeviceType: 0 }, { homeBaseAttached: false }, { selfPeer: true }, { channel: -1 }, { channel: 32 }, { channel: 1.5 }]) {
    assert.equal(isT8171SessionQualityRoute({ ...route, ...change }), false);
  }
});

test("the live request preserves the observed child and fixed view without recording writes", () => {
  assert.deepEqual(JSON.parse(t8171SessionQualityValue(1, 1, "synthetic", "1794698128788")), {
    account_id: "synthetic", cmd: 2730, mChannel: 1, mValue3: 0,
    payload: { quality: 1, mode: 0, primary_view: 0, channel: 1, transaction: "1794698128788" },
  });
  for (const quality of [-1, 4, 1.5, NaN]) assert.throws(() => t8171SessionQualityValue(1, quality, "synthetic", "1794698128788"));
  assert.throws(() => t8171SessionQualityValue(1, 1, "", "1794698128788"));
  assert.throws(() => t8171SessionQualityValue(1, 1, "synthetic", "bad"));
});

test("only the matching live reply changes state, and retirement clears it", async () => {
  const state = new T8171SessionQuality();
  let request!: Record<string, unknown>;
  const pending = state.change(1, 1, "synthetic", new AbortController().signal, value => { request = JSON.parse(value); });
  assert.equal(state.value, null);
  const body = request.payload as Record<string, unknown>;
  for (const changed of [{ cmd: 2731 }, { mChannel: 0 }, { mValue3: 1 },
    ...[{ mode: 12 }, { primary_view: 1 }, { channel: 0 }, { quality: 2 }, { transaction: "1790000000000" }, { transaction: Number(body.transaction) }]
      .map(payload => ({ payload: { ...body, ...payload } }))]) {
    assert.equal(state.accept({ ...request, ...changed }, 1), false);
  }
  assert.equal(state.accept({ ...request, mChannel: 2, payload: { ...body, channel: 2 } }, 2), false);
  await assert.rejects(state.change(1, 2, "synthetic", new AbortController().signal, () => assert.fail("overlap sent")));
  assert.equal(state.accept(request, 1), true); await pending;
  assert.equal(state.value, 1);
  assert.equal(state.accept(request, 1), false);
  state.close(); assert.equal(state.value, null);
  await assert.rejects(state.change(1, 0, "synthetic", new AbortController().signal, () => assert.fail("closed send")));
});

for (const failure of ["timeout", "abort", "close", "send"] as const) {
  test(`an uncertain ${failure} clears previous quality and rejects a late reply`, async () => {
    const state = new T8171SessionQuality(); let request!: Record<string, unknown>;
    await state.change(1, 2, "synthetic", new AbortController().signal, value => { state.accept(JSON.parse(value), 1); });
    assert.equal(state.value, 2);
    const controller = new AbortController();
    const pending = state.change(1, 1, "synthetic", controller.signal, value => {
      request = JSON.parse(value); if (failure === "send") throw new Error("synthetic failure");
    }, 5);
    const rejected = assert.rejects(pending);
    if (failure === "abort") controller.abort();
    if (failure === "close") state.close();
    await rejected; assert.equal(state.value, null); assert.equal(state.accept(request, 1), false);
  });
}

test("an idle or control-only PPCS session cannot acquire quality authority", async () => {
  const session = new FirstPartyPpcsSession({ stationSerial: "synthetic-hub", p2pDid: "synthetic-peer",
    appConnection: "synthetic", dskKey: "synthetic", channel: 1, cameraModel: "T8171", cameraDeviceType: 88,
    stationModel: "T8030", stationDeviceType: 18, accountId: "synthetic", homeBaseAttached: true, purpose: "control" });
  try {
    assert.equal(session.attachedQualityReady, false);
    assert.equal(session.attachedStreamingQuality, null);
    await assert.rejects(session.writeAttachedStreamingQuality(1, new AbortController().signal));
    assert.equal(session.stats.commands.includes(1350), false);
  } finally { session.close(); await session.waitUntilClosed(); }
});
