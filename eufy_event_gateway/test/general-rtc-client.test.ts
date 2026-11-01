/**
 * Exercises fixed RTC HTTP contracts through an offline restored Mega session.
 * Fixtures own synthetic keys and temporary files, reject every unlisted URL,
 * and observe persistence so a trial cannot quietly authenticate or renew keys.
 */
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MegaClient, megaOperation } from "../src/mega/client.js";
import { MegaSessionStore } from "../src/mega/session-store.js";
import { credentialVerifier, decryptEnvelope, sharedAesKey } from "../src/mega/crypto.js";
import { captureGeneralRtcIdentity } from "../src/mega/general-rtc-identity.js";
import type { MegaSession } from "../src/mega/types.js";
import { GeneralRtcError } from "../src/stream/general-rtc-protocol.js";

const security = "security-app-ie.eufylife.com", openapi = "app-openapi-eu-pr.eufy.com";
const sharedKey = "a".repeat(64);
const housePath = "/app/house/get_devs_list", hubPath = "/v3/web/get_hub_list", devicePath = "/v3/web/get_devs_list";
const paramsPath = "/v3/app/overall/get_params", pinPath = "/v3/web/wp/verify_captcha", signPath = "/v1/smart/ws/sign";
const paths = [housePath, hubPath, devicePath, paramsPath, pinPath, signPath] as const;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

