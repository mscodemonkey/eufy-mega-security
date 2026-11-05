/**
 * Exercises passive T8417 logging through offline provider startup and refresh.
 * Tests own the cloud inventory, timer callbacks and stdout logging seam. No
 * authentication exchange, camera transport or physical privacy write runs.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider, safeInventoryReads } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { T8417ReadShapeTracker } from "../src/provider/t8417-read-shape.js";

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

/** Own one camera's raw observations and the actual provider refresh callback. */
async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "t8417-provider-"));
  const callbacks: (() => void)[] = [], logs: string[] = [];
  context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(globalThis, "setInterval", ((callback: () => void) => {
    callbacks.push(callback); return { unref() {} };
  }) as unknown as typeof setInterval);
  context.mock.method(globalThis, "clearInterval", (() => {}) as typeof clearInterval);
  context.mock.method(process.stdout, "write", ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stdout.write);
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.method(MegaPushReceiver.prototype, "start", async () => {});
  let devices = [{ device_sn: "private-synthetic", device_model: "T8417", device_type: 105, category: "eufy_security", device_channel: 0,
    params: [{ param_type: 1035, param_value: "0" }] }];
  const normalInventory = async () => ({ groups: [], devices });
  const inventory = context.mock.method(MegaClient.prototype, "inventory", normalInventory);
  const events = new Proxy({}, { get: () => () => {} }) as ProviderEvents;
  const provider = new EufyProvider({ username: "synthetic", password: "synthetic", country: "AU", persistentDirectory: directory, maxStreamSeconds: 120 });
  context.after(async () => { await provider.close(); await rm(directory, { recursive: true, force: true }); });
  const summaries = () => logs.filter(line => line.includes("event=camera_t8417_read_shape_observed"));
  return { provider, events, inventory, normalInventory, logs, summaries, update: (value: typeof devices) => { devices = value; },
    rows: () => devices, refresh: async () => { callbacks.at(-1)!(); await turn(); await turn(); } };
}

test("startup, changed/unchanged/failed/empty refresh and retirement use raw inventory", async context => {
  const f = await fixture(context); const reset = context.mock.method(T8417ReadShapeTracker.prototype, "reset");
  await f.provider.start(f.events); assert.equal(f.summaries().length, 1);
  await f.refresh(); assert.equal(f.summaries().length, 1);
  f.update([{ ...f.rows()[0]!, params: [{ param_type: 1035, param_value: "1" }] }]);
  await f.refresh(); assert.equal(f.summaries().length, 2); assert.match(f.summaries()[1]!, /p1035=1/);
  const original = f.normalInventory;
  f.inventory.mock.mockImplementation(async () => { throw Error("Synthetic refresh failure"); });
  await f.refresh(); assert.equal(f.summaries().length, 2);
  f.inventory.mock.mockImplementation(original); const rows = f.rows(); f.update([]);
  const observer = context.mock.method(T8417ReadShapeTracker.prototype, "observe");
  await f.refresh(); assert.equal(observer.mock.callCount(), 0);
  f.update(rows); await f.refresh(); assert.equal(f.summaries().length, 2);
  const before = reset.mock.callCount(); await f.provider.close(); assert.ok(reset.mock.callCount() > before);
  await f.provider.start(f.events); assert.equal(f.summaries().length, 3);
  assert.ok(f.summaries().every(line => !line.includes("private-synthetic")));
});

test("a cancelled refresh cannot publish a late observation", async context => {
  const f = await fixture(context); await f.provider.start(f.events);
  let finish!: () => void;
  f.inventory.mock.mockImplementation(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { groups: [], devices: f.rows() }; });
  const refresh = f.refresh(); await turn(); await f.provider.close(); finish(); await refresh;
  assert.equal(f.summaries().length, 1);
});

test("an unexpected tracker or logger failure cannot break startup", async context => {
  const f = await fixture(context);
  const observe = context.mock.method(T8417ReadShapeTracker.prototype, "observe", () => { throw Error("private marker"); });
  await f.provider.start(f.events); assert.equal(f.summaries().length, 0); observe.mock.restore();
  context.mock.method(process.stdout, "write", ((chunk: unknown) => {
    if(String(chunk).includes("event=camera_t8417_read_shape_observed")) throw Error("private marker"); return true;
  }) as typeof process.stdout.write);
  await f.provider.close(); await f.provider.start(f.events);
});

test("T8417 enabled precedence remains independent from the passive summary", () => {
  assert.equal(safeInventoryReads([{ param_type: 2001, param_value: "1" }, { param_type: 1035, param_value: "1" }], 105, "T8417").enabled, true);
  assert.equal(safeInventoryReads([{ param_type: 2001, param_value: "0" }, { param_type: 1035, param_value: "0" }], 105, "T8417").enabled, false);
});

test("the new boundary catches a getter that throws only after camera publication", async context => {
  const f = await fixture(context); let published = false;
  const events = new Proxy({}, { get: (_target, name) => name === "camera" ? () => { published = true; } : () => {} }) as ProviderEvents;
  f.inventory.mock.mockImplementation(async () => ({ groups: [], get devices() {
    if (published) throw Error("private inventory getter"); return f.rows();
  } }));
  await f.provider.start(events); assert.equal(published, true); assert.equal(f.summaries().length, 0);
});

test("null inventory preserves the existing startup failure before any tracker call", async context => {
  const f = await fixture(context);
  f.inventory.mock.mockImplementation(async () => null as unknown as Awaited<ReturnType<MegaClient["inventory"]>>);
  const observe = context.mock.method(T8417ReadShapeTracker.prototype, "observe");
  await assert.rejects(f.provider.start(f.events), TypeError); assert.equal(observe.mock.callCount(), 0);
});
