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
  const controls = runInNewContext(script + "\n;({generalControls,cloudControls});", {
    document: { getElementById: el, querySelectorAll: () => [...elements.values()] }, fetch,
    Option: function(this: { value: string }, _text: string, value: string) { this.value = value; },
    window: { addEventListener: (name: string, callback: () => void) => { if (name === "pagehide") departures.push(callback); } },
    location: { protocol: "https:" }, AbortController, URL, setInterval, clearInterval,
  });
  el("device").value = "demo"; el("token").value = "fixture";
  return { el, calls, controls, departures, respond: (handler: typeof reply) => { reply = handler; } };
}

for (const scenario of ["initial", "empty", "success", "device", "reload", "failure", "http-failure", "json-failure", "no-selection", "pagehide", "general", "cloud", "siren-stop"]) {
  test(`Model control admission: ${scenario}`, async () => {
    const h = harness();
    if (scenario === "initial") {
      for (const id of ["trial-action", "trial-value", "trial-consent", "trial-send"]) assert.equal(h.el(id).disabled, true);
      return;
    }
    if (scenario === "no-selection") {
      h.el("trial-consent").checked = true; h.el("trial-action").value = "motion";
      await h.el("trial-send").onclick!(); assert.equal(h.calls.length, 0); return;
    }
    if (scenario === "empty") h.respond(async () => ({ actions: [] }));
    if (scenario === "failure") h.respond(async () => { throw Error("offline"); });
    if (scenario === "http-failure") h.respond(async () => ({ httpFailure: true }));
    if (scenario === "json-failure") h.respond(async () => ({ jsonFailure: true }));
    await h.el("trial-load").onclick!();
    if (["empty", "failure", "http-failure", "json-failure"].includes(scenario)) {
      assert.equal(h.el("trial-send").disabled, true); assert.match(h.el("trial-status").textContent, /owner-account/); return;
    }
    assert.equal(h.el("trial-send").disabled, false);
    if (scenario === "success") return;
    if (scenario === "device") { h.el("device").value = "other"; h.el("device").emit("change"); }
    if (scenario === "reload") {
      h.respond(async path => path.endsWith("targets") ? { devices: [] } : { state: "idle" });
      await h.el("load").onclick!();
    }
    if (scenario === "pagehide") for (const callback of h.departures) callback();
    if (scenario === "general" || scenario === "cloud") {
      const lock = scenario === "general" ? h.controls.generalControls : h.controls.cloudControls;
      lock(true); assert.equal(h.el("trial-send").disabled, true);
      lock(false); assert.equal(h.el("trial-send").disabled, false);
      lock(true); h.el("device").emit("change"); lock(false);
    }
    if (scenario === "siren-stop") {
      h.el("trial-siren-stop").hidden = false;
      h.el("device").emit("change"); h.controls.generalControls(true);
      assert.equal(h.el("trial-siren-stop").disabled, false); return;
    }
    assert.equal(h.el("trial-send").disabled, true);
    assert.equal(h.el("trial-consent").checked, false);
  });
}

for (const scenario of ["different-device", "overlapping", "send-finally"]) {
  test(`Late model control reply: ${scenario}`, async () => {
    const h = harness();
    let release!: (value: unknown) => void;
    h.respond(() => new Promise(resolve => { release = resolve; }));
    if (scenario === "send-finally") {
      h.respond(async () => ({ actions: ["motion"] })); await h.el("trial-load").onclick!();
      h.respond(() => new Promise(resolve => { release = resolve; }));
      h.el("trial-consent").checked = true;
    }
    const first = h.el(scenario === "send-finally" ? "trial-send" : "trial-load").onclick!();
    await Promise.resolve();
    if (scenario === "overlapping") {
      const oldRelease = release;
      const second = h.el("trial-load").onclick!(); await Promise.resolve();
      release({ actions: [] }); await second;
      oldRelease({ actions: ["siren"] });
    } else {
      h.el("device").value = "other"; h.el("device").emit("change");
      release(scenario === "send-finally" ? { outcome: "confirmed" } : { actions: ["motion"] });
    }
    await first;
    assert.equal(h.el("trial-action").value, ""); assert.equal(h.el("trial-send").disabled, true);
  });
}

test("Diagnostics declares its own readable canvas", () => {
  const page = diagnosticsPage();
  assert.match(page, /name="color-scheme" content="light"/);
  assert.match(page, /html\{color-scheme:light;background:#fff\}/);
  assert.match(page, /body\{background:#fff/);
});
