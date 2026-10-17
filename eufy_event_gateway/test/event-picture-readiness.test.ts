/**
 * Exercises media readiness and cancellation against synthetic HTTP responses.
 * Each test owns a temporary fake session, with no live credentials or network.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MegaClient } from "../src/mega/client.js";
import { credentialVerifier } from "../src/mega/crypto.js";

async function fixture(fetcher: typeof fetch, wait?: (milliseconds:number)=>Promise<void>) {
  const directory=await mkdtemp(join(tmpdir(),"picture-readiness-"));
  await writeFile(join(directory,"mega-session.json"),JSON.stringify({version:2,country:"au",openUdid:"synthetic",
    credentialVerifier:credentialVerifier("synthetic","test@example.invalid","synthetic"),authToken:"synthetic",tokenExpiresAt:2000000000,
    userId:"synthetic",megaDomain:"mega-eu-pr.eufy.com",domains:{},identities:{}}));
  const client=new MegaClient({email:"test@example.invalid",password:"synthetic",country:"AU",persistentDirectory:directory,
    minimumRequestIntervalMs:0,now:()=>1700000000000,fetch:fetcher,...(wait?{wait}:{})});
  await client.connect();
  return {client,dispose:async()=>{client.cancelPendingRequests();await rm(directory,{recursive:true,force:true});}};
}

for(const result of [200,404,401]) test(`bounded readiness and discarded bodies, final ${result}`,async()=>{
  const order:string[]=[],waits:number[]=[];let requests=0;
  const f=await fixture(async()=>{
    requests++;order.push(`fetch${requests}`);
    if(result===401) return new Response(new ReadableStream({cancel:()=>{order.push("cancel-final");}}),{status:401});
    if(requests<5 || result===404) return new Response(new ReadableStream({cancel:()=>{order.push(`cancel${requests}`);if(requests===2)throw Error("Synthetic cancel rejection");}}),{status:404});
    return new Response(Buffer.from([255,216,255,217]));
  },async milliseconds=>{waits.push(milliseconds);order.push("wait");});
  try {
    if(result===200) assert.equal((await f.client.download("https://security-app-eu.eufylife.com/image")).length,4);
    else await assert.rejects(f.client.download("https://security-app-eu.eufylife.com/image"),new RegExp(`HTTP ${result}`));
    assert.equal(requests,result===401?1:5);
    assert.deepEqual(waits,result===401?[]:[1000,2000,2000,5000]);
    if(result===401)assert.deepEqual(order,["fetch1","cancel-final"]);
    else {
      for(let n=1;n<=4;n++) assert.deepEqual(order.slice((n-1)*3,(n-1)*3+3),[`fetch${n}`,`cancel${n}`,"wait"]);
      if(result===404)assert.equal(order.at(-1),"cancel5");
    }
  } finally {await f.dispose();}
});

for(const injected of [false,true]) test(`abort during ${injected?"injected":"owned"} delay prevents another fetch`,async()=>{
  let calls=0,entered!:()=>void;
  const enteredWait=new Promise<void>(resolve=>{entered=resolve;});
  const f=await fixture(async()=>{calls++;if(!injected)setTimeout(()=>f.client.cancelPendingRequests(),10);return new Response(null,{status:404});},
    injected?async()=>{entered();await new Promise<void>(()=>undefined);}:undefined);
  try {
    const operation=assert.rejects(f.client.download("https://security-app-eu.eufylife.com/image"),/abort/i);
    if(injected){await enteredWait;f.client.cancelPendingRequests();}
    await operation;assert.equal(calls,1);
    await assert.rejects(f.client.download("https://security-app-eu.eufylife.com/image"),/abort/i);assert.equal(calls,1);
  } finally {await f.dispose();}
});

test("invalid selected host makes no request and redirects never forward credentials",async()=>{
  const headers:Headers[]=[];
  const f=await fixture(async(_url,options)=>{headers.push(new Headers(options?.headers));
    return headers.length===1?new Response(null,{status:302,headers:{location:"https://zhixin-security-synthetic.s3.eu-west-1.amazonaws.com/image"}}):new Response(Buffer.from([255,216,255,217]));});
  try {
    await assert.rejects(f.client.download("https://example.invalid/image"),/allowed Eufy host/);assert.equal(headers.length,0);
    assert.equal((await f.client.download("https://security-app-eu.eufylife.com/image")).length,4);
    assert.equal(headers[0]!.get("x-auth-token"),"synthetic");assert.equal([...headers[1]!.keys()].length,0);
  } finally {await f.dispose();}
});

test("a stalled discarded body cannot hold cancellation or trigger another request",async()=>{
  let entered!:()=>void,calls=0;
  const enteredCancel=new Promise<void>(resolve=>{entered=resolve;});
  const f=await fixture(async()=>{calls++;return new Response(new ReadableStream({cancel:()=>{entered();return new Promise<void>(()=>undefined);}}),{status:404});},async()=>{throw Error("Delay must not start");});
  try {
    const operation=assert.rejects(f.client.download("https://security-app-eu.eufylife.com/image"),/abort/i);
    await enteredCancel;f.client.cancelPendingRequests();await operation;assert.equal(calls,1);
  } finally {await f.dispose();}
});
