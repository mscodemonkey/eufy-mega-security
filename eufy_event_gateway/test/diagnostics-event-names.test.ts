/**
 * Checks manual name-check requests and stale-result cancellation in a fake DOM.
 * The browser owns its job. Invented responses must never expose private names.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticsPage } from "../src/diagnostics/page.js";

for (const changed of ["none", "date", "device"] as const) test(`name-check UI retains its selected date and device: ${changed}`, async () => {
  type Element = { value: string; checked: boolean; disabled: boolean; hidden: boolean; textContent: string;
    onclick?: () => Promise<void>; listeners: Map<string, (() => void)[]>; addEventListener: (name: string, fn: () => void) => void;
    replaceChildren: () => void; add: (option: { value: string }) => void; removeAttribute: () => void; pause: () => void; load: () => void };
  const elements = new Map<string, Element>();
  const element = (id: string): Element => {
    if (!elements.has(id)) {
      const value: Element = { value: "", checked: false, disabled: false, hidden: false, textContent: "", listeners: new Map(),
        addEventListener: (name, fn) => { value.listeners.set(name, [...(value.listeners.get(name) ?? []), fn]); },
        removeAttribute() {}, pause() {}, load() {},
        replaceChildren: () => { value.value = ""; }, add: option => { value.value ||= option.value; } };
      elements.set(id, value);
    }
    return elements.get(id)!;
  };
  let release!: () => void, signal: AbortSignal | undefined, calls = 0;
  const fetch = async (path: string, options: { method: string; body: string; signal: AbortSignal }) => {
    if (!path.endsWith("/diagnostics/event-names")) return { ok: false, json: async () => ({}) };
    calls++; signal = options.signal;
    assert.equal(path, "api/cameras/invented/diagnostics/event-names");
    assert.equal(options.method, "POST"); assert.deepEqual(JSON.parse(options.body), { date: "2026-10-31" });
    await new Promise<void>(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ scope: "one_history_page", records: 1, recordsWithFamiliarNames: 1,
      unresolvedPersonCrops: 0, privateName: "PRIVATE-CANARY" }) };
  };
  const script = diagnosticsPage().split("<script>")[1]!.split("</script>")[0]!;
  new Function("document", "fetch", "Option", "window", "location", script)(
    { getElementById: element }, fetch, function(this: { value: string }, _text: string, value: string) { this.value = value; },
    { addEventListener() {} }, { protocol: "https:" });
  element("device").value = "invented"; element("token").value = "fixture"; element("event-names-date").value = "2026-10-31";
  const pending = element("event-names-start").onclick!();
  assert.equal(calls, 1); assert.equal(element("event-names-start").disabled, true);
  if (changed !== "none") {
    const input = element(changed === "date" ? "event-names-date" : "device");
    input.value = changed === "date" ? "2026-11-01" : "other"; input.listeners.get("change")!.forEach(listener => listener());
    assert.equal(signal?.aborted, true);
  }
  release(); await pending;
  assert.doesNotMatch(element("event-names-status").textContent, /PRIVATE-CANARY/);
  assert.equal(element("event-names-start").disabled, false);
  if (changed === "none") assert.match(element("event-names-status").textContent, /1 contained a familiar name/);
  else assert.equal(element("event-names-status").textContent, "No recording name check started.");
});
