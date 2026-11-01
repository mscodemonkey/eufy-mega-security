/**
 * Proves private RTC wire/key replay with two local peers and synthetic media.
 * Tests own all sockets and recording files and never use a household camera.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader, SrtpSession, useH264, UdpTransport } from "werift";
import { RawHistory, setRawHistory, decodeRawSegment } from "../src/diagnostics/raw-history.js";
import { installRawRtcCapture, observeRawPeer, observeRawDataChannel } from "../src/diagnostics/raw-rtc.js";

test("encrypted datagrams and captured negotiation keys reproduce received RTP", { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-raw-rtc-"));
  const history = new RawHistory({ directory, reserveBytes: 1 }); await history.initialize(); setRawHistory(history);
  const original = UdpTransport.init; const restore = installRawRtcCapture();

  // These production paths each negotiate a single transport.
  const config = { bundlePolicy: "max-bundle" as const, iceServers: [], iceUseIpv6: false, codecs: { audio: [], video: [useH264({ payloadType: 99 })] } };
  const sender = new RTCPeerConnection(config), receiver = new RTCPeerConnection(config);
  t.after(async () => { await sender.close(); await receiver.close(); restore(); setRawHistory(undefined); await history.close(); await rm(directory, { recursive: true, force: true }); });
  observeRawPeer(sender, { device: "synthetic-sender" }); observeRawPeer(receiver, { device: "synthetic-receiver" });
  const track = new MediaStreamTrack({ kind: "video" }); sender.addTransceiver(track, { direction: "sendonly" });
  const channel = sender.createDataChannel("synthetic"); observeRawDataChannel(channel, { device: "synthetic-sender" });
  receiver.onDataChannel.subscribe(incoming => observeRawDataChannel(incoming, { device: "synthetic-receiver" }));
  let received: Buffer | undefined; let receivedCount = 0;
  receiver.onTrack.subscribe(incoming => incoming.onReceiveRtp.subscribe(packet => { received = packet.payload; receivedCount++; }));
  await sender.setLocalDescription(await sender.createOffer());
  await receiver.setRemoteDescription(sender.localDescription!);
  await receiver.setLocalDescription(await receiver.createAnswer());
  await sender.setRemoteDescription(receiver.localDescription!);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && (sender.connectionState !== "connected" || receiver.connectionState !== "connected" || channel.readyState !== "open")) await delay(20);
  assert.equal(sender.connectionState, "connected"); assert.equal(receiver.connectionState, "connected"); assert.equal(channel.readyState, "open");
  channel.send("synthetic command");
  const payload = Buffer.from([0x65, 1, 2, 3]);
  track.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 99, ssrc: 12345, sequenceNumber: 9, timestamp: 1234, marker: true }), payload));
  while (!received && Date.now() < deadline) await delay(20);
  assert.deepEqual(received, payload);
  await history.flush();
  const key = await readFile(join(directory, "key"));
  const records: { boundary: string; connection: string; direction: string; bytes: string; metadata: Record<string, unknown> }[] = [];
  for (const file of (await readdir(directory)).filter(name => name.endsWith(".raw"))) records.push(...decodeRawSegment(await readFile(join(directory, file)), key).records as typeof records);
  const keys = records.find(record => record.boundary === "rtc_srtp_keys" && record.connection === receiver.dtlsTransports[0]!.id)!;
  assert.ok(keys); assert.ok(records.some(record => record.boundary === "rtc_dtls_keys"));
  const saved = keys.metadata.config as { profile: number; keys: Record<string, { data: number[] }> };
  const replay = new SrtpSession({ profile: saved.profile, keys: {
    localMasterKey: Buffer.from(saved.keys.localMasterKey!.data), localMasterSalt: Buffer.from(saved.keys.localMasterSalt!.data),
    remoteMasterKey: Buffer.from(saved.keys.remoteMasterKey!.data), remoteMasterSalt: Buffer.from(saved.keys.remoteMasterSalt!.data),
  } });
  const packets = records.filter(record => record.boundary === "rtc_udp_datagram" && record.direction === "receive")
    .map(record => Buffer.from(record.bytes, "base64")).filter(bytes => (bytes[0]! & 0xc0) === 0x80 && (bytes[1]! & 0x7f) === 99);
  assert.ok(packets.length);
  assert.ok(packets.some(packet => { try { return RtpPacket.deSerialize(replay.decrypt(packet)).payload.equals(payload); } catch { return false; } }));
  assert.ok(records.some(record => record.boundary === "rtc_data_channel" && record.direction === "send" && Buffer.from(record.bytes, "base64").toString() === "synthetic command"));
  const beforeRejected = receivedCount;
  const rejected = Buffer.from(packets[0]!); rejected[rejected.length - 1]! ^= 1;
  await sender.dtlsTransports[0]!.iceTransport.connection.send(rejected);
  await delay(50); await history.flush();
  assert.equal(receivedCount, beforeRejected);
  const retained = [];
  for (const file of (await readdir(directory)).filter(name => name.endsWith(".raw"))) retained.push(...decodeRawSegment(await readFile(join(directory, file)), key).records as typeof records);
  assert.ok(retained.some(record => record.boundary === "rtc_udp_datagram" && record.direction === "receive"
    && Buffer.from(record.bytes, "base64").equals(rejected)));
  restore(); assert.equal(UdpTransport.init, original);
});
