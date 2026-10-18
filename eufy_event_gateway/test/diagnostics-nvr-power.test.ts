/**
 * Runs the actual Diagnostics script with a synthetic DOM and HTTP responses.
 * Tests own all callbacks, verifying consent, cancellation and private-error handling.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticsPage } from "../src/diagnostics/page.js";

for(const mode of ["success","cancel","selection","pagehide","private-error","non-ok","unknown-stage"])
  test(`Diagnostics NVR power form: ${mode}`,async()=>{
    type Element={value:string;checked:boolean;disabled:boolean;hidden:boolean;textContent:string;onclick?:()=>Promise<void>;
      addEventListener:(name:string,callback:()=>void)=>void;emit:(name:string)=>void;replaceChildren:()=>void;add:()=>void;removeAttribute:()=>void;load:()=>void;pause:()=>void};
    const elements=new Map<string,Element>();
    const element=(id:string):Element=>{
      if(!elements.has(id)){
        const listeners=new Map<string,(()=>void)[]>();
        elements.set(id,{value:"",checked:false,disabled:false,hidden:false,textContent:"",addEventListener:(name,callback)=>listeners.set(name,[...(listeners.get(name)??[]),callback]),
          emit:name=>{for(const callback of listeners.get(name)??[])callback();},replaceChildren:()=>undefined,add:()=>undefined,removeAttribute:()=>undefined,load:()=>undefined,pause:()=>undefined});
      }return elements.get(id)!;
    };
    const departures:(()=>void)[]=[];
    const calls:{path:string;body:unknown;signal:AbortSignal}[]=[];
    let entered!:()=>void;const entering=new Promise<void>(resolve=>{entered=resolve;});
    const fetch=async(path:string,options:{body:string;signal:AbortSignal})=>{
      calls.push({path,body:JSON.parse(options.body),signal:options.signal});entered();
      if(["cancel","selection","pagehide"].includes(mode))await new Promise<void>((_resolve,reject)=>options.signal.addEventListener("abort",()=>reject(Error("PRIVATE-CANARY")),{once:true}));
      return {ok:!["non-ok","unknown-stage"].includes(mode),json:async()=>{if(mode==="private-error")throw Error("PRIVATE-CANARY");return {outcome:"target_confirmed",restored:true,stage:mode==="unknown-stage"?"PRIVATE-CANARY":"identity",privateCanary:"PRIVATE-CANARY"};}};
    };
    const script=diagnosticsPage().split("<script>")[1]!.split("</script>")[0]!;
    new Function("document","fetch","Option","window","location",script)({getElementById:element},fetch,function(){},
      {addEventListener:(name:string,callback:()=>void)=>{if(name==="pagehide")departures.push(callback);}}, {protocol:"https:"});
    element("device").value="synthetic";element("token").value="synthetic";
    element("nvr-power-original").value="on";element("nvr-power-target").value="off";
    await element("nvr-power-start").onclick!();assert.equal(calls.length,0);
    element("nvr-power-consent").checked=true;
    const operation=element("nvr-power-start").onclick!();await entering;
    if(mode==="cancel")element("nvr-power-cancel").emit("click");
    if(mode==="selection"){element("device").value="other";element("device").emit("change");}
    if(mode==="pagehide")for(const callback of departures)callback();
    await operation;
    if(mode==="unknown-stage")assert.match(element("nvr-power-status").textContent,/did not complete: restore/);
    if(mode==="non-ok")assert.match(element("nvr-power-status").textContent,/did not complete: identity/);
    assert.equal(calls.length,1);assert.deepEqual(calls[0]!.body,{consent:true,originalPower:"on",target:"off"});
    assert.equal(element("nvr-power-consent").checked,false);assert.equal(element("nvr-power-start").disabled,false);
    assert.equal(element("nvr-power-status").textContent.includes("PRIVATE-CANARY"),false);
    if(["cancel","selection","pagehide"].includes(mode)){
      assert.equal(calls[0]!.signal.aborted,true);assert.match(element("nvr-power-status").textContent,/No final result|cannot show its final result/);
    } else if(mode==="success"){
      assert.match(element("nvr-power-status").textContent,/Reported original restored/);
      element("nvr-power-original").emit("change");assert.doesNotMatch(element("nvr-power-status").textContent,/Reported original restored/);
      assert.match(element("nvr-power-status").textContent,/No power test running/);
    }
  });
