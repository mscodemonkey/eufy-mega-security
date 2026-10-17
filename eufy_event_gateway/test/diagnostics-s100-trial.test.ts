/**
 * Runs the gateway-owned diagnostics script against a minimal synthetic DOM.
 * The test owns fetch responses and verifies active-camera stop and form locks.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticsPage } from "../src/diagnostics/page.js";

test("S100 Stop button remains available while the pulse form is locked and targets its original camera", async () => {
  const elements = new Map<string, { value: string; checked: boolean; disabled: boolean; hidden: boolean; textContent: string;
    onclick?: () => Promise<void>; onchange?: () => void; addEventListener: () => void; replaceChildren: () => void; add: (option: { value: string }) => void }>();
  const element = (id: string) => {
    if (!elements.has(id)) {
      const value = { addEventListener: () => {}, value: "", checked: true, disabled: false, hidden: false, textContent: "",
        replaceChildren: () => { value.value = ""; }, add: (option: { value: string }) => { value.value ||= option.value; } };
      elements.set(id, value);
    }
    return elements.get(id)!;
  };
  element("device").value = "test"; element("token").value = "fixture";
  element("trial-action").value = "siren";
  const calls: { path: string; enabled: boolean }[] = [];
  const result = { ok: true, json: async () => ({ outcome: "acknowledged", physicalConfirmationRequired: true }) };
  let release!: (value: typeof result) => void;
  const startReply = new Promise<typeof result>(resolve => { release = resolve; });
  const fetch = async (path: string, options: { body: string }) => {
    const request = JSON.parse(options.body); calls.push({ path, enabled: request.enabled });
    if (request.enabled) return startReply;
    release(result); return result;
  };
  const script = diagnosticsPage().split("<script>")[1]!.split("</script>")[0]!;
  new Function("document", "fetch", "Option", "window", script)(
    { getElementById: element }, fetch, function(this: { value: string }, _text: string, value: string) { this.value = value; }, { addEventListener() {} });
  element("trial-action").onchange!();
  element("trial-consent").checked = true;
  const pulse = element("trial-send").onclick!();
  await Promise.resolve();
  assert.equal(element("trial-send").disabled, true);
  assert.equal(element("device").disabled, true);
  assert.equal(element("trial-action").disabled, true);
  assert.equal(element("trial-load").disabled, true);
  assert.equal(element("trial-siren-stop").hidden, false);
  assert.equal(element("trial-siren-stop").disabled, false);
  await element("cloud-list").onclick!();
  assert.equal(calls.length, 1); assert.equal(element("device").disabled, true);
  element("device").value = "other";
  await element("trial-siren-stop").onclick!(); await pulse;
  assert.deepEqual(calls.map(call => call.enabled), [true, false]);
  assert.equal(calls.every(call => call.path.includes("/test/model-control-trial")), true);
  assert.equal(element("trial-send").disabled, false);
  assert.equal(element("device").disabled, false);
});
