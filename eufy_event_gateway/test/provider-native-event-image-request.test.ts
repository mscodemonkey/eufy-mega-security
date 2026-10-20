/**
 * Exercises the exact-model native-picture gate through synthetic pushes. Tests
 * own authentication, fetches and event callbacks, with no external account.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver, parsePushEvent, type MegaPushEvent } from "../src/mega/push.js";

for (const mode of ["selected", "off", "model", "type", "category", "unauthenticated", "failure", "decode", "downstream", "stale", "v8-bound"]) {
  test(`event-picture request ${mode} selects only the reviewed job and marks only download failures`, async context => {
    context.mock.method(globalThis, "fetch", async () => { assert.fail("Network forbidden"); });
    context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
    context.mock.getter(MegaClient.prototype, "isAuthenticated", () => mode !== "unauthenticated");
    const serial = "SYNTHETIC0000001";
    context.mock.method(MegaClient.prototype, "inventory", async () => ({ devices: [{ device_sn: serial,
      device_model: mode === "model" ? "T8171" : "T8172", device_type: mode === "type" ? 98 : 89,
      category: mode === "category" ? "eufy_care" : "eufy_security", member: { admin_user_id: "fixture-owner" } }] }));
    context.mock.method(MegaClient.prototype, "dskKeys", async () => ({}));
    let deliver!: (event: MegaPushEvent) => void;
    context.mock.method(MegaPushReceiver.prototype, "start", async function(this: MegaPushReceiver) { deliver = Reflect.get(this, "onEvent") as typeof deliver; });
    let calls = 0, normal = 0, keys = 0, published = 0;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const jpeg = Buffer.from([255,216,1,2,255,217]); let retained: Buffer = Buffer.from("last-good");
    context.mock.method(MegaClient.prototype, "download", async function(this: MegaClient) { assert.ok(this instanceof MegaClient); normal++; return jpeg; });
    context.mock.method(MegaClient.prototype, "downloadNativeEventImage", async function(this: MegaClient) {
      assert.ok(this instanceof MegaClient); calls++; entered();
      if(mode === "stale") await gate;
      if(mode === "failure") throw Error("synthetic HTTP 404");
      if(mode === "decode") return Buffer.from("invalid-image");
      if(mode === "v8-bound") {
        const body = Buffer.alloc(192); Buffer.from(`v8_eufysecurity:${serial}:`).copy(body); body[33] = 10; body[34] = 2; return body;
      }
      return Buffer.from(jpeg);
    });
    context.mock.method(MegaClient.prototype, "getEventImageKey", async function(this: MegaClient, id: number, owner: string) {

      // A real instance's private request state is touched to detect an unbound facade receiver.
      this.cancelPendingRequests(); assert.equal(id, 10); assert.equal(owner, "fixture-owner"); keys++; return Buffer.alloc(32, 1);
    });
    const logs: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout), stderr = process.stderr.write.bind(process.stderr);
    context.mock.method(process.stdout, "write", (v: string | Uint8Array) => {
      if(String(v).includes("component=")) { logs.push(String(v)); return true; }
      return stdout(v);
    });
    context.mock.method(process.stderr, "write", (v: string | Uint8Array) => {
      if(String(v).includes("component=")) { logs.push(String(v)); return true; }
      return stderr(v);
    });
    const events = new Proxy({ snapshot: (_serial: string, data: Buffer) => {
      if(mode === "downstream") throw Error("synthetic downstream failure"); retained = data; published++;
    } }, { get: (target, key) => Reflect.get(target, key) ?? (() => undefined) }) as unknown as ProviderEvents;
    const provider = new EufyProvider({ username: "fixture", password: "redacted", country: "AU", persistentDirectory: "/nonexistent/synthetic",
      maxStreamSeconds: 120, experimentalEventImageRequest: mode !== "off" });
    try {
      await provider.start(events);
      deliver(parsePushEvent({ device_sn: serial, station_sn: serial, pic_url: "https://example.invalid/private", a: 1, unique_id: "fixture-event" })!);
      if(mode === "stale") { await started; const closing = provider.close(); release(); await closing; }
      for(let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
      const selected = !["off", "model", "type", "category", "unauthenticated"].includes(mode);
      assert.equal(calls, selected ? 1 : 0);
      if(mode !== "category" && !selected) assert.equal(normal, 1);
      const failures = logs.filter(line => line.includes("event=push_snapshot_unavailable"));
      if(["failure", "decode", "v8-bound"].includes(mode)) assert.ok(failures.some(line => line.includes("request_style=native")));
      if(mode === "downstream") assert.ok(failures.length > 0 && failures.every(line => !line.includes("request_style=native")));
      assert.equal(keys, mode === "v8-bound" ? 1 : 0);
      if(["failure", "decode", "downstream", "stale", "v8-bound"].includes(mode)) { assert.equal(published, 0); assert.deepEqual(retained, Buffer.from("last-good")); }
      const success = logs.filter(line => line.includes("event=push_snapshot_retained"));
      assert.equal(success.length, mode === "selected" ? 1 : 0);
      assert.equal(success.some(line => /SYNTHETIC|fixture-owner|https:/.test(line)), false);
    } finally { release(); await provider.close(); }
  });
}
