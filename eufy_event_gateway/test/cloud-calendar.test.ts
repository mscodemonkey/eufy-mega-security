/**
 * Checks calendar boundaries and HTTPS with synthetic dates and temporary sessions.
 * Fake network responses own all side effects. These tests never access vendor
 * services, device settings, recording keys or media URLs.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cloudCalendarBounds, projectCloudCalendar, validateCloudCalendarQuery, CloudCalendarError } from "../src/mega/cloud-calendar.js";
import { MegaClient } from "../src/mega/client.js";
import { credentialVerifier, decryptEnvelope, encryptEnvelope, requestSignature, sharedAesKey, sharedSigningKey } from "../src/mega/crypto.js";

for (const [month, days] of [["2024-02",29],["2025-02",28],["2026-04",30],["2000-01",31],["2100-12",31]] as const) {
  test(`calendar uses UTC arithmetic for ${month}`, () => {
    for (const timezoneOffset of [0, -0, 60, 50_400, -50_400]) {
      const query = { month, timezoneOffset }, { start, end } = cloudCalendarBounds(query);
      assert.equal(end-start, days*86400);
      assert.equal(new Date((start+timezoneOffset)*1000).toISOString().slice(0,7),month);
      const result = projectCloudCalendar([{date:end},{date:start-1},{date:end-1},{date:start},{date:start}],query,"cam","hub");
      assert.deepEqual(result,{month,days:[1,days],droppedRows:2});
    }
  });
}

test("calendar refuses malformed query and foreign bindings", () => {
  for (const month of ["1999-12","2101-01","2026-00","2026-13","2026-1"," 2026-01",null]) {
    assert.throws(()=>validateCloudCalendarQuery({month:month as string,timezoneOffset:0}),SyntaxError);
  }
  for (const timezoneOffset of [61,50401,50460,-50401,0.5,Infinity,NaN]) {
    assert.throws(()=>cloudCalendarBounds({month:"2026-10",timezoneOffset}),SyntaxError);
  }
  const query={month:"2026-10",timezoneOffset:36000}, {start}=cloudCalendarBounds(query);
  assert.equal(start,Date.UTC(2026,9,1)/1000-36000);
  assert.deepEqual(projectCloudCalendar(null,query,"cam","cam").days,[]);
  assert.deepEqual(projectCloudCalendar(undefined,query,"cam","cam").days,[]);
  for(const row of [null,[],1,{date:-1},{date:1.1},{date:Number.MAX_SAFE_INTEGER+1},{date:String(start)},new Date(),
    {date:start,device_sn:"other"},{date:start,station_sn:""},{date:start,device_sn:1}]) {
    assert.throws(()=>projectCloudCalendar([row],query,"cam","hub"),CloudCalendarError);
  }
  assert.throws(()=>projectCloudCalendar({},query,"cam","hub"),CloudCalendarError);
  assert.throws(()=>projectCloudCalendar(Array(1001).fill({date:start}),query,"cam","hub"),CloudCalendarError);
  assert.deepEqual(projectCloudCalendar(Array(1000).fill({date:start,device_sn:"cam",station_sn:"hub"}),query,"cam","hub"),
    {month:query.month,days:[1],droppedRows:0});
  assert.deepEqual(projectCloudCalendar([{date:start,device_sn:null,station_sn:null}],query,"cam","cam").days,[1]);
});

test("fixed offset deliberately differs from a DST-adjusted day boundary", () => {
  const query={month:"2026-10",timezoneOffset:36000}, {start,end}=cloudCalendarBounds(query);
  assert.deepEqual(projectCloudCalendar([{date:start-3600},{date:end-1}],query,"cam","hub"),{month:query.month,days:[31],droppedRows:1});
});

for(const mode of ["valid","code","shape","preabort","abort","expired","identity-error","bad-query"]) {
  test(`calendar client ${mode} requests metadata without login or key lookup`,async context=>{
    const directory=await mkdtemp(join(tmpdir(),"calendar-client-"));
    const key="00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100";
    const host="security-app-eu.eufylife.com", controller=new AbortController();
    let calls=0,now=1_700_000_000_000;
    context.mock.method(globalThis,"fetch",async()=>{throw Error("Network forbidden");});
    try {
      await writeFile(join(directory,"mega-session.json"),JSON.stringify({version:2,country:"au",openUdid:"device",
        credentialVerifier:credentialVerifier("device","user@example.invalid","pw"),authToken:"fake-token",tokenExpiresAt:2_000_000_000,
        userId:"fake-user",verificationPending:false,megaDomain:"mega-eu-pr.eufy.com",domains:{eufy_security:host},
        identities:{[host]:{keyIdent:"fake",sharedKey:key,clientPublicKey:"fake-public"}}}));
      const client=new MegaClient({email:"user@example.invalid",password:"pw",country:"AU",persistentDirectory:directory,
        minimumRequestIntervalMs:0,now:()=>now,fetch:async(input,init)=>{
          calls++;assert.equal(new URL(String(input)).pathname,"/v3/event/web/get_history_by_time");
          assert.equal(new URL(String(input)).hostname,host);
          const payload=JSON.parse(decryptEnvelope(String(init?.body),sharedAesKey(key)));
          const {start,end}=cloudCalendarBounds({month:"2026-10",timezoneOffset:36000});
          assert.deepEqual(payload,{device_sn:"cam",station_sn:"hub",start_time:start,end_time:end,offset:36000,storage:2,shared:true});
          if(mode==="abort")controller.abort();
          if(mode==="expired")now=2_100_000_000_000;
          const code=mode==="identity-error"?4404:mode==="code"?123:0;
          const data=encryptEnvelope(JSON.stringify(mode==="shape"?{}:[{date:start}]),sharedAesKey(key));
          const headers=new Headers(init?.headers);
          return new Response(JSON.stringify({code,data,signature:requestSignature(sharedSigningKey(key),headers.get("x-request-ts")!,headers.get("x-request-once")!,data)}));
        }});
      await client.connect();
      if(mode==="preabort")controller.abort();
      const result=client.cloudCalendar("cam","hub",{month:mode==="bad-query"?"2026-13":"2026-10",timezoneOffset:36000},controller.signal);
      if(mode==="valid")assert.deepEqual(await result,{month:"2026-10",days:[1],droppedRows:0});
      else await assert.rejects(result,error=>error instanceof CloudCalendarError&&error.message==="Cloud calendar unavailable");
      assert.equal(calls,mode==="preabort"||mode==="bad-query"?0:1);
      client.cancelPendingRequests();
    } finally {await rm(directory,{recursive:true,force:true});}
  });
}
