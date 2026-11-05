/**
 * Exercises read-only lock refusal messages in the gateway's synthetic page DOM.
 * Each test owns its form and injected responses. No account or device is used.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticsPage } from "../src/diagnostics/page.js";

for (const [reason, expected] of [
  ["owner_account_required", /existing owner-authorized connection/],
  ["inventory_changed", /binding changed during the check/],
  ["PRIVATE_ACCOUNT_VALUE", /matching lock_status_trial_failed log line/],
] as const) {
  test(`lock refusal message ${reason} retains consent and excludes private values`, async () => {
    const elements = new Map<string, { value: string; checked: boolean; disabled: boolean; hidden: boolean; textContent: string;
      onclick?: () => Promise<void>; addEventListener: () => void; replaceChildren: () => void; add: (option: { value: string }) => void }>();
    const element = (id: string) => {
      if (!elements.has(id)) {
        const value = { value: "", checked: false, disabled: false, hidden: false, textContent: "", addEventListener: () => {},
          replaceChildren: () => { value.value = ""; }, add: (option: { value: string }) => { value.value ||= option.value; } };
        elements.set(id, value);
      }
      return elements.get(id)!;
    };
    let calls = 0;
    const fetch = async (path: string, options: { method: string; body: string }) => {
      ++calls;
      assert.equal(path, "api/locks/synthetic/status-trial");
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { consent: true });
      return { ok: false, json: async () => ({ stage: "admission", reason, owner: "PRIVATE_ACCOUNT_VALUE" }) };
    };
    const script = diagnosticsPage().split("<script>")[1]!.split("</script>")[0]!;
    new Function("document", "fetch", "Option", "window", "location", script)(
      { getElementById: element }, fetch, function(this: { value: string }, _text: string, value: string) { this.value = value; },
      { addEventListener() {} }, { protocol: "https:" });
    element("device").value = "synthetic";
    element("token").value = "fixture";
    await element("lock-status-start").onclick!();
    assert.equal(calls, 0);
    element("lock-status-consent").checked = true;
    await element("lock-status-start").onclick!();
    assert.equal(calls, 1);
    assert.match(element("lock-status-result").textContent, expected);
    assert.doesNotMatch([...elements.values()].map(value => value.textContent).join(""), /PRIVATE_ACCOUNT_VALUE/);
    assert.equal(element("lock-status-consent").checked, false);
    assert.equal(element("lock-status-start").disabled, false);
  });
}
