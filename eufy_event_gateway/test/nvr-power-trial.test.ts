/**
 * Exercises the power-test recovery policy using a synthetic ordered transport.
 * The fixture owns reported state and clocks, with no network or physical writes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { NvrPowerError, runNvrPowerTrial, type NvrCameraPower, type NvrPowerTransport } from "../src/provider/nvr-power-trial.js";
import { nvrStateSummary, nvrCameraPowerCommand } from "../src/stream/nvr-protocol.js";

function fixture(mode: string) {
  let state:NvrCameraPower="on", now=0, closed=0, prepares=0, reads=0, restores=0;
  const writes:NvrCameraPower[]=[], phases:boolean[]=[];
  const caller=new AbortController();
  const transport:NvrPowerTransport={
    prepare:async()=>{prepares++;if(mode==="hang-prepare")await new Promise<void>(()=>undefined);},
    validate:async recovery=>{phases.push(recovery);if(recovery&&mode==="binding")throw new NvrPowerError("identity");if(recovery&&mode==="hang-restore")await new Promise<void>(()=>undefined);},
    read:async()=>{
      reads++;
      if(!writes.length)return mode==="baseline-unknown"?null:mode==="baseline-wrong"?"off":"on";
      if(writes.length===1&&mode==="unknown-target")return null;
      if(writes.length===1&&mode==="late-target"&&reads===2)return "on";
      if(writes.length>1&&mode==="unknown-restore")return null;
      if(writes.length===2&&mode==="late-after-restore"&&reads===4){state="off";return "off";}
      return state;
    },
    write:async(value,signal,mark)=>{
      signal.throwIfAborted();
      if(!writes.length&&mode==="pre-send")throw new NvrPowerError("send");
      mark();writes.push(value);
      if(writes.length>1)restores++;
      if(!(mode==="retry-restore"&&restores===1))state=value;
      if(writes.length===1&&mode==="receipt")throw new NvrPowerError("receipt");
      if(writes.length===1&&mode==="first-send-throw")throw Error("PRIVATE-CANARY");
      if(writes.length===1&&mode==="cancel") {caller.abort();throw new NvrPowerError("cancelled");}
    },
    close:async()=>{closed++;if(mode==="hang-close")await new Promise<void>(()=>undefined);},
  };
  return {transport,caller,writes,phases,runtime:{now:()=>now,sleep:async(ms:number,signal:AbortSignal)=>{signal.throwIfAborted();now+=ms;}},
    counters:()=>({closed,prepares,reads,restores}),state:()=>state};
}

for(const mode of ["valid","receipt","first-send-throw","cancel","unknown-target","retry-restore","late-target","late-after-restore"])
  test(`camera power target and restore: ${mode}`,async()=>{
    const f=fixture(mode);
    const result=await runNvrPowerTrial(f.transport,{originalPower:"on",target:"off"},f.caller.signal,f.runtime);
    assert.equal(result.restored,true);assert.equal(result.physicalConfirmationRequired,true);assert.equal(f.state(),"on");
    assert.equal(result.outcome,["cancel","unknown-target"].includes(mode)?"target_unconfirmed_restored":"target_confirmed");
    assert.deepEqual(f.writes,["off","on",...(["retry-restore","late-after-restore"].includes(mode)?["on"]:[])]);
    assert.equal(f.counters().closed,1);assert.ok(f.phases.includes(true));
  });

for(const mode of ["baseline-unknown","baseline-wrong","pre-send","binding","unknown-restore"])
  test(`camera power fails safely: ${mode}`,async()=>{
    const f=fixture(mode);
    await assert.rejects(runNvrPowerTrial(f.transport,{originalPower:"on",target:"off"},f.caller.signal,f.runtime),error=>{
      assert.ok(error instanceof NvrPowerError);assert.equal(error.manualRestoreRequired,["binding","unknown-restore"].includes(mode));
      assert.equal(error.message.includes("PRIVATE-CANARY"),false);return true;
    });
    assert.deepEqual(f.writes,mode==="binding"?["off"]:mode==="unknown-restore"?["off","on"]:[]);
    assert.equal(f.counters().closed,1);
  });

test("same-value write needs no change push and no opposite restore",async()=>{
  const f=fixture("noop");
  assert.deepEqual(await runNvrPowerTrial(f.transport,{originalPower:"on",target:"on"},f.caller.signal,f.runtime),
    {outcome:"no_change_confirmed",restored:true,physicalConfirmationRequired:true});
  assert.deepEqual(f.writes,["on"]);
});

for(const [mode,budget,stage,manual] of [["hang-prepare",40000,"timeout",false],["hang-restore",60000,"restore",true],["hang-close",5000,"cleanup",false]] as const)
  test(`bounded phase ${mode}`,async context=>{
    context.mock.timers.enable({apis:["setTimeout"]});
    const f=fixture(mode);
    const operation=assert.rejects(runNvrPowerTrial(f.transport,{originalPower:"on",target:"off"},f.caller.signal,f.runtime),error=>{
      assert.ok(error instanceof NvrPowerError);assert.equal(error.stage,stage);assert.equal(error.manualRestoreRequired,manual);return true;
    });
    for(let n=0;n<20;n++)await new Promise(resolve=>setImmediate(resolve));
    context.mock.timers.tick(budget);await operation;
    context.mock.timers.reset();
  });

test("an already cancelled caller sends nothing",async()=>{
  const f=fixture("valid");f.caller.abort();
  await assert.rejects(runNvrPowerTrial(f.transport,{originalPower:"on",target:"off"},f.caller.signal,f.runtime),/cancelled/);
  assert.equal(f.counters().prepares,0);assert.deepEqual(f.writes,[]);
});

test("closed power builder has exact source layout and no arbitrary command",()=>{
  for(const value of [0,1] as const){
    const frame=nvrCameraPowerCommand("synthetic-owner",7,3,value);
    assert.equal(frame.subarray(0,4).toString(),"XZYH");assert.equal(frame.readUInt16LE(4),1350);
    assert.equal(frame.readUInt32LE(6),frame.length-16);assert.equal(frame[11],7);assert.equal(frame[12],3);
    assert.equal(frame[14],0);assert.equal(frame[15],2);
    assert.deepEqual(JSON.parse(frame.subarray(16).toString()),{account_id:"synthetic-owner",cmd:6250,payload:{switch:value}});
  }
  for(const [segment,channel,value] of [[0,3,0],[255,3,0],[7,255,0],[7,-1,0],[7,3,2]]){
    assert.throws(()=>nvrCameraPowerCommand("synthetic-owner",segment!,channel!,value as 0|1));
  }
});

for (const mode of ["never-dispatched", "retry-dispatched", "second-undispatched", "post-mark-throw", "unknown-after-dispatch", "abort-recovery"])
  test(`restoration requires its own dispatched write: ${mode}`, async () => {
    let state: NvrCameraPower = "on", recovering = false, attempts = 0, now = 0;
    const caller = new AbortController();
    const transport: NvrPowerTransport = {
      prepare: async () => undefined,
      validate: async recovery => { recovering = recovery; },
      read: async () => recovering && mode === "unknown-after-dispatch" ? null
        : recovering && (mode === "never-dispatched" || mode === "second-undispatched" && attempts === 2) ? "on" : state,
      write: async (value, signal, mark) => {
        signal.throwIfAborted();
        if (recovering) {
          attempts++;
          if (mode === "never-dispatched" || mode === "retry-dispatched" && attempts === 1
            || mode === "second-undispatched" && attempts === 2) throw Error("before dispatch");
        }
        mark();
        if (!(recovering && mode === "second-undispatched")) state = value;
        if (recovering && mode === "post-mark-throw") throw Error("after dispatch");
        if (recovering && mode === "abort-recovery") caller.abort();
      },
      close: async () => undefined,
    };
    const operation = runNvrPowerTrial(transport, { originalPower: "on", target: "off" }, caller.signal,
      { now: () => now, sleep: async ms => { now += ms; } });
    if (["never-dispatched", "second-undispatched", "unknown-after-dispatch"].includes(mode)) {
      await assert.rejects(operation, error => error instanceof NvrPowerError && error.manualRestoreRequired);
    } else assert.equal((await operation).restored, true);
    assert.equal(attempts, ["never-dispatched", "retry-dispatched", "second-undispatched"].includes(mode) ? 2 : 1);
  });

test("prepare errors retain their identity stage when cleanup also fails", async () => {
  const f = fixture("valid");
  f.transport.prepare = async () => { throw Error("private failure"); };
  f.transport.close = async () => { throw Error("private cleanup"); };
  await assert.rejects(runNvrPowerTrial(f.transport, { originalPower: "on", target: "off" }, f.caller.signal, f.runtime),
    error => error instanceof NvrPowerError && error.stage === "identity" && !error.manualRestoreRequired);
});

test("an established baseline failure survives cleanup failure", async () => {
  const f = fixture("baseline-wrong");
  f.transport.close = async () => { throw Error("private cleanup"); };
  await assert.rejects(runNvrPowerTrial(f.transport, { originalPower: "on", target: "off" }, f.caller.signal, f.runtime),
    error => error instanceof NvrPowerError && error.stage === "baseline" && !error.manualRestoreRequired);
});

test("power write values agree with scoped plain and encoded read-back", () => {
  for (const [value, power] of [[0, "on"], [1, "off"]] as const) {
    for (const parameter of [value, String(value), Buffer.from(String(value)).toString("base64")]) {
      assert.equal(nvrStateSummary({ params: [{ dev_type: 3, param_type: 6250, param_value: parameter }] }, 3).cameraPower, power);
    }
  }
  assert.equal(nvrStateSummary({ params: [{ dev_type: 3, param_type: 6250, param_value: 2 }] }, 3).cameraPower, null);
});
