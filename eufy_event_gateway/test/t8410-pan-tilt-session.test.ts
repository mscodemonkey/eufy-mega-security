/**
 * Tests negotiated HomeBase pan writes on isolated and borrowed media connections.
 * Synthetic sockets and keys exercise the real session without network access.
 */
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createECDH, createHmac } from "node:crypto";
import { Socket } from "node:dgram";
import test, { type TestContext } from "node:test";
import { T8410 } from "../src/stream/t8410-pan-tilt.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";

/** Deliver a synthetic XZYH frame through the real session's socket listener. */
function deliver(socket:Socket,command:number,payload:Buffer,sign=0,sequence=0,channel=0,ack=false):void {
  const frame=Buffer.alloc(16);frame.write("XZYH");frame.writeUInt16LE(command,4);frame.writeUInt32LE(payload.length,6);frame[13]=sign;frame[12]=channel;frame[14]=ack?1:0;
  const header=Buffer.from([0xf1,0xd0,0,0,0xd1,0,0,0]);header.writeUInt16BE(sequence,6);
  socket.emit("message",Buffer.concat([header,frame,payload]),{address:"127.0.0.1",port:12345});
}

/** Negotiate a real synthetic level-two key without network access or private-field hooks. */
async function peer(context:TestContext, purpose: "media" | "control" | "passive" | undefined, channel = 2) {
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
  const session=new FirstPartyPpcsSession({stationSerial:"SYNTHETIC1234567",p2pDid:"TEST-12345678-TEST",appConnection:"",dskKey:"synthetic",channel,homeBaseAttached:true,cameraModel:"T81A0",stationModel:"T8030",stationDeviceType:18,accountId:"synthetic-account",...(purpose ? {purpose} : {}),resolveCipherKey:async()=>recipient.getPrivateKey().toString("hex")});
  await session.start();deliver(socket,1100,Buffer.concat([legacy.update(plain),legacy.final()]),1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(session.stats.level2,1);
  return {session,socket,sent};
}

test("T8410 uses negotiated encryption on its isolated child channel", async context => {
  const { session, socket, sent } = await peer(context, "control");
  const before = sent.length, mediaStarts = session.stats.mediaStartAttempts;
  let settled = false;
  const operation = session.movePanTilt("left", () => {}, transport => new T8410(transport, 2)).then(() => { settled = true; });
  void operation.catch(() => {});
  try {
    await new Promise(resolve => setImmediate(resolve));
    const commands = sent.slice(before).filter(packet => packet.indexOf("XZYH") >= 0);
    assert.equal(commands.length, 1);
    const packet = commands[0]!, offset = packet.indexOf("XZYH");
    assert.equal(packet.readUInt16LE(offset + 4), 1700);
    assert.equal(packet[offset + 12], 2); assert.equal(packet[offset + 13], 8);
    const body = packet.subarray(offset + 16);
    const decipher = createDecipheriv("aes-256-gcm", Buffer.alloc(32, 9), body.subarray(16, 28));
    decipher.setAAD(Buffer.from("eufy security")); decipher.setAuthTag(body.subarray(0, 16));
    const value = JSON.parse(Buffer.concat([decipher.update(body.subarray(32)), decipher.final()]).toString());
    assert.equal(value.commandType, 6030); assert.equal(value.data.rotate_type, 1);
    await assert.rejects(session.movePanTilt("right", () => {}, transport => new T8410(transport, 2)), /unavailable/);
    const result = Buffer.alloc(132, 0xa5); result.writeInt32LE(0);
    deliver(socket, 1700, result, 0, 1, 3, true);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    deliver(socket, 1700, result, 0, 2, 2, true);
    await operation;
    assert.equal(session.stats.closeReason, "open"); assert.equal(session.stats.mediaStartAttempts, mediaStarts);
    // A second movement uses the same negotiated session and a fresh level-two sequence.
    const next = session.movePanTilt("right", () => {}, transport => new T8410(transport, 2));
    await new Promise(resolve => setImmediate(resolve));
    const second = sent.filter(packet => { const at = packet.indexOf("XZYH"); return at >= 0 && packet.readUInt16LE(at + 4) === 1700; }).at(-1)!;
    assert.notEqual(second[second.indexOf("XZYH") + 16 + 28], body[28]);
    deliver(socket, 1700, result, 0, 3, 2, true); await next;
  } finally { session.close(); await operation.catch(() => {}); }
});


test("a late movement receipt cannot acknowledge a second move on the same viewer channel", async context => {
  const { session, socket, sent } = await peer(context, "media", 1);
  session.stats.videoOutputFrames = 1;
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const move = (direction: "left" | "right", channel: number) =>
    session.movePanTilt(direction, () => {}, transport => new T8410(transport, channel), channel);
  try {
    const first = assert.rejects(move("left", 2), /timed out/);
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(10_000);
    await first;
    const before = sent.length;
    const second = move("right", 2);
    const rejected = assert.rejects(second, /unavailable/);
    void rejected.catch(() => undefined);
    await new Promise(resolve => setImmediate(resolve));
    deliver(socket, 1700, Buffer.alloc(4), 0, 1, 2, true);
    await rejected;
    const newMoves = sent.slice(before).filter(packet => {
      const at = packet.indexOf("XZYH");
      return at >= 0 && packet.readUInt16LE(at + 4) === 1700;
    });
    assert.equal(newMoves.length, 0);
    const sibling = move("right", 3);
    await new Promise(resolve => setImmediate(resolve));
    deliver(socket, 1700, Buffer.alloc(4), 0, 2, 3, true);
    await sibling;
    assert.equal(session.stats.closeReason, "open");
  } finally {
    context.mock.timers.reset();
    session.close();
    await session.waitUntilClosed();
  }
});

test("T8410 cannot borrow a viewer before video is ready", async context => {
  const { session, sent } = await peer(context, "media");
  const before = sent.length;
  try {
    await assert.rejects(session.movePanTilt("left", () => {}, transport => new T8410(transport, 2)), /unavailable/);
    assert.equal(sent.length, before); assert.equal(session.stats.closeReason, "open");
  } finally { session.close(); }
});

test("isolated pan cannot address a sibling or an invalid channel", async context => {
  const { session, sent } = await peer(context, "control", 2);
  const before = sent.length;
  let controllers = 0;
  try {
    for (const channel of [1, -1, 255, 1.5, NaN]) {
      await assert.rejects(session.movePanTilt("left", () => {}, transport => {
        controllers++;
        return new T8410(transport, channel);
      }, channel), /unavailable/);
    }
    assert.equal(controllers, 0);
    assert.equal(sent.length, before);
    assert.equal(session.stats.closeReason, "open");
  } finally { session.close(); }
});

for (const purpose of ["media",undefined] as const) test(`borrowed pan uses ${purpose ?? "default media"} viewer encryption without restarting video`, async context => {
  const { session, socket, sent } = await peer(context, purpose, 1);
  session.stats.videoOutputFrames = 1;
  const before = sent.length, starts = session.stats.mediaStartAttempts;
  let settled = false;
  const operation = session.movePanTilt("left", () => {}, transport => new T8410(transport, 2), 2).then(() => { settled = true; });
  void operation.catch(() => {});
  try {
    await new Promise(resolve => setImmediate(resolve));
    const commands = sent.slice(before).filter(packet => packet.indexOf("XZYH") >= 0);
    assert.equal(commands.length, 1);
    const packet = commands[0]!, offset = packet.indexOf("XZYH");
    assert.equal(packet.readUInt16LE(offset+4), 1700); assert.equal(packet[offset+12], 2); assert.equal(packet[offset+13], 8);
    const body = packet.subarray(offset+16);
    const decipher = createDecipheriv("aes-256-gcm", Buffer.alloc(32,9), body.subarray(16,28));
    decipher.setAAD(Buffer.from("eufy security")); decipher.setAuthTag(body.subarray(0,16));
    const value = JSON.parse(Buffer.concat([decipher.update(body.subarray(32)),decipher.final()]).toString());
    assert.equal(value.commandType,6030); assert.equal(value.data.rotate_type,1);
    const result = Buffer.alloc(132,0xa5); result.writeInt32LE(0);
    deliver(socket,1700,result,0,1,1,true);
    await new Promise(resolve=>setImmediate(resolve)); assert.equal(settled,false);
    deliver(socket,1700,result,0,2,2,true); await operation;
    assert.equal(session.stats.closeReason,"open"); assert.equal(session.stats.mediaStartAttempts,starts);
    await assert.rejects(session.movePanTilt("left",()=>{},transport=>new T8410(transport,1),255),/unavailable/);
  } finally { session.close(); await operation.catch(()=>{}); }
});


test("viewer binding rejects changed connection identity and closed sessions", async context => {
  const {session}=await peer(context,"media",1);
  const binding={stationSerial:"SYNTHETIC1234567",p2pDid:"TEST-12345678-TEST",appConnection:"",channel:1,accountId:"synthetic-account"};
  assert.equal(session.hasHomeBaseViewerBinding(binding),false);
  session.stats.videoOutputFrames=1; assert.equal(session.hasHomeBaseViewerBinding(binding),true);
  for (const change of [{stationSerial:"other"},{p2pDid:"other"},{appConnection:"other"},{channel:2},{accountId:"other"}]) {
    assert.equal(session.hasHomeBaseViewerBinding({...binding,...change}),false);
  }
  session.close(); assert.equal(session.hasHomeBaseViewerBinding(binding),false);
});


test("passive connections cannot lend their transport to movement", async context => {
  const {session}=await peer(context,"passive",1);
  session.stats.videoOutputFrames=1;
  try {
    await assert.rejects(session.movePanTilt("left",()=>{},transport=>new T8410(transport,2),2),/unavailable/);
  } finally { session.close(); }
});

test("controller transport decodes protected receipts only for its target channel", async context => {
  const { session } = await peer(context, "control", 2);
  try {
    await session.movePanTilt("left", () => {}, transport => {
      const controller = new T8410(transport, 2);
      context.mock.method(controller, "movePanTilt", async () => {
        const header = Buffer.alloc(16);
        header.write("XZYH");
        header.writeUInt16LE(1700, 4); header[12] = 2; header[13] = 1; header[14] = 1;
        const clear = Buffer.alloc(16); clear.writeInt32LE(-3);
        const cipher = createCipheriv("aes-128-ecb", Buffer.from("1234567-12345678"), null);
        cipher.setAutoPadding(false);
        const payload = Buffer.concat([cipher.update(clear), cipher.final()]);
        assert.equal(transport.decodeResult(header, payload, 1700, 2), -3);
        assert.equal(transport.decodeResult(header, payload, 1700, 1), null);
        assert.equal(transport.decodeResult(header, payload, 6030, 2), null);
        assert.equal(transport.decodeResult(Buffer.alloc(0), payload, 1700, 2), null);
        const foreign = Buffer.from(header); foreign[12] = 1;
        assert.equal(transport.decodeResult(foreign, payload, 1700, 2), null);
      });
      return controller;
    });
    assert.equal(session.stats.closeReason, "open");
  } finally { session.close(); }
});
