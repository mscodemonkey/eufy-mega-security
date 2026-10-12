/**
 * Exercises source-derived NVR framing with synthetic identities and bytes.
 * No cloud session or hardware is used. These checks cannot qualify playback.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { NvrPtcsReassembler } from "../src/stream/nvr-ptcs-reassembly.js";
import { nvrApplication, nvrCandidate, nvrCommand, nvrHeartbeat, nvrMatchCamera, nvrNetworkHost, nvrOffer, nvrPackets, nvrVideo } from "../src/stream/nvr-protocol.js";
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
  for (const bad of [candidate.replace('192.0.2.1', '127.0.0.1'), candidate.replace('1234', '65536'), candidate + '\r\n', candidate.replace('UDP', 'TCP')]) assert.throws(() => nvrCandidate(bad));
});

test('NVR trial configuration is default-off and requires authentication and a fixed region', () => {
  assert.equal(loadConfig({}).experimentalNvrLive, false); assert.equal(loadConfig({}).experimentalNvrRegion, 'auto');
  assert.throws(() => loadConfig({ EUFY_GATEWAY_EXPERIMENTAL_NVR_LIVE: 'true' }), /API_TOKEN/);
  assert.throws(() => loadConfig({ EUFY_GATEWAY_EXPERIMENTAL_NVR_REGION: 'https://example.com' }), /region/);
});
