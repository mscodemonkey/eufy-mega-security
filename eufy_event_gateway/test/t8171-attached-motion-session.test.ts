/**
 * Tests attached E30 motion bytes and receipt isolation with synthetic peers.
 * Tests own sockets, keys and timers. Production negotiation runs without
 * hardware, private state hooks or external network access.
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
  const session=new FirstPartyPpcsSession({stationSerial:"SYNTHETIC1234567",p2pDid:"TEST-12345678-TEST",appConnection:"",dskKey:"synthetic",channel:1,homeBaseAttached:true,cameraModel:"T8171",cameraDeviceType:88,stationModel:"T8030",accountId:"synthetic-account",purpose:"control",modelControlTrial:true,resolveCipherKey:async()=>recipient.getPrivateKey().toString("hex"),...options});
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

for (const enabled of [false, true]) {
  for (const outcome of ["success", "wrong-channel", "rejected", "timeout", "short-reply", "long-reply"]) {
    test(`attached E30 motion sends once, enabled=${enabled}, outcome=${outcome}`, async context => {
      const { session, socket, sent } = await peer(context);
      const operation = session.writeMotionDetection(enabled, undefined, "fresh-inventory");
      const result = ["rejected", "timeout", "short-reply", "long-reply"].includes(outcome) ? assert.rejects(operation) : operation;
      try {
        await new Promise(resolve => setImmediate(resolve));
        const writes = commands(sent).filter(packet => packet.readUInt16LE(12) === 1011);
        assert.equal(writes.length, 1);
        const request = writes[0]!;
        assert.equal(request[20], 1); assert.equal(request[21], 8);
        const encrypted = request.subarray(24);
        const decryptor = createDecipheriv("aes-256-gcm", Buffer.alloc(32, 9), encrypted.subarray(16, 28));
        decryptor.setAAD(Buffer.from("eufy security")); decryptor.setAuthTag(encrypted.subarray(0, 16));
        const clear = Buffer.concat([decryptor.update(encrypted.subarray(32)), decryptor.final()]);
        assert.equal(clear.length, 136);
        assert.equal(clear.readUInt32LE(0), 1); assert.equal(clear.readUInt32LE(4), Number(enabled));
        assert.equal(clear.subarray(8).toString("ascii").replace(/\0+$/, ""), "synthetic-account");
        const receipt = Buffer.alloc(132); receipt[4] = 62; receipt[8] = 205;
        if (outcome === "rejected") receipt.writeInt32LE(-1);
        if (outcome === "wrong-channel") {
          let settled = false; void operation.then(() => { settled = true; });
          deliver(socket, 1011, receipt, 0, 1, 2, true);
          await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
        }
        if (outcome === "short-reply" || outcome === "long-reply") {
          deliver(socket, 1011, Buffer.alloc(outcome === "short-reply" ? 4 : 133), 0, 1, 1, true);
          context.mock.timers.tick(2_001);
        } else if (outcome === "timeout") context.mock.timers.tick(2_001);
        else deliver(socket, 1011, receipt, 0, outcome === "wrong-channel" ? 2 : 1, 1, true);
        await result; context.mock.timers.tick(1_000);
        assert.equal(commands(sent).filter(packet => packet.readUInt16LE(12) === 1011).length, 1);
        assert.equal(commands(sent).filter(packet => packet.readUInt16LE(12) === 1700).length, 0);
        assert.equal(session.stats.mediaStartAttempts, 0);
      } finally { session.close(); await operation.catch(() => undefined); context.mock.timers.reset(); }
    });
  }
}

for (const options of [{ stationModel: "T8010" }, { cameraDeviceType: 89 }, { channel: 32 }, { channel: -1 }]) {
  test(`attached E30 refuses unqualified transport ${JSON.stringify(options)}`, async context => {
    const { session, sent } = await peer(context, options);
    try {
      await assert.rejects(session.writeMotionDetection(true));
      assert.equal(commands(sent).filter(packet => packet.readUInt16LE(12) === 1011).length, 0);
    } finally { session.close(); context.mock.timers.reset(); }
  });
}
