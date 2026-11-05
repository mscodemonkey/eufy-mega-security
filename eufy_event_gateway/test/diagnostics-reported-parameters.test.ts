/**
 * Executes the served diagnostics script against a synthetic DOM and fetch.
 * The browser owns consent and cancellation. Tests prove that selection changes
 * retire late responses and that loading the page never starts a cloud read.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticsPage } from "../src/diagnostics/page.js";

test("state-check browser requires consent and drops cancelled or stale replies", async () => {
  const elements = new Map<string, { value: string; checked: boolean; textContent: string; disabled: boolean; hidden: boolean;
    onclick?: () => Promise<void>; listeners: Map<string, () => void>; addEventListener: (event: string, action: () => void) => void;
    replaceChildren: () => void; removeAttribute: () => void }>();
  const element = (id: string) => {
    if (!elements.has(id)) {
      const listeners = new Map<string, () => void>();
      elements.set(id, { value: "", checked: false, textContent: "", disabled: false, hidden: false, listeners,
        addEventListener: (event, action) => { const previous = listeners.get(event); listeners.set(event, () => { previous?.(); action(); }); }, replaceChildren: () => undefined, removeAttribute: () => undefined });
    }
    return elements.get(id)!;
  };
  let calls = 0, finish!: (value: unknown) => void, signal: AbortSignal | undefined;
  const fetch = async (path: string, options: { signal: AbortSignal; body: string }) => {
    calls++; assert.equal(path, "api/diagnostics/parameter-check");
    assert.deepEqual(JSON.parse(options.body), { serial: "selected", consent: true });
    signal = options.signal;
    return { ok: true, json: () => new Promise(resolve => { finish = resolve; }) };
  };
  const script = diagnosticsPage().split("<script>")[1]!.split("</script>")[0]!;
  new Function("document", "fetch", "Option", "window", "location", script)(
    { getElementById: element }, fetch, function() {}, { addEventListener() {} }, { protocol: "https:" });
  assert.equal(calls, 0);
  await element("parameter-start").onclick!(); assert.equal(calls, 0);
  element("device").value = "selected";
  await element("parameter-start").onclick!(); assert.equal(calls, 0);
  element("parameter-consent").checked = true;
  const operation = element("parameter-start").onclick!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(element("parameter-consent").checked, false);
  await element("parameter-start").onclick!(); assert.equal(calls, 1);
  element("device").value = "different"; element("device").listeners.get("change")!();
  assert.equal(signal?.aborted, true);
  finish({ model: "T8410", observations: { 1035: "one" } }); await operation;
  assert.equal(element("parameter-status").textContent, "No state check running.");
  element("device").value = "selected"; element("parameter-consent").checked = true;
  const next = element("parameter-start").onclick!(); await new Promise(resolve => setImmediate(resolve));
  finish({ model: "T8410", observations: { 1035: "one" } }); await next;
  assert.match(element("parameter-status").textContent, /Cached candidates only/);
  assert.match(diagnosticsPage(), /6250 candidate is not a lens-position readback/);
});
