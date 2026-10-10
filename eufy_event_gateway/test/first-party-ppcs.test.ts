/**
 * Verifies attached-camera media restart boundaries for the PPCS transport.
 *
 * The session owns the UDP protocol; this test guards the time-based policy
 * that prevents a healthy HomeBase stream being reset by its own heartbeat.
 */
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createECDH, createHmac } from "node:crypto";
import test from "node:test";

import {
  buildAutoNightVisionCommandBody,
  buildAiTrackingControlData,
  buildCameraControlQueryValue,
  buildCameraEnableBody,
  buildAttachedMediaControlValue,
  buildLegacyAttachedMediaStopPayload,
  buildNightVisionBody,
  acceptsAttachedCameraMedia,
  acceptsSoloCamAudio,
  buildPpcsCloudLookup,
  buildStandaloneJsonControlPayload,
  buildStandaloneCameraLightBody,
  buildStandaloneLevel2LiveStartPayload,
  buildSoloCamMotionDetectionPayload,
  buildSoloCamAudioRecordingPayload,
  buildSoloCamStreamingQualityPayload,
  buildStandaloneC31StreamingQualityPayload,
  buildStandaloneC31NightVisionPayload,
  buildStandaloneC31EnabledPayload,
  buildStandaloneC31SirenStartPayload,
  buildStandaloneC31SirenStopPayload,
  buildSoloCamPanControlData,
  buildSoloCamPanControlPayload,
  buildStandaloneC31ControlPayload,
  buildStandaloneGuardModeValue,
  buildStandaloneLiveStartPayload,
  buildTimedCameraLightControlValue,
  decodePpcsVideoFrame,
  decodePpcsControlRecord,
  hasDecoderReadyKeyframe,
  isPpcsCameraIdentity,
  needsAttachedMediaReassert,
  needsStandaloneMediaReassert,
  parseCameraPresetPositions,
  supportsViewerPanControl,
  parsePpcsControlRecord,
  PpcsVideoFrameDecoder,
  PpcsVideoStreamNormalizer,
  ppcsCommandMagicOffset,
  ppcsFrameChannel,
  ppcsLookupCandidate,
  ppcsPartialCommandPrefix,
  ppcsSequenceDisposition,
} from "../src/stream/first-party-ppcs.js";
import {
  ppcsCandidatePorts,
  ppcsLocalLookupTargets,
} from "../src/stream/ppcs-lookup.js";

test("builds the two PPCS cloud lookup variants", () => {
  const did = "EUPRCAM-000000-XXXXX";
  const dsk = "XXXXXXXXXXXXXXXXXXXX";
  const fallback = buildPpcsCloudLookup(did, dsk);
  assert.equal(fallback.type.toString("hex"), "f16a");
  assert.equal(fallback.payload.length, 20 + dsk.length + 4);

  const classic = buildPpcsCloudLookup(did, dsk, { host: "192.0.2.1", port: 12_345 });
  assert.equal(classic.type.toString("hex"), "f126");
  assert.equal(classic.payload.length, fallback.payload.length + 20);
  assert.equal(classic.payload.subarray(20, 22).toString("hex"), "0002");
  assert.equal(classic.payload.readUInt16LE(22), 12_345);
  assert.deepEqual(classic.payload.subarray(24, 28), Buffer.from([1, 2, 0, 192]));
  assert.deepEqual(classic.payload.subarray(36, 40), Buffer.from([2, 5, 1, 5]));
  assert.deepEqual(classic.payload.subarray(40), fallback.payload.subarray(20));
});

test("builds a bounded camera enablement body without leaking adjacent data", () => {
  const body = buildCameraEnableBody(3, 0, "account-owner");
  assert.equal(body.length, 136);
  assert.equal(body.readUInt32LE(0), 3);
  assert.equal(body.readUInt32LE(4), 0);
  assert.equal(body.subarray(8, 21).toString("ascii"), "account-owner");
  assert.ok(body.subarray(21).every((value) => value === 0));
  assert.throws(() => buildCameraEnableBody(3, 0, ""), /non-empty account identity/);
});

test("builds and parses the privacy-safe preset-position query contract", () => {
  assert.deepEqual(JSON.parse(buildCameraControlQueryValue(6034, { value: 0 })), {
    commandType: 6034,
    data: { value: 0 },
  });
  assert.throws(() => buildCameraControlQueryValue(0, {}), /positive integer/);
  assert.deepEqual(parseCameraPresetPositions({ points: [
    { index: 0, enable: 0, isdefault: 0, name: "discarded" },
    { index: 3, enable: 1, isdefault: 1, thumbnail: "discarded" },
    { id: "7", enabled: true, isDefault: false },
    { index: -1, enable: 1 },
    { name: "missing index" },
  ] }), [
    { index: 0, enabled: false, isDefault: false },
    { index: 3, enabled: true, isDefault: true },
    { index: 7, enabled: true, isDefault: false },
  ]);
  assert.deepEqual(parseCameraPresetPositions({}), []);
});

test("builds the app-confirmed T817L pan and tracking payloads", () => {
  assert.deepEqual(JSON.parse(buildCameraControlQueryValue(6035, { value: 2 })), {
    commandType: 6035,
    data: { value: 2 },
  });
  assert.deepEqual(JSON.parse(buildCameraControlQueryValue(6031, { value: 1 })), {
    commandType: 6031,
    data: { value: 1 },
  });
  assert.deepEqual(buildAiTrackingControlData(true, 1_234), {
    enable: 0,
    index: 0,
    status: 0,
    type: 0,
    value: 1,
    voiceID: 0,
    zonecount: 0,
    transaction: "1234",
  });
  assert.equal(buildAiTrackingControlData(false, 1_234).value, 0);
  assert.throws(() => buildAiTrackingControlData(true, -1), /non-negative whole number/);
});

