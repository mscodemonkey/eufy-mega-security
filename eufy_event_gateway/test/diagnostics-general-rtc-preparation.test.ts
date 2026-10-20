/**
 * Runs the served diagnostics script with owned DOM and HTTP fixtures.
 * These tests verify form admission and stale-result handling, without sending
 * any camera command or claiming that browser gating replaces server checks.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { diagnosticsPage } from "../src/diagnostics/page.js";

/** Owns one fake form element and its change listeners for the script lifetime. */
class FormElement {
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  textContent = "";
  onclick?: () => Promise<void>;
  onchange?: () => void;
  readonly listeners = new Map<string, (() => void)[]>();

  constructor(readonly id: string) {}

  addEventListener(name: string, callback: () => void): void {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], callback]);
  }

  emit(name: string): void {
    for (const callback of this.listeners.get(name) ?? []) callback();
  }

  replaceChildren(...options: { value: string }[]): void { this.value = options[0]?.value ?? ""; }
  add(option: { value: string }): void { this.value ||= option.value; }
  removeAttribute(): void {}
  load(): void {}
  pause(): void {}
}

function harness() {
  const elements = new Map<string, FormElement>();
  const el = (id: string): FormElement => {
    if (!elements.has(id)) elements.set(id, new FormElement(id));
    return elements.get(id)!;
  };
  const departures: (() => void)[] = [];
  const calls: { path: string; method?: string; body?: string }[] = [];
  let reply: (path: string, options: { method?: string; body?: string }) => Promise<unknown> = async () => ({ actions: ["motion"] });
  const fetch = async (path: string, options: { method?: string; body?: string }) => {
    calls.push({ path, ...options });
    const result = await reply(path, options);
    const failure = result as { httpFailure?: boolean; jsonFailure?: boolean };
    return { ok: !failure?.httpFailure, json: async () => { if(failure?.jsonFailure) throw Error("Invalid JSON"); return result; } };
  };
  const script = diagnosticsPage().split("<script>")[1]!.split("</script>")[0]!;
  const controls = runInNewContext(script + "\n;({generalControls,cloudControls,showPreparation});", {
    document: { getElementById: el, querySelectorAll: () => [...elements.values()] }, fetch,
    setTimeout, clearTimeout,
    Option: function(this: { value: string }, _text: string, value: string) { this.value = value; },
    window: { addEventListener: (name: string, callback: () => void) => { if (name === "pagehide") departures.push(callback); } },
    location: { protocol: "https:" }, AbortController, URL, setInterval, clearInterval,
  });
  el("device").value = "demo"; el("token").value = "fixture";
  return { el, calls, controls, departures, respond: (handler: typeof reply) => { reply = handler; } };
}

test("sign-in requires separate consent and sends exactly one POST on response loss", async () => {
  const h = harness();
  await h.el("general-prepare").onclick!(); assert.equal(h.calls.length, 0);
  h.el("general-prepare-consent").checked = true;
  h.respond(async (_path, options) => { if(options.method === "POST") throw Error("lost response"); return { state: "ready" }; });
  await h.el("general-prepare").onclick!();
  assert.deepEqual(h.calls.map(call => call.method), ["POST", "GET"]);
  assert.equal(h.calls[0]!.body, '{"consent":true}');
  assert.equal(h.el("general-prepare-consent").checked, false);
  assert.match(h.el("general-prepare-status").textContent, /does not confirm/);
  assert.equal(h.el("device").disabled, false);
});

test("repeated waiting status preserves form locks and ready restores their original state", () => {
  const h = harness();
  h.controls.showPreparation("signing-in"); h.controls.showPreparation("authentication-required");
  assert.equal(h.el("device").disabled, true); assert.equal(h.el("trial-load").disabled, true);
  h.controls.showPreparation("ready");
  assert.equal(h.el("device").disabled, false);
  assert.equal(h.el("general-prepare-consent").checked, false);
  assert.throws(() => h.controls.showPreparation("SENTINEL_SERVER_TEXT"));
  assert.equal(h.el("general-prepare-status").textContent.includes("SENTINEL"), false);
});

test("page hide resets consent without dispatching or cancelling authentication", () => {
  const h = harness(); h.el("general-prepare-consent").checked = true;
  for(const departure of h.departures) departure();
  assert.equal(h.el("general-prepare-consent").checked, false); assert.equal(h.calls.length, 0);
});
