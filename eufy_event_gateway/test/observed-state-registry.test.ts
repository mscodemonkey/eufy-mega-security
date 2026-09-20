/** Tests freshness and source precedence for observed device state. */

import assert from "node:assert/strict";
import test from "node:test";
import { ObservedStateRegistry } from "../src/provider/observed-state-registry.js";

test("keeps newer values and ignores missing observations", () => {
  const registry = new ObservedStateRegistry<"enabled">();
  registry.set("camera", "enabled", true, "inventory", 10);
  registry.set("camera", "enabled", undefined, "push", 20);
  registry.set("camera", "enabled", false, "inventory", 9);
  assert.deepEqual(registry.snapshot("camera"), { enabled: true });
});

test("uses source authority when observations share a timestamp", () => {
  const registry = new ObservedStateRegistry<"battery">();
  registry.set("camera", "battery", 20, "inventory", 10);
  registry.set("camera", "battery", 80, "ppcs", 10);
  assert.equal(registry.get<number>("camera", "battery")?.value, 80);
});