test("keeps native SoloCam pan controls distinct from the attached T817L payloads", () => {
  const transaction = 1_791_490_000_000;
  assert.deepEqual(buildSoloCamPanControlData(6034, undefined, transaction), { transaction: `${transaction}` });
  assert.deepEqual(JSON.parse(buildCameraControlQueryValue(6035, buildSoloCamPanControlData(6035, 1, transaction))), {
    commandType: 6035, data: { value: 1, transaction: `${transaction}` },
  });
  for (const value of [0, 1]) {
    assert.deepEqual(buildSoloCamPanControlData(6016, value, transaction), { value, transaction: `${transaction}` });
  }
  assert.throws(() => buildSoloCamPanControlData(6034, 0, transaction), /does not accept/);
  for (const value of [-1, 10, 1.5, undefined]) assert.throws(() => buildSoloCamPanControlData(6035, value, transaction), /Invalid/);
  assert.throws(() => buildSoloCamPanControlData(6016, 2, transaction), /Invalid/);
  assert.throws(() => buildSoloCamPanControlData(6016, 1, 1791490000), /epoch milliseconds/);
});

test("authenticates native SoloCam preset movement on the control rather than media envelope", () => {
  const key = Buffer.alloc(32, 7);
  const payload = buildSoloCamPanControlPayload(6035, 1, key, 257, 1791490000000);
  assert.deepEqual(payload.subarray(4, 10), Buffer.from([8, 0, 0, 8, 0, 0]));
  const encrypted = payload.subarray(10);
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
  decipher.setAAD(Buffer.from("eufy security"));
  decipher.setAuthTag(encrypted.subarray(0, 16));
  const clear = Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]);
  assert.deepEqual(JSON.parse(clear.toString("utf8")), {
    commandType: 6035, data: { value: 1, transaction: "1791490000000" },
  });
});

test("authenticates captured C31 boolean controls without the legacy tracking or timed-light fields", () => {
  const key = Buffer.alloc(32, 11);
  const transaction = 1791490000000;
  for (const command of [6016, 6031, 1400] as const) {
    for (const enabled of [false, true]) {
      const payload = buildStandaloneC31ControlPayload(command, enabled, key, 257, transaction);
      assert.deepEqual(payload.subarray(4, 10), Buffer.from([8, 0, 0, 8, 0, 0]));
      const encrypted = payload.subarray(10);
      const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
      decipher.setAAD(Buffer.from("eufy security"));
      decipher.setAuthTag(encrypted.subarray(0, 16));
      const clear = Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]);
      const value = enabled ? 1 : 0;
      assert.deepEqual(JSON.parse(clear.toString("utf8")), {
        commandType: command,
        data: command === 1400
          ? { value, open: value, type: 2, transaction: "1791490000000" }
          : { value, transaction: "1791490000000" },
      });
    }
  }
  assert.throws(() => buildStandaloneC31ControlPayload(6016, true, key, 0, 1234), /epoch milliseconds/);
  assert.throws(() => buildStandaloneC31ControlPayload(9999 as 6016, true, key, 0, transaction), /Unsupported/);
});

test("builds the direct standalone-camera guard-mode value", () => {
  assert.deepEqual(
    JSON.parse(buildStandaloneGuardModeValue("account-owner", "Home Assistant", 63)),
    {
      account_id: "account-owner",
      cmd: 1224,
      mChannel: 0,
      mValue3: 0,
      payload: { mode_type: 63, user_name: "Home Assistant" },
    },
  );
  assert.throws(
    () => buildStandaloneGuardModeValue("account-owner", "Home Assistant", 2),
    /Unsupported standalone camera guard mode/,
  );
});

test("builds the T8210-family Auto night vision direct command body", () => {
  const key = Buffer.from("0123456789abcdef", "ascii");
  const body = buildAutoNightVisionCommandBody(4, false, "account-owner", key);
  assert.equal(body[4], 1);
  assert.equal(body[5], 0);
  assert.equal(body[6], 4);
  assert.equal(body[7], 1);
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(body.subarray(10)), decipher.final()]);
  assert.equal(plain.readUInt32LE(0), 4);
  assert.equal(plain.readUInt32LE(4), 0);
  assert.equal(plain.subarray(8, 21).toString("ascii"), "account-owner");
  assert.ok(plain.subarray(136).every((value) => value === 0));
});

test("builds the verified night-vision SET_PAYLOAD body", () => {
  assert.deepEqual(JSON.parse(buildNightVisionBody(3, 2, "account-owner").toString("utf8")), {
    account_id: "account-owner",
    cmd: 1277,
    mChannel: 0,
    mValue3: 0,
    payload: { channel: 3, night_sion: 2 },
  });
  assert.equal(JSON.parse(buildNightVisionBody(0, 3, "account-owner").toString("utf8")).payload.night_sion, 3);
  assert.throws(() => buildNightVisionBody(3, 4, "account-owner"), /integer from 0 through 3/);
});

test("reissues a standalone start during startup or after a media stall", () => {
  assert.equal(needsStandaloneMediaReassert(false, null, 1_000), true);
  assert.equal(needsStandaloneMediaReassert(false, 1_000, 6_000), false);
  assert.equal(needsStandaloneMediaReassert(false, 1_000, 11_000), true);
  assert.equal(needsStandaloneMediaReassert(true, null, 1_000), false);
});

test("accepts both PPCS cloud candidate response forms", () => {
  for (const header of [[0xf1, 0x40], [0xf1, 0x82], [0xf1, 0x41]]) {
    const response = Buffer.alloc(24);
    response.set(header, 0);
    response.writeUInt16LE(32_108, 6);
    response.set([9, 2, 0, 192], 8);
    assert.deepEqual(ppcsLookupCandidate(response), { host: "192.0.2.9", port: 32_108 });
  }
  assert.equal(isPpcsCameraIdentity(Buffer.from([0xf1, 0x42])), true);
  assert.equal(isPpcsCameraIdentity(Buffer.from([0xf1, 0x84])), true);
  assert.equal(isPpcsCameraIdentity(Buffer.from([0xf1, 0x40])), false);
  assert.deepEqual(ppcsCandidatePorts(32_108), [32_105, 32_106, 32_107, 32_108, 32_109, 32_110, 32_111]);
});

