/**
 * Checks authenticated consent and recovery ownership with an ephemeral server.
 * Synthetic providers return summaries without contacting a device or cloud.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { diagnosticsPage } from "../src/diagnostics/page.js";
import { GatewayState } from "../src/domain/gateway-state.js";
import type { CameraProvider } from "../src/provider/provider.js";
import { GatewayServer } from "../src/server.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { LiveStreamManager } from "../src/stream/live-stream-manager.js";

const headers={authorization:`Bearer ${"x".repeat(32)}`,"content-type":"application/json"};
const consent={consent:true,originalPower:"on",target:"off"};
const summary={outcome:"target_confirmed" as const,restored:true as const,physicalConfirmationRequired:true as const};

for(const disabled of ["none","controls","models","video"]) test(`NVR power HTTP consent and flags: ${disabled}`,async()=>{
  const directory=await mkdtemp(join(tmpdir(),"nvr-power-http-"));
  const state=new GatewayState();state.registerCamera({serial:"synthetic",name:"Synthetic",model:"T8E00",stationSerial:"station",streamSupported:true,doorbellSupported:false});
  let calls=0,busy=false;
  const provider={testNvrCameraPower:async(serial:string,input:unknown,signal:AbortSignal)=>{
    calls++;assert.equal(serial,"synthetic");assert.deepEqual(input,{originalPower:"on",target:"off"});assert.equal(signal.aborted,false);
    return {...summary,privateCanary:"PRIVATE-CANARY"};
  }} as unknown as CameraProvider;
  const server=new GatewayServer({...loadConfig({}),port:0,apiToken:"x".repeat(32),experimentalNvrControls:disabled!=="controls",
    experimentalModelControls:disabled!=="models",experimentalNvrLive:disabled!=="video"},state,new SnapshotStore(directory),
    {hasActiveSession:()=>busy} as unknown as LiveStreamManager,provider,null);
  try {
    await server.listen();const url=`http://127.0.0.1:${server.port}/api/cameras/synthetic/nvr-power-trial`;
    const options={method:"POST",headers,body:JSON.stringify(consent)};
    assert.equal((await fetch(url,{...options,headers:{}})).status,401);
    if(disabled!=="none"){assert.equal((await fetch(url,options)).status,409);assert.equal(calls,0);return;}
    for(const body of [{},{...consent,consent:false},{...consent,extra:true},{...consent,target:["off"]},{...consent,originalPower:null}])
      assert.equal((await fetch(url,{...options,body:JSON.stringify(body)})).status,400);
    for(const body of ['{"consent":false,"consent":true,"originalPower":"on","target":"off"}',
      '{"consent":true,"originalPower":"on","target":"off","target":"off"}',JSON.stringify({...consent,extra:"x".repeat(16384)})])
      assert.equal((await fetch(url,{...options,body})).status,400);
    assert.equal((await fetch(url+"?force=true",options)).status,400);
    assert.equal((await fetch(url.replace("synthetic/","unknown/"),options)).status,404);
    assert.equal((await fetch(url,{...options,headers:{...headers,"content-type":"text/plain"}})).status,415);
    busy=true;assert.equal((await fetch(url,options)).status,409);busy=false;
    const response=await fetch(url,options);assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
    assert.deepEqual(await response.json(),summary);assert.equal(calls,1);
    assert.equal(state.getCamera("synthetic").streamSupported,true);
  } finally {await server.close();await rm(directory,{recursive:true,force:true});}
});

test("client cancellation retains the global job until restoration finishes",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"nvr-power-cancel-"));
  const state=new GatewayState();state.registerCamera({serial:"synthetic",name:"Synthetic",model:"T8E00",stationSerial:"station",streamSupported:true,doorbellSupported:false});
  let enter!:()=>void,abort!:()=>void,finish!:()=>void,calls=0;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),aborted=new Promise<void>(resolve=>{abort=resolve;}),restored=new Promise<void>(resolve=>{finish=resolve;});
  const provider={testNvrCameraPower:async(_serial:string,_input:unknown,signal:AbortSignal)=>{
    calls++;if(calls===1){signal.addEventListener("abort",abort,{once:true});enter();await restored;}return summary;
  }} as unknown as CameraProvider;
  const server=new GatewayServer({...loadConfig({}),port:0,apiToken:"x".repeat(32),experimentalNvrControls:true,experimentalModelControls:true,experimentalNvrLive:true},
    state,new SnapshotStore(directory),{hasActiveSession:()=>false} as unknown as LiveStreamManager,provider,null);
  const controller=new AbortController();
  try {
    await server.listen();const url=`http://127.0.0.1:${server.port}/api/cameras/synthetic/nvr-power-trial`;
    const options={method:"POST",headers,body:JSON.stringify(consent)};
    const request=assert.rejects(fetch(url,{...options,signal:controller.signal}),/abort/i);
    await entered;controller.abort();await aborted;await request;
    assert.equal((await fetch(url,options)).status,409);assert.equal(calls,1);
    finish();await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await fetch(url,options)).status,200);assert.equal(calls,2);
  } finally {finish();controller.abort();await server.close();await rm(directory,{recursive:true,force:true});}
});

test("Diagnostics makes observation and cancellation limits explicit",()=>{
  const page=diagnosticsPage();
  assert.match(page,/id="nvr-power-consent" type="checkbox"/);assert.doesNotMatch(page,/id="nvr-power-consent"[^>]*checked/);
  assert.match(page,/pagehide', cancelNvrPower/);assert.match(page,/change', cancelNvrPower/);
  assert.match(page,/A lost connection or gateway restart can prevent automatic restoration/);
  new Function(page.split("<script>")[1]!.split("</script>")[0]!);
});
