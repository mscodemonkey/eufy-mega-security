/**
 * Exercises the lock registry's read-only busy observation using injected
 * sessions. The registry owns polling and aborts, while preparation admission
 * consumes only the getter. No broker or physical lock is contacted.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { E30LockProvider } from "../src/provider/e30-lock-provider.js";

const row = { device_model: "T85F1", device_type: 206, device_sn: "T85F100000000001", parent_sn: "T85F100000000001",
  member: { admin_user_id: "abcdefghijkl", short_user_id: "0001", nick_name: "Synthetic", member_type: 1 } };

test("autonomous inventory polling owns busy until its aborted operation settles", async () => {
  let opened = 0;
  const provider = new E30LockProvider({ changed: () => {},
    credentials: async () => await new Promise<never>(() => {}),
    session: () => { opened++; throw Error("Unexpected session"); } });
  assert.equal(provider.busy, false);
  provider.inventory([row], true);
  assert.equal(provider.busy, true);
  provider.close();
  assert.equal(provider.busy, true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(provider.busy, false); assert.equal(opened, 0);
});

test("settled injected queries release busy without changing the query lifecycle", async () => {
  let queries = 0;
  const provider = new E30LockProvider({ changed: () => {}, credentials: async () => ({ host: "synthetic", certificate: "synthetic",
    privateKey: "synthetic", userId: "synthetic", clientId: "synthetic" }),
    session: () => ({ open: async () => {}, query: async () => { queries++; return { rawState: 4, batteryPercent: 80 }; },
      actuate: async () => { throw Error("Unexpected write"); }, close: () => {} }) });
  try {
    provider.inventory([row], true); assert.equal(provider.busy, true);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(provider.busy, false); assert.equal(queries, 1);
  } finally { provider.close(); }
});