test("adds the HomeBase inventory address to local PPCS lookup", () => {
  assert.deepEqual(ppcsLocalLookupTargets(null), [
    { host: "255.255.255.255", port: 32_108 },
  ]);
  assert.deepEqual(ppcsLocalLookupTargets("192.168.1.50"), [
    { host: "255.255.255.255", port: 32_108 },
    { host: "192.168.1.50", port: 32_108 },
  ]);
});

test("labels a standalone live start as level-one frame type 11", () => {
  const key = Buffer.from("0123456789abcdef", "utf8");
  const value = JSON.stringify({ commandType: 1000, data: { cmd: 1000 } });
  const payload = buildStandaloneLiveStartPayload(value, 4, key);

  assert.equal(payload.readUInt16LE(0), payload.length - 10);
  assert.deepEqual(payload.subarray(4, 10), Buffer.from([1, 0, 4, 1, 11, 0]));

  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  const clear = Buffer.concat([decipher.update(payload.subarray(10)), decipher.final()]);
  assert.equal(clear.subarray(0, value.length).toString("utf8"), value);
});

test("labels a negotiated standalone live start as level-two frame type 10", () => {
  const key = Buffer.alloc(32, 7);
  const value = JSON.stringify({ commandType: 1000, data: { cmd: 1000 } });
  const payload = buildStandaloneLevel2LiveStartPayload(value, 4, key, 257);

  assert.equal(payload.readUInt16LE(0), payload.length - 10);
  assert.deepEqual(payload.subarray(4, 10), Buffer.from([8, 0, 4, 8, 10, 0]));
  const encrypted = payload.subarray(10);
  assert.deepEqual(encrypted.subarray(28, 32), Buffer.from([1, 3, 2, 1]));
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
  decipher.setAAD(Buffer.from("eufy security", "utf8"));
  decipher.setAuthTag(encrypted.subarray(0, 16));
  const clear = Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]);
  assert.equal(clear.toString("utf8"), value);
});

test("keeps the native SoloCam motion envelope separate from a live-start request", () => {
  const key = Buffer.alloc(32, 7);
  for (const enabled of [false, true]) {
    const payload = buildSoloCamMotionDetectionPayload(enabled, key, 257, 1791464400000);
    assert.deepEqual(payload.subarray(4, 10), Buffer.from([8, 0, 0, 8, 0, 0]));
    const encrypted = payload.subarray(10);
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
    decipher.setAAD(Buffer.from("eufy security"));
    decipher.setAuthTag(encrypted.subarray(0, 16));
    const clear = Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]);
    assert.deepEqual(JSON.parse(clear.toString("utf8")), {
      commandType: 6040, data: { status: enabled ? 1 : 0, transaction: "1791464400000" },
    });
  }
  assert.throws(() => buildSoloCamMotionDetectionPayload(true, key, 1, 1791464400), /epoch milliseconds/);
});

test("keeps the native SoloCam recorded-audio envelope separate from a live-start request", () => {
  const key = Buffer.alloc(32, 7);
  for (const enabled of [false, true]) {
    const payload = buildSoloCamAudioRecordingPayload(enabled, key, 257, 1791464400000);
    assert.deepEqual(payload.subarray(4, 10), Buffer.from([8, 0, 0, 8, 0, 0]));
    const encrypted = payload.subarray(10);
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
    decipher.setAAD(Buffer.from("eufy security"));
    decipher.setAuthTag(encrypted.subarray(0, 16));
    const clear = Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]);
    assert.deepEqual(JSON.parse(clear.toString("utf8")), {
      commandType: 6012, data: { enable: enabled ? 1 : 0, transaction: "1791464400000" },
    });
  }
  assert.throws(() => buildSoloCamAudioRecordingPayload(true, key, 1, 1791464400), /epoch milliseconds/);
});

test("matches every native SoloCam quality wrapper without changing recorded-video quality", () => {
  const key = Buffer.alloc(32, 9);
  for (const quality of [0, 1, 2, 3]) {
    const payload = buildSoloCamStreamingQualityPayload(quality, "fixture-admin", key, 257, 1791464400000);
    assert.deepEqual(payload.subarray(4, 10), Buffer.from([8, 0, 0, 8, 0, 0]));
    const encrypted = payload.subarray(10);
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
    decipher.setAAD(Buffer.from("eufy security"));
    decipher.setAuthTag(encrypted.subarray(0, 16));
    const clear = Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]);
    assert.deepEqual(JSON.parse(clear.toString("utf8")), {
      account_id: "fixture-admin", cmd: 2730, mChannel: 0, mValue3: 0,
      payload: { quality, mode: 0, primary_view: 0, channel: 0, transaction: "1791464400000" },
    });
  }
  for (const invalid of [-1, 4, 1.5, Number.NaN]) {
    assert.throws(() => buildSoloCamStreamingQualityPayload(invalid, "fixture-admin", key, 1, 1791464400000), /Unsupported/);
  }
  assert.throws(() => buildSoloCamStreamingQualityPayload(1, "", key, 1, 1791464400000), /administrator/);
  assert.throws(() => buildSoloCamStreamingQualityPayload(1, "fixture-admin", key, 1, 1791464400), /epoch milliseconds/);
});

test("matches the authenticated C31 quality wrapper and rejects the SoloCam-only tier", () => {
  const key = Buffer.alloc(32, 9);
  for (const quality of [0, 2, 3]) {
    const payload = buildStandaloneC31StreamingQualityPayload(quality, "fixture-admin", key, 257, 1791464400000);
    assert.deepEqual(payload.subarray(4, 10), Buffer.from([8, 0, 0, 8, 0, 0]));
    const encrypted = payload.subarray(10);
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
    decipher.setAAD(Buffer.from("eufy security"));
    decipher.setAuthTag(encrypted.subarray(0, 16));
    const clear = Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]);
    assert.deepEqual(JSON.parse(clear.toString("utf8")), {
      account_id: "fixture-admin", cmd: 2730, mChannel: 0, mValue3: 0,
      payload: { quality, mode: -1, primary_view: -1, transaction: "1791464400000" },
    });
  }
  for (const invalid of [-1, 1, 4, 2.5, Number.NaN]) {
    assert.throws(() => buildStandaloneC31StreamingQualityPayload(invalid, "fixture-admin", key, 1, 1791464400000), /Unsupported/);
  }
  assert.throws(() => buildStandaloneC31StreamingQualityPayload(0, "", key, 1, 1791464400000000), /administrator/);
  assert.throws(() => buildStandaloneC31StreamingQualityPayload(0, "fixture-admin", key, 1, 1791464400), /epoch milliseconds/);
});

