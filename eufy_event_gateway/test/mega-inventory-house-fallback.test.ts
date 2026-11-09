/**
 * Exercises complete account inventory recovery through synthetic encrypted HTTP.
 * Tests own saved authentication, response pages and cancellation. No real Eufy
 * session, login, setting command or device connection is used.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MegaClient } from "../src/mega/client.js";
import { credentialVerifier, decryptEnvelope, encryptEnvelope, sharedAesKey } from "../src/mega/crypto.js";

for (const mode of ["normal", "recover", "root-failure", "startup-partial", "permission", "network", "page", "house-failure", "page-failure", "house-id", "house-limit", "conflict", "cancelled", "binding", "device"] as const) {
  test(`inventory house recovery: ${mode}`, async context => {
    context.mock.method(globalThis, "fetch", async () => { throw Error("Unowned network forbidden"); });
    const directory = await mkdtemp(join(tmpdir(), "inventory-houses-"));
    const key = "00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100";
    const controller = new AbortController();
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    let now = 1_700_000_000_000;
    const a = { device_sn: "synthetic-a", device_model: "T8171", device_type: 88, parent_sn: "synthetic-a", device_channel: 0,
      category: "eufy_security", member: { admin_user_id: "synthetic-owner" }, params: [] };
    try {
      await writeFile(join(directory, "mega-session.json"), JSON.stringify({ version: 2, country: "au", openUdid: "fixture",
        credentialVerifier: credentialVerifier("fixture", "user@example.invalid", "synthetic"), authToken: "retained", tokenExpiresAt: 2_000_000_000,
        userId: "owner", megaDomain: "mega-us-pr.eufy.com", domains: {},
        identities: { "app-openapi-us-pr.eufy.com": { keyIdent: "cached", sharedKey: key, clientPublicKey: "public" } } }));
      const client = new MegaClient({ email: "user@example.invalid", password: "synthetic", country: "AU", persistentDirectory: directory,
        now: () => now, minimumRequestIntervalMs: 0, fetch: async (input, init) => {
          const url = new URL(String(input));
          assert.equal(url.host, "app-house-us-pr.eufy.com");
          assert.equal(new Headers(init?.headers).get("x-auth-token"), "retained");
          assert.ok(["/app/house/get_devs_list", "/app/house/get_house_list"].includes(url.pathname), "no login or other effect is permitted");
          const body = JSON.parse(decryptEnvelope(String(init?.body), sharedAesKey(key)));
          calls.push({ path: url.pathname, body });
          let code = 0, data: unknown;
          if (calls.length === 1) {
            assert.deepEqual(body, { house_id: "", device_sns: {} });
            if (mode === "network") throw Error("synthetic network refusal");
            code = mode === "normal" ? 0 : mode === "permission" ? 20004 : -1;
            data = { devices: [a] };
          } else if (url.pathname.endsWith("get_house_list")) {
            assert.deepEqual(body, {});
            if (mode === "cancelled") controller.abort();
            if (mode === "binding") now = 2_000_000_000_000;
            code = mode === "house-failure" ? -1 : 0;
            data = { house_infos: mode === "house-limit" ? Array.from({ length: 17 }, (_, i) => ({ house_id: String(i) }))
              : mode === "house-id" ? [{ house_id: "" }] : [{ house_id: "house-one" }, { house_id: "house-two" }] };
          } else if (!Object.hasOwn(body, "house_id")) {
            assert.deepEqual(body, {});
            if (["root-failure", "startup-partial"].includes(mode)) code = -1;
            data = mode === "page" ? {} : { devices: [mode === "device" ? { invalid: "private" } : a] };
          } else if (body.house_id === "house-one") {
            data = { devices: [{ ...a, member: { admin_user_id: mode === "conflict" ? "changed-owner" : "synthetic-owner" } }, { ...a, device_sn: "synthetic-b", parent_sn: "synthetic-b" }] };
          } else {
            assert.equal(body.house_id, "house-two");
            if (mode === "page-failure") code = -1;
            data = { devices: [{ ...a, device_sn: "synthetic-c", parent_sn: "synthetic-c" }] };
          }
          return new Response(JSON.stringify({ code, msg: "PRIVATE_RESPONSE", data: encryptEnvelope(JSON.stringify(data), sharedAesKey(key)) }));
        } });
      await client.connect();
      assert.equal(client.isInventoryTemporarilyUnavailable(new Error("Inventory is temporarily unavailable")), false);
      const result = client.inventory(controller.signal, { includeChargingDays: false, allowPartial: mode === "startup-partial" });
      if (["normal", "recover", "startup-partial"].includes(mode)) {
        const inventory = await result;
        assert.equal(inventory.devices.length, mode === "normal" ? 1 : 3);
        assert.equal(calls.length, mode === "normal" ? 1 : 5);
        assert.equal(inventory.complete, mode === "startup-partial" ? false : undefined);
      } else {
        await assert.rejects(result, error => {
          assert.equal(client.isInventoryTemporarilyUnavailable(error), ["root-failure", "house-failure", "page-failure"].includes(mode));
          return true;
        });
        if (["permission", "network"].includes(mode)) assert.equal(calls.length, 1, "other failures must not broaden reads");
        if (["page", "device"].includes(mode)) assert.equal(calls.length, 2);
        if (["house-failure", "house-id", "house-limit", "cancelled", "binding"].includes(mode)) assert.equal(calls.length, 3);
        if (mode === "conflict") assert.equal(calls.length, 4);
        if (["page-failure", "root-failure"].includes(mode)) assert.equal(calls.length, 5);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
