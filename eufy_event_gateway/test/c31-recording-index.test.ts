/**
 * Exercises the manual C31 index query with synthetic negotiated encrypted peers.
 * Tests own sockets, identity and response bytes. No network or real camera is
 * contacted, and successful parsing is not a hardware playback claim.
 */
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createECDH, createHmac } from "node:crypto";
import { Socket } from "node:dgram";
import test, { type TestContext } from "node:test";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { C31IndexError, parseC31IndexRequest, summarizeC31Index, validateC31IndexWindow } from "../src/stream/c31-recording-index.js";

/** Deliver a synthetic XZYH frame through the real session's socket listener. */
function deliver(socket:Socket,command:number,payload:Buffer,sign=0,sequence=0):void {
  const frame=Buffer.alloc(16);frame.write("XZYH");frame.writeUInt16LE(command,4);frame.writeUInt32LE(payload.length,6);frame[13]=sign;
  const header=Buffer.from([0xf1,0xd0,0,0,0xd1,0,0,0]);header.writeUInt16BE(sequence,6);
  socket.emit("message",Buffer.concat([header,frame,payload]),{address:"127.0.0.1",port:12345});
}

/** Negotiate a real synthetic level-two key without network access or private-field hooks. */
async function peer(context:TestContext) {
  let socket!:Socket;const sent:Buffer[]=[];
  context.mock.method(Socket.prototype,"bind",function(this:Socket){socket=this;queueMicrotask(()=>this.emit("message",Buffer.from([0xf1,0x42,0,0]),{address:"127.0.0.1",port:12345}));return this;});
  context.mock.method(Socket.prototype,"send",function(data:Buffer){sent.push(Buffer.from(data));});
  context.mock.method(Socket.prototype,"close",function(this:Socket){return this;});
  const recipient=createECDH("prime256v1");recipient.setPrivateKey(Buffer.alloc(32,1));
  const ephemeral=createECDH("prime256v1");ephemeral.setPrivateKey(Buffer.alloc(32,2));
  const shared=ephemeral.computeSecret(recipient.getPublicKey()),label=Buffer.from("ECIES");
  const hmac=(key:Buffer,data:Buffer):Buffer=>createHmac("sha256",key).update(data).digest();
  let previous:Buffer<ArrayBufferLike>=label,derived:Buffer<ArrayBufferLike>=Buffer.alloc(0);
  while(derived.length<48){previous=hmac(shared,previous);derived=Buffer.concat([derived,hmac(shared,Buffer.concat([previous,label]))]);}
  const key=Buffer.alloc(32,9),envelope=Buffer.alloc(129),iv=Buffer.alloc(16,3);
  ephemeral.getPublicKey(undefined,"compressed").copy(envelope);iv.copy(envelope,33);
  const wrap=createCipheriv("aes-128-cbc",derived.subarray(0,16),iv);Buffer.concat([wrap.update(key),wrap.final()]).copy(envelope,49);
  const plain=Buffer.alloc(144);plain.writeUInt16LE(1);envelope.copy(plain,4);
  const legacy=createCipheriv("aes-128-ecb",Buffer.from("1234567-12345678"),null);legacy.setAutoPadding(false);
  const session=new FirstPartyPpcsSession({stationSerial:"SYNTHETIC1234567",p2pDid:"TEST-12345678-TEST",appConnection:"",dskKey:"synthetic",channel:0,homeBaseAttached:false,cameraModel:"T817L",accountId:"synthetic-account",purpose:"control",resolveCipherKey:async()=>recipient.getPrivateKey().toString("hex")});
  await session.start();deliver(socket,1100,Buffer.concat([legacy.update(plain),legacy.final()]),1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(session.stats.level2,1);
  return {session,socket,sent};
}

test("index summaries reject private envelope mismatches and bound rows", () => {
  const end = 1791720000, begin = end - 1800;
  const reply = { begin_time: begin, end_time: end, account: "synthetic-account", id: 77,
    videos: [{ start_time: begin + 1, stop_time: end - 1, cipher_id: "PRIVATE-CIPHER-CANARY" }] };
  const result = summarizeC31Index({ ...reply, secret: "PRIVATE-EXTRA-CANARY", videos: [...reply.videos, {}] }, begin, end, "synthetic-account");
  assert.deepEqual(result, { outcome: "intervals", windowMatches: true, ownerMatches: true, valid: 1, invalid: 1, overlapping: 1 });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|synthetic|179172|77/);
  for (const change of [{ account: "other" }, { begin_time: begin * 1000 }, { end_time: end + 1 },
    { beginTime: begin }, { id: null }, { videos: Array(513).fill({}) }, { videos: "bad" }]) {
    assert.throws(() => summarizeC31Index({ ...reply, ...change }, begin, end, "synthetic-account"), C31IndexError);
  }
  assert.equal(summarizeC31Index({ ...reply, videos: [] }, begin, end, "synthetic-account").outcome, "empty");
  assert.equal(summarizeC31Index({ ...reply, videos: Array(512).fill(reply.videos[0]) }, begin, end, "synthetic-account").valid, 512);
  assert.equal(summarizeC31Index({ ...reply, videos: [{}] }, begin, end, "synthetic-account").outcome, "unusable");
  validateC31IndexWindow(begin, end, end);
  for (const [a, b] of [[begin * 1000, end * 1000], [begin - 1, end], [end, end], [begin, end + 1], [NaN, end]]) {
    assert.throws(() => validateC31IndexWindow(a!, b!, end), C31IndexError);
  }
});

