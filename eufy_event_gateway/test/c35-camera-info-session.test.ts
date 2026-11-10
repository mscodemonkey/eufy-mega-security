/**
 * Qualifies the opt-in C35 state query through independently decrypted wire frames.
 * Synthetic sockets and keys exercise the real session without network access.
 */
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createECDH, createHmac } from "node:crypto";
import { Socket } from "node:dgram";
import test, { type TestContext } from "node:test";
import { FirstPartyPpcsSession, type PpcsCameraOptions } from "../src/stream/first-party-ppcs.js";

/** Deliver a synthetic XZYH frame through the real session's socket listener. */
function deliver(socket:Socket,command:number,payload:Buffer,sign=0,sequence=0,channel=0,ack=false):void {
  const frame=Buffer.alloc(16);frame.write("XZYH");frame.writeUInt16LE(command,4);frame.writeUInt32LE(payload.length,6);frame[13]=sign;frame[12]=channel;frame[14]=ack?1:0;
  const header=Buffer.from([0xf1,0xd0,0,0,0xd1,0,0,0]);header.writeUInt16BE(sequence,6);
  socket.emit("message",Buffer.concat([header,frame,payload]),{address:"127.0.0.1",port:12345});
}

/** Negotiate a real synthetic level-two key without network access or private-field hooks. */
async function peer(context:TestContext, options: Partial<PpcsCameraOptions> = {}, negotiate = true) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
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
  const session=new FirstPartyPpcsSession({stationSerial:"SYNTHETIC1234567",p2pDid:"TEST-12345678-TEST",appConnection:"",dskKey:"synthetic",channel:0,homeBaseAttached:false,cameraModel:"T8110",cameraDeviceType:10035,accountId:"synthetic-account",purpose:"control",modelControlTrial:true,resolveCipherKey:async()=>recipient.getPrivateKey().toString("hex"),...options});
  await session.start();
  if (negotiate) deliver(socket,1100,Buffer.concat([legacy.update(plain),legacy.final()]),1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(session.stats.level2,negotiate ? 1 : 0);
  return {session,socket,sent};
}

/** Select camera commands while excluding PPCS negotiation packets. */
function commands(sent: readonly Buffer[]): Buffer[] {
  return sent.filter(packet => packet.length >= 24 && packet.subarray(8, 12).toString() === "XZYH");
}

/** Independently wrap a synthetic response with negotiated protection. */
function response(body: string): Buffer {
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 9), iv);
  cipher.setAAD(Buffer.from("eufy security"));
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([cipher.getAuthTag(), iv, Buffer.alloc(4), encrypted]);
}

for (const mode of ["valid", "invalid-tag", "clear", "wrong-channel", "invalid-schema", "closed", "timeout"]) {
  test(`C35 protected state query: ${mode}`, async context => {
    const { session, socket, sent } = await peer(context);
    const operation = session.readCameraInfo("c35-spotlight-state");
    const result = mode === "valid" ? operation
      : assert.rejects(operation, mode === "clear" ? { reason: "protection_mismatch" }
        : mode === "invalid-tag" ? { reason: "authentication_failed" } : { name: "CameraInfoReadError" });
    try {
      await new Promise(resolve => setImmediate(resolve));
      const queries = commands(sent).filter(packet => packet.readUInt16LE(12) === 1103);
      assert.equal(queries.length, 1);
      const query = queries[0]!;
      assert.equal(query[20], 0);
      assert.equal(query[21], 8);
      assert.deepEqual([...query.subarray(18, 20)], [8, 0]);
      const body = query.subarray(24);
      assert.equal(body.length, 40);
      const decipher = createDecipheriv("aes-256-gcm", Buffer.alloc(32, 9), body.subarray(16, 28));
      decipher.setAAD(Buffer.from("eufy security"));
      decipher.setAuthTag(body.subarray(0, 16));
      const clear = Buffer.concat([decipher.update(body.subarray(32)), decipher.final()]);
      assert.deepEqual([...clear], [255, 0, 0, 0, 135, 3, 0, 0]);
      const document = '{"params":[{"param_type":1400,"param_value":"1"}]}';
      const payload = response(mode === "invalid-schema" ? '{"params":false}' : document);
      if (mode === "valid") deliver(socket, 1103, payload, 8, 1);
      else if (mode === "closed") session.close();
      else {
        if (mode === "invalid-tag") payload[0] = payload[0]! ^ 1;
        if (mode === "clear") deliver(socket, 1103, Buffer.from(document), 0, 1);
        else if (mode !== "timeout") deliver(socket, 1103, payload, 8, 1, mode === "wrong-channel" ? 1 : 0);
        context.mock.timers.tick(10_000);
      }
      const value = await result;
      if (mode === "valid") assert.deepEqual(value, [{ param_type: 1400, param_value: "1" }]);
      assert.equal(session.stats.mediaStartAttempts, 0);
      assert.equal(commands(sent).filter(packet => ![1100, 1103].includes(packet.readUInt16LE(12))).length, 0);
      if (mode !== "closed") {
        const next = session.readCameraInfo("c35-spotlight-state");
        await new Promise(resolve => setImmediate(resolve));
        deliver(socket, 1103, response(document), 8, mode === "timeout" ? 1 : 2);
        await next;
      }
    } finally { session.close(); await operation.catch(() => undefined); context.mock.timers.reset(); }
  });
}