test("builds the wall-light control as a level-one command 1700 value", () => {
  const key = Buffer.from("0123456789abcdef", "utf8");
  const value = buildTimedCameraLightControlValue(true);
  const payload = buildStandaloneJsonControlPayload(value, 3, key);

  assert.deepEqual(JSON.parse(value), {
    commandType: 1400,
    data: { time: 0, type: 2, value: 1 },
  });
  assert.deepEqual(
    JSON.parse(buildTimedCameraLightControlValue(false)),
    { commandType: 1400, data: { time: 0, type: 2, value: 0 } },
  );
  assert.deepEqual(payload.subarray(4, 10), Buffer.from([1, 0, 3, 1, 0, 0]));

  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  const clear = Buffer.concat([decipher.update(payload.subarray(10)), decipher.final()]);
  assert.equal(clear.subarray(0, value.length).toString("utf8"), value);
});

test("builds the SoloCam spotlight control with the direct integer and account envelope", () => {
  const key = Buffer.from("0123456789abcdef", "utf8");
  const body = buildStandaloneCameraLightBody(3, true, "account-1", key);
  assert.deepEqual(body.subarray(4, 10), Buffer.from([1, 0, 3, 1, 0, 0]));

  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  const clear = Buffer.concat([decipher.update(body.subarray(10)), decipher.final()]);
  assert.equal(clear.readUInt32LE(0), 3);
  assert.equal(clear.readUInt32LE(4), 1);
  assert.equal(clear.subarray(8, 17).toString("utf8"), "account-1");
});

test("reasserts attached media during startup or after a stall", () => {
  assert.equal(needsAttachedMediaReassert(null, 1_000), true);
  assert.equal(needsAttachedMediaReassert(1_000, 6_000), false);
  assert.equal(needsAttachedMediaReassert(1_000, 11_000), true);
});

test("builds distinct HomeBase start and stop media envelopes", () => {
  assert.deepEqual(JSON.parse(buildAttachedMediaControlValue(1003, 4, "account-owner", "public-key").toString()), {
    account_id: "account-owner",
    cmd: 1003,
    mChannel: 4,
    mValue3: 1003,
    payload: {
      ClientOS: "Android",
      accountId: "account-owner",
      camera_type: 0,
      entrytype: 0,
      key: "public-key",
      streamtype: 1,
    },
  });
  assert.deepEqual(JSON.parse(buildAttachedMediaControlValue(1004, 4, "account-owner").toString()), {
    account_id: "account-owner",
    cmd: 1004,
    mChannel: 4,
    mValue3: 1004,
    payload: {},
  });
  assert.throws(
    () => buildAttachedMediaControlValue(1003, 4, "account-owner"),
    /requires an RSA public key/,
  );
});

test("builds the T8010 direct encrypted media stop command", () => {
  const key = Buffer.from("0123456789abcdef", "utf8");
  const payload = buildLegacyAttachedMediaStopPayload(4, key);

  assert.equal(payload.readUInt16LE(0), 16);
  assert.deepEqual(payload.subarray(4, 10), Buffer.from([1, 0, 4, 1, 0, 0]));
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  const clear = Buffer.concat([decipher.update(payload.subarray(10)), decipher.final()]);
  assert.equal(clear.readUInt32LE(0), 4);
  assert.ok(clear.subarray(4).every((value) => value === 0));
});

test("requires complete codec setup and an IDR before attached media settles", () => {
  assert.equal(hasDecoderReadyKeyframe("h264", [7, 8, 5]), true);
  assert.equal(hasDecoderReadyKeyframe("h264", [7, 8, 1]), false);
  assert.equal(hasDecoderReadyKeyframe("h265", [32, 33, 34, 19]), true);
  assert.equal(hasDecoderReadyKeyframe("h265", [32, 33, 34, 20]), true);
  assert.equal(hasDecoderReadyKeyframe("h265", [32, 39, 1]), false);
  assert.equal(hasDecoderReadyKeyframe("unknown", [32, 33, 34, 19]), false);
});

test("accepts only the requested camera's HomeBase video", () => {
  assert.equal(acceptsAttachedCameraMedia(1300, 4, 4), true);
  assert.equal(acceptsAttachedCameraMedia(1300, 3, 4), false);
  assert.equal(acceptsAttachedCameraMedia(1100, 3, 4), true);
});

test("reads the media channel from the current frame before the parser advances", () => {
  const currentFrame = Buffer.alloc(16);
  Buffer.from("XZYH").copy(currentFrame);
  currentFrame[12] = 4;
  const followingFrame = Buffer.alloc(16, 9);

  assert.equal(ppcsFrameChannel(Buffer.concat([currentFrame, followingFrame])), 4);
  assert.equal(ppcsFrameChannel(followingFrame), null);
});

test("retains a split PPCS command magic prefix", () => {
  assert.deepEqual(ppcsPartialCommandPrefix(Buffer.from("X")), Buffer.from("X"));
  assert.deepEqual(ppcsPartialCommandPrefix(Buffer.from("XZ")), Buffer.from("XZ"));
  assert.deepEqual(ppcsPartialCommandPrefix(Buffer.from("XZYH\0")), Buffer.from("XZYH\0"));
  assert.equal(ppcsPartialCommandPrefix(Buffer.from("garbage")), undefined);
  assert.equal(ppcsPartialCommandPrefix(Buffer.alloc(16, 0)), undefined);
});

test("finds a command header after a short parser resync tail", () => {
  assert.equal(ppcsCommandMagicOffset(Buffer.from("discardXZYH")), 7);
  assert.equal(ppcsCommandMagicOffset(Buffer.from("no command")), -1);
});

