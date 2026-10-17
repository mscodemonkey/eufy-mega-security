/**
 * Exercises passive HomeBase notifications with a synthetic encrypted peer.
 * Tests own sockets and keys, and assert that only handshake commands are sent.
 */
import assert from "node:assert/strict";
import { createCipheriv, createECDH, createHmac } from "node:crypto";
import { Socket } from "node:dgram";
import test, { type TestContext } from "node:test";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import type { SensorMotionObservation } from "../src/stream/sensor-status-notification.js";

/** Deliver a synthetic XZYH frame through the real session's socket listener. */
function deliver(socket:Socket,command:number,payload:Buffer,sign=0,sequence=0):void {
  const frame=Buffer.alloc(16);frame.write("XZYH");frame.writeUInt16LE(command,4);frame.writeUInt32LE(payload.length,6);frame[13]=sign;
  const header=Buffer.from([0xf1,0xd0,0,0,0xd1,0,0,0]);header.writeUInt16BE(sequence,6);
  socket.emit("message",Buffer.concat([header,frame,payload]),{address:"127.0.0.1",port:12345});
}

/** Negotiate a real synthetic level-two key without network access or private-field hooks. */
async function peer(context:TestContext, observe: (observation: SensorMotionObservation) => void) {
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
  const session=new FirstPartyPpcsSession({stationSerial:"SYNTHETIC1234567",p2pDid:"TEST-12345678-TEST",appConnection:"",dskKey:"synthetic",channel:0,homeBaseAttached:true,cameraModel:"T8910",accountId:"synthetic-account",purpose:"passive",onSensorMotion:observe,resolveCipherKey:async()=>recipient.getPrivateKey().toString("hex")});
  await session.start();deliver(socket,1100,Buffer.concat([legacy.update(plain),legacy.final()]),1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(session.stats.level2,1);
  return {session,socket,sent};
}

test("passive handshake decrypts motion and never starts media or controls", async context => {
  const observations: SensorMotionObservation[] = [];
  const { session, socket, sent } = await peer(context, observation => observations.push(observation));
  const clear = Buffer.from(JSON.stringify({cmd:1829,payload:{params:[{dev_type:3,param_type:1605,param_value:1800000000000}]}}));
  try {
    deliver(socket, 1351, clear, 0, 1);
    const iv = Buffer.alloc(12, 7), cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 9), iv);
    cipher.setAAD(Buffer.from("eufy security"));
    const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
    deliver(socket, 1351, Buffer.concat([cipher.getAuthTag(), iv, Buffer.alloc(4), encrypted]), 8, 2);
    assert.deepEqual(observations, [{channel:3,triggeredAt:1800000000000}, {channel:3,triggeredAt:1800000000000}]);
    assert.equal(session.stats.mediaStartAttempts, 0);
    const commands = sent.filter(value => value.subarray(8,12).toString() === "XZYH").map(value => value.readUInt16LE(12));
    assert.deepEqual(commands, [1100]);
    deliver(socket, 1300, Buffer.alloc(4), 0, 3);
    assert.equal(session.stats.closeReason, "client_stop");
    deliver(socket, 1351, clear, 0, 4);
    assert.equal(observations.length, 2);
  } finally { session.close(); }
});
