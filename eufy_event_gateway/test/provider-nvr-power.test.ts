/**
 * Verifies exact NVR trial admission and parent ownership using synthetic cloud
 * rows and sessions. No socket or physical setting is accessed by these tests.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { NvrRtcSession } from "../src/stream/nvr-rtc-session.js";
import { NvrGuardError } from "../src/provider/nvr-guard-trial.js";
import { NvrPowerError, type NvrCameraPower } from "../src/provider/nvr-power-trial.js";

for(const mode of ["valid","busy","controls-disabled","model-disabled","video-disabled","model","type","parent","parent-type","owner","shared","duplicate","changed","cloud-restore-failure","malformed-restore","cancel","shutdown","queued-inventory","stalled-prepare","stalled-validate","stalled-signalling","cancel-before","stalled-recovery","stalled-fallback"])
  test(`NVR power provider: ${mode}`,async context=>{
    const directory=await mkdtemp(join(tmpdir(),"nvr-power-provider-"));
    const network=context.mock.method(globalThis,"fetch",async()=>{throw Error("Network forbidden");});
    context.mock.method(MegaClient.prototype,"connect",async()=>({state:"authenticated"}));
    context.mock.method(MegaClient.prototype,"isAuthenticatedUser",(id:string)=>mode!=="shared"&&id==="synthetic-owner");
    const child={device_sn:"synthetic-camera",device_model:mode==="model"?"T8140":"T8E00",device_type:mode==="type"?302:301,device_channel:3,parent_sn:"synthetic-station",category:"eufy_security",member:{admin_user_id:mode==="owner"?"other-owner":"synthetic-owner"}};
    const parent={device_sn:"synthetic-station",device_model:mode==="parent"?"T9000":"T8N00",device_type:mode==="parent-type"?27:300,category:"eufy_security",member:{admin_user_id:"synthetic-owner"}};
    const sibling={...child,device_sn:"synthetic-sibling",device_channel:4};
    let reads=0,recovery=false,state:NvrCameraPower="on";
    const writes:NvrCameraPower[]=[];
    context.mock.method(MegaClient.prototype,"inventory",async(signal?:AbortSignal)=>{
      reads++;
      if(mode === "cancel-before" && reads === 3) controller.abort();
      if(reads > 1 && mode === "queued-inventory") await new Promise(resolve=>setTimeout(resolve,6000));
      if(reads > 1 && (mode === "stalled-prepare" || mode === "stalled-validate" && reads === 4
        || ["stalled-recovery","stalled-fallback"].includes(mode) && recovery)) {
        await new Promise((_resolve,reject)=>{ signal!.addEventListener("abort",()=>reject(signal!.reason),{once:true}); });
      }
      signal?.throwIfAborted();
      if(mode==="cloud-restore-failure"&&recovery)throw Error("Synthetic cloud unavailable");
      if(mode==="malformed-restore"&&recovery)return {devices:null} as never;
      return {devices:[parent,sibling,{...child,...(mode==="changed"&&writes.length?{device_channel:5}:{})},
        ...(mode==="duplicate"&&reads>1?[{...child,device_sn:"duplicate-child"}]:[])]};
    });
    context.mock.method(MegaClient.prototype,"dskKeys",async()=>({}));
    context.mock.method(MegaClient.prototype,"nvrSignallingContext",async(_station:string,_region:string,signal:AbortSignal)=>{
      if(mode === "stalled-signalling") await new Promise((_resolve,reject)=>{signal.addEventListener("abort",()=>reject(signal.reason),{once:true});});
      return {host:"security-smart-ie.eufylife.com",region:"IE",authToken:"synthetic",gtoken:"synthetic",sign:"synthetic"};});
    context.mock.method(MegaPushReceiver.prototype,"start",async()=>undefined);
    const prepare=context.mock.method(NvrRtcSession.prototype,"preparePowerTrial",async()=>undefined);
    const identities=context.mock.method(NvrRtcSession.prototype,"validatePowerTrial",async(signal?:AbortSignal)=>{
      if(mode === "stalled-fallback" && recovery) await new Promise((_resolve,reject)=>{signal!.addEventListener("abort",()=>reject(signal!.reason),{once:true});});
    });
    context.mock.method(NvrRtcSession.prototype,"readPowerTrial",async()=>state);
    const controller=new AbortController();
    const provider=new EufyProvider({username:"synthetic",password:"synthetic",country:"AU",persistentDirectory:directory,maxStreamSeconds:120,
      experimentalNvrControls:mode!=="controls-disabled",experimentalModelControls:mode!=="model-disabled",experimentalNvrLive:mode!=="video-disabled",normalNvrLive:mode!=="video-disabled"});
    context.mock.method(NvrRtcSession.prototype,"writePowerTrial",async(value:NvrCameraPower,signal:AbortSignal,mark:()=>void)=>{
      signal.throwIfAborted();mark();writes.push(value);state=value;
      if(writes.length===1){recovery=true;if(mode==="cancel")controller.abort();if(mode==="shutdown")await provider.close();}
    });
    const close=context.mock.method(NvrRtcSession.prototype,"close",async()=>undefined);
    const stateRegistry=new GatewayState();
    const events=new Proxy({camera:(camera:Parameters<ProviderEvents["camera"]>[0])=>stateRegistry.registerCamera(camera)}, {get:(target,key)=>Reflect.get(target,key)??(()=>undefined)}) as unknown as ProviderEvents;
    try {
      await provider.start(events);
      context.mock.timers.enable({apis:["setTimeout"]});
      const timed = ["queued-inventory","stalled-prepare","stalled-validate","stalled-signalling","cancel-before","stalled-recovery","stalled-fallback"].includes(mode);
      if(timed) context.mock.method(AbortSignal,"timeout",(milliseconds:number)=>{
        const deadline=new AbortController();setTimeout(()=>deadline.abort(),milliseconds);return deadline.signal;
      });
      const operation=provider.testNvrCameraPower("synthetic-camera",{originalPower:"on",target:"off"},controller.signal);
      const succeeds=["valid","busy","cloud-restore-failure","cancel","queued-inventory","stalled-recovery"].includes(mode);
      const expected=succeeds?operation:assert.rejects(operation,NvrPowerError);
      void operation.catch(()=>undefined);
      let elapsed=0,settled=false;void operation.finally(()=>{settled=true;}).catch(()=>undefined);
      if(timed) for(let tick=0;tick<100&&!settled;tick++){
        for(let n=0;n<10;n++)await new Promise(resolve=>setImmediate(resolve));
        context.mock.timers.tick(1000);elapsed+=1000;
      }
      for(let n=0;n<25;n++)await new Promise(resolve=>setImmediate(resolve));
      if(mode === "stalled-prepare" || mode === "stalled-validate") assert.ok(elapsed >= 10_000 && elapsed <= 12_000);
      if(mode === "stalled-signalling") assert.ok(elapsed >= 5_000 && elapsed <= 7_000);
      if(mode === "stalled-recovery" || mode === "stalled-fallback") assert.ok(elapsed <= 65_000);
      if(mode==="busy") {
        await assert.rejects(provider.testNvrCameraPower("synthetic-camera",{originalPower:"on",target:"off"},new AbortController().signal),/busy/);
        await assert.rejects(provider.startStream("synthetic-sibling"),/recording retrieval|busy|admission/);
        await assert.rejects(async()=>provider.setCameraEnabled("synthetic-sibling",false),/trial|recording retrieval|busy|admission/);
      }
      context.mock.timers.tick(1000);
      for(let n=0;n<25;n++)await new Promise(resolve=>setImmediate(resolve));
      if(succeeds){
        const result=await expected;assert.equal(result?.restored,true);
        assert.equal(stateRegistry.hasCamera("synthetic-camera"),true);
        assert.equal(stateRegistry.getCamera("synthetic-camera").enableControlSupported,false);assert.deepEqual(writes,["off","on"]);
        assert.equal(prepare.mock.callCount(),1);assert.ok(identities.mock.callCount()>=2);assert.ok(close.mock.callCount()>=1);
        await assert.rejects(provider.testNvrCameraPower("synthetic-camera",{originalPower:"on",target:"off"},new AbortController().signal),/busy/);
        if(mode === "valid") {
          const afterCooldown = performance.now() + 61_000, before = reads;
          context.mock.method(performance, "now", () => afterCooldown);
          await assert.rejects(provider.testNvrGuardMode("synthetic-camera", { target: "home", timeZone: "UTC" }, new AbortController().signal),
            error => error instanceof NvrGuardError && error.stage === "inventory");
          assert.ok(reads > before);
          assert.deepEqual(writes, ["off", "on"]);
        }
      } else {
        await expected;
        if(mode === "stalled-fallback") await assert.rejects(operation,error=>error instanceof NvrPowerError && error.manualRestoreRequired);
        assert.deepEqual(writes,["changed","shutdown","malformed-restore","stalled-fallback"].includes(mode)?["off"]:[]);
      }
      assert.equal(network.mock.callCount(),0);
    } finally {
      controller.abort();await provider.close();context.mock.timers.tick(120_000);
      for(let n=0;n<10;n++)await new Promise(resolve=>setImmediate(resolve));
      context.mock.timers.reset();await rm(directory,{recursive:true,force:true});
    }
  });
