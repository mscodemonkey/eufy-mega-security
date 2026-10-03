/**
 * Protects first-image warm-up independently of Eufy and FFmpeg.
 *
 * These cases verify startup gating, one-at-a-time capture, retained-image
 * rechecks, failure isolation, and shutdown without opening camera sessions.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { StartupSnapshotWarmup } from "../src/startup-snapshot-warmup.js";

test("captures new cameras sequentially after provider startup", async () => {
  const captures: string[] = [];
  let releaseFirst!: () => void;
  const firstCapture = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const warmup = new StartupSnapshotWarmup(
    () => false,
    async (serial) => {
      captures.push(serial);
      if (serial === "camera-1") await firstCapture;
    },
    () => assert.fail("No warm-up capture should fail"),
  );

  warmup.enqueue("camera-1");
  warmup.enqueue("camera-2");
  assert.deepEqual(captures, []);
  warmup.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(captures, ["camera-1"]);

  releaseFirst();
  await warmup.waitUntilIdle();
  assert.deepEqual(captures, ["camera-1", "camera-2"]);
});

test("skips retained images and continues after a camera capture fails", async () => {
  const captures: string[] = [];
  const failures: unknown[] = [];
  const retained = new Set(["camera-2"]);
  const warmup = new StartupSnapshotWarmup(
    (serial) => retained.has(serial),
    async (serial) => {
      captures.push(serial);
      if (serial === "camera-1") throw new Error("camera sleeping");
    },
    (error) => failures.push(error),
  );

  warmup.enqueue("camera-1");
  warmup.enqueue("camera-2");
  warmup.enqueue("camera-3");
  warmup.start();
  await warmup.waitUntilIdle();

  assert.deepEqual(captures, ["camera-1", "camera-3"]);
  assert.equal(failures.length, 1);
});

test("does not immediately retry a failed camera when inventory reports it again", async () => {
  const captures: string[] = [];
  const warmup = new StartupSnapshotWarmup(
    () => false,
    async (serial) => {
      captures.push(serial);
      throw new Error("camera sleeping");
    },
    () => undefined,
  );

  warmup.enqueue("camera-1");
  warmup.start();
  await warmup.waitUntilIdle();
  warmup.enqueue("camera-1");
  await warmup.waitUntilIdle();

  assert.deepEqual(captures, ["camera-1"]);
});

test("retries sleeping cameras only after cooldown and stops after three attempts", async () => {
  let now = 0;
  let attempts = 0;
  const warmup = new StartupSnapshotWarmup(() => false, async () => {
    attempts++;
    throw new Error("sleeping");
  }, () => undefined, () => now);
  warmup.start();
  for (let i = 0; i < 5; i++) {
    warmup.enqueue("camera");
    await warmup.waitUntilIdle();
    now += 120_000;
  }
  assert.equal(attempts, 3);
});

test("does not start queued captures after shutdown", async () => {
  const captures: string[] = [];
  const warmup = new StartupSnapshotWarmup(
    () => false,
    async (serial) => {
      captures.push(serial);
    },
    () => assert.fail("No warm-up capture should fail"),
  );

  warmup.enqueue("camera-1");
  warmup.stop();
  warmup.start();
  await warmup.waitUntilIdle();
  assert.deepEqual(captures, []);
});