test("historical consent accepts one closed bounded interval and preserves recent-window compatibility", () => {
  const now = 1_800_000_000, window = { beginTime: now - 7500, endTime: now - 7200 };
  assert.deepEqual(parseC31IndexRequest({ consentReadRecordingIndex: true, ...window }, now), window);
  assert.equal(parseC31IndexRequest({ consentReadRecordingIndex: true }, now), undefined);
  validateC31IndexWindow(now - 86400, now - 86400 + 60, now);
  for (const body of [null, {}, { consentReadRecordingIndex: false },
    { consentReadRecordingIndex: true, beginTime: window.beginTime },
    { consentReadRecordingIndex: true, ...window, privateField: true },
    ...[{ beginTime: now - 86401, endTime: now - 86400 }, { beginTime: now - 1801, endTime: now },
      { beginTime: now, endTime: now + 1 }, { beginTime: window.beginTime * 1000, endTime: window.endTime * 1000 },
      { beginTime: NaN, endTime: now }, { beginTime: "1799992500", endTime: now },
      { beginTime: now - 60.5, endTime: now }, { beginTime: now, endTime: now }]
      .map(value => ({ consentReadRecordingIndex: true, ...value }))]) {
    assert.throws(() => parseC31IndexRequest(body, now), C31IndexError);
  }
});

for (const mode of ["reply", "historical", "owner", "transaction", "closed", "timeout", "media", "oversized", "guard", "send"]) {
  test(`single scoped C31 query settles and cleans up: ${mode}`, async context => {
    const p = await peer(context), end = Math.floor(Date.now() / 1000) - (mode === "historical" ? 7200 : 0), begin = end - 1800;
    context.mock.timers.enable({ apis: ["setTimeout"] });
    if (mode === "send") context.mock.method(Socket.prototype, "send", function(data: Buffer) {
      p.sent.push(Buffer.from(data)); const at = data.indexOf(Buffer.from("XZYH"));
      if (at >= 0 && data.readUInt16LE(at + 4) === 1700) throw Error("PRIVATE-ERROR-CANARY");
    });
    let guards = 0;
    const operation = p.session.readC31RecordingIndex(begin, end, () => { if (++guards === 2 && mode === "guard") throw new C31IndexError("cancelled"); });
    const success = mode === "reply" || mode === "historical";
    const observed = success ? operation : assert.rejects(operation, C31IndexError);
    await new Promise(resolve => setImmediate(resolve));
    const frames = p.sent.filter(b => { const at = b.indexOf(Buffer.from("XZYH")); return at >= 0 && b.readUInt16LE(at + 4) === 1700; });
    assert.equal(frames.length, mode === "guard" ? 0 : 1);
    if (frames.length && mode !== "send") {
      const raw = frames[0]!.subarray(frames[0]!.indexOf(Buffer.from("XZYH")) + 6), encrypted = raw.subarray(10);
      const decipher = createDecipheriv("aes-256-gcm", Buffer.alloc(32, 9), encrypted.subarray(16, 28));
      decipher.setAAD(Buffer.from("eufy security")); decipher.setAuthTag(encrypted.subarray(0, 16));
      const request = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]).toString());
      assert.deepEqual(Object.keys(request).sort(), ["commandType", "data"]);
      assert.equal(request.commandType, 6000);
      assert.deepEqual(Object.keys(request.data).sort(), ["begin_time", "device_sn", "end_time", "sensor_id"]);
      assert.equal(request.data.sensor_id, 0);
      assert.equal(request.data.begin_time, begin); assert.equal(request.data.end_time, end);
      assert.equal(request.data.device_sn, "SYNTHETIC1234567");
    }
    const reply = { begin_time: begin, end_time: end, account: mode === "owner" ? "wrong" : "synthetic-account", id: 1, videos: [] };
    if (["reply", "historical", "owner", "transaction"].includes(mode)) {
      deliver(p.socket, 1351, Buffer.from(JSON.stringify({ cmd: 6004, payload: reply })), 0, 1);
      deliver(p.socket, 1351, Buffer.from(JSON.stringify({ cmd: 6003, payload: reply })), 0, 2);
      deliver(p.socket, 1351, Buffer.from(JSON.stringify({ cmd: 6000, payload: { ack: true } })), 0, 3);
      deliver(p.socket, 1351, Buffer.from(JSON.stringify({ cmd: 6000, payload: { ...reply, ...(mode === "transaction" ? { transaction: "wrong" } : {}) } })), 0, 4);
      if (mode === "transaction") context.mock.timers.tick(15_000);
    } else if (mode === "media") deliver(p.socket, 1300, Buffer.alloc(0), 0, 1);
    else if (mode === "oversized") deliver(p.socket, 1351, Buffer.alloc(256 * 1024 + 1), 0, 1);
    else if (mode === "timeout") context.mock.timers.tick(15_000);
    else p.session.close();
    if (success) assert.equal((await observed as { outcome: string }).outcome, "empty"); else await observed;
    assert.equal(p.session.stats.mediaStartAttempts, 0); p.session.close(); p.session.close();
  });
}

