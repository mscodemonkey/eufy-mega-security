/**
 * Exercises the owner parameter endpoint with synthetic encrypted HTTPS.
 * Each test owns a saved session and server keys. No real account is used, and
 * only the exact read and an optional missing-key exchange may be dispatched.
 */
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MegaClient } from "../src/mega/client.js";
import { credentialVerifier, decryptEnvelope, encryptEnvelope, sharedAesKey, MEGA_PRESET_KEY } from "../src/mega/crypto.js";
import { ParameterCheckError } from "../src/provider/reported-parameter-check.js";

for (const mode of ["cached", "absent", "owner", "identity-error", "other-error", "cancelled", "late", "expired", "malformed"] as const) {
  test(`parameter HTTPS never logs in or replays: ${mode}`, async context => {
    context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
    const directory = await mkdtemp(join(tmpdir(), "parameter-mega-"));
    let key = "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100", reads = 0, exchanges = 0;
    let clock = 1_700_000_000_000;
    const controller = new AbortController();
    try {
      await writeFile(join(directory, "mega-session.json"), JSON.stringify({ version: 2, country: "au", openUdid: "fixture",
        credentialVerifier: credentialVerifier("fixture", "user@example.invalid", "synthetic"), authToken: "retained", tokenExpiresAt: 2_000_000_000,
        userId: "owner", megaDomain: "mega-us-pr.eufy.com", domains: {},
        identities: mode === "absent" ? {} : { "app-openapi-us-pr.eufy.com": { keyIdent: "cached", sharedKey: key, clientPublicKey: "public" } } }));
      const client = new MegaClient({ email: "user@example.invalid", password: "synthetic", country: "AU", persistentDirectory: directory,
        now: () => clock, minimumRequestIntervalMs: 0, fetch: async (input, init) => {
          const url = new URL(String(input));
          const headers = new Headers(init?.headers);
          assert.equal(headers.get("x-auth-token"), "retained");
          assert.equal(headers.get("app-tab"), null);
          if (url.pathname === "/openapi/oauth/key/exchange") {
            assert.equal(mode, "absent"); exchanges++;
            const point = decryptEnvelope(JSON.parse(String(init?.body)).client_public_key, Buffer.from(MEGA_PRESET_KEY, "hex"));
            const server = createECDH("prime256v1"); server.generateKeys();
            key = server.computeSecret(Buffer.from(point, "hex")).toString("hex");
            return new Response(JSON.stringify({ code: 0, data: { server_public_key: encryptEnvelope(server.getPublicKey("hex"), Buffer.from(MEGA_PRESET_KEY, "hex")) } }));
          }
          assert.equal(url.host, "app-devicemanage-us-pr.eufy.com");
          assert.equal(url.pathname, "/app/devicemanage/get_device_param_list");
          assert.deepEqual(JSON.parse(decryptEnvelope(String(init?.body), sharedAesKey(key))), { device_sns: ["target"] });
          reads++;
          if (mode === "cancelled" || mode === "late") controller.abort();
          if (mode === "late") await new Promise(resolve => setImmediate(resolve));
          if (mode === "expired") clock = 2_000_000_000_000;
          const code = mode === "owner" ? 20004 : mode === "identity-error" ? 4404 : mode === "other-error" ? 10019 : 0;
          return new Response(JSON.stringify({ code, msg: "SENTINEL_PRIVATE", data: encryptEnvelope(JSON.stringify(mode === "malformed" ? {} : {
            params: [{ param_type: 1035, param_value: "1", update_time: "SENTINEL_PRIVATE" }], private: "SENTINEL_PRIVATE",
          }), sharedAesKey(key)) }));
        } });
      await assert.rejects(client.readReportedParameters("target", "T8410", controller.signal), /unauthorized/);
      assert.equal(reads, 0);
      await client.connect();
      const operation = client.readReportedParameters("target", "T8410", controller.signal);
      if (["cached", "absent"].includes(mode)) assert.deepEqual((await operation).observations, { 1035: "one", 2001: "missing" });
      else {
        const stage = mode === "owner" ? "owner_account_required" : ["cancelled", "late"].includes(mode) ? "cancelled"
          : mode === "expired" ? "binding_changed" : mode === "malformed" ? "invalid_response" : "request";
        await assert.rejects(operation, error => error instanceof ParameterCheckError && error.stage === stage && !error.message.includes("SENTINEL"));
      }
      assert.equal(reads, 1); assert.equal(exchanges, mode === "absent" ? 1 : 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
