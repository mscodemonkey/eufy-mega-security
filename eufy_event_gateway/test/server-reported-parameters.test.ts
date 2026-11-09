/**
 * Exercises the authenticated diagnostic HTTP boundary with a synthetic provider.
 * The test owns the server and disconnects clients deliberately. No account or
 * device is contacted, and no provider exception may become a public response.
 */
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";
import { ParameterCheckError, projectDeviceListMotion, projectReportedParameters } from "../src/provider/reported-parameter-check.js";

test("parameter HTTP authenticates loopback, closes consent and rejects private provider data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "parameter-http-"));
  let calls = 0, value: unknown = projectReportedParameters("T8410", { params: [] }), fail: unknown = null;
  let receivedSignal: AbortSignal | undefined, receivedSource: "device_list" | undefined;
  const provider = { readReportedParameters: async (_serial: string, signal: AbortSignal, source?: "device_list") => {
    calls++; receivedSignal = signal; receivedSource = source; if (fail) throw fail; return value;
  } } as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "fixture", experimentalModelControls: true }, new GatewayState(),
    new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
  try {
    await server.listen(); const url = `http://127.0.0.1:${server.port}/api/diagnostics/parameter-check`;
    const options = { method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" }, body: JSON.stringify({ serial: "target", consent: true }) };
    const good = await fetch(url, options); assert.equal(good.status, 200); assert.equal(good.headers.get("cache-control"), "no-store");
    assert.deepEqual(await good.json(), value); assert.equal(receivedSignal?.aborted, false);
    assert.equal((await fetch(url, { ...options, headers: { "content-type": "application/json" } })).status, 401);
    value = projectReportedParameters("T8910", { params: [{ param_type: 1605, param_value: Date.now() }] });
    const motion = await fetch(url, options);
    assert.equal(motion.status, 200);
    assert.deepEqual(await motion.json(), { model: "T8910", profile: "motion_time_candidate", observations: { 1605: "recent" } });
    value = projectDeviceListMotion({ params: [] }, { params: [] });
    const listOptions = { ...options, body: JSON.stringify({ serial: "target", consent: true, source: "device_list" }) };
    const list = await fetch(url, listOptions);
    assert.equal(list.status, 200); assert.equal(receivedSource, "device_list");
    assert.deepEqual(await list.json(), value);
    assert.deepEqual(await (await fetch(url, options)).json(), { stage: "invalid_response" });
    value = projectReportedParameters("T8910", { params: [] });
    assert.deepEqual(await (await fetch(url, listOptions)).json(), { stage: "invalid_response" });
    const before = calls;
    for (const body of [{ serial: "target" }, { serial: "target", consent: true, source: "unknown" }, { serial: "target", consent: false, source: "device_list" }, { serial: "target", consent: false }, { serial: "target", consent: true, extra: "SENTINEL" },
      { serial: "x".repeat(129), consent: true }, { serial: {}, consent: true }, []]) {
      assert.deepEqual(await (await fetch(url, { ...options, body: JSON.stringify(body) })).json(), { stage: "invalid_request" });
    }
    assert.equal((await fetch(url, { ...options, body: "{bad" })).status, 400);
    assert.equal((await fetch(url, { ...options, body: " ".repeat(1025) })).status, 400);
    assert.equal((await fetch(url, { ...options, headers: { authorization: "Bearer fixture" } })).status, 400);
    assert.equal((await fetch(url, { headers: options.headers })).status, 400);
    assert.equal(calls, before);
    value = { ...projectReportedParameters("T8410", { params: [] }), private: "SENTINEL" };
    assert.deepEqual(await (await fetch(url, options)).json(), { stage: "invalid_response" });
    fail = Error("SENTINEL"); assert.deepEqual(await (await fetch(url, options)).json(), { stage: "request" });
    fail = new ParameterCheckError("owner_binding_unavailable");
    assert.deepEqual(await (await fetch(url, options)).json(), { stage: "owner_binding_unavailable" });
    fail = new ParameterCheckError("owner_account_required");
    assert.deepEqual(await (await fetch(url, options)).json(), { stage: "owner_account_required" });
    fail = new ParameterCheckError("SENTINEL" as never);
    assert.deepEqual(await (await fetch(url, options)).json(), { stage: "request" });
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("real HTTP disconnect cancels the provider and retires the handler", async () => {
  const directory = await mkdtemp(join(tmpdir(), "parameter-disconnect-"));
  let started!: () => void, aborted!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const provider = { readReportedParameters: async (_serial: string, signal: AbortSignal) => {
    started(); signal.addEventListener("abort", aborted, { once: true }); return await new Promise(() => undefined);
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "fixture", experimentalModelControls: true }, new GatewayState(),
    new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
  try {
    await server.listen();
    const client = request({ host: "127.0.0.1", port: server.port, path: "/api/diagnostics/parameter-check", method: "POST",
      headers: { authorization: "Bearer fixture", "content-type": "application/json" } });
    client.on("error", () => undefined); client.end(JSON.stringify({ serial: "target", consent: true }));
    await active; client.destroy(); await cancelled;
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const mode of ["disabled", "missing-token", "timeout"] as const) {
  test(`parameter HTTP fails safely: ${mode}`, async context => {
    const directory = await mkdtemp(join(tmpdir(), "parameter-http-gate-"));
    let calls = 0, signal: AbortSignal | undefined;
    if (mode === "timeout") {
      const original = setTimeout;
      context.mock.method(globalThis, "setTimeout", ((callback: () => void, delay: number) => original(callback, delay === 30_000 ? 20 : delay)) as typeof setTimeout);
    }
    const provider = { readReportedParameters: async (_serial: string, value: AbortSignal) => {
      calls++; signal = value; return await new Promise(() => undefined);
    } } as unknown as CameraProvider;
    const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: mode === "missing-token" ? "" : "fixture", experimentalModelControls: mode !== "disabled" },
      new GatewayState(), new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
    try {
      await server.listen();
      const result = await fetch(`http://127.0.0.1:${server.port}/api/diagnostics/parameter-check`, {
        method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" }, body: '{"serial":"target","consent":true}',
      });
      assert.deepEqual(await result.json(), { stage: mode === "missing-token" ? "unauthorized" : mode });
      assert.equal(calls, mode === "timeout" ? 1 : 0);
      if (mode === "timeout") assert.equal(signal?.aborted, true);
    } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
