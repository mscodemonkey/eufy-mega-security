/**
 * Checks calendar ownership against fresh synthetic inventory and cancellation.
 * The provider owns no real connection here. Mocked sessions and temporary
 * directories isolate state and prohibit all vendor network access.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver } from "../src/mega/push.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { CloudCalendarError } from "../src/mega/cloud-calendar.js";

for(const mode of ["valid","shared","standalone","disabled","unknown","unsupported","duplicate","missing","first-fail","second-fail",
  "parent","channel","model","type","category","admin","cancelled","closing","unauthenticated","malformed"]) {
  test(`calendar provider ${mode} never mutates inventory or returns a stale binding`,async context=>{
    const directory=await mkdtemp(join(tmpdir(),"calendar-provider-"));
    const network=context.mock.method(globalThis,"fetch",async()=>{throw Error("Network forbidden");});
    context.mock.method(MegaClient.prototype,"connect",async()=>({state:"authenticated"}));
    context.mock.getter(MegaClient.prototype,"isAuthenticated",()=>mode!=="unauthenticated");
    const row={device_sn:"cam",device_model:mode==="unsupported"?"T8900":"T8113-Z",device_type:mode==="unsupported"?10:8,
      category:"eufy_security",parent_sn:mode==="standalone"?"":"hub",device_channel:0,
      ...(mode==="shared"?{}:{member:{admin_user_id:"owner"}})};
    let reads=0;
    const inventory=context.mock.method(MegaClient.prototype,"inventory",async()=>{
      reads++;
      if(mode==="first-fail"&&reads===2||mode==="second-fail"&&reads===3)throw Error("Private inventory failure");
      if(mode==="malformed"&&reads>1)return {devices:null} as never;
      const changed=reads===3?mode:"none";
      const fresh={...row,...(changed==="parent"?{parent_sn:"other"}:{}),...(changed==="channel"?{device_channel:3}:{}),
        ...(changed==="model"?{device_model:"T8114"}:{}),...(changed==="type"?{device_type:9}:{}),
        ...(changed==="category"?{category:"other"}:{}),...(changed==="admin"?{member:{admin_user_id:"other"}}:{})};
      return {devices:mode==="missing"&&reads>1?[]:[fresh,...(mode==="duplicate"&&reads>1?[{...fresh,device_sn:" cam "}]:[])],groups:[]};
    });
    context.mock.method(MegaClient.prototype,"dskKeys",async()=>({}));
    context.mock.method(MegaPushReceiver.prototype,"start",async()=>undefined);
    const provider=new EufyProvider({username:"synthetic",password:"synthetic",country:"AU",persistentDirectory:directory,
      maxStreamSeconds:120,experimentalCloudRecordings:mode!=="disabled"});
    let eventsCount=0;
    const events=new Proxy({},{get:()=>()=>{eventsCount++;}}) as ProviderEvents;
    const controller=new AbortController();
    const calendar=context.mock.method(MegaClient.prototype,"cloudCalendar",async(camera:string,parent:string)=>{
      assert.equal(camera,"cam");assert.equal(parent,mode==="standalone"?"cam":"hub");
      if(mode==="cancelled")controller.abort();
      if(mode==="closing")await provider.close();
      return {month:"2026-10",days:[1,4],droppedRows:2};
    });
    try {
      await provider.start(events);
      const before=eventsCount;
      const result=provider.cloudCalendar(mode==="unknown"?"other":"cam",{month:"2026-10",timezoneOffset:0},controller.signal);
      if(["valid","shared","standalone"].includes(mode)) {
        assert.deepEqual(await result,{month:"2026-10",days:[1,4]});assert.equal(inventory.mock.callCount(),3);
        assert.equal(eventsCount,before);
      } else await assert.rejects(result,error=>error instanceof CloudCalendarError&&error.message==="Cloud calendar unavailable");
      if(["disabled","unknown","unsupported","unauthenticated"].includes(mode))assert.equal(calendar.mock.callCount(),0);
      assert.equal(network.mock.callCount(),0);
    } finally {await provider.close();await rm(directory,{recursive:true,force:true});}
  });
}
