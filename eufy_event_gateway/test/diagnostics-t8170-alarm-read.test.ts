/**
 * Runs the gateway-owned diagnostics script against a minimal synthetic DOM.
 * The test owns fetch responses and verifies active-camera stop and form locks.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticsPage } from "../src/diagnostics/page.js";

import { readFile } from "node:fs/promises";

test("T8170 browser form stays read-only and refuses private or malformed result fields", async () => {
  const elements = new Map<string, { value: string; checked: boolean; disabled: boolean; hidden: boolean; textContent: string;
    onclick?: () => Promise<void>; onchange?: () => void; addEventListener: () => void; replaceChildren: () => void; add: (option: { value: string }) => void }>();
  const element = (id: string) => {
    if(!elements.has(id)) {
      const value = { addEventListener: () => {}, value: "", checked: false, disabled: false, hidden: false, textContent: "",
        replaceChildren: () => { value.value = ""; }, add: (option: { value: string }) => { value.value ||= option.value; } };
      elements.set(id, value);
    }
    return elements.get(id)!;
  };
  element("device").value = "fixture"; element("token").value = "fixture";
  let result: unknown = { outcome: "decoded", parameterCount: 2, guardMode: 63 }, fail = false;
  const requests: unknown[] = [];
  const fetch = async (_path: string, options: { method?: string; body?: string }) => {
    if(options.method === "GET") return { ok: true, json: async () => ({ actions: ["alarmState"] }) };
    requests.push(JSON.parse(options.body!));
    return { ok: !fail, json: async () => fail ? { error: "private-serial-owner-key" } : result };
  };
  const script = diagnosticsPage().split("<script>")[1]!.split("</script>")[0]!;
  new Function("document", "fetch", "Option", "window", "location", script)(
    { getElementById: element }, fetch, function(this: { value: string }, _text: string, value: string) { this.value = value; },
    { addEventListener() {} }, { protocol: "https:" });
  await element("trial-load").onclick!();
  assert.equal(element("trial-action").value, "alarmState"); assert.equal(element("trial-value").value, "false");
  assert.equal(element("trial-siren-stop").hidden, true);
  assert.doesNotMatch(element("trial-consent-label").textContent, /siren|arm|restor/i);
  for(const value of [{ outcome: "decoded", parameterCount: 2, guardMode: 63 },
    { outcome: "decoded", parameterCount: 2, private: "private-serial-owner-key" }, { outcome: "decoded", parameterCount: 1.5 },
    { outcome: "decoded", parameterCount: 65536 }, { outcome: "decoded", parameterCount: 1, guardMode: 7 },
    { outcome: "timeout", frames: 0, parseStage: "none", keyReady: true },
    { outcome: "unavailable", frames: 0, parseStage: "none", keyReady: false }]) {
    result = value; element("trial-consent").checked = true; await element("trial-send").onclick!();
    assert.equal(element("trial-consent").checked, false); assert.doesNotMatch(element("trial-status").textContent, /private-serial/);
    if("guardMode" in value && value.guardMode === 63) assert.match(element("trial-status").textContent, /mapping unconfirmed/);
    if(value.outcome === "unavailable") assert.match(element("trial-status").textContent, /not sent.*not tested/);
  }
  fail = true; element("trial-consent").checked = true; await element("trial-send").onclick!();
  assert.equal(element("trial-consent").checked, false); assert.doesNotMatch(element("trial-status").textContent, /private-serial|siren/i);
  assert.ok(requests.every(row => JSON.stringify(row) === '{"action":"alarmState","enabled":false}'));
  const guide = await readFile(new URL("../../docs/T8170_ALARM_READ_TEST.md", import.meta.url), "utf8");
  for(const word of ["unconfirmed", "uncorrelated", "40-second", "private", "keyReady", "Do not arm"]) assert.ok(guide.includes(word));
});