for (const options of [
  { cameraModel: "T817L" }, { cameraDeviceType: 10034 }, { cameraDeviceType: null },
  { channel: 1 }, { homeBaseAttached: true }, { purpose: "passive" as const }, { modelControlTrial: false },
]) test(`C35 candidate rejects mismatched identity ${JSON.stringify(options)}`, async context => {
  const { session, sent } = await peer(context, options);
  try {
    await assert.rejects(session.readCameraInfo("c35-spotlight-state"));
    assert.equal(commands(sent).filter(packet => packet.readUInt16LE(12) === 1103).length, 0);
  } finally { session.close(); }
});

test("C35 legacy control read retains its empty clear query", async context => {
  const { session, socket, sent } = await peer(context);
  try {
    const result = session.readCameraInfo();
    const query = commands(sent).find(packet => packet.readUInt16LE(12) === 1103)!;
    assert.equal(query[21], 0);
    assert.equal(query.length, 24);
    deliver(socket, 1103, Buffer.from('{"params":[]}'), 0, 1);
    assert.deepEqual(await result, []);
  } finally { session.close(); }
});

test("closing during C35 key negotiation sends no state query", async context => {
  const { session, sent } = await peer(context, {}, false);
  const rejected = assert.rejects(session.readCameraInfo("c35-spotlight-state"));
  session.close();
  context.mock.timers.tick(50);
  await rejected;
  assert.equal(commands(sent).filter(packet => packet.readUInt16LE(12) === 1103).length, 0);
  context.mock.timers.reset();
});

test("C35 query counter exhaustion refuses another dispatch", async context => {
  const { session, socket, sent } = await peer(context);
  try {
    for (let index = 0; index < 256; index++) {
      const reading = session.readCameraInfo("c35-spotlight-state");
      await new Promise(resolve => setImmediate(resolve));
      deliver(socket, 1103, response('{"params":[]}'), 8, index + 1);
      await reading;
    }
    await assert.rejects(session.readCameraInfo("c35-spotlight-state"));
    assert.equal(commands(sent).filter(packet => packet.readUInt16LE(12) === 1103).length, 256);
  } finally { session.close(); }
});

test("a failed C35 dispatch retires its pending response slot", async context => {
  const { session, socket } = await peer(context);
  const send = context.mock.method(Socket.prototype, "send", () => { throw Error("synthetic send failure"); });
  try {
    await assert.rejects(session.readCameraInfo("c35-spotlight-state"));
    send.mock.restore();
    const reading = session.readCameraInfo("c35-spotlight-state");
    await new Promise(resolve => setImmediate(resolve));
    deliver(socket, 1103, response('{"params":[]}'), 8, 1);
    assert.deepEqual(await reading, []);
  } finally { session.close(); }
});
