/**
 * Checks closed trial inputs and network policy without creating sockets.
 * Fixtures own only synthetic request bytes and SDP/network descriptions.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GeneralRtcError, generalRtcSubmission, generalRtcSmartHost } from "../src/stream/general-rtc-protocol.js";
import { generalRtcCandidate, generalRtcRelays } from "../src/stream/general-rtc-network.js";

test("strict submission decodes escapes and permits either key order", () => {
  assert.deepEqual(generalRtcSubmission(Buffer.from('{"consent":true,"pin":"12\\u0033"}')), { consent: true, pin: "123" });
  assert.deepEqual(generalRtcSubmission(Buffer.from(' \n{"pin":"123", "consent" : true}\t')), { consent: true, pin: "123" });
});

for (const value of ['{}', '{"consent":false,"pin":"123"}', '{"consent":true,"pin":""}',
  '{"consent":true,"pin":"123","pin":"456"}', '{"consent":true,"pin":"123","p\\u0069n":"456"}',
  '{"consent":true,"pin":"123","extra":1}', '{"consent":true,"pin":"123"} {}',
  '{"consent":true,"pin":"\\u0000"}', '{"consent":true,"pin":{}}', '{"consent":true,"pin":"123",}',
  '\ufeff{"consent":true,"pin":"123"}', '{"consent":true,"pin":"' + "1".repeat(33) + '"}',
  '{"consent":true,"pin":"123","consent":true}', '{"consent":true,"pin":"123"',
  '{"consent":true,"pin":"\\uZZZZ"}']) {
  test(`submission rejects malformed or ambiguous input ${JSON.stringify(value)}`, () => {
    assert.throws(() => generalRtcSubmission(Buffer.from(value)), SyntaxError);
  });
}

test("submission rejects invalid UTF-8", () => {
  assert.throws(() => generalRtcSubmission(Buffer.from([0xff])), SyntaxError);
});

test("smart region is chosen only from the effective allowlisted Security host", () => {
  assert.equal(generalRtcSmartHost("security-app-ie.eufylife.com"), "security-smart-ie.eufylife.com");
  assert.equal(generalRtcSmartHost("security-app-eu.eufylife.com"), "security-smart-eu.eufylife.com");
  assert.equal(generalRtcSmartHost("security-app.eufylife.com"), "security-smart.eufylife.com");
  for (const host of ["", "security-app-qa.eufylife.com", "other.invalid", "SECURITY-APP.EUFYLIFE.COM"]) assert.equal(generalRtcSmartHost(host), null);
});

const relay = (host: string, port: unknown = 3478) => ({ turn_addr: host, turn_port: port,
  turn_user: "synthetic-user", turn_password: "synthetic-credential" });

for (const host of ["0.1.2.3", "10.1.2.3", "100.64.1.2", "127.0.0.1", "169.254.1.2", "172.16.1.2", "192.0.0.1",
  "192.0.2.1", "192.168.1.1", "198.18.1.2", "198.51.100.1", "203.0.113.1", "224.1.2.3", "240.1.2.3",
  "255.255.255.255", "::", "::1", "::ffff:8.8.8.8", "64:ff9b::808:808", "100::1", "2001::1", "2001:db8::1",
  "2002::1", "fc00::1", "fe80::1", "ff00::1", "fec0::1", "::2", "1000::1", "2000::1", "3000::1", "3fff::1", "192.88.99.2",
  "relay.example.invalid", "[2606:4700:4700::1111]"]) {
  test(`relay refuses excluded address class ${host}`, () => {
    assert.throws(() => generalRtcRelays(relay(host)), (error: unknown) => error instanceof GeneralRtcError && error.stage === "turn");
  });
}

test("relays accept only bounded explicit public IP data and canonical ports", () => {
  assert.deepEqual(generalRtcRelays(relay("8.8.8.8", "3478")), [{ urls: "turn:8.8.8.8:3478?transport=udp", username: "synthetic-user", credential: "synthetic-credential" }]);
  assert.equal(generalRtcRelays(relay("2606:4700:4700::1111"))[0]?.urls, "turn:[2606:4700:4700::1111]:3478?transport=udp");
  for (const port of [0, 65536, -1, 1.5, "03478", "3478.0", "3478x", null, true]) assert.throws(() => generalRtcRelays(relay("8.8.8.8", port)));
  for (const rows of [[], Array.from({ length: 5 }, () => relay("8.8.8.8")), [null], [{}]]) assert.throws(() => generalRtcRelays(rows));
});

test("IP-only candidates permit local media while refusing DNS hosts and related hosts", () => {
  const candidate = "candidate:fixture 1 udp 123 192.168.1.2 1234 typ host";
  assert.equal(generalRtcCandidate(candidate), candidate);
  assert.equal(generalRtcCandidate("candidate:fixture 1 udp 123 8.8.8.8 1234 typ srflx raddr 192.168.1.2 rport 2345").includes("192.168.1.2"), true);
  assert.throws(() => generalRtcCandidate(candidate.replace("192.168.1.2", "camera.local")));
  assert.throws(() => generalRtcCandidate("candidate:fixture 1 udp 123 8.8.8.8 1234 typ srflx raddr camera.local rport 2345"));
});
