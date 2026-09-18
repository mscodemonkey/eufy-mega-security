/**
 * Regression coverage for the T8171 inventory reported in issue 73.
 * Synthetic inventory belongs to each test. Provider admission and route
 * diagnostics consume it without opening a network or claiming hardware success.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  inventoryLogSummaries,
  isDoorbellDevice,
  parseMegaInventory,
} from "../src/provider/eufy-provider.js";

test("T8171 is admitted while media readiness still requires parent identity", () => {
  const devices = parseMegaInventory({ devices: [
    {
      device_sn: "e30", device_model: "T8171", device_type: 88,
      parent_sn: "station", device_channel: 1, category: "eufy_security",
    },
    {
      device_sn: "station", device_model: "T8030", device_type: 18,
      category: "eufy_security", p2p_did: "test-did", p2p_conn: "test-connection",
    },
    {
      device_sn: "wrong-category", device_model: "T8171", device_type: 88,
      parent_sn: "station", device_channel: 2, category: "other",
    },
  ] });
  const ready = inventoryLogSummaries(devices, new Set(["station"]));
  assert.equal(ready[0]?.acceptedAsCamera, true);
  assert.equal(ready[0]?.streamSupported, true);
  assert.equal(ready[1]?.acceptedAsCamera, false);
  assert.equal(ready[2]?.acceptedAsCamera, false);
  assert.equal(isDoorbellDevice(devices[0]!), false);

  const withoutIdentity = inventoryLogSummaries(devices, new Set());
  assert.equal(withoutIdentity[0]?.acceptedAsCamera, true);
  assert.equal(withoutIdentity[0]?.streamSupported, false);
});
