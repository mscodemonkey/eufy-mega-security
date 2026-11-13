/**
 * Qualifies configuration and station selection for manual LAN destinations.
 * Fixtures own synthetic inventory and never open sockets. Existing PPCS tests
 * separately qualify response identity and authenticated session admission.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { homeBaseLocalAddress, homeBaseLocalAddressSelection, parseHomeBaseAddresses } from "../src/provider/homebase-address.js";
import { ppcsLocalLookupTargets } from "../src/stream/ppcs-lookup.js";

const peer = { serial: "synthetic-station", model: "T8030", deviceType: 18,
  category: "eufy_security", parentSerial: "", localAddress: "192.168.1.20" };

test("an exact HomeBase hint directs the existing lookup without altering inventory", () => {
  const hints = parseHomeBaseAddresses('[{"serial":"synthetic-station","address":"10.23.4.5"}]');
  assert.deepEqual(ppcsLocalLookupTargets(homeBaseLocalAddress(peer, hints)), [
    { host: "255.255.255.255", port: 32108 }, { host: "10.23.4.5", port: 32108 },
  ]);
  assert.equal(peer.localAddress, "192.168.1.20");
  assert.equal(homeBaseLocalAddress(peer, []), peer.localAddress);
  assert.equal(homeBaseLocalAddress({ ...peer, serial: "another-station" }, hints), peer.localAddress);
  for (const [model, deviceType] of [["T8010", 0], ["T9000", 27]] as const) {
    assert.equal(homeBaseLocalAddress({ ...peer, model, deviceType }, hints), "10.23.4.5");
  }
});

test("a matching selector cannot turn a camera or changed identity into a HomeBase", () => {
  const hints = parseHomeBaseAddresses('[{"serial":"synthetic-station","address":"10.23.4.5"}]');
  for (const change of [{ model: "T8214", deviceType: 94 }, { deviceType: 0 },
    { category: "eufy_care" }, { parentSerial: "foreign-parent" }, { model: "T8N00", deviceType: 300 }]) {
    assert.equal(homeBaseLocalAddress({ ...peer, ...change }, hints), peer.localAddress);
  }
  assert.equal(homeBaseLocalAddress({ ...peer, parentSerial: peer.serial }, hints), "10.23.4.5");
});

test("configuration defaults empty and refuses ambiguous or nonlocal destinations privately", () => {
  assert.deepEqual(loadConfig({}).homeBaseLocalAddresses, []);
  const rows = [{ serial: "synthetic-station", address: "172.16.3.4" }];
  assert.deepEqual(loadConfig({ EUFY_GATEWAY_HOMEBASE_LOCAL_ADDRESSES: JSON.stringify(rows) }).homeBaseLocalAddresses, rows);
  const badRows = [null, {}, [rows[0], rows[0]], [{ ...rows[0], port: 9999 }],
    [{ ...rows[0], serial: " unsafe-selector " }], Array.from({ length: 33 }, (_, i) => ({ serial: String(i), address: "10.1.2.3" })),
    ...["127.0.0.1", "169.254.1.2", "8.8.8.8", "224.1.2.3", "255.255.255.255", "::1", "station.local",
      "http://10.1.2.3", "10.1.2.3:32108", "010.1.2.3", "172.32.1.2", "192.169.1.2"].map(address => [{ ...rows[0], address }])];
  for (const value of ["invalid-private-input", ...badRows.map(row => JSON.stringify(row))]) {
    assert.throws(() => parseHomeBaseAddresses(value), error => error instanceof Error
      && error.message === "HomeBase local addresses must be a JSON list of unique serial and private IPv4 address pairs");
  }
  assert.throws(() => parseHomeBaseAddresses(" ".repeat(8193)));
});

test("lookup source explains selected and dormant hints without exposing destinations", () => {
  const hints = [{ serial: peer.serial, address: "10.23.4.5" }];
  assert.equal(homeBaseLocalAddressSelection(peer, hints).source, "manual");
  assert.equal(homeBaseLocalAddressSelection({ ...peer, serial: "other" }, hints).source, "inventory");
  assert.equal(homeBaseLocalAddressSelection({ ...peer, parentSerial: "foreign" }, hints).source, "inventory");
  assert.equal(homeBaseLocalAddressSelection({ ...peer, localAddress: null }, []).source, "broadcast_only");
});
