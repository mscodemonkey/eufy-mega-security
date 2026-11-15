/**
 * Qualifies streaming C31 audio through independently decrypted native wire frames.
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
  const session=new FirstPartyPpcsSession({stationSerial:"SYNTHETIC1234567",p2pDid:"TEST-12345678-TEST",appConnection:"",dskKey:"synthetic",channel:0,homeBaseAttached:false,cameraModel:"T817L",cameraDeviceType:10031,accountId:"synthetic-account",purpose:"media",modelControlTrial:true,resolveCipherKey:async()=>recipient.getPrivateKey().toString("hex"),...options});
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


/** Decode protected controls independently of the session's encoder. */
function control(packet: Buffer): number {
  const body = packet.subarray(24);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.alloc(32, 9), body.subarray(16, 28));
  decipher.setAAD(Buffer.from("eufy security")); decipher.setAuthTag(body.subarray(0, 16));
  return JSON.parse(Buffer.concat([decipher.update(body.subarray(32)), decipher.final()]).toString()).commandType;
}

/** Deliver only a selected video ACK, from the already negotiated synthetic peer. */
function acknowledge(socket: Socket, packet: Buffer): void {
  const ack = Buffer.from([0xf1, 0xd1, 0, 6, 0xd1, 1, 0, 1, 0, 0]);
  packet.copy(ack, 8, 6, 8);
  socket.emit("message", ack, { address: "127.0.0.1", port: 12345 });
}

/** Yield one valid native frame while a test owns the producer's retirement. */
function audio(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xf9, 0x60, 0x40, 4, 0x1f, 0xfc]), Buffer.alloc(25)]);
}

for (const cancel of [false, true]) test(`C31 live native lifecycle, cancellation=${cancel}`, async context => {
  const { session, socket, sent } = await peer(context);
  const abort = new AbortController();
  let retire!: () => void;
  const held = new Promise<void>(resolve => { retire = resolve; });
  async function* input(): AsyncGenerator<Buffer> { yield audio(); await held; if (!cancel) yield audio(); }
  const summaries: unknown[] = [];
  const operation = session.playC31AudioStream(input(), abort.signal, summary => summaries.push(summary));
  const settled = cancel ? assert.rejects(operation) : operation;
  try {
    const deadline = performance.now() + 2_000;
    while (!commands(sent).some(packet => packet.readUInt16LE(12) === 1301)) {
      assert.ok(performance.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
    }
    await assert.rejects(session.playC31AudioStream(input()), /owned standalone|unavailable/);
    const first = commands(sent).find(packet => packet.readUInt16LE(12) === 1301)!;
    assert.equal(first[5], 1); assert.equal(first[20], 0); assert.equal(first[21], 0);
    assert.equal(first.readUInt32LE(24), audio().length);
    assert.ok(first.subarray(28, 40).every(byte => byte === 0));
    assert.deepEqual(first.subarray(40), audio());
    acknowledge(socket, first);
    if (cancel) abort.abort();
    retire();
    if (!cancel) {
      while (commands(sent).filter(packet => packet.readUInt16LE(12) === 1301).length < 2) {
        assert.ok(performance.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
      }
      acknowledge(socket, commands(sent).filter(packet => packet.readUInt16LE(12) === 1301)[1]!);
    }
    await settled;
    assert.deepEqual(commands(sent).filter(packet => packet.readUInt16LE(12) === 1700 && packet[21] === 8).map(control).filter(value => value === 1001 || value === 1002), [1001, 1002]);
    assert.equal(summaries.length, 1);
    assert.deepEqual(summaries[0], { sentFrames: cancel ? 1 : 2, acknowledgedFrames: cancel ? 1 : 2,
      retransmissions: 0, stopAttempts: 1, pendingFrames: 0 });
    assert.equal(session.stats.closeReason, "open");
  } finally { retire(); abort.abort(); await operation.catch(() => undefined); session.close(); }
});

for (const options of [{cameraModel:"T817LX"}, {cameraDeviceType:10035}, {homeBaseAttached:true}, {channel:1},
  {purpose:"control" as const}, {purpose:"passive" as const}]) test(`C31 live rejects mismatched owner ${JSON.stringify(options)}`, async context => {
  const { session, sent } = await peer(context, options);
  async function* input(): AsyncGenerator<Buffer> { yield audio(); }
  try {
    const before = sent.length;
    await assert.rejects(session.playC31AudioStream(input()));
    assert.equal(sent.length, before);
  } finally { session.close(); }
});


test("failed native speaker stop retires the original C31 transport", async context => {
  const { session, socket } = await peer(context);
  context.mock.method(Socket.prototype, "send", function(packet: Buffer) {
    if (packet.length >= 24 && packet.subarray(8, 12).toString() === "XZYH") {
      if (packet.readUInt16LE(12) === 1301) queueMicrotask(() => acknowledge(socket, packet));
      if (packet.readUInt16LE(12) === 1700 && packet[21] === 8 && control(packet) === 1002) throw new Error("synthetic stop failed");
    }
  });
  async function* input(): AsyncGenerator<Buffer> { yield audio(); }
  try {
    await assert.rejects(session.playC31AudioStream(input()), /synthetic stop failed/);
    assert.equal(session.stats.closeReason, "client_stop");
  } finally { session.close(); }
});