test("distinguishes forward loss from duplicate and stale PPCS datagrams", () => {
  assert.equal(ppcsSequenceDisposition(null, 12), "first");
  assert.equal(ppcsSequenceDisposition(12, 13), "next");
  assert.equal(ppcsSequenceDisposition(12, 15), "gap");
  assert.equal(ppcsSequenceDisposition(12, 12), "duplicate");
  assert.equal(ppcsSequenceDisposition(12, 11), "stale");
  assert.equal(ppcsSequenceDisposition(5_000, 1), "restart");
  assert.equal(ppcsSequenceDisposition(0xffff, 0), "next");
});

test("does not apply an earlier encrypted frame key to a plaintext frame", () => {
  const annexB = Buffer.from([0, 0, 0, 1, 0x65, 0x88]);
  const frame = Buffer.alloc(22 + annexB.length);
  frame.writeUInt32LE(annexB.length, 0);
  annexB.copy(frame, 22);

  assert.deepEqual(decodePpcsVideoFrame(frame, 0, () => Buffer.alloc(16, 9)), annexB);
});

test("unwraps and uses the key carried by an encrypted video frame", () => {
  const key = Buffer.alloc(16, 7);
  const clear = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x65]), Buffer.alloc(123, 3)]);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
  const tail = Buffer.from([4, 5, 6]);
  const frame = Buffer.alloc(151 + clear.length + tail.length);
  frame.writeUInt32LE(clear.length + tail.length, 0);
  Buffer.alloc(128, 8).copy(frame, 22);
  encrypted.copy(frame, 151);
  tail.copy(frame, 151 + encrypted.length);

  assert.deepEqual(decodePpcsVideoFrame(frame, 1, () => key), Buffer.concat([clear, tail]));
});

test("accepts a legacy encrypted keyframe with length-prefixed H.264 media", () => {
  const key = Buffer.alloc(16, 7);
  const clear = Buffer.alloc(128, 3);
  clear.writeUInt32BE(124, 0);
  clear[4] = 0x67;
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
  const frame = Buffer.alloc(151 + encrypted.length);
  frame.writeUInt32LE(encrypted.length, 0);
  Buffer.alloc(128, 8).copy(frame, 22);
  encrypted.copy(frame, 151);
  const decoder = new PpcsVideoFrameDecoder(() => key);

  assert.deepEqual(decoder.decode(frame, 1), {
    data: clear,
    protection: "rsa-ecb",
  });
  const normalizer = new PpcsVideoStreamNormalizer();
  assert.deepEqual(normalizer.push(clear), Buffer.concat([Buffer.from([0, 0, 0, 1]), clear.subarray(4)]));
  assert.equal(normalizer.framing, "length-prefixed");
  assert.deepEqual(normalizer.nalTypes, [7]);
});

test("accepts standalone encrypted media whose declared length includes its metadata header", () => {
  const key = Buffer.alloc(16, 7);
  const clear = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x40]), Buffer.alloc(123, 3)]);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
  const tail = Buffer.alloc(50, 4);
  const frame = Buffer.alloc(151 + encrypted.length + tail.length);
  frame.writeUInt32LE(frame.length - 129, 0);
  Buffer.alloc(128, 8).copy(frame, 22);
  encrypted.copy(frame, 151);
  tail.copy(frame, 151 + encrypted.length);

  assert.deepEqual(
    new PpcsVideoFrameDecoder(() => key).decode(frame, 1),
    { data: Buffer.concat([clear, tail]), protection: "rsa-ecb" },
  );
});

test("accepts standalone encrypted media whose declared length covers the complete frame", () => {
  const key = Buffer.alloc(16, 7);
  const clear = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x40]), Buffer.alloc(123, 3)]);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
  const tail = Buffer.alloc(50, 4);
  const frame = Buffer.alloc(151 + encrypted.length + tail.length);
  frame.writeUInt32LE(frame.length, 0);
  Buffer.alloc(128, 8).copy(frame, 22);
  encrypted.copy(frame, 151);
  tail.copy(frame, 151 + encrypted.length);

  assert.deepEqual(
    new PpcsVideoFrameDecoder(() => key).decode(frame, 1),
    { data: Buffer.concat([clear, tail]), protection: "rsa-ecb" },
  );
});

test("accepts standalone encrypted media whose declaration overruns the outer frame", () => {
  const key = Buffer.alloc(16, 7);
  const clear = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x40]), Buffer.alloc(123, 3)]);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
  const tail = Buffer.alloc(50, 4);
  const frame = Buffer.alloc(151 + encrypted.length + tail.length);
  frame.writeUInt32LE(frame.length + 257, 0);
  Buffer.alloc(128, 8).copy(frame, 22);
  encrypted.copy(frame, 151);
  tail.copy(frame, 151 + encrypted.length);

  assert.deepEqual(
    new PpcsVideoFrameDecoder(() => key).decode(frame, 1),
    { data: Buffer.concat([clear, tail]), protection: "rsa-ecb" },
  );
});

test("classifies a failed legacy key unwrap without exposing frame data", () => {
  const frame = Buffer.alloc(151 + 128);
  frame.writeUInt32LE(128, 0);
  const decoder = new PpcsVideoFrameDecoder(() => {
    throw new Error("private key detail must not enter diagnostics");
  });

  assert.equal(decoder.decode(frame, 1), undefined);
  assert.equal(decoder.lastFailure, "legacy-key-unwrap");
});

test("classifies an unsupported unwrapped legacy media key size", () => {
  const frame = Buffer.alloc(151 + 128);
  frame.writeUInt32LE(128, 0);
  const decoder = new PpcsVideoFrameDecoder(() => Buffer.alloc(24));

  assert.equal(decoder.decode(frame, 1), undefined);
  assert.equal(decoder.lastFailure, "legacy-key-size");
});

test("accepts a decrypted legacy continuation without a video start code", () => {
  const key = Buffer.alloc(16, 7);
  const clear = Buffer.alloc(128, 0xff);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
  const frame = Buffer.alloc(151 + encrypted.length);
  frame.writeUInt32LE(encrypted.length, 0);
  Buffer.alloc(128, 8).copy(frame, 22);
  encrypted.copy(frame, 151);

  assert.deepEqual(new PpcsVideoFrameDecoder(() => key).decode(frame, 1), {
    data: clear,
    protection: "rsa-ecb",
  });
});

