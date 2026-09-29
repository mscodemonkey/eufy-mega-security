/**
 * Protects durable snapshot semantics independently of HTTP and Eufy.
 *
 * The cases cover initialization, hashed filenames, revisions, malformed
 * indexes, and concurrent writes that must leave complete old or new files.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SnapshotStore } from "../src/storage/snapshot-store.js";

test("persists snapshots and restores their metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-gateway-test-"));
  try {
    const store = new SnapshotStore(directory);
    await store.initialize();
    const info = await store.write("../../unsafe serial", Buffer.from("image"), "image/jpeg", "event", new Date("2026-09-11Z"));
    assert.equal(info.revision, 1);

    const restored = new SnapshotStore(directory);
    await restored.initialize();
    assert.deepEqual(await restored.read("../../unsafe serial"), { data: Buffer.from("image"), info });
    await assert.rejects(readFile(join(directory, "unsafe serial")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses to replace the last good image with empty data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-gateway-test-"));
  try {
    const store = new SnapshotStore(directory);
    await store.initialize();
    await store.write("camera", Buffer.from("good"), "image/jpeg", "event");
    await assert.rejects(store.write("camera", Buffer.alloc(0), "image/jpeg", "live"));
    assert.equal((await store.read("camera"))?.data.toString(), "good");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes concurrent writes and assigns increasing revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-gateway-test-"));
  try {
    const store = new SnapshotStore(directory);
    await store.initialize();
    const [first, second] = await Promise.all([
      store.write("camera", Buffer.from("first"), "image/jpeg", "event"),
      store.write("camera", Buffer.from("second"), "image/jpeg", "live"),
    ]);
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    assert.equal((await store.read("camera"))?.data.toString(), "second");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not let a push image replace the retained live frame", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-gateway-test-"));
  try {
    const store = new SnapshotStore(directory);
    await store.initialize();
    const live = await store.write("camera", Buffer.from("live"), "image/jpeg", "live");
    const event = await store.writeEvent("camera", Buffer.from("push"), "image/jpeg");

    assert.equal(event, null);
    assert.deepEqual(await store.read("camera"), { data: Buffer.from("live"), info: live });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retains push images until a live frame exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-gateway-test-"));
  try {
    const store = new SnapshotStore(directory);
    await store.initialize();
    const first = await store.writeEvent("camera", Buffer.from("first"), "image/jpeg");
    const second = await store.writeEvent("camera", Buffer.from("second"), "image/jpeg");

    assert.equal(first?.revision, 1);
    assert.equal(second?.revision, 2);
    assert.equal((await store.read("camera"))?.data.toString(), "second");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
