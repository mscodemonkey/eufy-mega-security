/**
 * Exercises calendar HTTP admission, query grammar and cancellation on localhost.
 * Synthetic providers and temporary servers own all state. No vendor account,
 * hardware, recordings or production gateway is contacted.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";
import { CloudCalendarError, type CloudCalendarResult } from "../src/mega/cloud-calendar.js";

async function fixture(provider: Partial<CameraProvider>, flag=true, token="x".repeat(32), deadline=30000) {
  const directory=await mkdtemp(join(tmpdir(),"calendar-http-")), state=new GatewayState();
  state.registerCamera({serial:"cam",name:"Synthetic",model:"T8113-Z",stationSerial:"hub",streamSupported:false,doorbellSupported:false});
  const server=new GatewayServer({...loadConfig({}),port:0,apiToken:token,experimentalCloudRecordings:flag},
    state,new SnapshotStore(directory),{} as LiveStreamManager,provider as CameraProvider,null,null,null,82000,deadline);
  await server.listen();
  return {server,url:`http://127.0.0.1:${server.port}/api/cameras/cam/cloud-calendar`,
    headers:{authorization:`Bearer ${token}`},close:async()=>{await server.close();await rm(directory,{recursive:true,force:true});}};
}

test("calendar authenticates before ordered admission and never contacts a provider for invalid input",async()=>{
  let calls=0;
  const provider={cloudCalendar:async()=>{calls++;return {month:"2026-10",days:[1,4]};}};
  for(const [implementation,flag,token,expected] of [[{},true,"x".repeat(32),501],[provider,false,"x".repeat(32),409],
    [provider,true,"",409]] as const){
    const f=await fixture(implementation,flag,token);
    try {
      if(token) {const denied=await fetch(f.url);assert.equal(denied.status,401);assert.equal(denied.headers.get("cache-control"),"no-store");}
      const result=await fetch(f.url,{headers:f.headers});assert.equal(result.status,expected);assert.equal(result.headers.get("cache-control"),"no-store");
    }finally{await f.close();}
  }
  const f=await fixture(provider);
  try {
    assert.equal((await fetch(f.url.replace("/cam/","/other/"),{headers:f.headers})).status,404);
    for(const query of ["","month=2026-10&month=2026-10","month=2026-10&extra=1","month=2026-10&offset=0&offset=0",
      "month=2026-13","month=2026-10&offset=","month=2026-10&offset=1e3","month=2026-10&offset=%2B0",
      "month=2026-10&offset=-0","month=2026-10&offset=00","month=2026-10&offset=61","month=2101-01"]){
      const result=await fetch(f.url+'?'+query,{headers:f.headers});assert.equal(result.status,400,query);
      assert.equal(result.headers.get("cache-control"),"no-store");assert.deepEqual(await result.json(),{error:"Invalid cloud calendar query"});
    }
    assert.equal(calls,0);
    const result=await fetch(f.url+'?month=2026-10&offset=36000',{headers:f.headers});
    assert.equal(result.status,200);assert.deepEqual(await result.json(),{month:"2026-10",days:[1,4]});assert.equal(calls,1);
  }finally{await f.close();}
});

test("calendar fixes operational errors and releases its slot after every failure",async()=>{
  let calls=0;
  const f=await fixture({cloudCalendar:async()=>{calls++;if(calls===1)throw new CloudCalendarError("response");throw Error("PRIVATE_SENTINEL");}});
  try {
    for(const stage of ["response","request","request"]){
      const result=await fetch(f.url+'?month=2026-10',{headers:f.headers});assert.equal(result.status,502);
      assert.deepEqual(await result.json(),{error:"Cloud calendar unavailable",stage});
    }
    assert.equal(calls,3);
  }finally{await f.close();}
});

test("calendar bounds concurrency, cancellation and a provider that ignores the deadline",async()=>{
  const releases:Array<(value:CloudCalendarResult)=>void>=[];
  const signals:AbortSignal[]=[];
  let notify!:()=>void;
  const entered=new Promise<void>(resolve=>{notify=resolve;});
  const f=await fixture({cloudCalendar:async(_camera,_query,signal)=>{
    signals.push(signal);if(signals.length===2)notify();
    return await new Promise<CloudCalendarResult>(resolve=>{releases.push(resolve);});
  }},true,"x".repeat(32),200);
  try {
    const first=fetch(f.url+'?month=2026-10',{headers:f.headers}),second=fetch(f.url+'?month=2026-10',{headers:f.headers});
    await entered;
    const busy=await fetch(f.url+'?month=2026-10',{headers:f.headers});assert.equal(busy.status,502);
    assert.deepEqual(await busy.json(),{error:"Cloud calendar unavailable",stage:"admission"});
    for(const result of await Promise.all([first,second])){assert.equal(result.status,502);assert.equal((await result.json()).stage,"request");}
    assert.ok(signals.every(signal=>signal.aborted));
    for(const resolve of releases)resolve({month:"2026-10",days:[1]});
  }finally{for(const resolve of releases)resolve({month:"2026-10",days:[]});await f.close();}
});

test("calendar client disconnect cancels while a normal response does not",async()=>{
  let entered!:()=>void,finish!:()=>void,aborted!:()=>void,signal:AbortSignal|undefined,calls=0;
  const ready=new Promise<void>(resolve=>{entered=resolve;}),stopped=new Promise<void>(resolve=>{aborted=resolve;});
  const held=new Promise<void>(resolve=>{finish=resolve;});
  const f=await fixture({cloudCalendar:async(_camera,_query,active)=>{
    calls++;signal=active;if(calls===1){active.addEventListener("abort",aborted,{once:true});entered();await held;}
    return {month:"2026-10",days:[]};
  }});
  try {
    const controller=new AbortController();
    const failed=assert.rejects(fetch(f.url+'?month=2026-10',{headers:f.headers,signal:controller.signal}),/abort/i);
    await ready;controller.abort();await stopped;await failed;assert.equal(signal?.aborted,true);finish();
    const result=await fetch(f.url+'?month=2026-10',{headers:f.headers});assert.equal(result.status,200);await result.text();
    await new Promise(resolve=>setImmediate(resolve));assert.equal(signal?.aborted,false);
  }finally{finish();await f.close();}
});