/** Build a deterministic authenticated-media frame for the public decoder contract. */
function authenticatedFrame(
  recipient: ReturnType<typeof createECDH>,
  mediaKey: Buffer,
  clear: Buffer,
  keyframe: boolean,
): Buffer {
  const ephemeral = createECDH("prime256v1");
  ephemeral.setPrivateKey(Buffer.alloc(32, 2));
  const shared = ephemeral.computeSecret(recipient.getPublicKey());
  const label = Buffer.from("ECIES");
  const hmac = (key: Buffer, value: Buffer): Buffer => createHmac("sha256", key).update(value).digest();
  let previous: Buffer<ArrayBufferLike> = label;
  let derived: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  while (derived.length < 48) {
    previous = hmac(shared, previous);
    derived = Buffer.concat([derived, hmac(shared, Buffer.concat([previous, label]))]);
  }

  const envelope = Buffer.alloc(129);
  ephemeral.getPublicKey(undefined, "compressed").copy(envelope, 0);
  const envelopeIv = Buffer.alloc(16, 3);
  envelopeIv.copy(envelope, 33);
  const envelopeCipher = createCipheriv("aes-128-cbc", derived.subarray(0, 16), envelopeIv);
  const wrapped = Buffer.concat([envelopeCipher.update(mediaKey), envelopeCipher.final()]);
  wrapped.copy(envelope, 49);
  hmac(derived.subarray(16, 48), envelope.subarray(33, 97)).copy(envelope, 97);

  const nonce = Buffer.alloc(12, keyframe ? 4 : 5);
  const bodyCipher = createCipheriv("aes-256-gcm", mediaKey, nonce);
  bodyCipher.setAAD(Buffer.from("eufy security"));
  const body = Buffer.concat([bodyCipher.update(clear), bodyCipher.final()]);
  const frame = Buffer.alloc(179 + body.length);
  frame.writeUInt32LE(clear.length, 0);
  frame[4] = keyframe ? 1 : 0;
  if (keyframe) envelope.copy(frame, 22);
  bodyCipher.getAuthTag().copy(frame, 151);
  nonce.copy(frame, 167);
  body.copy(frame, 179);
  return frame;
}

test("authenticates ECC-wrapped keyframes and reuses their media key for delta frames", () => {
  const recipient = createECDH("prime256v1");
  recipient.setPrivateKey(Buffer.alloc(32, 1));
  const mediaKey = Buffer.alloc(32, 9);
  const keyframe = Buffer.from([0, 0, 0, 1, 0x40, 0x01, 0x42, 0x01]);
  const delta = Buffer.from([0, 0, 0, 1, 0x02, 0x01, 0xaa]);
  const decoder = new PpcsVideoFrameDecoder(() => undefined);
  decoder.setEccPrivateKey(recipient.getPrivateKey().toString("hex"));

  assert.deepEqual(decoder.decode(authenticatedFrame(recipient, mediaKey, keyframe, true), 1), {
    data: keyframe,
    protection: "ecc-gcm",
  });
  assert.deepEqual(decoder.decode(authenticatedFrame(recipient, mediaKey, delta, false), 1), {
    data: delta,
    protection: "ecc-gcm",
  });
});

test("rejects authenticated media after its tag is changed", () => {
  const recipient = createECDH("prime256v1");
  recipient.setPrivateKey(Buffer.alloc(32, 1));
  const frame = authenticatedFrame(recipient, Buffer.alloc(32, 9), Buffer.from([0, 0, 0, 1, 0x65]), true);
  frame[151] = (frame[151] ?? 0) ^ 1;
  const decoder = new PpcsVideoFrameDecoder(() => undefined);
  decoder.setEccPrivateKey(recipient.getPrivateKey().toString("hex"));

  assert.equal(decoder.decode(frame, 1), undefined);
});

test("converts complete length-prefixed H.264 NAL units to Annex-B", () => {
  const sei = Buffer.from([0x06, 0x05, 0x3a, 0xfe]);
  const idr = Buffer.from([0x65, 0x88, 0x84]);
  const lengthPrefixed = Buffer.alloc(8 + sei.length + idr.length);
  lengthPrefixed.writeUInt32BE(sei.length, 0);
  sei.copy(lengthPrefixed, 4);
  lengthPrefixed.writeUInt32BE(idr.length, 4 + sei.length);
  idr.copy(lengthPrefixed, 8 + sei.length);

  const normalizer = new PpcsVideoStreamNormalizer();
  assert.deepEqual(
    normalizer.push(lengthPrefixed),
    Buffer.concat([Buffer.from([0, 0, 0, 1]), sei, Buffer.from([0, 0, 0, 1]), idr]),
  );
  assert.equal(normalizer.framing, "length-prefixed");
});

test("leaves an Annex-B stream unchanged", () => {
  const annexB = Buffer.from([0, 0, 0, 1, 0x65, 0x88]);
  const normalizer = new PpcsVideoStreamNormalizer();

  assert.equal(normalizer.push(annexB), annexB);
  assert.equal(normalizer.framing, "annexb");
});

test("records privacy-safe H.264 NAL types across output chunks", () => {
  const normalizer = new PpcsVideoStreamNormalizer();

  normalizer.push(Buffer.from([0, 0]));
  normalizer.push(Buffer.from([0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 0xce]));
  normalizer.push(Buffer.from([0, 0, 1, 0x65, 0x88]));

  assert.equal(normalizer.codec, "h264");
  assert.deepEqual(normalizer.nalTypes, [7, 8, 5]);
});

test("prefers decoder setup over a conflicting PPCS frame marker", () => {
  const normalizer = new PpcsVideoStreamNormalizer();

  normalizer.push(Buffer.from([0, 0, 0, 1, 0x40, 0x01]), "h264");

  assert.equal(normalizer.codec, "h265");
  assert.deepEqual(normalizer.nalTypes, [32]);
});

