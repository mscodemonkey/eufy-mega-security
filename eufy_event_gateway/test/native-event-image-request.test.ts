/**
 * Exercises the optional event-picture HTTP shape with a synthetic saved account.
 * Tests own fetch, clocks, retry delays and temporary session files. No request
 * can leave the injected fetch boundary or reach an Eufy account.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MegaClient } from "../src/mega/client.js";
import { credentialVerifier } from "../src/mega/crypto.js";
import { loadConfig } from "../src/config.js";

/** Build an authenticated offline client without performing a login exchange. */
async function fixture(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "native-picture-"));
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  let now = 1_700_000_000_000;
  await writeFile(join(directory, "mega-session.json"), JSON.stringify({ version: 2, country: "au", openUdid: "device",
    credentialVerifier: credentialVerifier("device", "user@example.invalid", "password"), authToken: "synthetic-media-token",
    tokenExpiresAt: 2_000_000_000, userId: "synthetic", megaDomain: "mega-eu-pr.eufy.com", domains: {}, identities: {} }));
  const requests: RequestInit[] = [], waits: number[] = [];
  let response: (request: RequestInit) => Promise<Response> = async () => new Response(Buffer.from([255, 216, 255, 217]));
  let wait: () => void = () => {};
  const client = new MegaClient({ email: "user@example.invalid", password: "password", country: "AU", persistentDirectory: directory,
    now: () => now, minimumRequestIntervalMs: 0,
    wait: async ms => { waits.push(ms); wait(); },
    fetch: async (_url, options) => { requests.push(options ?? {}); return response(options ?? {}); } });
  await client.connect();
  return { client, requests, waits, respond: (value: typeof response) => { response = value; },
    expire: () => { now = 2_100_000_000_000; }, onWait: (value: () => void) => { wait = value; } };
}

for (const native of [false, true]) test(`initial and redirect header policy native=${native}`, async context => {
  const f = await fixture(context);
  f.respond(async () => f.requests.length === 1 ? new Response(null, { status: 302,
    headers: { location: "https://zhixin-security-au.s3.ap-southeast-2.amazonaws.com/private-image" } }) : new Response(Buffer.from([255, 216, 255, 217])));
  const result = await (native ? f.client.downloadNativeEventImageWithMetadata("https://security-app-eu.eufylife.com/image")
    : f.client.downloadWithMetadata("https://security-app-eu.eufylife.com/image"));
  assert.equal(result.data.length, 4); assert.equal(f.requests.length, 2);
  assert.equal(Object.hasOwn(f.requests[0]!, "headers"), !native);
  assert.equal(new Headers(f.requests[0]!.headers).get("x-auth-token"), native ? null : "synthetic-media-token");
  assert.equal(Object.hasOwn(f.requests[1]!, "headers"), false);
});

test("native 404 schedule has no authenticated fallback and expires after five attempts", async context => {
  const f = await fixture(context); f.respond(async () => new Response(null, { status: 404 }));
  await assert.rejects(f.client.downloadNativeEventImage("https://security-app-eu.eufylife.com/image"), /HTTP 404/);
  assert.deepEqual(f.waits, [1000, 2000, 2000, 5000]); assert.equal(f.requests.length, 5);
  assert.ok(f.requests.every(request => !Object.hasOwn(request, "headers")));
});

test("native retries recheck authentication and shutdown cancels without another request", async context => {
  const f = await fixture(context); f.respond(async () => new Response(null, { status: 404 }));
  f.onWait(f.expire);
  await assert.rejects(f.client.downloadNativeEventImage("https://security-app-eu.eufylife.com/image"), /authentication/);
  assert.equal(f.requests.length, 1);
});

test("native shutdown retires retries under the same request lifetime", async context => {
  const f = await fixture(context); f.respond(async () => new Response(null, { status: 404 }));
  f.onWait(() => f.client.cancelPendingRequests());
  await assert.rejects(f.client.downloadNativeEventImage("https://security-app-eu.eufylife.com/image"));
  assert.equal(f.requests.length, 1);
});

test("native requests preserve URL, redirect and byte bounds", async context => {
  const f = await fixture(context);
  for (const url of ["http://security-app-eu.eufylife.com/image", "https://evil.invalid/image", "https://user@security-app-eu.eufylife.com/image",
    "https://security-app-eu.eufylife.com:444/image"]) await assert.rejects(f.client.downloadNativeEventImage(url));
  assert.equal(f.requests.length, 0);
  f.respond(async () => new Response(Buffer.alloc(10)));
  await assert.rejects(f.client.downloadNativeEventImage("https://security-app-eu.eufylife.com/image", 4));
  f.respond(async () => new Response(null, { status: 302, headers: { location: "https://evil.invalid/image" } }));
  await assert.rejects(f.client.downloadNativeEventImage("https://security-app-eu.eufylife.com/image"));
});

test("option is strict, defaults off, needs no API token and has consistent Supervisor wiring", async () => {
  assert.equal(loadConfig({}).experimentalEventImageRequest, false);
  assert.equal(loadConfig({ EUFY_GATEWAY_EXPERIMENTAL_EVENT_IMAGE_REQUEST: "true" }).experimentalEventImageRequest, true);
  assert.equal(loadConfig({ EUFY_GATEWAY_EXPERIMENTAL_EVENT_IMAGE_REQUEST: "false" }).experimentalEventImageRequest, false);
  for (const value of ["1", "yes"]) assert.throws(() => loadConfig({ EUFY_GATEWAY_EXPERIMENTAL_EVENT_IMAGE_REQUEST: value }));
  assert.equal(loadConfig({ EUFY_GATEWAY_EXPERIMENTAL_EVENT_IMAGE_REQUEST: " TRUE " }).experimentalEventImageRequest, true);
  const root = new URL("../", import.meta.url);
  const config = await readFile(new URL("config.yaml", root), "utf8"), shell = await readFile(new URL("run.sh", root), "utf8");
  const translation = await readFile(new URL("translations/en.yaml", root), "utf8");
  assert.match(config, /experimental_event_image_request: false/); assert.match(config, /experimental_event_image_request: bool\?/);
  assert.match(shell, /EUFY_GATEWAY_EXPERIMENTAL_EVENT_IMAGE_REQUEST=.*experimental_event_image_request \/\/ false/);
  assert.match(translation, /experimental_event_image_request:/); assert.match(translation, /Pictures may stop while enabled/);
});