test("index readers cannot replace each other's slot after waiting for a key", async context => {
  const p = await peer(context), end = Math.floor(Date.now() / 1000), begin = end - 300;
  try {
    const first = p.session.readC31RecordingIndex(begin, end, () => {});
    await assert.rejects(p.session.readC31RecordingIndex(begin, end, () => {}), /busy/);
    deliver(p.socket, 1351, Buffer.from(JSON.stringify({ cmd: 6000, payload: {
      begin_time: begin, end_time: end, account: "synthetic-account", id: 1, videos: [],
    } })), 0, 1);
    assert.equal((await first).outcome, "empty");
    assert.equal(p.sent.filter(b => { const at = b.indexOf(Buffer.from("XZYH"));
      return at >= 0 && b.readUInt16LE(at + 4) === 1700; }).length, 1);
  } finally { p.session.close(); }
});

test("continuous session uses a fresh index, signed-in playback identity and one stop before disconnect", async context => {
  const p = await peer(context), begin = Math.floor(Date.now() / 1000) - 100;
  const controller = new AbortController();
  const operation = p.session.readC31ContinuousClip(begin, "synthetic-playback-user", controller.signal, () => {});
  const rejected = assert.rejects(operation);
  await new Promise(resolve => setImmediate(resolve));
  deliver(p.socket, 1351, Buffer.from(JSON.stringify({ cmd: 6000, payload: {
    begin_time: begin, end_time: begin + 10, account: "synthetic-account", id: 1,
    videos: [{ start_time: begin - 5, stop_time: begin + 20, cipher_id: 1 }],
  } })), 0, 1);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(); await rejected; p.session.close(); p.session.close();
  const requests = p.sent.filter(data => {
    const at = data.indexOf(Buffer.from("XZYH")); return at >= 0 && data.readUInt16LE(at + 4) === 1700;
  }).map(data => {
    const encrypted = data.subarray(data.indexOf(Buffer.from("XZYH")) + 16);
    const decrypt = createDecipheriv("aes-256-gcm", Buffer.alloc(32, 9), encrypted.subarray(16, 28));
    decrypt.setAAD(Buffer.from("eufy security")); decrypt.setAuthTag(encrypted.subarray(0, 16));
    return JSON.parse(Buffer.concat([decrypt.update(encrypted.subarray(32)), decrypt.final()]).toString());
  });
  assert.equal(requests.length, 3); assert.equal(requests[0].commandType, 6000);
  assert.deepEqual(requests[1], { commandType: 6001, data: { account_id: "synthetic-playback-user", begin_time: begin, cmd: 0,
    device_sn: "SYNTHETIC1234567", index: 0, play_speed: 1, play_type: 0, record_id: 0, sensor_id: 0, session_id: 125 } });
  assert.deepEqual(requests[2], { commandType: 6001, data: { begin_time: 0, cmd: 3,
    device_sn: "SYNTHETIC1234567", file_path: "", index: 0, play_speed: 1, play_type: 0, record_id: 0, sensor_id: 0, session_id: 123 } });
  assert.equal(p.session.stats.mediaStartAttempts, 0);
});