test("uses the PPCS frame marker when media bytes do not identify a codec", () => {
  const normalizer = new PpcsVideoStreamNormalizer();

  normalizer.push(Buffer.from([0, 0, 0, 1, 0x1c, 0x01]), "h264");

  assert.equal(normalizer.codec, "h264");
  assert.deepEqual(normalizer.nalTypes, [28]);
});

test("records privacy-safe H.265 NAL types across output chunks", () => {
  const normalizer = new PpcsVideoStreamNormalizer();

  normalizer.push(Buffer.from([0, 0, 0, 1, 0x40, 0x01]));
  normalizer.push(Buffer.from([0, 0, 1, 0x42, 0x01, 0, 0, 1, 0x44, 0x01]));
  normalizer.push(Buffer.from([0, 0, 1, 0x26, 0x01]));

  assert.equal(normalizer.codec, "h265");
  assert.deepEqual(normalizer.nalTypes, [32, 33, 34, 19]);
});

test("converts a length-prefixed NAL split across PPCS video frames", () => {
  const normalizer = new PpcsVideoStreamNormalizer();
  const first = Buffer.from([0, 0, 0, 0xfc, 0x21, 0xe6, 0x03, 0x04]);
  const second = Buffer.alloc(248, 0x55);

  assert.deepEqual(
    normalizer.push(first),
    Buffer.from([0, 0, 0, 1, 0x21, 0xe6, 0x03, 0x04]),
  );
  assert.deepEqual(normalizer.push(second), second);
  assert.equal(normalizer.framing, "length-prefixed");
});

test("retains a split length prefix until the next PPCS video frame", () => {
  const normalizer = new PpcsVideoStreamNormalizer();

  assert.deepEqual(normalizer.push(Buffer.from([0, 0])), Buffer.alloc(0));
  assert.deepEqual(
    normalizer.push(Buffer.from([0, 3, 0x65, 0x88, 0x84])),
    Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84]),
  );
});

test("H264 setup remains H264 when a delta slice resembles a HEVC VPS", () => {
  const normalizer = new PpcsVideoStreamNormalizer();
  normalizer.push(Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0, 1, 0x68, 0xee]), "h264");
  assert.equal(normalizer.codec, "h264");
  normalizer.push(Buffer.from([0, 0, 0, 1, 0x41, 0x9a]));
  assert.equal(normalizer.codec, "h264");
  assert.deepEqual(normalizer.nalTypes, [7, 8, 1]);
  const partial = new PpcsVideoStreamNormalizer();
  partial.push(Buffer.from([0, 0, 0, 1, 0x41, 0x9a]), "h264");
  assert.equal(partial.codec, "h264");
});

test("genuine HEVC setup stays HEVC after EOS resembles a lone H264 PPS", () => {
  const normalizer = new PpcsVideoStreamNormalizer();
  normalizer.push(Buffer.from([0, 0, 0, 1, 0x40, 0x01, 0, 0, 1, 0x42, 0x01, 0, 0, 1, 0x44, 0x01]), "h264");
  normalizer.push(Buffer.from([0, 0, 1, 0x48, 0x01]));
  assert.equal(normalizer.codec, "h265");
  assert.deepEqual(normalizer.nalTypes, [32, 33, 34, 36]);
});

test("SoloCam audio isolates attached children and excludes controls and unrelated models", () => {
  assert.equal(acceptsSoloCamAudio("T8171", true, 1, 1, "live"), true);
  assert.equal(acceptsSoloCamAudio("T8171", true, 1, 2, "live"), false);
  assert.equal(acceptsSoloCamAudio("T8171", true, 1, 1, "control"), false);
  assert.equal(acceptsSoloCamAudio("T8171", false, 0, 0, undefined), true);
  assert.equal(acceptsSoloCamAudio("T8171", false, 1, 1, "live"), false);
  assert.equal(acceptsSoloCamAudio("T817L", true, 1, 1, "live"), false);
  assert.equal(acceptsSoloCamAudio("T817L", false, 0, 0, "live"), true);
  assert.equal(acceptsSoloCamAudio("T817L", false, 1, 1, "live"), false);
  assert.equal(acceptsSoloCamAudio("T817L", false, 0, 1, "live"), false);
  assert.equal(acceptsSoloCamAudio("T817L", false, 0, 0, "control"), false);
  assert.equal(acceptsSoloCamAudio("T817L121", false, 0, 0, "live"), false);
  assert.equal(acceptsSoloCamAudio("T8171", true, -1, -1, "live"), false);
});


test("control replies accept native PKCS7 padding and reject partial or trailing data", () => {
  const body = Buffer.from(JSON.stringify({ cmd: 6034, payload: { points: [{ index: 1, enable: 1 }] } }));
  const expected = JSON.parse(body.toString());
  assert.deepEqual(parsePpcsControlRecord(body), expected);
  assert.deepEqual(parsePpcsControlRecord(Buffer.concat([body, Buffer.alloc(8)])), expected);
  for (let padding = 1; padding <= 16; padding++) {
    assert.deepEqual(parsePpcsControlRecord(Buffer.concat([body, Buffer.alloc(padding, padding)])), expected);
  }
  for (const suffix of [Buffer.from([2]), Buffer.from([1, 2]), Buffer.alloc(17, 17), Buffer.from("garbage")]) {
    assert.equal(parsePpcsControlRecord(Buffer.concat([body, suffix])), undefined);
  }
  assert.equal(parsePpcsControlRecord(Buffer.from("[]")), undefined);
  assert.equal(parsePpcsControlRecord(body.subarray(0, -1)), undefined);
});