/** Restore only synthetic material, then measure trial calls after startup persistence. */
async function fixture(context: TestContext, handler: typeof fetch, missing?: "openapi" | "security") {
  const directory = await mkdtemp(join(tmpdir(), "general-client-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const pair = createECDH("prime256v1"); pair.setPrivateKey(Buffer.from("1".padStart(64, "0"), "hex"));
  const native = { keyIdent: "synthetic", sharedKey, clientPublicKey: pair.getPublicKey("hex") };
  const saved: MegaSession = { version: 2, country: "au", openUdid: "synthetic-client",
    credentialVerifier: credentialVerifier("synthetic-client", "fixture@example.invalid", "redacted"),
    authToken: "synthetic-token", userId: "synthetic-owner", tokenExpiresAt: 9e9, verificationPending: false,
    megaDomain: "mega-eu-pr.eufy.com", domains: { eufy_security: security },
    identities: { ...(missing === "openapi" ? {} : { [openapi]: native }), ...(missing === "security" ? {} : { [security]: native }) } };
  const identity = captureGeneralRtcIdentity(saved, security, "1".padStart(64, "0"), native.clientPublicKey, undefined)!;
  const path = join(directory, "mega-session.json");
  await writeFile(path, JSON.stringify({ ...saved, generalRtcIdentity: identity }));
  const requests: { path: string; host: string; options: RequestInit | undefined; body: unknown }[] = [];
  const writes = context.mock.method(MegaSessionStore.prototype, "save");
  const client = new MegaClient({ email: "fixture@example.invalid", password: "redacted", country: "AU", persistentDirectory: directory,
    experimentalGeneralRtc: true, minimumRequestIntervalMs: 0, fetch: async (url, options) => {
      const parsed = new URL(String(url));
      assert.ok((paths as readonly string[]).includes(parsed.pathname), "Unlisted outbound URL");
      const sign = parsed.pathname === signPath;
      assert.equal(parsed.hostname, sign ? "security-smart-ie.eufylife.com" : parsed.pathname === housePath ? "app-house-eu-pr.eufy.com" : security);
      requests.push({ path: parsed.pathname, host: parsed.hostname, options,
        body: sign ? undefined : JSON.parse(decryptEnvelope(String(options?.body), sharedAesKey(sharedKey))) });
      return handler(url, options);
    } });
  context.after(() => client.cancelPendingRequests());
  assert.equal((await client.connect()).state, "authenticated");
  assert.equal(requests.length, 0);
  writes.mock.resetCalls();
  const before = await readFile(path, "utf8");
  return { client, requests, unchanged: async () => { assert.equal(writes.mock.callCount(), 0); assert.equal(await readFile(path, "utf8"), before); } };
}

function response(path: string): Response {
  const data = path === housePath ? { devices: [{ device_sn: "synthetic-camera" }], groups: [] }
    : path === hubPath ? [{ station_sn: "synthetic-station" }]
      : path === devicePath ? [{ device_sn: "synthetic-camera", station_sn: "synthetic-station" }]
        : path === signPath ? "synthetic-sign" : [];
  return new Response(JSON.stringify({ code: 0, data }));
}

test("request table uses exact native bodies, scoped headers and a GET-only smart sign", async context => {
  const f = await fixture(context, async url => response(new URL(String(url)).pathname));
  assert.equal(f.client.generalRtcHasNativeIdentities(), true);
  const signal = new AbortController().signal;
  const inventory = await f.client.generalRtcInventory(signal);
  assert.deepEqual(inventory.devices.map(row => row.device_sn), ["synthetic-station", "synthetic-camera"]);
  await f.client.generalRtcHubs(0, signal); await f.client.generalRtcHubs(4, signal);
  await f.client.generalRtcParams(signal);
  let dispatched = 0;
  await f.client.generalRtcVerifyPin("1234", signal, () => { dispatched++; });
  assert.equal(await f.client.generalRtcSign(signal), "synthetic-sign");
  assert.equal(dispatched, 1);
  assert.deepEqual(f.requests.map(row => row.path), [hubPath, devicePath, hubPath, hubPath, paramsPath, pinPath, signPath]);
  assert.deepEqual(f.requests[0]?.body, { page: 0, num: 100, station_sn: "", device_sn: "" });
  assert.deepEqual(f.requests[1]?.body, { page: 0, num: 100, station_sn: "", device_sn: "", orderby: "" });
  assert.deepEqual(f.requests[2]?.body, { page: 0, num: 100, station_sn: "", device_sn: "" });
  assert.deepEqual(f.requests[3]?.body, { page: 4, num: 100, station_sn: "", device_sn: "" });
  assert.deepEqual(f.requests[4]?.body, { param_name: "common.start_stream.config" });
  assert.deepEqual(f.requests[5]?.body, { captcha: "1234" });
  const pinHeaders = f.requests[5]?.options?.headers as Record<string, string>;
  assert.equal(pinHeaders["X-Auto-Ts"], pinHeaders["x-request-ts"]);
  const sign = f.requests[6]!.options!;
  assert.equal(sign.method, "GET"); assert.equal(sign.redirect, "error");
  assert.deepEqual(sign.headers, { "X-Auth-Token": "synthetic-token", "Web-Country": "AU" });
  for (const path of paths.slice(2)) assert.notEqual(megaOperation(path), "unknown");
  await f.unchanged();
});

for (const code of [4404, 4406, 100030]) for (const index of [0, 1, 2, 3]) {
  test(`native rejection ${code} at table row ${index} never retries, exchanges or saves`, async context => {
    const f = await fixture(context, async url => {
      const path = new URL(String(url)).pathname;
      const rejectedPath = [hubPath, devicePath, paramsPath, pinPath][index];
      return path === rejectedPath ? new Response(JSON.stringify({ code, data: {} })) : response(path);
    });
    const signal = new AbortController().signal;
    let dispatched = 0;
    const operation = index < 2 ? f.client.generalRtcInventory(signal) : index === 2 ? f.client.generalRtcParams(signal)
      : f.client.generalRtcVerifyPin("1234", signal, () => { dispatched++; });
    await assert.rejects(operation, (error: unknown) => error instanceof GeneralRtcError && error.reason === "native_identity_rejected");
    assert.equal(f.requests.filter(row => row.path === [hubPath, devicePath, paramsPath, pinPath][index]).length, 1);
    assert.equal(f.requests.length, index === 1 ? 2 : 1);
    assert.equal(dispatched, index === 3 ? 1 : 0);
    await f.unchanged();
  });
}

for (const missing of ["openapi", "security"] as const) test(`cached ${missing} identity admission matches the portal host boundary`, async context => {
  const f = await fixture(context, async url => response(new URL(String(url)).pathname), missing);
  assert.equal(f.client.generalRtcHasNativeIdentities(), missing === "openapi");
  const signal = new AbortController().signal;
  if (missing === "openapi") await f.client.generalRtcInventory(signal);
  else await assert.rejects(f.client.generalRtcHubs(0, signal),
    (error: unknown) => error instanceof GeneralRtcError && error.reason === "native_identity_missing");
  assert.equal(f.requests.length, missing === "openapi" ? 2 : 0); await f.unchanged();
});

test("a queued PIN cancelled before dispatch returns without waiting for the queue or counting dispatch", async context => {
  const f = await fixture(context, async (_url, options) => await new Promise<Response>((_resolve, reject) => {
    options!.signal!.addEventListener("abort", () => reject(Error("synthetic cancellation")), { once: true });
  }));
  const active = f.client.generalRtcHubs(0, new AbortController().signal).catch(() => undefined);
  await turn();
  const controller = new AbortController(); let dispatched = 0;
  const pending = f.client.generalRtcVerifyPin("1234", controller.signal, () => { dispatched++; });
  controller.abort(); await assert.rejects(pending, GeneralRtcError);
  assert.equal(dispatched, 0); assert.equal(f.requests.length, 1);
  f.client.cancelPendingRequests(); await active; await f.unchanged();
});

test("trial inventory propagates a failed device list while normal inventory retains its fallback", async context => {
  const f = await fixture(context, async url => new URL(String(url)).pathname === devicePath
    ? new Response("failure", { status: 500 }) : response(new URL(String(url)).pathname));
  await assert.rejects(f.client.generalRtcInventory(new AbortController().signal), GeneralRtcError);
  const normal = await f.client.inventory(); assert.equal(normal.devices.length, 1);
  assert.equal(f.requests.filter(row => row.path === devicePath).length, 1);
  await f.unchanged();
});

test("portal inventory scans bounded pages and keeps an attached station distinct from its camera", async context => {
  const f = await fixture(context, async (url, options) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(decryptEnvelope(String(options?.body), sharedAesKey(sharedKey))) as { page?: number };
    if (path === hubPath && body.page === 0) {
      return new Response(JSON.stringify({ code: 0, data: Array.from({ length: 100 }, (_, index) => ({ station_sn: `station-${index}` })) }));
    }
    if (path === hubPath) return new Response(JSON.stringify({ code: 0, data: [{ station_sn: "station-final" }] }));
    if (path === devicePath) {
      return new Response(JSON.stringify({ code: 0, data: [{ device_sn: "camera", station_sn: "station-final" }] }));
    }
    return response(path);
  });
  const inventory = await f.client.generalRtcInventory(new AbortController().signal);
  assert.equal(inventory.devices.length, 102);
  assert.deepEqual(f.requests.map(row => [row.path, (row.body as { page?: number }).page]),
    [[hubPath, 0], [hubPath, 1], [devicePath, 0]]);
  await f.unchanged();
});

test("portal inventory rejects duplicate routing identities", async context => {
  const f = await fixture(context, async url => {
    const path = new URL(String(url)).pathname;
    if (path === devicePath) {
      return new Response(JSON.stringify({ code: 0, data: [{ device_sn: "duplicate" }, { device_sn: "duplicate" }] }));
    }
    return response(path);
  });
  await assert.rejects(f.client.generalRtcInventory(new AbortController().signal),
    (error: unknown) => error instanceof GeneralRtcError && error.reason === "topology");
  await f.unchanged();
});

test("a stalled native request uses the declared ten-second cap", async context => {
  const controller = new AbortController(), times: number[] = [];
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => { times.push(milliseconds); return controller.signal; });
  const f = await fixture(context, async (_url, options) => await new Promise<Response>((_resolve, reject) => {
    options!.signal!.addEventListener("abort", () => reject(Error("synthetic timeout")), { once: true });
  }));
  const pending = f.client.generalRtcHubs(0, new AbortController().signal);
  await turn(); assert.ok(times.includes(10_000)); controller.abort();
  await assert.rejects(pending, GeneralRtcError); assert.equal(f.requests.length, 1); await f.unchanged();
});
