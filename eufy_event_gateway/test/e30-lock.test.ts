/**
 * Verifies E30 framing, private identity admission and bounded transport races.
 * Synthetic OpenSSL vectors independently anchor the cipher. Fake MQTT clients
 * and loopback-only TLS handshakes cannot contact or actuate hardware.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { inspect } from "node:util";
import { createCipheriv, createDecipheriv } from "node:crypto";
import type { MqttClient, IClientOptions } from "mqtt";
import { buildE30Command, decodeE30QueryReply, decodeE30SettingsReply, E30SettingsObservation, E30LockError, parseE30MqttCredentials,
  validateE30Identity, type E30Command, type E30LockIdentity } from "../src/provider/e30-lock-protocol.js";
import { e30MqttClientId } from "../src/provider/e30-lock-protocol.js";
import { buildE30NotificationCommand, parseE30NotificationMode, e30MqttEnvelope, type E30NotificationSetting } from "../src/provider/e30-lock-protocol.js";
import { e30BrokerTlsOptions, E30MqttSession, e30SubscriptionOutcome, isPublicE30BrokerAddress } from "../src/provider/e30-lock-mqtt.js";
import { E30LockProvider, e30InventoryIdentity } from "../src/provider/e30-lock-provider.js";
import { loadConfig } from "../src/config.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import { GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { CameraProvider } from "../src/provider/provider.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";
import { execFileSync } from "node:child_process";
import { connect as tlsConnect, createServer as tlsServer } from "node:tls";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const identity: E30LockIdentity = { serial: "T85F100000000001", name: "Synthetic lock",
  adminUserId: "abcdefghijkl", userName: "Tester", shortUserId: "0001", administrator: true };
const credentials = { host: "security-mqtt-us.anker.com", certificate: "synthetic", privateKey: "synthetic",
  userId: "synthetic", clientId: "synthetic-client" };
const queryHex = "ff093a0003000240223c9bce64e610b26e7ab8f8d8f79974eee909ed04eb4ce471491200b3b745b66d7b4c0729cd9f792b3806e7e2cec950f6e7";
const replyHex = "ff092a00030002482219329f72ad928e1d39ca0be6185b573538535f71c3117458c95b53b3c6e23e5968";

function reply(query: E30Command, hex = replyHex, overrides: Record<string, unknown> = {}): Buffer {
  const inner = { cmd: 1940, payload: { dev_sn: identity.serial, time: query.keyTime.toString(16).padStart(8, "0"),
    seq_num: query.sequence, lock_payload: hex, ...overrides } };
  return Buffer.from(JSON.stringify({ payload: JSON.stringify({ trans: Buffer.from(JSON.stringify(inner)).toString("base64") }) }));
}

function keys(time: number): { key: Buffer; iv: Buffer } {
  const stamp = Buffer.alloc(4); stamp.writeUInt32BE(time);
  return { key: Buffer.concat([Buffer.from(identity.adminUserId), stamp]), iv: Buffer.from(identity.serial) };
}

function stateReply(query: E30Command, state = 2, battery = 100): Buffer {
  const plain = Buffer.alloc(16); plain.set([0, 0xa1, 1, battery, 0xa2, 1, state]);
  const { key, iv } = keys(query.keyTime);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const frame = Buffer.alloc(10 + ct.length);
  frame.set([0xff, 9]); frame.writeUInt16LE(frame.length, 2); frame.set([3, 0, 2, 0x48, 0x22], 4); ct.copy(frame, 9);
  frame[frame.length - 1] = frame.subarray(0, -1).reduce((a, b) => a ^ b, 0);
  return reply(query, frame.toString("hex"));
}

test("E30 query matches an independent OpenSSL AES-CBC vector", () => {
  const query = buildE30Command(identity, "query", 1_700_000_000, 1_700_000_033, 7);
  assert.equal((query.transfer.payload as Record<string, unknown>).lock_payload, queryHex);
  assert.deepEqual(decodeE30QueryReply(reply(query), identity, query), { rawState: 2, batteryPercent: 100 });
  for (const overrides of [{ time: "00000000" }, { time: "not-hex" }, { time: -1 },
    { dev_sn: "other-device" }, { seq_num: 8 }, { lock_payload: replyHex.slice(2) }]) {
    assert.equal(decodeE30QueryReply(reply(query, replyHex, overrides), identity, query), null);
  }
  assert.equal(decodeE30QueryReply(Buffer.alloc(65_537), identity, query), null);
});

test("E30 actuation has fixed version three and wire lock zero/unlock one", () => {
  for (const desired of [true, false]) {
    const command = buildE30Command(identity, desired, 1_700_000_000, 1_700_000_033, 7);
    const hex = (command.transfer.payload as Record<string, unknown>).lock_payload as string;
    const frame = Buffer.from(hex, "hex");
    assert.deepEqual([...frame.subarray(4, 9)], [3, 0, 2, 0x40, 0x23]);
    const { key, iv } = keys(command.keyTime); const decipher = createDecipheriv("aes-128-cbc", key, iv);
    const plain = Buffer.concat([decipher.update(frame.subarray(9, -1)), decipher.final()]);
    assert.equal(plain[22], desired ? 0 : 1);
    assert.equal(decodeE30QueryReply(reply(command), identity, command), null);
  }
});

test("E30 rejects corrupt checksum, length, ciphertext padding and non-query frames", () => {
  const query = buildE30Command(identity, "query", 1_700_000_000, 1_700_000_033, 7);
  for (const position of [0, 2, 4, 6, 7, 8, 20, 40, 41]) {
    const frame = Buffer.from(replyHex, "hex"); frame[position] = frame[position]! ^ 0x80;
    if (position !== 41) frame[41] = frame.subarray(0, -1).reduce((a, b) => a ^ b, 0);
    assert.equal(decodeE30QueryReply(reply(query, frame.toString("hex")), identity, query), null);
  }
  assert.deepEqual(decodeE30QueryReply(stateReply(query, 255, 255), identity, query), { rawState: 255, batteryPercent: null });
});

test("E30 identity, endpoint and opt-in validation fail closed", () => {
  assert.equal(e30MqttClientId("synthetic-user", "0123456789abcdef", 1_700_000_000),
    "android-eufy_security-synthetic-user-0123456789abcdef-1700000000");
  for (const serial of ["short", "unsafe/serial0000", "unsafe+serial0000", "unsafe#serial0000"]) {
    assert.throws(() => validateE30Identity({ ...identity, serial }), E30LockError);
  }
  assert.throws(() => validateE30Identity({ ...identity, adminUserId: "short" }), E30LockError);
  assert.throws(() => validateE30Identity({ ...identity, shortUserId: "odd" }), E30LockError);
  const readIdentity = { ...identity, shortUserId: "", userName: "" };
  assert.doesNotThrow(() => buildE30Command(readIdentity, "query", 1_700_000_000, 1_700_000_033, 7));
  assert.throws(() => buildE30Command(readIdentity, false, 1_700_000_000, 1_700_000_033, 7), E30LockError);
  for (const host of ["127.0.0.1", "attacker.invalid", "aiot-mqtt-us.anker.com.attacker.invalid", "mqtts://aiot-mqtt-us.anker.com"]) {
    assert.throws(() => parseE30MqttCredentials({ endpoint_addr: host }, "user", "install"), E30LockError);
  }
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.1.1", "192.168.1.1", "169.254.1.1", "224.0.0.1", "::1"]) assert.equal(isPublicE30BrokerAddress(address), false);
  assert.equal(isPublicE30BrokerAddress("8.8.8.8"), true);
  assert.equal(loadConfig({}).experimentalE30Locks, false);
  assert.throws(() => loadConfig({ EUFY_GATEWAY_EXPERIMENTAL_E30_LOCKS: "true" }), /require/);
  assert.throws(() => loadConfig({ EUFY_GATEWAY_EXPERIMENTAL_E30_LOCKS: "yes" }), /true or false/);
});

class FakeMqtt extends EventEmitter {
  connected = false;
  closed = false;
  publishes = 0;
  refused = false;
  wrongMessages = false;
  volume = 2;
  autoLock = false;
  autoDelay = 90;
  autoStart = [255, 255];
  autoEnd = [255, 255];
  publishError = false;
  notificationFailure: "error" | "timeout" | "abort" | null = null;
  notificationDispatched?: () => void;
  commands: E30Command[] = [];
  previousReply?: Buffer;
  grantOverride?: unknown;
  subscribeError: Error | null = null;
  hangSubscribe = false;
  grantedQos = 0;
  stream = { destroy: (): void => { this.connected = false; } };
  subscribe(topic: string, options: { qos: number }, callback: (error: Error | null, grants: unknown) => void): void {
    assert.equal(options.qos, 1);
    assert.equal(topic, `cmd/eufy_security/T85F1/${identity.serial}/res`);
    if (this.hangSubscribe) return;
    callback(this.subscribeError, this.grantOverride ?? [{ topic, qos: this.refused ? 128 : this.grantedQos }]);
  }
  publish(topic: string, body: string, options: { qos: number; retain: boolean; dup: boolean }, callback: (error?: Error) => void): void {
    this.publishes++;
    assert.deepEqual(options, { qos: 1, retain: false, dup: false });
    const outer = JSON.parse(body); const payload = JSON.parse(outer.payload);
    const trans = JSON.parse(Buffer.from(payload.trans, "base64").toString());
    if (trans.cmd === 1919) {
      this.commands.push({ transfer: trans, keyTime: 0, sequence: outer.head.msg_seq, opcode: 1919 });
      this.notificationDispatched?.();
      if (this.notificationFailure === "timeout" || this.notificationFailure === "abort") return;
      callback(this.notificationFailure === "error" ? new Error("synthetic") : undefined);
      return;
    }
    const command: E30Command = { transfer: trans, keyTime: trans.payload.time, sequence: trans.payload.seq_num, opcode: (trans.payload.apiCommand === 6016 ? 53 : trans.payload.apiCommand === 6015 ? 52 : 34) };
    this.commands.push(command);
    if (this.publishError && command.opcode === 52) { callback(new Error("synthetic failure")); return; }
    if (command.opcode === 52) {
      const written = commandPlainFields(command);
      if (written.get(0xa3)?.[0] === 0) {
        this.autoLock = written.get(0xa4)?.[0] === 1;
        this.autoDelay = written.get(0xa5)!.readUInt16LE();
        this.autoStart = [...written.get(0xa7)!]; this.autoEnd = [...written.get(0xa8)!];
      }
      callback(); return;
    }
    const bytes = command.opcode === 53 ? settingsReply(command, autoSettingsPlain(this.autoLock, this.autoDelay, this.volume, 0, this.autoStart, this.autoEnd)) : stateReply(command);
    callback();
    this.emit("message", topic.replace(/req$/, "res"), bytes, { retain: true });
    this.emit("message", topic.replace(/req$/, "res"), bytes, { dup: true });
    this.emit("message", "unrelated/res", bytes, {});
    if (this.previousReply) this.emit("message", topic.replace(/req$/, "res"), this.previousReply, {});
    if (!this.wrongMessages) this.emit("message", topic.replace(/req$/, "res"), bytes, {});
    this.previousReply = bytes;
  }
  end(): void { this.closed = true; this.connected = false; this.emit("close"); }
}

test("E30 subscribes first, ignores retained/duplicate/foreign replies and destroys its clean client", async () => {
  const fake = new FakeMqtt(); const controller = new AbortController();
  let options: IClientOptions | undefined;
  const session = new E30MqttSession(identity, credentials, controller.signal, {
    resolve: async () => ["8.8.8.8"], connect: value => {
      options = value; queueMicrotask(() => { fake.connected = true; fake.emit("connect"); }); return fake as unknown as MqttClient;
    },
  });
  try {
    await session.open();
    assert.deepEqual(await session.query(), { rawState: 2, batteryPercent: 100 });
    assert.equal(fake.publishes, 1);
    assert.equal(options?.rejectUnauthorized, true);
    assert.equal(options?.servername, credentials.host);
    assert.equal(options?.ca, undefined);
    assert.equal(typeof (options as IClientOptions & { checkServerIdentity?: unknown }).checkServerIdentity, "function");
    assert.equal(options?.reconnectPeriod, 0);
    assert.equal(options?.clean, true);
    assert.equal(options?.resubscribe, false);
    controller.abort();
    await assert.rejects(session.query(), E30LockError);
    assert.equal(fake.publishes, 1);
  } finally { session.close(); }
  assert.equal(fake.closed, true);
  assert.equal(fake.listenerCount("message"), 0);
});

test("E30 grant matrix permits only exact-topic numeric QoS0 or QoS1", async () => {
  const topic = `cmd/eufy_security/T85F1/${identity.serial}/res`;
  for (const qos of [0, 1]) {
    const fake = new FakeMqtt(); fake.grantedQos = qos;
    const session = new E30MqttSession(identity, credentials, new AbortController().signal, {
      resolve: async () => ["8.8.8.8"], connect: () => {
        queueMicrotask(() => { fake.connected = true; fake.emit("connect"); }); return fake as unknown as MqttClient;
      },
    });
    try { await session.open(); assert.equal(fake.publishes, 0); await session.query(); assert.equal(fake.publishes, 1); }
    finally { session.close(); }
    assert.equal(fake.closed, true);
  }
  const invalid: [unknown, string][] = [
    [[{ topic, qos: 128 }], "refused_128"],
    ...[2, -1, NaN, undefined, 1.5, "1"].map(qos => [[{ topic, qos }], "qos_invalid"] as [unknown, string]),
    [[], "count_invalid"], [undefined, "count_invalid"],
    [[{ topic, qos: 1 }, { topic, qos: 1 }], "count_invalid"],
    [[{ topic: "other", qos: 1 }], "topic_mismatch"],
    [[{ qos: 1 }], "topic_mismatch"], [[{ topic: 1, qos: 1 }], "topic_mismatch"],
  ];
  for (const [grants, expected] of invalid) {
    assert.equal(e30SubscriptionOutcome(null, grants, topic), expected);
    const fake = new FakeMqtt(); fake.grantOverride = grants ?? [];
    const session = new E30MqttSession(identity, credentials, new AbortController().signal, {
      resolve: async () => ["8.8.8.8"], connect: () => {
        queueMicrotask(() => { fake.connected = true; fake.emit("connect"); }); return fake as unknown as MqttClient;
      },
    });
    try { await assert.rejects(session.open(), E30LockError); }
    finally { session.close(); }
    assert.equal(fake.publishes, 0); assert.equal(fake.closed, true); assert.equal(fake.connected, false);
  }
  assert.equal(e30SubscriptionOutcome(new Error("private vendor text"), [{ topic, qos: 1 }], topic), "error");
});

test("E30 subscribe cancellation and timeout publish nothing and close the socket", async () => {
  for (const abort of [true, false]) {
    const fake = new FakeMqtt(); fake.hangSubscribe = true;
    const controller = new AbortController();
    const session = new E30MqttSession(identity, credentials, controller.signal, {
      resolve: async () => ["8.8.8.8"], connect: () => {
        queueMicrotask(() => { fake.connected = true; fake.emit("connect"); if (abort) setImmediate(() => controller.abort()); });
        return fake as unknown as MqttClient;
      },
    });
    try { await assert.rejects(session.open(), E30LockError); }
    finally { session.close(); }
    assert.equal(fake.publishes, 0); assert.equal(fake.closed, true); assert.equal(fake.connected, false);
  }
});

test("E30 subscription refusal advances without publishing and callback errors fail closed", async () => {
  const first = new FakeMqtt(); first.refused = true;
  const second = new FakeMqtt(); second.grantedQos = 1;
  const clients = [first, second]; let connections = 0;
  const session = new E30MqttSession(identity, credentials, new AbortController().signal, {
    resolve: async () => ["8.8.8.8", "1.1.1.1"], connect: () => {
      const fake = clients[connections++]!;
      queueMicrotask(() => { fake.connected = true; fake.emit("connect"); }); return fake as unknown as MqttClient;
    },
  });
  try {
    await session.open(); assert.equal(first.closed, true); assert.equal(first.publishes, 0);
    await session.query(); assert.equal(second.publishes, 1);
  } finally { session.close(); }
  assert.equal(second.closed, true);
  const failed = new FakeMqtt(); failed.subscribeError = new Error("private vendor text");
  const denied = new E30MqttSession(identity, credentials, new AbortController().signal, {
    resolve: async () => ["8.8.8.8"], connect: () => {
      queueMicrotask(() => { failed.connected = true; failed.emit("connect"); }); return failed as unknown as MqttClient;
    },
  });
  try { await assert.rejects(denied.open(), E30LockError); } finally { denied.close(); }
  assert.equal(failed.closed, true); assert.equal(failed.publishes, 0);
});

test("E30 denied subscription publishes nothing and closes its socket", async () => {
  const fake = new FakeMqtt(); fake.refused = true;
  const session = new E30MqttSession(identity, credentials, new AbortController().signal, {
    resolve: async () => ["8.8.8.8"], connect: () => {
      queueMicrotask(() => { fake.connected = true; fake.emit("connect"); }); return fake as unknown as MqttClient;
    },
  });
  await assert.rejects(session.open(), E30LockError); session.close();
  assert.equal(fake.publishes, 0); assert.equal(fake.closed, true);
});

test("E30 unrecognised raw states stay unknown; cache GET and unavailable writes do not connect", async () => {
  const row = { device_model: "T85F1", device_type: 206, device_sn: identity.serial, parent_sn: identity.serial,
    member: { admin_user_id: identity.adminUserId, short_user_id: identity.shortUserId, nick_name: identity.userName, member_type: 1 } };
  assert.ok(e30InventoryIdentity(row));
  assert.equal(e30InventoryIdentity({ ...row, device_type: 203 }), null);
  assert.equal(e30InventoryIdentity({ ...row, parent_sn: "another-station" }), null);
  let queries = 0; let writes = 0; let socketsClosed = 0;
  const provider = new E30LockProvider({ credentials: async () => credentials, changed: () => {},
    session: () => ({ open: async () => {}, query: async () => { queries++; return { rawState: 2, batteryPercent: 100 }; },
      actuate: async () => { writes++; }, close: () => { socketsClosed++; } }) });
  provider.inventory([row], true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queries, 1); assert.equal(provider.list()[0]?.state, "unknown");
  provider.list(); provider.list(); assert.equal(queries, 1);
  await assert.rejects(provider.setLocked(identity.serial, false), E30LockError);
  assert.equal(writes, 0);
  await assert.rejects(provider.refresh(identity.serial), (error: unknown) => error instanceof E30LockError && error.code === "rate_limited");
  provider.inventory([], false); assert.equal(provider.list().length, 1); assert.equal(provider.list()[0]?.available, false);
  provider.inventory([{ device_model: "other", device_sn: "synthetic-other" }]); assert.equal(provider.list().length, 0);
  provider.close(); assert.equal(socketsClosed, 2);
});

test("GatewayState expires and removes locks independently of other inventories", () => {
  const state = new GatewayState();
  state.replaceLocks([{ serial: identity.serial, name: "Synthetic", model: "T85F1", state: "locked",
    available: true, batteryPercent: 100, stateObservedAt: new Date(0).toISOString() }]);
  assert.equal(state.listLocks()[0]?.available, false); assert.equal(state.listLocks()[0]?.state, "unknown");
  assert.equal(state.hasLock(identity.serial), true);
  state.replaceLocks([]); assert.equal(state.hasLock(identity.serial), false);
});

function inventoryRow() {
  return { device_model: "T85F1", device_type: 206, device_sn: identity.serial, parent_sn: identity.serial,
    member: { admin_user_id: identity.adminUserId, short_user_id: identity.shortUserId, nick_name: identity.userName, member_type: 1 } };
}

test("E30 synthetic admitted state still requires a fresh prequery for no-op and rejects unknown prestate", async () => {
  let queries = 0; let writes = 0; let rawState = 2;
  const provider = new E30LockProvider({ credentials: async () => credentials, changed: () => {}, stateCodes: { locked: 2, unlocked: 1 },
    session: () => ({ open: async () => {}, query: async () => { queries++; return { rawState, batteryPercent: 100 }; },
      actuate: async () => { writes++; }, close: () => {} }) });
  try {
    provider.inventory([inventoryRow()], true); await new Promise(resolve => setImmediate(resolve));
    assert.equal(queries, 1);
    assert.equal((await provider.setLocked(identity.serial, true)).state, "locked");
    assert.equal(queries, 2); assert.equal(writes, 0);
    rawState = 255;
    await assert.rejects(provider.setLocked(identity.serial, false), (error: unknown) => error instanceof E30LockError && error.code === "unavailable");
    assert.equal(queries, 3); assert.equal(writes, 0); assert.equal(provider.list()[0]?.available, false);
  } finally { provider.close(); }
});

test("E30 post-dispatch failures invalidate state and never retry the actuation", async () => {
  let writes = 0;
  const provider = new E30LockProvider({ credentials: async () => credentials, changed: () => {}, stateCodes: { locked: 2, unlocked: 1 },
    session: () => ({ open: async () => {}, query: async () => ({ rawState: 2, batteryPercent: 100 }),
      actuate: async (_locked, dispatch) => { dispatch(); writes++; throw new Error("PRIVATE_VENDOR_ERROR"); }, close: () => {} }) });
  try {
    provider.inventory([inventoryRow()], true); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(provider.setLocked(identity.serial, false), (error: unknown) => error instanceof E30LockError && error.code === "outcome_unknown" && !error.message.includes("PRIVATE"));
    assert.equal(writes, 1); assert.equal(provider.list()[0]?.state, "unknown"); assert.equal(provider.list()[0]?.available, false);
    await assert.rejects(provider.setLocked(identity.serial, false), (error: unknown) => error instanceof E30LockError && error.code === "rate_limited");
    assert.equal(writes, 1);
  } finally { provider.close(); }
});

test("E30 cancellation before dispatch and concurrent calls cannot queue a late write", async () => {
  let release: ((value: typeof credentials) => void) | undefined;
  let credentialCalls = 0; let writes = 0;
  const provider = new E30LockProvider({ credentials: async () => ++credentialCalls === 1 ? credentials
    : new Promise(resolve => { release = resolve; }), changed: () => {}, stateCodes: { locked: 2, unlocked: 1 },
  session: () => ({ open: async () => {}, query: async () => ({ rawState: 2, batteryPercent: 100 }),
    actuate: async () => { writes++; }, close: () => {} }) });
  try {
    provider.inventory([inventoryRow()], true); await new Promise(resolve => setImmediate(resolve));
    const controller = new AbortController();
    const first = provider.setLocked(identity.serial, false, controller.signal);
    await assert.rejects(provider.setLocked(identity.serial, false), (error: unknown) => error instanceof E30LockError && error.code === "busy");
    controller.abort();
    await assert.rejects(first, E30LockError);
    release?.(credentials); await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes, 0);
  } finally { provider.close(); }
});

for (const enabled of [false, true]) {
  test(`E30 HTTP opt-in=${enabled}: authenticated cache reads and closed control bodies`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "e30-http-"));
    const state = new GatewayState();
    const lock = { serial: identity.serial, name: "Synthetic", model: "T85F1" as const,
      state: "unknown" as const, available: false, batteryPercent: null, stateObservedAt: null };
    state.replaceLocks([lock]);
    let operations = 0;
    const provider = { refreshLock: async () => { operations++; return lock; },
      setLockState: async () => { operations++; throw new Error("SENTINEL_PRIVATE_DETAIL"); } } as unknown as CameraProvider;
    const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "x".repeat(32), experimentalE30Locks: enabled },
      state, new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
    try {
      await server.listen();
      const base = `http://127.0.0.1:${server.port}/api/locks`;
      const headers = { authorization: `Bearer ${"x".repeat(32)}`, "content-type": "application/json" };
      assert.equal((await fetch(base)).status, 401);
      assert.deepEqual(await (await fetch(base, { headers })).json(), { locks: enabled ? [lock] : [] });
      assert.equal(operations, 0);
      const post = { method: "POST", headers, body: '{"locked":false}' };
      assert.equal((await fetch(`${base}/${identity.serial}/state`, { ...post, headers: {} })).status, 401);
      if (!enabled) {
        assert.equal((await fetch(`${base}/${identity.serial}/state`, post)).status, 409);
        assert.equal(operations, 0); return;
      }
      assert.equal((await fetch(`${base}/missing/state`, post)).status, 404);
      assert.equal((await fetch(`${base}/${identity.serial}/state`, { ...post, headers: { authorization: headers.authorization } })).status, 415);
      for (const body of [{ locked: "false" }, { locked: false, raw: "payload" }, {}, null, []]) {
        assert.equal((await fetch(`${base}/${identity.serial}/state`, { ...post, body: JSON.stringify(body) })).status, 400);
      }
      assert.equal(operations, 0);
      assert.equal((await fetch(`${base}/${identity.serial}/refresh`, { ...post, body: "{}" })).status, 200);
      const failed = await fetch(`${base}/${identity.serial}/state`, post);
      assert.equal(failed.status, 503);
      assert.doesNotMatch(await failed.text(), /SENTINEL/);
      assert.equal(state.listLocks()[0]?.state, "unknown");
    } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test("E30 rejects noncanonical and reserved DNS answers at subnet boundaries", () => {
  for (const address of ["08.8.8.8", "8.08.8.8", "256.1.1.1", "192.88.99.0", "192.88.99.255",
    "198.51.100.0", "198.51.100.255", "203.0.113.0", "203.0.113.255", "198.18.0.0", "198.19.255.255"]) {
    assert.equal(isPublicE30BrokerAddress(address), false, address);
  }
  for (const address of ["192.88.98.255", "192.88.100.0", "198.51.99.255", "198.51.101.0",
    "203.0.112.255", "203.0.114.0", "198.17.255.255", "198.20.0.0"]) {
    assert.equal(isPublicE30BrokerAddress(address), true, address);
  }
});

test("E30 credential admission and real TLS enforce hostname, dates, key and trust", async () => {
  const directory = await mkdtemp(join(tmpdir(), "e30-tls-"));
  await chmod(directory, 0o700);
  const openssl = (...args: string[]): void => { execFileSync("openssl", args, { cwd: directory, stdio: "pipe" }); };
  try {
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=E30 synthetic CA");
    openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=security-mqtt-us.anker.com");
    writeFileSync(join(directory, "extensions"), "subjectAltName=DNS:security-mqtt-us.anker.com\nextendedKeyUsage=serverAuth\n");
    writeFileSync(join(directory, "index"), ""); writeFileSync(join(directory, "serial"), "01\n");
    writeFileSync(join(directory, "ca.conf"), "[ca]\ndefault_ca=local\n[local]\ndatabase=index\nserial=serial\nnew_certs_dir=.\ncertificate=ca.pem\nprivate_key=ca.key\ndefault_md=sha256\npolicy=policy\n[policy]\ncommonName=supplied\n");
    openssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "1", "-extfile", "extensions");
    for (const [name, start, end] of [["expired", "20000101000000Z", "20010101000000Z"], ["future", "20990101000000Z", "21000101000000Z"]] as const) {
      openssl("ca", "-batch", "-config", "ca.conf", "-in", "leaf.csr", "-out", `${name}.pem`, "-startdate", start, "-enddate", end, "-notext");
      writeFileSync(join(directory, "index"), "");
    }
    const read = (name: string): string => readFileSync(join(directory, name), "utf8");
    const row = { endpoint_addr: credentials.host, certificate_pem: read("leaf.pem"), private_key: read("leaf.key"),
      user_id: "synthetic", app_name: "eufy_security" };
    const parse = (changes: Record<string, unknown> = {}) => parseE30MqttCredentials({ ...row, ...changes }, "synthetic", "0123456789abcdef");
    for (const endpoint_addr of [credentials.host, "aiot-mqtt-us.anker.com"]) {
      assert.equal(parse({ endpoint_addr }).host, credentials.host);
      assert.equal(parse({ endpoint_addr, endpoint_port: 8883 }).host, credentials.host);
    }
    for (const changes of [
      ...["aiot-mqtt-eu.anker.com", "security-mqtt-eu.anker.com", "aiot-mqtt-cn.anker.com", "SECURITY-mqtt-us.anker.com", `${credentials.host}.`, "127.0.0.1"].map(endpoint_addr => ({ endpoint_addr })),
      ...["8883", 443, null, 0].map(endpoint_port => ({ endpoint_port })),
      { user_id: "foreign" }, { app_name: "eufy_home" }, { certificate_pem: "invalid" }, { private_key: "invalid" },
      { certificate_pem: "x".repeat(32_769) }, { private_key: "x".repeat(32_769) }, { private_key: read("ca.key") },
      ...["expired", "future"].map(name => ({ certificate_pem: read(`${name}.pem`) })),
    ]) assert.throws(() => parse(changes), E30LockError);
    const options = e30BrokerTlsOptions(credentials.host);
    assert.equal(options.rejectUnauthorized, true); assert.equal(options.servername, credentials.host);
    assert.equal("ca" in options, false); assert.equal(typeof options.checkServerIdentity, "function");
    assert.throws(() => e30BrokerTlsOptions("aiot-mqtt-us.anker.com"), E30LockError);
    const handshake = async (cert: string, key: string, trusted: boolean): Promise<void> => {
      const server = tlsServer({ cert, key }, socket => socket.end());
      server.on("tlsClientError", () => {});
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address(); assert.ok(address && typeof address !== "string");
        await new Promise<void>((resolve, reject) => {

          // Only this local TLS harness supplies a test CA. Product options have no CA override.
          const socket = tlsConnect({ ...options, host: "127.0.0.1", port: address.port,
            ...(trusted ? { ca: read("ca.pem") } : {}) });
          socket.setTimeout(3_000, () => socket.destroy(new Error("synthetic TLS timeout")));
          socket.once("secureConnect", () => { socket.destroy(); resolve(); }); socket.once("error", reject);
        });
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    };
    await handshake(read("leaf.pem"), read("leaf.key"), true);
    await assert.rejects(handshake(read("leaf.pem"), read("leaf.key"), false));
    await assert.rejects(handshake(read("ca.pem"), read("ca.key"), true), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("E30 multiple exact-model locks block actuation", async () => {
  let writes = 0;
  const provider = new E30LockProvider({ credentials: async () => credentials, changed: () => {}, stateCodes: { locked: 4, unlocked: 3 },
    session: () => ({ open: async () => {}, query: async () => ({ rawState: 4, batteryPercent: 100 }),
      actuate: async () => { writes++; }, close: () => {} }) });
  try {
    provider.inventory([inventoryRow(), { ...inventoryRow(), device_sn: "T85F100000000002", parent_sn: "T85F100000000002" }], true);
    assert.equal(provider.list().length, 2);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(provider.setLocked(identity.serial, false), E30LockError);
    assert.equal(writes, 0);
  } finally { provider.close(); }
});

function settingsReply(query: E30Command, plaintext: Buffer, overrides: Record<string, unknown> = {}, opcode = 0x4835): Buffer {
  const aligned = Buffer.alloc(Math.ceil(plaintext.length / 16) * 16); plaintext.copy(aligned);
  const { key, iv } = keys(query.keyTime);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(aligned), cipher.final()]);
  const frame = Buffer.alloc(10 + encrypted.length);
  frame.set([0xff, 9]); frame.writeUInt16LE(frame.length, 2); frame.set([3, 0, 2], 4);
  frame.writeUInt16BE(opcode, 7); encrypted.copy(frame, 9);
  frame[frame.length - 1] = frame.subarray(0, -1).reduce((a, b) => a ^ b, 0);
  return reply(query, frame.toString("hex"), overrides);
}

test("E30 settings GET and volume-only SET have independent OpenSSL-anchored fields", () => {
  const readIdentity = { ...identity, userName: "", shortUserId: "" };
  for (const [action, opcode, api] of [["settings", 53, 6016], [{ soundVolume: 1 }, 52, 6015], [{ soundVolume: 2 }, 52, 6015], [{ soundVolume: 3 }, 52, 6015]] as const) {
    const command = buildE30Command(readIdentity, action, 1_700_000_000, 1_700_000_033, 7);
    const payload = command.transfer.payload as Record<string, unknown>;
    const frame = Buffer.from(payload.lock_payload as string, "hex");
    assert.deepEqual([...frame.subarray(4, 9)], [3, 0, 2, 0x40, opcode]); assert.equal(payload.apiCommand, api);
    const { key, iv } = keys(command.keyTime);
    const plain = execFileSync("openssl", ["enc", "-d", "-aes-128-cbc", "-K", key.toString("hex"), "-iv", iv.toString("hex")], { input: frame.subarray(9, -1) });
    const stamp = Buffer.alloc(4); stamp.writeUInt32LE(1_700_000_000);
    const expected = Buffer.concat([Buffer.from([0xa1, 4]), stamp, Buffer.from([0xa2, 12]), Buffer.from(identity.adminUserId), ...(opcode === 52 ? [Buffer.from([0xa3, 1, 4, 0xa4, 1, typeof action === "object" ? action.soundVolume : 0])] : [])]);
    assert.ok(plain.subarray(0, expected.length).equals(expected)); assert.ok(plain.subarray(expected.length).every(byte => byte === 0));
    const aligned = Buffer.alloc(Math.ceil(expected.length / 16) * 16); expected.copy(aligned);
    assert.ok(frame.subarray(9, -1).equals(execFileSync("openssl", ["enc", "-aes-128-cbc", "-K", key.toString("hex"), "-iv", iv.toString("hex")], { input: aligned })));
  }
  for (const volume of [0, 4, -1, 1.5, "2", NaN, undefined]) assert.throws(() => buildE30Command(identity, { soundVolume: volume } as never, 1, 2, 3), E30LockError);
});

test("E30 settings replies require exact correlation and keep unrelated values private", () => {
  const query = buildE30Command(identity, "settings", 1_700_000_000, 1_700_000_033, 7);
  const decode = (plain: Buffer, overrides: Record<string, unknown> = {}, opcode = 0x4835) => decodeE30SettingsReply(settingsReply(query, plain, overrides, opcode), identity, query);
  for (const volume of [0, 1, 2, 3]) assert.equal(decode(Buffer.from([0, 0xab, 1, volume]))?.volume, volume);
  for (const plain of [[0], [0, 0xab, 2, 1, 2], [0, 0xab, 1, 4], [0, 0xab, 1, 255], [0, 0xab, 1, 2, 0xab, 1, 2], [0, 0xa0, 1, 2], [0, 0xab, 0], [0, 0xab, 255, 2], [1, 0xab, 1, 2], [0, 0xab, 1, 2, 0, 0, 1]]) assert.equal(decode(Buffer.from(plain)), null);
  const valid = Buffer.from([0, 0xab, 1, 2]);
  for (const overrides of [{ time: 0 }, { dev_sn: "foreign" }, { seq_num: 8 }, { seq_num: null }, { seq_num: "7" }, { dev_sn: undefined }, { time: undefined }, { time: "123" }]) assert.equal(decode(valid, overrides), null);
  assert.equal(decode(valid, { seq_num: undefined })?.volume, 2);
  assert.equal(decode(valid, {}, 0x4822), null);
  const status = buildE30Command(identity, "query", 1_700_000_000, 1_700_000_033, 7);
  assert.equal(decodeE30QueryReply(settingsReply(status, valid), identity, status), null);
  for (const action of [true, { soundVolume: 1 }] as const) {
    const write = buildE30Command(identity, action, 1_700_000_000, 1_700_000_033, 7);
    assert.equal(decodeE30SettingsReply(settingsReply(write, valid), identity, write), null);
  }
  const other = Buffer.from("UNRELATED_PRIVATE_SETTINGS");
  const baseline = decode(Buffer.concat([valid, Buffer.from([0xac, other.length]), other]))!;
  const next = decode(Buffer.concat([Buffer.from([0, 0xab, 1, 1]), Buffer.from([0xac, other.length]), other]))!;
  assert.deepEqual(baseline.compareStableFields(baseline, next), { unchanged: true, comparedFields: 1 });
  assert.equal(baseline.compareStableFields(baseline, decode(valid)!).unchanged, false);
  assert.ok(!JSON.stringify(baseline).includes(other.toString())); assert.ok(!inspect(baseline).includes(other.toString()));
  assert.equal(decode(Buffer.concat([valid, Buffer.from([0xac, 255]), Buffer.alloc(255, 1)]))?.volume, 2);
});

test("E30 settings transport shares correlation, rejects ungranted writes and never retries", async () => {
  const fake = new FakeMqtt();
  const session = new E30MqttSession(identity, credentials, new AbortController().signal, { resolve: async () => ["8.8.8.8"], connect: () => { queueMicrotask(() => { fake.connected = true; fake.emit("connect"); }); return fake as unknown as MqttClient; } });
  let dispatches = 0;
  const dispatch = (): void => { assert.equal(fake.publishes, 2); dispatches++; };
  try {
    await assert.rejects(session.setSoundVolume(1, dispatch), E30LockError); await session.open();
    assert.equal((await session.querySettings()).volume, 2); assert.equal(fake.listenerCount("message"), 0); await session.query();
    for (const invalid of [0, 4, NaN, "2", undefined]) await assert.rejects(session.setSoundVolume(invalid as never, dispatch), E30LockError);
    assert.equal(dispatches, 0); assert.equal(fake.publishes, 2);
    await session.setSoundVolume(1, dispatch); assert.equal(dispatches, 1); assert.equal(fake.publishes, 3);
    assert.equal(new Set(fake.commands.map(command => command.keyTime)).size, 3);
    assert.ok(fake.commands.every((command, index) => !index || command.keyTime > fake.commands[index - 1]!.keyTime));
    assert.ok(fake.commands.every((command, index) => !index || command.sequence > fake.commands[index - 1]!.sequence));
    fake.publishError = true;
    await assert.rejects(session.setSoundVolume(2, () => { dispatches++; }), (error: unknown) => error instanceof E30LockError && error.code === "outcome_unknown");
    assert.equal(fake.publishes, 4); assert.equal(dispatches, 2);
  } finally { session.close(); }
});


test("E30 settings comparison rejects vacuous, appearing, vanishing and changed fields", () => {
  const query = buildE30Command(identity, "settings", 1_700_000_000, 1_700_000_033, 7);
  const snapshot = (...tags: number[]) => decodeE30SettingsReply(settingsReply(query, Buffer.from([0, 0xab, 1, 2, ...tags])), identity, query)!;
  const none = snapshot(); const a = snapshot(0xac, 1, 1); const b = snapshot(0xac, 1, 2);
  assert.deepEqual(none.compareStableFields(none, none), { unchanged: false, comparedFields: 0 });
  assert.equal(a.compareStableFields(b, a).unchanged, false);
  assert.equal(a.compareStableFields(a, b).unchanged, false);
  assert.equal(a.compareStableFields(a, none).unchanged, false);
  assert.equal(a.compareStableFields(a, snapshot(0xac, 1, 1, 0xad, 1, 1)).unchanged, false);
});

test("E30 status regression retains optional reply identity and sequence", () => {
  const query = buildE30Command(identity, "query", 1_700_000_000, 1_700_000_033, 7);
  assert.ok(decodeE30QueryReply(reply(query, replyHex, {dev_sn: undefined, seq_num: undefined}), identity, query));
  assert.equal(decodeE30QueryReply(reply(query, replyHex, {dev_sn: "foreign"}), identity, query), null);
  assert.equal(decodeE30QueryReply(reply(query, replyHex, {seq_num: 8}), identity, query), null);
});


test("E30 settings reject damaged framing and padding", () => {
  const query = buildE30Command(identity, "settings", 1_700_000_000, 1_700_000_033, 7);
  const outer = JSON.parse(settingsReply(query, Buffer.from([0, 0xab, 1, 2])).toString());
  const inner = JSON.parse(Buffer.from(JSON.parse(outer.payload).trans, "base64").toString());
  const original = Buffer.from(inner.payload.lock_payload, "hex");
  for (const position of [0, 2, 7, 20, original.length - 2, original.length - 1]) {
    const frame = Buffer.from(original); frame[position] = frame[position]! ^ 0x80;
    if (position !== frame.length - 1) frame[frame.length - 1] = frame.subarray(0, -1).reduce((a, b) => a ^ b, 0);
    assert.equal(decodeE30SettingsReply(reply(query, frame.toString("hex")), identity, query), null);
  }
});

test("E30 settings discard late replies and reject overlapping reads", async () => {
  const fake = new FakeMqtt(); const controller = new AbortController();
  const session = new E30MqttSession(identity, credentials, controller.signal, {resolve:async()=>["8.8.8.8"],connect:()=>{queueMicrotask(()=>{fake.connected=true;fake.emit("connect");});return fake as unknown as MqttClient;}});
  try {
    await session.open(); assert.equal((await session.querySettings()).volume,2);
    fake.volume=3; assert.equal((await session.querySettings()).volume,3);
    fake.wrongMessages=true;
    const pending=session.querySettings(); void pending.catch(()=>undefined);
    await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(session.querySettings(),(error:unknown)=>error instanceof E30LockError && error.code==="busy");
    controller.abort(); await assert.rejects(pending,E30LockError);
    assert.equal(fake.listenerCount("message"),0);
  } finally {session.close();}
});


function autoSettingsPlain(enabled = false, delay = 90, volume = 2, schedule = 0, start = [255, 255], end = [255, 255]): Buffer {
  const timer = Buffer.alloc(2); timer.writeUInt16LE(delay);
  return Buffer.concat([Buffer.from([0, 0xa1, 1, enabled ? 1 : 0, 0xa2, 2]), timer,
    Buffer.from([0xa3, 1, schedule, 0xa4, start.length, ...start, 0xa5, end.length, ...end, 0xab, 1, volume])]);
}

test("E30 Auto Lock trial admits plausible inactive times and copies them without normalization", () => {
  for (const [start, end] of [[[7, 30], [22, 5]], [[255, 255], [22, 5]], [[7, 30], [255, 255]],
    [[255, 255], [255, 255]], [[0, 0], [23, 59]]]) {
    const snapshot = autoSnapshot(autoSettingsPlain(false, 387, 2, 0, start, end));
    assert.deepEqual(snapshot.autoLockTrialPreflight(), { eligible: true, delaySeconds: 387 });
    const commands = [true, false].map(enabled => commandPlainFields(buildE30Command(identity,
      { autoLock: { enabled, settings: snapshot } }, 1_700_000_000, 1_700_000_034, 8)));
    for (const fields of commands) {
      assert.deepEqual([...fields.keys()], [0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8]);
      assert.deepEqual(fields.get(0xa6), Buffer.from([0]));
      assert.deepEqual(fields.get(0xa7), Buffer.from(start!)); assert.deepEqual(fields.get(0xa8), Buffer.from(end!));
    }
    for (const tag of commands[0]!.keys()) if (tag !== 0xa4) assert.deepEqual(commands[0]!.get(tag), commands[1]!.get(tag));
    for (const text of [JSON.stringify(snapshot), inspect(snapshot), JSON.stringify(snapshot.autoLockTrialPreflight()), inspect(snapshot.autoLockTrialPreflight())]) {
      assert.ok(!text.includes("22, 5") && !text.includes("7, 30") && !text.includes("start") && !text.includes("end"));
    }
  }
  for (const bad of [[24, 0], [0, 60], [255, 0], [0, 255], [255, 254]]) {
    for (const [start, end] of [[bad, [7, 30]], [[7, 30], bad]]) {
      assert.equal(autoSnapshot(autoSettingsPlain(false, 90, 2, 0, start, end)).autoLockTrialPreflight().eligible, false);
    }
  }
  assert.equal(autoSnapshot(autoSettingsPlain(true)).autoLockTrialPreflight().eligible, false);
  assert.equal(autoSnapshot(autoSettingsPlain(false, 90, 2, 1, [7, 30], [22, 5])).autoLockTrialPreflight().eligible, false);
  assert.deepEqual(autoSnapshot(autoSettingsPlain(false, 0)).autoLockTrialPreflight(), { eligible: false, delaySeconds: null });
  for (const [start, end] of [[[7], [22, 5]], [[7, 30], [22]]]) {
    assert.equal(autoSnapshot(autoSettingsPlain(false, 90, 2, 0, start, end)).autoLockEnabled, null);
  }
  assert.equal(autoSnapshot(autoSettingsPlain(false, 90, 2, 2)).autoLockEnabled, null);
});

function commandPlainFields(command: E30Command): Map<number, Buffer> {
  const frame = Buffer.from((command.transfer.payload as Record<string, unknown>).lock_payload as string, "hex");
  const { key, iv } = keys(command.keyTime);
  const plain = execFileSync("openssl", ["enc", "-d", "-aes-128-cbc", "-K", key.toString("hex"), "-iv", iv.toString("hex")], { input: frame.subarray(9, -1) });
  const fields = new Map<number, Buffer>();
  let offset = 0;
  while (plain[offset]) { const tag = plain[offset]!, length = plain[offset + 1]!; fields.set(tag, plain.subarray(offset + 2, offset + 2 + length)); offset += length + 2; }
  assert.ok(plain.subarray(offset).every(byte => byte === 0));
  return fields;
}

function autoSnapshot(plain = autoSettingsPlain()) {
  const query = buildE30Command(identity, "settings", 1_700_000_000, 1_700_000_033, 7);
  return decodeE30SettingsReply(settingsReply(query, plain), identity, query)!;
}

test("E30 Auto Lock encodes only the boolean and preserves exact companion bytes without A9", () => {
  const snapshot = autoSnapshot(autoSettingsPlain(false, 387));
  assert.equal(snapshot.autoLockEnabled, false);
  assert.deepEqual(snapshot.autoLockTrialPreflight(), { eligible: true, delaySeconds: 387 });
  for (const enabled of [true, false]) {
    const command = buildE30Command(identity, { autoLock: { enabled, settings: snapshot } }, 1_700_000_000, 1_700_000_034, 8);
    assert.equal(command.opcode, 52); assert.equal((command.transfer.payload as Record<string, unknown>).apiCommand, 6015);
    const fields = commandPlainFields(command);
    assert.deepEqual([...fields.keys()], [0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8]);
    assert.deepEqual(fields.get(0xa3), Buffer.from([0])); assert.deepEqual(fields.get(0xa4), Buffer.from([enabled ? 1 : 0]));
    assert.deepEqual(fields.get(0xa5), Buffer.from([131, 1])); assert.deepEqual(fields.get(0xa6), Buffer.from([0]));
    assert.deepEqual(fields.get(0xa7), Buffer.from([255, 255])); assert.deepEqual(fields.get(0xa8), Buffer.from([255, 255]));
  }
  for (const enabled of [1, 0, "true", null, undefined]) assert.throws(() => buildE30Command(identity, { autoLock: { enabled, settings: snapshot } } as never, 1, 2, 3), E30LockError);
  assert.throws(() => buildE30Command(identity, { autoLock: { enabled: true, settings: snapshot, extra: 1 } } as never, 1, 2, 3), E30LockError);
  assert.throws(() => buildE30Command(identity, { autoLock: { enabled: true, settings: snapshot }, soundVolume: 1 } as never, 1, 2, 3), E30LockError);
});

test("E30 Auto Lock rejects malformed, unbound, foreign and stale snapshots", context => {
  const known = autoSettingsPlain();
  for (const index of [2, 5, 9, 12, 16]) {
    const malformed = Buffer.from(known); malformed[index] = 0;
    const snapshot = autoSnapshot(malformed); assert.equal(snapshot?.autoLockEnabled ?? null, null);
  }
  const zero = autoSnapshot(autoSettingsPlain(false, 0)); assert.equal(zero.autoLockEnabled, null);
  assert.throws(() => buildE30Command(identity, {autoLock:{enabled:true,settings:zero}},1,2,3), E30LockError);
  const unbound = new E30SettingsObservation(2, new Map());
  assert.throws(() => buildE30Command(identity,{autoLock:{enabled:true,settings:unbound}},1,2,3),E30LockError);
  const snapshot = autoSnapshot();
  assert.throws(() => buildE30Command({...identity,serial:"T85F100000000002"},{autoLock:{enabled:true,settings:snapshot}},1,2,3),E30LockError);
  assert.throws(() => buildE30Command({...identity,adminUserId:"mnopqrstuvwx"},{autoLock:{enabled:true,settings:snapshot}},1,2,3),E30LockError);
  let time = 100; context.mock.method(performance, "now", () => time);
  const stale = autoSnapshot(); time = 10_101;
  assert.throws(() => buildE30Command(identity,{autoLock:{enabled:true,settings:stale}},1,2,3),E30LockError);
});

test("E30 Auto Lock comparison ignores only enable and preserves volume, timer and schedule", () => {
  const a = autoSnapshot(); const toggled = autoSnapshot(autoSettingsPlain(true));
  assert.equal(a.compareStableFields(a,toggled,"autoLock").unchanged,true);
  assert.equal(a.compareStableFields(a,toggled).unchanged,false);
  const timer = autoSnapshot(autoSettingsPlain(false,91)); const volume = autoSnapshot(autoSettingsPlain(false,90,3));
  assert.equal(a.compareStableFields(a,timer,"autoLock").unchanged,false);
  assert.equal(a.compareStableFields(timer,a,"autoLock").unchanged,false);
  assert.equal(a.compareStableFields(a,volume,"autoLock").unchanged,false);
  assert.equal(a.compareStableFields(a,volume).unchanged,true);
  assert.throws(()=>a.compareStableFields(a,a,"anything" as never),E30LockError);
  assert.ok(!JSON.stringify(a).includes("delaySeconds")); assert.ok(!inspect(a).includes("delaySeconds"));
});

test("E30 Auto Lock transport reads fresh settings and publishes once with no retry", async () => {
  const fake = new FakeMqtt();
  fake.autoStart = [7, 30]; fake.autoEnd = [22, 5];
  const session = new E30MqttSession(identity,credentials,new AbortController().signal,{resolve:async()=>["8.8.8.8"],connect:()=>{queueMicrotask(()=>{fake.connected=true;fake.emit("connect");});return fake as unknown as MqttClient;}});
  let dispatches = 0;
  try {
    await session.open();
    await assert.rejects(session.setAutoLock(1 as never,()=>dispatches++),E30LockError); assert.equal(fake.publishes,0);
    await session.setAutoLock(true,()=>{assert.equal(fake.publishes,1);dispatches++;});
    assert.equal(fake.publishes,2); assert.equal(dispatches,1); assert.equal(fake.autoLock,true);
    assert.deepEqual(fake.autoStart, [7, 30]); assert.deepEqual(fake.autoEnd, [22, 5]);
    fake.publishError=true;
    await assert.rejects(session.setAutoLock(false,()=>dispatches++),(error:unknown)=>error instanceof E30LockError&&error.code==="outcome_unknown");
    assert.equal(fake.publishes,4); assert.equal(dispatches,2);
    assert.ok(fake.commands.every((command,index)=>!index||command.keyTime>fake.commands[index-1]!.keyTime));
  } finally {session.close();}
});

test("E30 notification JSON changes exactly one bit across all modes", () => {
  for (let mode = 0; mode < 32; mode++) for (const [setting, mask] of [["notifications", 1], ["unlockedNotifications", 2], ["lockedNotifications", 4]] as const) {
    for (const enabled of [true, false]) {
      const command = buildE30NotificationCommand(identity, setting, enabled, mode, 42);
      const expected = enabled ? mode | mask : mode & ~mask;
      assert.equal(JSON.stringify(command.transfer), `{"cmd":1919,"mChannel":0,"mValue3":0,"payload":{"mode":${expected}}}`);
      assert.equal((expected ^ mode) & ~mask, 0); assert.equal(expected & 24, mode & 24);
      assert.ok(Object.isFrozen(command.transfer) && Object.isFrozen(command.transfer.payload));
      const envelope = JSON.parse(e30MqttEnvelope(identity, command, "synthetic"));
      const payload = JSON.parse(envelope.payload);
      assert.equal(envelope.head.msg_seq, 42); assert.equal(envelope.head.cmd, 9);
      assert.equal(payload.account_id, identity.adminUserId); assert.equal(payload.device_sn, identity.serial);
      assert.deepEqual(JSON.parse(Buffer.from(payload.trans, "base64").toString()), command.transfer);
    }
  }
  const rejected = (args: unknown[]) => assert.throws(() => buildE30NotificationCommand(...args as Parameters<typeof buildE30NotificationCommand>),
    (error: unknown) => error instanceof E30LockError && error.code === "unavailable" && error.message === new E30LockError("unavailable").message);
  for (const mode of [-1, 32, 1.5, NaN, "3", -0, Infinity, Number.MAX_SAFE_INTEGER + 1, 3n]) rejected([identity,"notifications",true,mode,1]);
  for (const setting of ["unknown","__proto__","toString",undefined]) rejected([identity,setting,true,3,1]);
  for (const enabled of [1,0,"true",null,undefined]) rejected([identity,"notifications",enabled,3,1]);
  for (const sequence of [-1,2 ** 32,1.5,"1"]) rejected([identity,"notifications",true,3,sequence]);
  for (const value of [null,{...identity,serial:"bad"},{...identity,adminUserId:"bad"},{...identity,administrator:false}]) rejected([value,"notifications",true,3,1]);
});

test("E30 notification inventory rejects ambiguous and noncanonical values", () => {
  for (const type of [1919,"1919"]) for (const value of [0,3,31,"0","3","31"]) assert.equal(parseE30NotificationMode([{param_type:type,param_value:value}]),Number(value));
  for (const value of [-1,32,1.5,NaN,-0,Infinity,true,null,{},"03"," 3","3 ","+3","-0","0x3","３",3n]) assert.equal(parseE30NotificationMode([{param_type:1919,param_value:value}]),null);
  for (const params of [null,{},[],[null],[3],[{param_type:1919,param_value:3},{param_type:"1919",param_value:3}],[{param_type:1919}],[Object.create({param_type:1919,param_value:3})]]) assert.equal(parseE30NotificationMode(params),null);
});

test("E30 notification transport publishes once, ignores stray replies and shares sequence ownership", async () => {
  const fake = new FakeMqtt(), controller = new AbortController();
  const session = new E30MqttSession(identity,credentials,controller.signal,{resolve:async()=>["8.8.8.8"],connect:()=>{queueMicrotask(()=>{fake.connected=true;fake.emit("connect");});return fake as unknown as MqttClient;}});
  const unavailable = (error:unknown) => error instanceof E30LockError && error.code === "unavailable";
  await assert.rejects(session.setNotification("notifications",false,3,()=>{}), unavailable);
  assert.equal(fake.publishes,0);
  try {
    await session.open();
    await assert.rejects(session.setNotification("notifications",false,3,null as never),unavailable);
    await assert.rejects(session.setNotification("__proto__" as E30NotificationSetting,false,3,()=>{}),unavailable);
    fake.connected=false;await assert.rejects(session.setNotification("notifications",false,3,()=>{}),unavailable);fake.connected=true;
    let dispatches=0;
    await session.setNotification("lockedNotifications",true,3,()=>{assert.equal(fake.publishes,0);dispatches++;});
    assert.equal(dispatches,1);assert.equal(fake.publishes,1);assert.equal(fake.listenerCount("message"),0);
    fake.emit("message",`cmd/eufy_security/T85F1/${identity.serial}/res`,Buffer.from('{"cmd":1919,"payload":{"result":0}}'),{});
    fake.emit("message",`cmd/eufy_security/T85F1/${identity.serial}/res`,reply(buildE30Command(identity,"query",1,2,3)),{});
    await session.querySettings();await session.query();await session.setNotification("lockedNotifications",false,7,()=>dispatches++);await session.querySettings();
    assert.ok(fake.commands.every((command,index)=>!index||command.sequence>fake.commands[index-1]!.sequence));
    const reads=fake.commands.filter(command=>command.opcode!==1919);assert.ok(reads.every((command,index)=>!index||command.keyTime>reads[index-1]!.keyTime));
    fake.wrongMessages=true;const pending=session.query();void pending.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(session.setNotification("notifications",false,3,()=>{}),(error:unknown)=>error instanceof E30LockError&&error.code==="busy");controller.abort();await assert.rejects(pending);
    const count=fake.publishes;await assert.rejects(session.setNotification("notifications",false,3,()=>{}),unavailable);assert.equal(fake.publishes,count);
  } finally {session.close();}
});

test("E30 notification post-dispatch errors remain unknown without retry", async () => {
  for (const failure of ["error","timeout","abort"] as const) {
    const fake=new FakeMqtt(),controller=new AbortController();fake.notificationFailure=failure;
    if(failure==="abort")fake.notificationDispatched=()=>controller.abort();
    const session=new E30MqttSession(identity,credentials,controller.signal,{resolve:async()=>["8.8.8.8"],connect:()=>{queueMicrotask(()=>{fake.connected=true;fake.emit("connect");});return fake as unknown as MqttClient;}});
    try {
      await session.open();let dispatched=0;
      const pending=session.setNotification("notifications",false,3,()=>dispatched++);
      if(failure==="timeout")await assert.rejects(session.setNotification("notifications",false,3,()=>{}),(error:unknown)=>error instanceof E30LockError&&error.code==="busy");
      await assert.rejects(pending,(error:unknown)=>error instanceof E30LockError&&error.code==="outcome_unknown");assert.equal(dispatched,1);assert.equal(fake.publishes,1);assert.equal(fake.listenerCount("message"),0);
    } finally {session.close();}
  }
});

test("E30 notification writes stay inside the exact reviewed protocol, transport and provider boundaries", async () => {
  const walk=async(directory:string):Promise<string[]>=>{const files:string[]=[];for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())files.push(...await walk(path));else if(path.endsWith(".ts"))files.push(path);}return files;};
  const allowed = [join("src", "provider", "e30-lock-protocol.ts"), join("src", "provider", "e30-lock-mqtt.ts"), join("src", "provider", "e30-lock-provider.ts")];
  const files = await walk("src"); assert.ok(files.length > allowed.length);
  for (const file of files) if (!allowed.includes(file)) assert.ok(!/setNotification|buildE30NotificationCommand/.test(readFileSync(file,"utf8")), file);
  for (const file of allowed) assert.ok(files.includes(file));
});

test("E30 settings bodies are closed and TTL groups expire independently", async () => {
  const {isE30LockSettingChange,maskSmartLockState}=await import("../src/domain/types.js");
  for(const body of [{setting:"autoLock",value:true},{setting:"volume",value:1},{setting:"notifications",value:false}])assert.equal(isE30LockSettingChange(body),true);
  for(const body of [null,[],{},Object.create({setting:"autoLock",value:true}),{setting:"autoLock",value:1},{setting:"volume",value:true},{setting:"volume",value:0},{setting:"volume",value:4},{setting:"__proto__",value:true},{setting:"autoLock",value:true,extra:1}])assert.equal(isE30LockSettingChange(body),false);
  const now=Date.now(),fresh=new Date(now).toISOString(),old=new Date(now-360001).toISOString();
  const state={serial:identity.serial,name:"Synthetic",model:"T85F1" as const,state:"locked" as const,available:true,batteryPercent:100,stateObservedAt:fresh,
    settings:{volume:2 as const,autoLock:false,notifications:true,lockedNotifications:false,unlockedNotifications:true,observedAt:fresh,notificationsObservedAt:old}};
  const masked=maskSmartLockState(state,now);assert.equal(masked.available,true);assert.equal(masked.settings?.autoLock,false);assert.equal(masked.settings?.notifications,null);assert.equal(state.settings.notifications,true);
  const reverse=maskSmartLockState({...state,stateObservedAt:old,settings:{...state.settings,observedAt:old,notificationsObservedAt:fresh}},now);
  assert.equal(reverse.available,false);assert.equal(reverse.settings?.autoLock,null);assert.equal(reverse.settings?.notifications,true);
});

test("E30 settings no-op publishes fresh cache, and failed settings reads preserve physical state", async () => {
  let settingsFail=false,writes=0,cloudCalls=0;
  const row={...inventoryRow(),params:[{param_type:1919,param_value:"3"}]};
  const provider=new E30LockProvider({credentials:async()=>credentials,changed:()=>{},freshDevices:async()=>{cloudCalls++;return[row];},session:()=>({open:async()=>{},query:async()=>({rawState:4,batteryPercent:100}),querySettings:async()=>{if(settingsFail)throw Error('synthetic');return autoSnapshot();},setAutoLock:async()=>{writes++;},actuate:async()=>{writes++;},close:()=>{}})});
  try{
    provider.inventory([row],true);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(provider.list()[0]?.settings?.notifications,true);assert.equal(cloudCalls,1);
    const result=await provider.setSetting(identity.serial,{setting:"autoLock",value:false});assert.equal(result.settings?.autoLock,false);assert.equal(writes,0);
    await provider.setSetting(identity.serial,{setting:"autoLock",value:false});assert.equal(writes,0);
    settingsFail=true;await assert.rejects(provider.setSetting(identity.serial,{setting:"autoLock",value:true}));assert.equal(provider.list()[0]?.state,"locked");assert.equal(provider.list()[0]?.available,true);
  }finally{provider.close();}
});

test("E30 settings share motor throttle and preserve physical state after unknown setting writes", async () => {
  let writes=0;
  const provider=new E30LockProvider({credentials:async()=>credentials,changed:()=>{},session:()=>({open:async()=>{},query:async()=>({rawState:4,batteryPercent:100}),querySettings:async()=>autoSnapshot(),setAutoLock:async(_enabled,dispatch)=>{dispatch();writes++;throw Error('synthetic');},actuate:async()=>{writes++;},close:()=>{}})});
  try{
    provider.inventory([inventoryRow()],true);await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(provider.setSetting(identity.serial,{setting:"autoLock",value:true}),(error:unknown)=>error instanceof E30LockError&&error.code==="outcome_unknown");
    assert.equal(writes,1);assert.equal(provider.list()[0]?.settings?.autoLock,null);assert.equal(provider.list()[0]?.state,"locked");
    await assert.rejects(provider.setLocked(identity.serial,false),(error:unknown)=>error instanceof E30LockError&&error.code==="rate_limited");assert.equal(writes,1);
  }finally{provider.close();}
});

test("E30 settings require current owner binding and refuse exhausted dispatch budget", async context => {
  let writes=0,now=Date.now(),changedBinding=false,budget=false;
  context.mock.method(Date,"now",()=>now);
  const provider=new E30LockProvider({credentials:async()=>credentials,changed:()=>{},freshDevices:async()=>[{...inventoryRow(),member:{...inventoryRow().member,admin_user_id:changedBinding?"mnopqrstuvwx":identity.adminUserId},params:[{param_type:1919,param_value:"3"}]}],session:()=>({open:async()=>{},query:async()=>({rawState:4,batteryPercent:100}),querySettings:async()=>autoSnapshot(),setAutoLock:async(_enabled,dispatch)=>{if(budget)now+=61001;dispatch();writes++;},actuate:async()=>{writes++;},close:()=>{}})});
  try{
    provider.inventory([inventoryRow()],true);await new Promise(resolve=>setImmediate(resolve));changedBinding=true;
    await assert.rejects(provider.setSetting(identity.serial,{setting:"notifications",value:false}));assert.equal(writes,0);
    budget=true;await assert.rejects(provider.setSetting(identity.serial,{setting:"autoLock",value:true}));assert.equal(writes,0);
  }finally{provider.close();}
});

test("E30 settings HTTP validates authorization and closed bodies before any provider action", async () => {
  const directory=await mkdtemp(join(tmpdir(),"e30-settings-http-")),state=new GatewayState();
  const lock={serial:identity.serial,name:"Synthetic",model:"T85F1" as const,state:"locked" as const,available:true,batteryPercent:100,stateObservedAt:new Date().toISOString()};state.replaceLocks([lock]);let calls=0;
  const provider={setLockSetting:async()=>{calls++;return lock;}} as unknown as CameraProvider;
  const server=new GatewayServer({...loadConfig({}),port:0,apiToken:"x".repeat(32),experimentalE30Locks:true},state,new SnapshotStore(directory),{} as LiveStreamManager,provider,null);
  try{
    await server.listen();const base=`http://127.0.0.1:${server.port}/api/locks`,url=`${base}/${identity.serial}/settings`,headers={authorization:`Bearer ${"x".repeat(32)}`,"content-type":"application/json"};
    const post=(body:unknown,changes={})=>fetch(url,{method:"POST",headers,body:JSON.stringify(body),...changes});
    assert.equal((await post({setting:"autoLock",value:true},{headers:{}})).status,401);
    assert.equal((await fetch(`${base}/missing/settings`,{method:"POST",headers,body:"{}"})).status,404);
    assert.equal((await post({}, {headers:{authorization:headers.authorization}})).status,415);
    for(const body of [null,[],{},"text",{setting:"autoLock",value:"true"},{setting:"volume",value:0},{setting:"notifications",value:1},{setting:"autoLock",value:true,raw:1}])assert.equal((await post(body)).status,400);
    await fetch(url+'?setting=autoLock&value=true',{headers});assert.equal(calls,0);
    assert.equal((await post({setting:"autoLock",value:true})).status,200);assert.equal(calls,1);
  }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});

test("E30 notification provider requires full-mode readback and preserves unrelated settings", async () => {
  for(const drift of [false,true]){
    let mode=3,writes=0;
    const provider=new E30LockProvider({credentials:async()=>credentials,changed:()=>{},freshDevices:async()=>[{...inventoryRow(),params:[{param_type:1919,param_value:String(mode)}]}],session:()=>({open:async()=>{},query:async()=>({rawState:4,batteryPercent:100}),querySettings:async()=>autoSnapshot(),setNotification:async(_setting,_enabled,current,dispatch)=>{assert.equal(current,3);dispatch();writes++;mode=drift?31:7;},actuate:async()=>{throw Error('Forbidden');},close:()=>{}})});
    try{
      provider.inventory([inventoryRow()],true);await new Promise(resolve=>setImmediate(resolve));
      const change={setting:"lockedNotifications" as const,value:true};
      if(drift){await assert.rejects(provider.setSetting(identity.serial,change),(error:unknown)=>error instanceof E30LockError&&error.code==="outcome_unknown");assert.equal(provider.list()[0]?.settings?.notifications,null);}
      else{const result=await provider.setSetting(identity.serial,change);assert.equal(result.settings?.lockedNotifications,true);assert.equal(result.settings?.unlockedNotifications,true);assert.equal(result.settings?.autoLock,false);assert.equal(result.settings?.volume,2);}
      assert.equal(writes,1);assert.equal(provider.list()[0]?.state,"locked");
    }finally{provider.close();}
  }
});

test("E30 settings and motor share a lease and cancellation retires delayed credentials", async () => {
  let calls=0,writes=0,release:((value:typeof credentials)=>void)|undefined;
  const provider=new E30LockProvider({credentials:async()=>++calls===1?credentials:new Promise(resolve=>{release=resolve;}),changed:()=>{},session:()=>({open:async()=>{},query:async()=>({rawState:4,batteryPercent:100}),querySettings:async()=>autoSnapshot(),setAutoLock:async()=>{writes++;},actuate:async()=>{writes++;},close:()=>{}})});
  try{
    provider.inventory([inventoryRow()],true);await new Promise(resolve=>setImmediate(resolve));const controller=new AbortController();
    const pending=provider.setSetting(identity.serial,{setting:"autoLock",value:true},controller.signal);void pending.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(provider.setLocked(identity.serial,false),(error:unknown)=>error instanceof E30LockError&&error.code==="busy");
    controller.abort();await assert.rejects(pending);release?.(credentials);await new Promise(resolve=>setImmediate(resolve));assert.equal(writes,0);assert.equal(provider.list()[0]?.state,"locked");
  }finally{provider.close();}
});

test("E30 provider accepts a correlated status reply after the former five-second cutoff", async () => {
  const fake=new FakeMqtt(),emit=fake.emit.bind(fake),timers:ReturnType<typeof setTimeout>[]=[];
  fake.emit=(event:string|symbol,...args:unknown[]):boolean=>{
    const packet=args[2] as {retain?:boolean;dup?:boolean}|undefined;
    if(event==="message"&&fake.commands.at(-1)?.opcode===34&&!packet?.retain&&!packet?.dup){timers.push(setTimeout(()=>emit(event,...args),6000));return true;}
    return emit(event,...args);
  };
  const done=new Promise<void>(resolve=>fake.once("close",resolve));
  const provider=new E30LockProvider({credentials:async()=>credentials,changed:()=>{},stateCodes:{locked:2,unlocked:1},
    session:(id,creds,signal)=>new E30MqttSession(id,creds,signal,{resolve:async()=>["8.8.8.8"],connect:()=>{queueMicrotask(()=>{fake.connected=true;fake.emit("connect");});return fake as unknown as MqttClient;}})});
  try{provider.inventory([inventoryRow()],true);await done;assert.equal(provider.list()[0]?.state,"locked");assert.equal(provider.list()[0]?.available,true);assert.equal(fake.publishes,2);}
  finally{provider.close();timers.forEach(clearTimeout);}
});

test("E30 status transport allows fifteen seconds while settings retain their five-second bound", async context => {
  const {E30_STATUS_QUERY_TIMEOUT_MS}=await import("../src/provider/e30-lock-mqtt.js");assert.equal(E30_STATUS_QUERY_TIMEOUT_MS,15000);
  const requested:number[]=[],original=AbortSignal.timeout.bind(AbortSignal);
  context.mock.method(AbortSignal,"timeout",(ms:number)=>{requested.push(ms);return original(ms===5000?5:ms);});
  const fake=new FakeMqtt(),session=new E30MqttSession(identity,credentials,new AbortController().signal,{resolve:async()=>["8.8.8.8"],connect:()=>{queueMicrotask(()=>{fake.connected=true;fake.emit("connect");});return fake as unknown as MqttClient;}});
  try{await session.open();await session.query();fake.wrongMessages=true;await assert.rejects(session.querySettings(),E30LockError);assert.deepEqual(requested,[15000,5000]);assert.equal(fake.listenerCount("message"),0);}
  finally{session.close();}
});

test("E30 pre-dispatch motor failures preserve confirmed facts without setting a write throttle", async context => {
  const now=Date.now();let fail=false;context.mock.timers.enable({apis:["Date"],now});
  const provider=new E30LockProvider({credentials:async()=>credentials,changed:()=>{},session:()=>({open:async()=>{},query:async()=>{if(fail)throw Error('synthetic');return{rawState:4,batteryPercent:100};},querySettings:async()=>autoSnapshot(),actuate:async()=>{throw Error('Forbidden');},close:()=>{}})});
  try{
    provider.inventory([inventoryRow()],true);await new Promise(resolve=>setImmediate(resolve));const before=provider.list()[0];assert.equal(before?.state,"locked");fail=true;
    for(let n=0;n<2;n++){await assert.rejects(provider.setLocked(identity.serial,false),(error:unknown)=>error instanceof E30LockError&&error.code==="unavailable");assert.deepEqual(provider.list()[0],before);}
    context.mock.timers.setTime(now+11000);await assert.rejects(provider.refresh(identity.serial));assert.equal(provider.list()[0]?.available,false);assert.equal(provider.list()[0]?.settings?.autoLock,null);
    context.mock.timers.setTime(now+411000);assert.equal(provider.list()[0]?.available,false);
  }finally{provider.close();}
});

test("E30 motor reserve admits twenty seconds and refuses less before dispatch", async context => {
  let now=Date.now();context.mock.timers.enable({apis:["Date"],now});context.mock.method(Date,"now",()=>now);
  for(const remaining of [19999,20000]){
    const baseline=now;let active=false,advanced=false,actuations=0,dispatches=0;
    const provider=new E30LockProvider({credentials:async()=>credentials,changed:()=>{},session:()=>({open:async()=>{},query:async()=>({get rawState(){if(active&&!advanced){now=baseline+45000-remaining;advanced=true;}return 4;},batteryPercent:100}),actuate:async(_desired,dispatch)=>{actuations++;dispatch();dispatches++;throw Error('synthetic');},close:()=>{}})});
    try{provider.inventory([inventoryRow()],true);await new Promise(resolve=>setImmediate(resolve));active=true;await assert.rejects(provider.setLocked(identity.serial,false),(error:unknown)=>error instanceof E30LockError&&error.code===(remaining===20000?"outcome_unknown":"unavailable"));assert.equal(actuations,remaining===20000?1:0);assert.equal(dispatches,remaining===20000?1:0);}
    finally{provider.close();now=baseline;}
  }
});

test("E30 exhausted preflight handles already-started read rejections", async context => {
  let now=Date.now(),active=false,writes=0;const failures:unknown[]=[];const rejected=(reason:unknown)=>failures.push(reason);process.on("unhandledRejection",rejected);context.mock.timers.enable({apis:["Date"],now});context.mock.method(Date,"now",()=>now);
  const provider=new E30LockProvider({credentials:async()=>{if(active)now+=26000;return credentials;},changed:()=>{},session:()=>({open:async()=>{if(active)throw Error('synthetic retired read');},query:async()=>({rawState:4,batteryPercent:100}),actuate:async()=>{writes++;},close:()=>{}})});
  try{provider.inventory([inventoryRow()],true);await new Promise(resolve=>setImmediate(resolve));active=true;await assert.rejects(provider.setLocked(identity.serial,false));await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));assert.equal(writes,0);assert.deepEqual(failures,[]);assert.equal(provider.list()[0]?.state,"locked");}
  finally{provider.close();process.off("unhandledRejection",rejected);}
});

test("E30 post-dispatch readback keeps the fifteen-second provider cap", async context => {
  let now=Date.now(),written=false,clockReads=0,writes=0;const original=now;context.mock.timers.enable({apis:["Date"],now});context.mock.method(Date,"now",()=>{if(written&&++clockReads===2)now=original+3000;return now;});
  const provider=new E30LockProvider({credentials:async()=>credentials,changed:()=>{},session:()=>({open:async()=>{},query:async()=>{if(written){now=original+16000;return new Promise<never>(()=>{});}return{rawState:4,batteryPercent:100};},actuate:async(_desired,dispatch)=>{dispatch();writes++;written=true;},close:()=>{}})});
  try{provider.inventory([inventoryRow()],true);await new Promise(resolve=>setImmediate(resolve));await assert.rejects(provider.setLocked(identity.serial,false),(error:unknown)=>error instanceof E30LockError&&error.code==="outcome_unknown");assert.equal(writes,1);assert.equal(provider.list()[0]?.available,false);}
  finally{provider.close();}
});