test("control queries authenticate both level-two notification signatures without plaintext fallback", () => {
  const key = Buffer.alloc(32, 0x52), level1 = Buffer.alloc(16, 0x31);
  const body = Buffer.from(JSON.stringify({ cmd: 6034, payload: { points: [{ index: 2, enable: 1 }] } }));
  const expected = JSON.parse(body.toString());
  for (const sign of [2, 8]) {
    const nonce = Buffer.alloc(12, sign);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from("eufy security"));
    const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
    const frame = Buffer.concat([cipher.getAuthTag(), nonce,
      ...(sign === 8 ? [Buffer.from([0, 3, 2, 1])] : []), encrypted]);
    assert.deepEqual(decodePpcsControlRecord(frame, sign, level1, key), expected);
    assert.equal(decodePpcsControlRecord(frame, sign, level1, null), undefined);
    assert.equal(decodePpcsControlRecord(frame, sign, level1, Buffer.alloc(32)), undefined);
    const damaged = Buffer.from(frame);
    damaged[0] = damaged[0]! ^ 1;
    assert.equal(decodePpcsControlRecord(damaged, sign, level1, key), undefined);
    assert.equal(decodePpcsControlRecord(body, sign, level1, key), undefined);
  }
  assert.deepEqual(decodePpcsControlRecord(body, 0, level1, null), expected);
  assert.equal(decodePpcsControlRecord(body, 3, level1, key), undefined);
  const cipher = createCipheriv("aes-128-ecb", level1, null);
  const frame = Buffer.concat([cipher.update(body), cipher.final()]);
  assert.deepEqual(decodePpcsControlRecord(frame, 1, level1, null), expected);
  assert.equal(decodePpcsControlRecord(frame.subarray(1), 1, level1, null), undefined);
});


test("C31 viewer ownership admits preset and cruise commands without admitting unrelated writes", () => {
  for (const command of [6034, 6035, 6031]) assert.equal(supportsViewerPanControl("T817L", false, 0, command), true);
  for (const command of [undefined, 6016, 1400, 6040, 1277]) assert.equal(supportsViewerPanControl("T817L", false, 0, command), false);
  assert.equal(supportsViewerPanControl("T817L", true, 0, 6035), false);
  assert.equal(supportsViewerPanControl("T817L", false, 1, 6035), false);
  assert.equal(supportsViewerPanControl("T817L121", false, 0, 6035), false);
  assert.equal(supportsViewerPanControl("T8171", false, 0), true);
  assert.equal(supportsViewerPanControl("T8171", true, 1), true);
  assert.equal(supportsViewerPanControl("T8171", true, 0), false);
});


test("C31 night vision uses its authenticated native wrapper rather than the E30 envelope", () => {
  const key = Buffer.alloc(32, 7);
  for (const mode of [0, 1, 2]) {
    const payload = buildStandaloneC31NightVisionPayload(mode, "fixture-admin", key, 257, 1791464400000);
    const encrypted = payload.subarray(10);
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
    decipher.setAAD(Buffer.from("eufy security"));
    decipher.setAuthTag(encrypted.subarray(0, 16));
    const clear = Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]);
    assert.deepEqual(JSON.parse(clear.toString("utf8")), {
      account_id: "fixture-admin", cmd: 1277, mChannel: 0, mValue3: 0,
      payload: { night_sion: mode, channel: 0, transaction: "1791464400000" },
    });
  }
  for (const invalid of [-1, 3, 1.5, Number.NaN]) assert.throws(() => buildStandaloneC31NightVisionPayload(invalid, "fixture-admin", key, 1, 1791464400000), /Unsupported/);
  assert.throws(() => buildStandaloneC31NightVisionPayload(0, "", key, 1, 1791464400000), /administrator/);
  assert.throws(() => buildStandaloneC31NightVisionPayload(0, "fixture-admin", key, 1, 1791464400), /epoch milliseconds/);
});


test("C31 enablement protects its native privacy bit and validates identity and transaction", () => {
  const key = Buffer.alloc(32, 7);
  for (const rawValue of [0, 1]) {
    const payload = buildStandaloneC31EnabledPayload(rawValue, "fixture-admin", key, 1, 1791464400000);
    const encrypted = payload.subarray(10);
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
    decipher.setAAD(Buffer.from("eufy security"));
    decipher.setAuthTag(encrypted.subarray(0, 16));
    const clear = Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]);
    assert.deepEqual(JSON.parse(clear.toString("utf8")), {
      account_id: "fixture-admin", cmd: 6250, mChannel: 0, mValue3: 0,
      payload: { switch: rawValue, transaction: "1791464400000" },
    });
  }
  for (const invalid of [-1, 2, 0.5, Number.NaN]) assert.throws(() => buildStandaloneC31EnabledPayload(invalid, "fixture-admin", key, 1, 1791464400000), /Unsupported/);
  assert.throws(() => buildStandaloneC31EnabledPayload(0, "", key, 1, 1791464400000), /administrator/);
  assert.throws(() => buildStandaloneC31EnabledPayload(0, "fixture-admin", key, 1, 1791464400), /epoch milliseconds/);
});


test("C31 siren authenticates its timed JSON start and both ordered binary stop steps", () => {
  const key = Buffer.alloc(32, 7);
  const decode = (payload: Buffer): Buffer => {
    const encrypted = payload.subarray(10);
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(16, 28));
    decipher.setAAD(Buffer.from("eufy security"));
    decipher.setAuthTag(encrypted.subarray(0, 16));
    assert.equal(payload[7], 8);
    return Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]);
  };
  const start = buildStandaloneC31SirenStartPayload("fixture-admin", key, 1, 1791619200000);
  assert.equal(start[6], 0);
  assert.deepEqual(JSON.parse(decode(start).toString()), {
    account_id: "fixture-admin", cmd: 1201, mChannel: 0, mValue3: 0,
    payload: { channel: 0, type: 10, time_out: 30, user_name: "", transaction: "1791619200000" },
  });
  for (const command of [1201, 1202] as const) {
    const stop = buildStandaloneC31SirenStopPayload(command, key, command);
    const clear = decode(stop);
    assert.equal(clear.length, 8);
    assert.equal(clear.readUInt32LE(0), command === 1201 ? 10 : 255);
    assert.equal(clear.readUInt32LE(4), 0);
    assert.equal(stop[6], 255);
  }
  assert.throws(() => buildStandaloneC31SirenStartPayload("", key, 1, 1791619200000), /administrator/);
  assert.throws(() => buildStandaloneC31SirenStartPayload("fixture-admin", key, 1, 0), /epoch/);
  assert.throws(() => buildStandaloneC31SirenStopPayload(0 as 1201, key, 1), /stop command/);
});
