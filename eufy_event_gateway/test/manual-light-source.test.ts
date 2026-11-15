/**
 * Tests manual-light source ownership without device I/O.
 * Fake media leases expose readiness, retirement and cancellation separately
 * so command success cannot conceal a lost source or a leaked retained lease.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ManualLightSource } from "../src/stream/manual-light-source.js";

for (const mode of ["off", "expired", "failure", "shutdown"] as const) {
  test(`manual light retains only its own source until ${mode}`, async () => {
    let holds = 0, releases = 0, writes = 0, expired = 0;
    let retire!: () => void;
    const lights = new ManualLightSource(async (_serial, signal, ready) => {
      holds++;
      await new Promise<void>(resolve => {
        retire = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
        ready();
      });
      releases++;
    }, () => { expired++; });
    try {
      assert.equal(await lights.run("camera", true, async () => { writes++; return "on"; }), "on");
      assert.equal(holds, 1); assert.equal(releases, 0);
      if (mode === "off") {
        assert.equal(await lights.run("camera", false, async () => { writes++; return "off"; }), "off");
        assert.equal(holds, 1); assert.equal(expired, 0);
      } else if (mode === "expired") {
        retire(); await new Promise(resolve => setImmediate(resolve));
        assert.equal(expired, 1);
      } else if (mode === "failure") {
        await assert.rejects(lights.run("camera", true, async () => { writes++; throw new Error("unconfirmed"); }), /unconfirmed/);
        assert.equal(writes, 2); assert.equal(expired, 1);
      } else {
        await lights.close();
        await assert.rejects(lights.run("camera", true, async () => { writes++; }), /closed/);
        assert.equal(writes, 1);
      }
      assert.equal(releases, 1);
    } finally { await lights.close(); }
  });
}

test("an unready light source never submits a command", async () => {
  let writes = 0;
  const lights = new ManualLightSource(async () => { throw new Error("source failed"); }, () => {});
  try {
    await assert.rejects(lights.run("camera", true, async () => { writes++; }));
    assert.equal(writes, 0);
  } finally { await lights.close(); }
});

test("source retirement during an in-flight command cannot produce a successful on", async () => {
  let retire!: () => void, finishWrite!: () => void;
  const lights = new ManualLightSource(async (_serial, _signal, ready) => {
    await new Promise<void>(resolve => { retire = resolve; ready(); });
  }, () => {});
  try {
    const result = lights.run("camera", true, async () => {
      await new Promise<void>(resolve => { finishWrite = resolve; });
    });
    await new Promise(resolve => setImmediate(resolve));
    retire(); await new Promise(resolve => setImmediate(resolve)); finishWrite();
    await assert.rejects(result, /retired/);
  } finally { await lights.close(); }
});

test("an off request waits for the preceding on without a second media lease", async () => {
  let finishOn!: () => void, holds = 0;
  const events: string[] = [];
  const lights = new ManualLightSource(async (_serial, signal, ready) => {
    holds++;
    await new Promise<void>(resolve => { signal.addEventListener("abort", () => resolve(), { once: true }); ready(); });
  }, () => {});
  try {
    const on = lights.run("camera", true, async () => {
      events.push("on"); await new Promise<void>(resolve => { finishOn = resolve; }); events.push("confirmed");
    });
    const off = lights.run("camera", false, async () => { events.push("off"); });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ["on"]); finishOn(); await Promise.all([on, off]);
    assert.deepEqual(events, ["on", "confirmed", "off"]); assert.equal(holds, 1);
  } finally { await lights.close(); }
});

test("cancelled startup cannot send on, while cancelling a finished request preserves its light", async () => {
  for (const cancelBeforeReady of [false, true]) {
    let writes = 0, released = 0;
    const controller = new AbortController();
    const lights = new ManualLightSource(async (_serial, signal, ready) => {
      await new Promise<void>(resolve => {
        signal.addEventListener("abort", () => { released++; resolve(); }, { once: true });
        if (cancelBeforeReady) controller.abort(); else ready();
      });
    }, () => {});
    try {
      const operation = lights.run("camera", true, async () => { writes++; }, controller.signal);
      if (cancelBeforeReady) { await assert.rejects(operation); assert.equal(writes, 0); assert.equal(released, 1); }
      else { await operation; controller.abort(); assert.equal(writes, 1); assert.equal(released, 0); }
    } finally { await lights.close(); }
  }
});
