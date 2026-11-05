/**
 * Exercises the attached read-only lock query with a synthetic encrypted peer.
 * Tests own sockets and keys, and assert that only one status query is sent.
 */
import assert from "node:assert/strict";
import { createDecipheriv, createCipheriv, createECDH, createHmac } from "node:crypto";
import { Socket } from "node:dgram";
import test, { type TestContext } from "node:test";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";


/** Deliver a synthetic XZYH frame through the real session's socket listener. */
function deliver(socket:Socket,command:number,payload:Buffer,sign=0,sequence=0, channel=3):void {
  const frame=Buffer.alloc(16);frame.write("XZYH");frame.writeUInt16LE(command,4);frame.writeUInt32LE(payload.length,6);frame[13]=sign;frame[12]=channel;
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
  const session=new FirstPartyPpcsSession({stationSerial:"SYNTHETIC1234567",p2pDid:"TEST-12345678-TEST",appConnection:"",dskKey:"synthetic",channel:3,homeBaseAttached:true,cameraModel:"T85V0",stationModel:"T8030",accountId:"synthetic-account",purpose:"control",resolveCipherKey:async()=>recipient.getPrivateKey().toString("hex")});
  await session.start();deliver(socket,1100,Buffer.concat([legacy.update(plain),legacy.final()]),1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(session.stats.level2,1);
  return {session,socket,sent};
}


const identity = { serial: "SYNTHETICLOCK001", accountId: "synthetic-account", channel: 3 };
const time = 0x65010203, sequence = 7;
const replyVector = "ff092a000300024822c0dc9806f1f1cc131506bfa0bb61a9b73793ef635fec3a764105b8a363517e34d2";

function encryptedReply(changes: Record<string, unknown> = {}): Buffer {
  const clear = Buffer.from(JSON.stringify({ cmd: 1940, payload: { apiCommand: 6012, time, seq_num: sequence, lock_payload: replyVector, ...changes } }));
  const iv = Buffer.alloc(12, 7), cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 9), iv);
  cipher.setAAD(Buffer.from("eufy security"));
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
  return Buffer.concat([cipher.getAuthTag(), iv, Buffer.alloc(4), encrypted]);
}

for (const mode of ["valid", "close", "timeout", "guard", "malformed"]) test(`attached status encrypted peer: ${mode}`, async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { session, socket, sent } = await peer(context);
  try {
    let guards = 0;
    const operation = session.readT85V0Status(identity, time, sequence, () => { guards++; if (mode === "guard") throw Error("binding moved"); });
    const failed = mode !== "valid" ? assert.rejects(operation, mode === "guard" ? /binding moved/ : /cancelled|timeout|malformed/) : null;
    await new Promise(resolve => setImmediate(resolve));
    if (mode === "guard") { await failed; assert.equal(guards, 1); return; }
    const commands = sent.filter(value => value.subarray(8,12).toString() === "XZYH");
    assert.deepEqual(commands.map(value => value.readUInt16LE(12)), [1100, 1350]);
    const wire = commands[1]!;
    assert.equal(wire[20], 3); assert.equal(wire[21], 8);
    const encrypted = wire.subarray(24), decipher = createDecipheriv("aes-256-gcm", Buffer.alloc(32, 9), encrypted.subarray(16,28));
    decipher.setAuthTag(encrypted.subarray(0,16)); decipher.setAAD(Buffer.from("eufy security"));
    const query = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(32)),decipher.final()]).toString());
    assert.equal(query.cmd,1940); assert.equal(query.payload.apiCommand,6012); assert.equal(query.mChannel,3);
    assert.equal(Buffer.from(query.payload.lock_payload,"hex").readUInt16BE(7),0x4022);
    assert.equal(session.stats.mediaStartAttempts,0);
    let settled = false; void operation.then(() => { settled = true; }, () => { settled = true; });
    deliver(socket,1351,encryptedReply(),8,1,4);
    deliver(socket,1351,Buffer.from(JSON.stringify({cmd:1940,payload:{apiCommand:6012,time,seq_num:sequence,lock_payload:replyVector}})),0,2);
    deliver(socket,1351,encryptedReply({seq_num:8}),8,3);
    const forged=encryptedReply();forged[0]!^=1;deliver(socket,1351,forged,8,4);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled,false);
    if(mode === "close") session.close();
    else if(mode === "timeout") context.mock.timers.tick(15_000);
    else deliver(socket,1351,encryptedReply(mode === "malformed" ? {lock_payload:"zz"} : {}),8,5);
    if(failed) await failed;
    else assert.deepEqual(await operation,{reportedState:"locked",batteryPercent:77,physicalConfirmationRequired:true});
    deliver(socket,1351,encryptedReply(),8,6);
    assert.equal(sent.filter(value=>value.subarray(8,12).toString()==="XZYH" && value.readUInt16LE(12)===1350).length,1);
  } finally { session.close();context.mock.timers.reset(); }
});
