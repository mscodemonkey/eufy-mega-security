/**
 * Verifies redacted media paths through synthetic cloud failures and provider
 * logs. Tests own all fake sessions, requests and observers, with no live I/O.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaRequestDiagnostic } from "../src/mega/media-request-diagnostic.js";
import { MegaClient } from "../src/mega/client.js";
import { credentialVerifier } from "../src/mega/crypto.js";
import { MegaPushReceiver, parsePushEvent, type MegaPushEvent } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";

const initialUrl = "https://security-app-eu.eufylife.com/v1/image/PRIVATE_FILE.jpg?token=PRIVATE_QUERY#PRIVATE_FRAGMENT";
const objectUrl = "https://zhixin-security-synthetic.s3.eu-west-1.amazonaws.com/PRIVATE_BUCKET/PRIVATE_HASH.png?signature=PRIVATE_SIGNATURE";

test("fixed route words survive while private URL components are omitted", () => {
  assert.equal(mediaRequestDiagnostic(new URL(initialUrl)), "eufy-eu /v1/image/[redacted].jpg segments=3 q=present");
  assert.equal(mediaRequestDiagnostic(new URL("https://PRIVATE_USER:PRIVATE_PASS@security-app.eufylife.com/Image/%69mage/%2F/hash/image.jpg")),
    "eufy-us /[redacted]/[redacted]/[redacted]/[redacted]/[redacted].jpg segments=5 q=absent");
  assert.equal(mediaRequestDiagnostic(new URL(objectUrl)), "object-store /[redacted]/[redacted].png segments=2 q=present");
  assert.equal(mediaRequestDiagnostic(new URL("https://security-app-ie.eufylife.com/image/")), "eufy-ie /image segments=1 q=absent");
});

test("unknown hosts, unusual paths, oversized input and exceptions remain safe", () => {
  for (const host of ["evil-eufylife.com", "security-app.eufylife.com.evil.test", "[::1]", "security-app.eufylife.com:8443"]) {
    assert.equal(mediaRequestDiagnostic(new URL(`https://${host}/PRIVATE`)), "unknown /[redacted] segments=1 q=absent");
  }
  for (const path of ["", "/", "/./../image/", "/image\\PRIVATE", "/☃/\u0000PRIVATE", "/PRIVATE.JPG", `/${"x".repeat(1000)}`]) {
    const result = mediaRequestDiagnostic(new URL(`https://security-app.eufylife.com${path}`));
    assert.ok(result.length < 300);
    assert.doesNotMatch(result, /PRIVATE|☃|\u0000/);
  }
  assert.equal(mediaRequestDiagnostic(new URL(`https://security-app.eufylife.com/${Array(12).fill("image").join("/")}`)),
    "eufy-us /image/image/image/image/image/image/image/image/[truncated] segments=12 q=absent");
  const unavailable = "unknown unavailable segments=0 q=absent";
  assert.equal(mediaRequestDiagnostic(new URL(`https://security-app.eufylife.com/${"x".repeat(2048)}`)), unavailable);
  assert.equal(mediaRequestDiagnostic(null as unknown as URL), unavailable);
  const broken = new URL(initialUrl);
  Object.defineProperty(broken, "href", { get() { throw Error("PRIVATE"); } });
  assert.equal(mediaRequestDiagnostic(broken), unavailable);
});

for (const mode of ["initial404", "redirect404", "redirect403", "mixed"]) {
  test(`terminal failure ${mode} describes only the latest request attempt`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "media-diagnostic-"));
    const waits: number[] = [];
    let initialRequests = 0;
    try {
      await writeFile(join(directory, "mega-session.json"), JSON.stringify({
        version: 2, country: "au", openUdid: "fixture", credentialVerifier: credentialVerifier("fixture", "test@example.invalid", "redacted"),
        authToken: "fixture", tokenExpiresAt: 2_000_000_000, userId: "fixture", megaDomain: "mega-eu-pr.eufy.com", domains: {}, identities: {},
      }));
      const client = new MegaClient({ email: "test@example.invalid", password: "redacted", country: "AU", persistentDirectory: directory,
        minimumRequestIntervalMs: 0, now: () => 1_700_000_000_000, wait: async ms => { waits.push(ms); },
        fetch: async (url, options) => {
          if (String(url) === initialUrl) {
            assert.equal(new Headers(options?.headers).get("x-auth-token"), "fixture");
            initialRequests++;
            if (mode === "initial404" || (mode === "mixed" && initialRequests === 5)) return new Response(null, { status: 404 });
            return new Response(null, { status: 302, headers: { location: objectUrl } });
          }
          assert.equal(String(url), objectUrl);
          assert.equal(new Headers(options?.headers).get("x-auth-token"), null);
          return new Response(null, { status: mode === "redirect403" ? 403 : 404 });
        },
      });
      await client.connect();
      await assert.rejects(client.download(initialUrl), (error: unknown) => {
        assert.ok(error instanceof Error);
        const redirected = mode === "redirect404" || mode === "redirect403";
        assert.equal(error.message, `Mega media download failed (HTTP ${mode === "redirect403" ? 403 : 404}); attempts=${mode === "redirect403" ? 1 : 5}; hop=${redirected ? "redirect" : "initial"}; initial=eufy-eu /v1/image/[redacted].jpg segments=3 q=present${redirected ? "; redirect=object-store /[redacted]/[redacted].png segments=2 q=present" : ""}`);
        assert.doesNotMatch(error.message, /PRIVATE|token|signature|synthetic|amazonaws|eufylife/);
        return true;
      });
      assert.deepEqual(waits, mode === "redirect403" ? [] : [1000, 2000, 2000, 5000]);
      assert.equal(initialRequests, mode === "redirect403" ? 1 : 5);
      client.cancelPendingRequests();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test("the snapshot warning carries safe failure details through the real provider", async context => {
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [
    { device_sn: "camera", device_model: "T8214", device_type: 94, category: "eufy_security" },
  ] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
  const message = "Mega media download failed (HTTP 404); attempts=5; hop=initial; initial=" + mediaRequestDiagnostic(new URL(initialUrl));
  context.mock.method(MegaClient.prototype, "download", async () => { throw Error(message); });
  let deliver!: (event: MegaPushEvent) => void;
  context.mock.method(MegaPushReceiver.prototype, "start", async function(this: MegaPushReceiver) {
    deliver = Reflect.get(this, "onEvent") as typeof deliver;
  });
  const warnings: string[] = [];
  context.mock.method(process.stderr, "write", ((chunk: unknown) => { warnings.push(String(chunk)); return true; }) as typeof process.stderr.write);
  const events = new Proxy({}, { get: () => () => undefined }) as ProviderEvents;
  const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: "/nonexistent/fixture", maxStreamSeconds: 120 });
  try {
    await provider.start(events);
    const event = parsePushEvent({ device_sn: "camera", a: 3102, pic_url: initialUrl });
    assert.ok(event);
    deliver(event);
    for (let attempt = 0; attempt < 20 && !warnings.some(line => line.includes("push_snapshot_unavailable")); attempt++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const line = warnings.find(line => line.includes("push_snapshot_unavailable"));
    assert.ok(line);
    assert.ok(line.includes(`Eufy push snapshot unavailable: ${message}`));
    assert.doesNotMatch(line, /PRIVATE|token|eufylife/);
    assert.equal(network.mock.callCount(), 0);
  } finally { await provider.close(); }
});
