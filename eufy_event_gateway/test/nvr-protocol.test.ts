/**
 * Exercises source-derived NVR framing with synthetic identities and bytes.
 * No cloud session or hardware is used. These checks cannot qualify playback.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { IceCandidate, RTCIceCandidate } from "werift";
import { diagnosticsPage } from "../src/diagnostics/page.js";
import { NvrPtcsReassembler } from "../src/stream/nvr-ptcs-reassembly.js";
import { nvrApplication, nvrCandidate, nvrCommand, nvrHeartbeat, nvrMatchCamera, nvrNetworkHost, nvrOffer, nvrPackets, nvrVideo, nvrTrialSensor, nvrStateSummary, NvrTrialError } from "../src/stream/nvr-protocol.js";
import { loadConfig } from "../src/config.js";

function offer(): string {
  return ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:2',
    'a=ice-ufrag:synthetic', 'a=ice-pwd:syntheticPasswordAtLeast22', 'a=setup:actpass',
    'a=fingerprint:sha-256 ' + Array(32).fill('AA').join(':'), 'a=sctp-port:5000', 'a=max-message-size:262144', ''].join('\r\n');
}

function video(): Buffer {
  const body = Buffer.alloc(28); body.writeUInt32LE(6); body[5] = 1;
  body.writeUInt16LE(65535, 6); body.writeUInt16LE(3840, 10); body.writeUInt16LE(2160, 12);
  body.writeBigUInt64LE(9007199254740993n, 14); Buffer.from([0, 0, 0, 1, 38, 1]).copy(body, 22);
  const frame = Buffer.alloc(16); frame.write('XZYH'); frame.writeUInt16LE(1300, 4); frame.writeUInt32LE(body.length, 6); frame[12] = 3; frame[14] = 1;
  return Buffer.concat([frame, body]);
}

test('NVR sender fragments and reassembles reordered large frames over a slow simulated relay', () => {
  const frame = Buffer.alloc(400000, 7), packets = nvrPackets(frame, 65535, 123, 1);
  const receive = new NvrPtcsReassembler({ maxFrameBytes: 4 * 1024 * 1024 + 64, maxBufferedBytes: 12 * 1024 * 1024 });
  let now = 0, completed: Buffer | null = null;
  for (const packet of packets.reverse()) {
    const result = receive.push(packet, now++ * 2);
    if (result.status === 'complete') completed = result.frame;
  }
  assert.deepEqual(completed, frame);
  assert.equal(receive.stats.bufferedBytes, 0);
  assert.equal(receive.push(packets[0]!, 900).status, 'rejected');
  assert.throws(() => receive.expire(899), /monotonic/);
});

test('NVR discovery/start/stop payloads and heartbeat match the separate fixed contracts', () => {
  for (const command of [9100, 1003, 1004] as const) {
    const parsed = nvrApplication(nvrCommand('synthetic-account', command, 1, 3));
    assert.equal(parsed.command, 1350); assert.equal(parsed.segment, 1); assert.equal(parsed.channel, 255);
    const body = JSON.parse(parsed.payload.toString()); assert.equal(body.cmd, command);
    if (command === 1003) {
      assert.equal(parsed.stream, 1);
      assert.deepEqual(body.payload, { ClientOS: 'WEB', entrytype: 1, camera_type: 0, streamtype: 2, key: '', msg_id: '', audio_chn: -1, stitch_mode: 1, chn_list: [{ index: 0, chn: 3, sensor: 1 }] });
    } else assert.deepEqual(body.payload, {});
  }
  const heartbeat = nvrHeartbeat(); assert.equal(heartbeat.length, 36); assert.equal(heartbeat[12], 99);
  assert.equal(nvrApplication(heartbeat.subarray(20)).command, 1139);
  assert.throws(() => nvrCommand('synthetic', 9100, 0, 3));
  const malformed = nvrCommand('synthetic', 9100, 1, 3); malformed.writeUInt32LE(999, 6); assert.throws(() => nvrApplication(malformed));
  const flagged = nvrCommand('synthetic', 9100, 1, 3); flagged[10] = 1;
  assert.equal(nvrApplication(flagged).command, 1350);
  flagged[10] = 2; assert.throws(() => nvrApplication(flagged), /framing/);
});

test('NVR video requires the selected stream and preserves 64-bit timestamps', () => {
  const frame = video(), parsed = nvrVideo(nvrApplication(frame), 3);
  assert.equal(parsed.codec, 'h265'); assert.equal(parsed.sequence, 65535); assert.equal(parsed.timestamp, 9007199254740993n);
  for (const mutate of [(b: Buffer) => { b[14] = 2; }, (b: Buffer) => { b[12] = 4; },
    (b: Buffer) => { b[21] = 2; }, (b: Buffer) => { b.writeUInt32LE(7, 16); },
    (b: Buffer) => { b.writeUInt16LE(0, 26); }, (b: Buffer) => { b.writeUInt16LE(1301, 4); }]) {
    const bad = Buffer.from(frame); mutate(bad); assert.throws(() => nvrVideo(nvrApplication(bad), 3));
  }
  assert.throws(() => nvrVideo(nvrApplication(frame.subarray(0, 20)), 3));
});

test('NVR video accepts the observed media envelope without accepting other channels or commands', () => {
  const frame = video(); frame[12] = 101;
  assert.equal(nvrVideo(nvrApplication(frame), 3).codec, 'h265');
  for (const channel of [100, 102, 4, 0]) {
    const wrong = Buffer.from(frame); wrong[12] = channel;
    assert.throws(() => nvrVideo(nvrApplication(wrong), 3));
  }
  const wrongStream = Buffer.from(frame); wrongStream[14] = 2;
  assert.throws(() => nvrVideo(nvrApplication(wrongStream), 3));
  const audio = Buffer.from(frame); audio.writeUInt16LE(1301, 4);
  assert.throws(() => nvrVideo(nvrApplication(audio), 3));
});

test('NVR discovery refuses missing, ambiguous and wrong camera bindings', () => {
  const row = { sn: 'synthetic-camera', ch: 3, dev_type: 301 };
  nvrMatchCamera({ payload: { dev_list: [row] } }, 'synthetic-camera', 3);
  assert.throws(() => nvrMatchCamera({ payload: { dev_list: [{}] } }, 'synthetic-camera', 3), /identity_field_missing/);
  for (const rows of [[{ ...row, ch: 4 }], [{ ...row, dev_type: 300 }], [row, row]]) {
    assert.throws(() => nvrMatchCamera({ payload: { dev_list: rows } }, 'synthetic-camera', 3), /identity_unmatched/);
  }
});

test('NVR native SDP refuses compact or mixed media and never weakens fingerprints', () => {
  assert.equal(nvrOffer(offer()).mid, '2');
  assert.throws(() => nvrOffer(offer() + 'a=ice-ufrag:duplicate\r\n'));
  assert.throws(() => nvrOffer(offer() + Array(65).fill('a=candidate:1 1 UDP 123 192.0.2.1 1234 typ host\r\n').join('')));
  for (const bad of [JSON.stringify({ ice: {} }), offer() + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\n',
    offer() + 'a=fingerprint:sha-1 AA:BB\r\n', offer().replace('sha-256', 'sha-1'), offer().replace('a=mid:2', 'a=mid:'),
    offer().replace('a=sctp-port:5000', 'a=sctp-port:0')]) assert.throws(() => nvrOffer(bad));
});

test('NVR endpoint and candidate checks reject local-only and malformed destinations', () => {
  for (const host of ['127.0.0.1', '0.0.0.0', '169.254.1.1', '224.0.0.1', '::1', '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0', '::', 'fe80::1', 'ff02::1', 'x.local', 'x.localhost']) assert.equal(nvrNetworkHost(host), false, host);
  for (const host of ['192.0.2.1', '10.0.0.1', 'turn.example.com']) assert.equal(nvrNetworkHost(host), true);
  const candidate = 'candidate:1 1 UDP 123 192.0.2.1 1234 typ host'; assert.equal(nvrCandidate('a=' + candidate), candidate);
  const failures = new Map([
    [candidate + '\r\n', 'candidate_shape'],
    [candidate.replace(' 1 UDP', ' 2 UDP'), 'candidate_component'],
    [candidate.replace('UDP', 'TCP'), 'candidate_transport'],
    [candidate.replace(' 123 ', ' 4294967296 '), 'candidate_priority'],
    [candidate.replace('192.0.2.1', '127.0.0.1'), 'candidate_host'],
    [candidate.replace('1234', '65536'), 'candidate_port'],
    [candidate.replace('typ host', 'typ unknown'), 'candidate_type'],
    [candidate + ' rport 0', 'candidate_related_port'],
  ]);
  for (const [bad, reason] of failures) {
    assert.throws(() => nvrCandidate(bad), (error: unknown) => error instanceof NvrTrialError && error.reason === reason);
  }
});

test('NVR trial configuration is default-off and requires authentication and a fixed region', () => {
  assert.equal(loadConfig({}).experimentalNvrLive, false); assert.equal(loadConfig({}).experimentalNvrRegion, 'auto');
  assert.throws(() => loadConfig({ EUFY_GATEWAY_EXPERIMENTAL_NVR_LIVE: 'true' }), /API_TOKEN/);
  assert.throws(() => loadConfig({ EUFY_GATEWAY_EXPERIMENTAL_NVR_REGION: 'https://example.com' }), /region/);
});


test('NVR trial profiles match only exact reported model and type pairs', () => {
  for (const [model, type] of [['T8140', 14], ['T8140-Z', 14], ['T8113-V', 8], ['T8172', 89], ['T8162', 26], ['T8170', 48], ['T81A0', 10005], ['T8425', 47]] as const) {
    assert.equal(nvrTrialSensor(model, type), 0);
    for (const wrong of [model.toLowerCase(), model + 'X']) assert.equal(nvrTrialSensor(wrong, type), null);
    assert.equal(nvrTrialSensor(model, 301), null);
    const command = nvrApplication(nvrCommand('synthetic', 1003, 1, 0, 0));
    assert.deepEqual(JSON.parse(command.payload.toString()).payload.chn_list, [{ index: 0, chn: 0, sensor: 0 }]);
    nvrMatchCamera({ payload: { dev_list: [{ sn: 'synthetic-camera', ch: 0, dev_type: type }] } }, 'synthetic-camera', 0, type);
  }
  assert.equal(nvrTrialSensor('T8E00', 301), 1);
  assert.equal(nvrTrialSensor('T8E00', 14), null);
  assert.throws(() => nvrCommand('synthetic', 1003, 1, 0, 2 as never));
  assert.throws(() => nvrCommand('synthetic', 1224 as never, 1, 0));
});

test('NVR discovery rejects ambiguous aliases and duplicate selected identities before video', () => {
  const row = { sn: 'synthetic-camera', ch: 0, dev_type: 14 };
  for (const rows of [[{ ...row, type: 301 }], [{ ...row, type: '14' }], [row, { ...row, dev_type: 301 }], [row, { ...row, sn: 'synthetic-other' }], [row, { ...row, ch: 1 }], [{ ...row, dev_type: undefined }]]) {
    assert.throws(() => nvrMatchCamera({ payload: { dev_list: rows } }, 'synthetic-camera', 0, 14));
  }
  nvrMatchCamera({ payload: { dev_list: [{ ...row, dev_type: undefined, type: 14 }] } }, 'synthetic-camera', 0, 14);
});


test('NVR state reads preserve explicit station and channel-zero scope without exposing other parameters', () => {
  const response = { payload: { params: [
    { dev_type: 255, param_type: 1224, param_value: '2' },
    { channel: 255, param_type: 1151, param_value: 1 },
    { channel: 0, param_type: 6250, param_value: 'MA==' },
    { channel: 1, param_type: 6250, param_value: 1 },
    { channel: 0, param_type: 9999, param_value: 'private-value-never-projected' },
  ] } };
  const value = nvrStateSummary(response, 0);
  assert.equal(value.configuredGuardMode, 2); assert.equal(value.effectiveGuardMode, 1); assert.equal(value.cameraPower, 'on');
  assert.equal(value.parameterCount, 5); assert.equal(Number.isNaN(Date.parse(value.queriedAt)), false);
  assert.equal(JSON.stringify(value).includes('private-value'), false);
  assert.equal(nvrStateSummary(response, 1).cameraPower, 'off');
  const read = nvrApplication(nvrCommand('synthetic', 1103, 2, 0));
  assert.deepEqual(JSON.parse(read.payload.toString()).payload, { channel_info: { array_size: 2, channel_array: [255, 0] } });
});

test('NVR state reads keep missing, invalid and structured values unknown', () => {
  for (const value of [undefined, null, 'unknown', -1, 999, {}, 'eyJtb2RlIjoxfQ==', 'sA==']) {
    const result = nvrStateSummary({ params: [{ channel: 0, param_type: 6250, param_value: value }, { dev_type: 255, param_type: 1224, param_value: value }] }, 0);
    assert.equal(result.cameraPower, null); assert.equal(result.configuredGuardMode, null);
  }
  assert.equal(nvrStateSummary({ params: [{ dev_type: 255, param_type: 1224, param_value: 6 }] }, 0).configuredGuardMode, null);
  const empty = nvrStateSummary({ params: [] }, 0);
  assert.equal(empty.cameraPower, null); assert.equal(empty.effectiveGuardMode, null);
});

test('NVR state rejects malformed, oversized, duplicate and conflicting scoped rows', () => {
  const row = { dev_type: 0, param_type: 6250, param_value: 0 };
  for (const response of [{}, { params: {} }, { params: [], db_bypass_str: {} },
    { params: Array(1025).fill(row) }, { params: [row, row] },
    { params: [{ ...row, channel: 1 }] }, { params: [{ ...row, channel: '0' }] },
    { params: [{ ...row, param_value: '0'.repeat(257) }] }]) assert.throws(() => nvrStateSummary(response, 0), /state/);
});


test('NVR setup reasons identify rejected fields without echoing their values', () => {
  const cases = [
    [offer() + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\n', 'offer_media'],
    [offer().replace('sha-256', 'sha-1'), 'offer_fingerprint'],
    [offer().replace('a=mid:2', 'a=mid:'), 'offer_mid'],
    [offer().replace('a=ice-pwd:syntheticPasswordAtLeast22', 'a=ice-pwd:private'), 'offer_ice'],
    [offer().replace('actpass', 'active'), 'offer_setup'],
    [offer().replace('a=sctp-port:5000', 'a=sctp-port:0'), 'offer_sctp'],
    [offer().replace('262144', '1'), 'offer_message_size'],
    [offer() + 'a=ice-ufrag:private-value\r\n', 'offer_duplicate'],
    [offer() + Array(65).fill('a=candidate:1 1 UDP 123 192.0.2.1 1234 typ host\r\n').join(''), 'candidate_limit'],
  ] as const;
  for (const [input, reason] of cases) assert.throws(() => nvrOffer(input), error => {
    assert.ok(error instanceof NvrTrialError); assert.equal(error.stage, 'negotiation');
    assert.equal(error.reason, reason); assert.equal(error.message.includes('private'), false); return true;
  });
  assert.throws(() => nvrCandidate('private-candidate'), error => {
    assert.ok(error instanceof NvrTrialError); assert.equal(error.reason, 'candidate_shape'); return true;
  });
  const unsafe = new NvrTrialError('negotiation', 'private-value' as never);
  assert.equal(unsafe.reason, 'unspecified'); assert.equal(unsafe.message.includes('private-value'), false);
});

test('NVR offer accepts one optional numeric SCTP token without widening the media shape', () => {
  assert.equal(nvrOffer(offer().replace('webrtc-datachannel', 'webrtc-datachannel 1024')).mid, '2');
  for (const suffix of [' private', ' 1024 extra', ' 1024 2048', ' -1']) {
    assert.throws(() => nvrOffer(offer().replace('webrtc-datachannel', `webrtc-datachannel${suffix}`)), error => {
      assert.ok(error instanceof NvrTrialError); assert.equal(error.reason, 'offer_media'); return true;
    });
  }
});

test('NVR concealed metadata reaches the real ICE parser without weakening destinations', () => {
  for (const type of ['srflx', 'prflx', 'relay']) {
    for (const destination of ['192.0.2.1', '2001:db8::1']) {
      for (const address of ['0.0.0.0', '::']) {
        for (const port of ['0', '9']) {
          const text = `candidate:1 1 UDP 123 ${destination} 1234 typ ${type} raddr ${address} rport ${port}`;
          assert.equal(nvrCandidate('a=' + text), text);
          assert.equal(nvrOffer(offer() + 'a=' + text + '\r\n').mid, '2');
          const parsed = IceCandidate.fromJSON(new RTCIceCandidate({ candidate: nvrCandidate(text), sdpMid: '2', sdpMLineIndex: 0 }));
          assert.ok(parsed);
          assert.equal(parsed.ip, destination);
          assert.equal(parsed.port, 1234);
          assert.equal(parsed.relatedAddress, address);
          assert.equal(parsed.relatedPort, Number(port));
        }
      }
    }
  }
  const candidate = 'candidate:1 1 UDP 123 192.0.2.1 1234 typ relay raddr 0.0.0.0 rport 0';
  assert.equal(nvrOffer(offer() + ('a=' + candidate + '\r\n').repeat(64)).mid, '2');
  assert.throws(() => nvrOffer(offer() + ('a=' + candidate + '\r\n').repeat(65)),
    (error: unknown) => error instanceof NvrTrialError && error.reason === 'candidate_limit');
  assert.throws(() => nvrOffer((offer() + 'a=' + candidate + '\r\n').replace('sha-256', 'sha-1')),
    (error: unknown) => error instanceof NvrTrialError && error.reason === 'offer_fingerprint');
});

test('NVR related metadata rejects malformed and ambiguous pairs with fixed reasons', () => {
  const prefix = 'candidate:1 1 UDP 123 192.0.2.1 1234 typ relay';
  const cases = [
    [' raddr 0.0.0.0', 'candidate_related_address'],
    [' raddr :: rport 1234', 'candidate_related_address'],
    [' raddr [::] rport 9', 'candidate_related_address'],
    [' raddr 0:0:0:0:0:0:0:0 rport 9', 'candidate_related_address'],
    [' raddr 00.0.0.0 rport 9', 'candidate_related_address'],
    [' rport 0', 'candidate_related_port'],
    [' raddr 192.0.2.2 rport 0', 'candidate_related_port'],
    [' raddr :: rport -1', 'candidate_related_port'],
    [' raddr :: rport canary-private-value', 'candidate_related_port'],
    [' raddr :: rport 65536', 'candidate_related_port'],
    [' raddr :: rport 0 rport 9', 'candidate_related_port'],
    [' raddr :: raddr 0.0.0.0 rport 9', 'candidate_related_address'],
    [' raddr :: rport', 'candidate_shape'],
  ] as const;
  for (const [suffix, reason] of cases) {
    assert.throws(() => nvrCandidate(prefix + suffix), (error: unknown) => {
      assert.ok(error instanceof NvrTrialError);
      assert.equal(error.reason, reason);
      assert.equal(error.message.includes('canary-private-value'), false);
      return true;
    });
  }
  for (const port of ['0', '9']) {
    assert.throws(() => nvrCandidate(prefix.replace('typ relay', 'typ host') + ' raddr :: rport ' + port));
  }
  for (const destination of ['0.0.0.0', '::', '127.0.0.1']) {
    assert.throws(() => nvrCandidate(prefix.replace('192.0.2.1', destination) + ' raddr :: rport 0'),
      (error: unknown) => error instanceof NvrTrialError && error.reason === 'candidate_host');
  }
  assert.throws(() => nvrCandidate(prefix.replace('1234', '0') + ' raddr :: rport 0'),
    (error: unknown) => error instanceof NvrTrialError && error.reason === 'candidate_port');
  for (const suffix of ['', ' raddr 192.0.2.2 rport 9', ' raddr 192.0.2.2 rport 65535', ' generation 0 network-cost 999']) {
    assert.equal(nvrCandidate(prefix + suffix), prefix + suffix);
  }
});

test('NVR modes retain custom and geofencing values without inventing absent station state', () => {
  for (const mode of [0, 1, 2, 3, 4, 5, 47, 63, 6, 7, 62, 64]) {
    const result = nvrStateSummary({ params: [
      { channel: 255, param_type: 1224, param_value: mode },
      { dev_type: 255, param_type: 1151, param_value: mode },
    ] }, 9);
    const expected = [6, 7, 62, 64].includes(mode) ? null : mode;
    assert.equal(result.configuredGuardMode, expected);
    assert.equal(result.effectiveGuardMode, expected);
  }
  const cameraOnly = nvrStateSummary({ params: [{ dev_type: 9, param_type: 1224, param_value: 2 }],
    db_bypass_str: [{ channel: 9, param_type: 6250, param_value: 'MA==' }] }, 9);
  assert.equal(cameraOnly.cameraPower, 'on');
  assert.equal(cameraOnly.configuredGuardMode, null);
  assert.equal(cameraOnly.effectiveGuardMode, null);
  assert.equal(cameraOnly.parameterCount, 2);
});

test('NVR diagnostics distinguish custom labels and unknown local readings', () => {
  const page = diagnosticsPage();
  for (const [mode, label] of [[0, 'Away'], [1, 'Home'], [2, 'Schedule'], [3, 'Custom 1'],
    [4, 'Custom 2'], [5, 'Custom 3'], [47, 'Geofencing'], [63, 'Disarmed']]) {
    assert.ok(page.includes(`${mode}: '${label}'`));
  }
  assert.equal(page.includes("3: 'Geofence'"), false);
  assert.ok(page.includes('Unknown means this read returned no value or an unrecognised one.'));
  assert.ok(page.includes('Cloud inventory is checked during this test. It is not local confirmation. The effective-mode sensor uses separate reported updates.'));
});
