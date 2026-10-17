/**
 * Exercises motion and retained-image ownership through synthetic provider pushes.
 * Test-owned cloud/session mocks forbid network and physical device operations.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver, parsePushEvent, type MegaPushEvent } from "../src/mega/push.js";

for (const mode of ["list","rejected","failure","absent"]) test(`motion and retained picture survive ${mode}`,async context=>{
  const network=context.mock.method(globalThis,"fetch",async()=>{throw Error("Network forbidden");});
  context.mock.method(MegaClient.prototype,"connect",async()=>({state:"authenticated"}));
  context.mock.method(MegaClient.prototype,"inventory",async()=>({devices:[{device_sn:"synthetic",device_model:"T8214",device_type:94,category:"eufy_security"}]}));
  context.mock.method(MegaClient.prototype,"dskKeys",async()=>({}));
  let deliver!:(event:MegaPushEvent)=>void;
  context.mock.method(MegaPushReceiver.prototype,"start",async function(this:MegaPushReceiver){deliver=Reflect.get(this,"onEvent") as typeof deliver;});
  const downloads:string[]=[];
  const jpeg=Buffer.from([255,216,1,2,255,217]);
  context.mock.method(MegaClient.prototype,"download",async(url:string)=>{downloads.push(url);if(mode==="failure")throw Error("Synthetic HTTP404");return jpeg;});
  let motions=0, publications=0;
  let retained: Buffer=Buffer.from("last-good");
  const events=new Proxy({motion:(_serial:string,value:boolean)=>{if(value)motions++;},snapshot:(_serial:string,data:Buffer)=>{retained=data;publications++;}},
    {get:(target,key)=>Reflect.get(target,key)??(()=>undefined)}) as unknown as ProviderEvents;
  const provider=new EufyProvider({username:"synthetic",password:"synthetic",country:"AU",persistentDirectory:"/nonexistent/synthetic",maxStreamSeconds:120});
  try {
    await provider.start(events);
    const raw=mode==="absent"?null:mode==="rejected"?Array(9).fill("https://example.invalid/first").join(","):
      "https://example.invalid/first,https://example.invalid/second";
    const event=parsePushEvent({device_sn:"synthetic",pic_url:raw,a:1,unique_id:"synthetic-event"})!;
    deliver(event);
    assert.equal(motions,1);
    for(let n=0;n<6;n++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(publications,mode==="list"?1:0);
    assert.deepEqual(retained,mode==="list"?jpeg:Buffer.from("last-good"));
    assert.deepEqual(downloads,["list","failure"].includes(mode)?["https://example.invalid/first"]:[]);
    deliver(event);for(let n=0;n<3;n++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(motions,1);assert.equal(network.mock.callCount(),0);
  } finally {await provider.close();}
});
