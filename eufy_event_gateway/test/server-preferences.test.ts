/**
 * Exercises authenticated preference writes and failure-state preservation over HTTP.
 * Synthetic providers own confirmation; no physical camera or cloud is contacted.
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

test("preference writes validate input and preserve reported state when confirmation fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eufy-preferences-http-"));
  const state = new GatewayState();
  const identity = { serial: "synthetic", name: "Synthetic", model: "T817L", stationSerial: "synthetic",
    streamSupported: false, doorbellSupported: false, preferenceControls: ["microphone"],
    audioSettings: { recordingEnabled: true, microphoneEnabled: true, speakerEnabled: true, speakerVolume: 50 } };
  state.registerCamera(identity);
  let calls = 0;
  let fail = true;
  const provider = { setCameraPreference: async (serial: string, name: string, value: number) => {
    calls++;
    assert.equal(serial, "synthetic");
    assert.equal(name, "microphone");
    assert.equal(value, 0);
    if (fail) throw new Error("Write not confirmed by fresh readback");
    return { ...identity, audioSettings: { ...identity.audioSettings, microphoneEnabled: false } };
  } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "synthetic-secret" }, state,
    new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.port}/api/cameras`;
    const options = { method: "POST", headers: { authorization: "Bearer synthetic-secret", "content-type": "application/json" }, body: '{"preference":"microphone","value":0}' };
    assert.equal((await fetch(`${base}/synthetic/preferences`, { ...options, headers: {} })).status, 401);
    assert.equal((await fetch(`${base}/missing/preferences`, options)).status, 404);
    assert.equal((await fetch(`${base}/synthetic/preferences`, { ...options, body: '{"preference":"microphone","value":2}' })).status, 400);
    for (const body of [{ preference: "continuous", value: 1 }, { preference: "watermark", value: true }, { preference: "speakerVolume", value: 101 }]) {
      assert.equal((await fetch(`${base}/synthetic/preferences`, { ...options, body: JSON.stringify(body) })).status, 400);
    }
    assert.equal(calls, 0);
    assert.equal((await fetch(`${base}/synthetic/preferences`, options)).status, 500);
    assert.equal(state.getCamera("synthetic").audioSettings?.microphoneEnabled, true);
    fail = false;
    assert.equal((await fetch(`${base}/synthetic/preferences`, options)).status, 200);
    assert.equal(state.getCamera("synthetic").audioSettings?.microphoneEnabled, false);
    assert.equal(state.getCamera("synthetic").audioSettings?.recordingEnabled, true);
    assert.equal(calls, 2);
    delete provider.setCameraPreference;
    assert.equal((await fetch(`${base}/synthetic/preferences`, options)).status, 409);
    assert.equal(calls, 2);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reviewed settings distinguish clean rejection, ambiguity and confirmed SSE state", async () => {
  const { CameraSettingError } = await import("../src/provider/camera-settings.js");
  const directory = await mkdtemp(join(tmpdir(), "eufy-settings-http-")), state = new GatewayState();
  const identity = { serial: "fixture", name: "Fixture", model: "T817L", stationSerial: "fixture", streamSupported: false, doorbellSupported: false,
    motionSensitivityControlSupported: true, motionSensitivitySteps: 3, reportedSettings: { motionSensitivityStep: 2 } } as unknown as Parameters<GatewayState["registerCamera"]>[0];
  state.registerCamera(identity);
  let calls = 0, code: "busy" | "outcome_unknown" | null = "busy";
  const provider = { setCameraSetting: async () => { calls++; if (code) throw new CameraSettingError(code); return { ...identity, reportedSettings: { motionSensitivityStep: 3 } }; } } as unknown as CameraProvider;
  const server = new GatewayServer({ ...loadConfig({}), port: 0, apiToken: "fixture-token" }, state, new SnapshotStore(directory), {} as LiveStreamManager, provider, null);
  const events: unknown[] = []; state.on("event", event => events.push(event));
  try {
    await server.listen(); const base = `http://127.0.0.1:${server.port}/api/cameras`;
    const post = (body: unknown, headers = { authorization: "Bearer fixture-token", "content-type": "application/json" }, id = "fixture") => fetch(`${base}/${id}/settings`, { method: "POST", headers, body: JSON.stringify(body) });
    const body = { setting: "motionSensitivity", value: 3 };
    assert.equal((await post(body, { authorization: "", "content-type": "application/json" })).status, 401);
    assert.equal((await post(body, undefined, "missing")).status, 404);
    assert.equal((await post(body, { authorization: "Bearer fixture-token", "content-type": "text/plain" })).status, 400);
    assert.equal((await post({ ...body, extra: 1 })).status, 400); assert.equal(calls, 0);
    let result = await post(body); assert.equal(result.status, 409); assert.equal((await result.json()).code, "busy");
    code = "outcome_unknown"; result = await post(body); assert.equal(result.status, 503); assert.equal((await result.json()).code, "outcome_unknown");
    code = null; result = await post(body); assert.equal(result.status, 200);
    const confirmed = await result.json(); assert.equal(confirmed.motionSensitivitySteps, 3); assert.equal(confirmed.reportedSettings.motionSensitivityStep, 3);
    assert.ok(events.some(event => JSON.stringify(event).includes('"motionSensitivityStep":3')));
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("E21 HTTP preferences require configured API validation and use the dedicated provider boundary", async () => {
  const { E21ControlError } = await import("../src/provider/e21-profile.js");
  const directory = await mkdtemp(join(tmpdir(), "e21-preferences-http-")), state = new GatewayState();
  const identity = { serial:"care",name:"Synthetic",model:"T8354",stationSerial:"care",streamSupported:false,doorbellSupported:false,
    careMonitor:true,preferenceControls:["speakerVolume"],carePreferences:{speakerVolume:20},preferenceRanges:{speakerVolume:{minimum:0,maximum:100}} };
  state.registerCamera(identity);
  let legacy = 0, dedicated = 0, fail = true, emitted = 0;
  state.on("event",event=>{ if(event.type === "camera-updated") emitted++; });
  const provider = { setCameraPreference:async()=>{legacy++;throw Error("Wrong provider boundary");},
    setE21Preference:async(serial:string,name:string,value:number)=>{
      dedicated++;assert.equal(serial,"care");assert.equal(name,"speakerVolume");assert.equal(value,0);
      if(fail)throw new E21ControlError("outcome_unknown");return {...identity,carePreferences:{speakerVolume:0}};
    } } as unknown as CameraProvider;
  for(const token of ["","synthetic-secret"]) {
    const server = new GatewayServer({...loadConfig({}),port:0,apiToken:token,experimentalModelControls:true},state,new SnapshotStore(directory),{} as LiveStreamManager,provider,null);
    try {
      await server.listen();const url=`http://127.0.0.1:${server.port}/api/cameras/care/preferences`;
      const options={method:"POST",headers:{authorization:"Bearer synthetic-secret","content-type":"application/json"},body:JSON.stringify({preference:"speakerVolume",value:0})};
      assert.equal((await fetch(url,{...options,headers:{}})).status,401);
      if(!token){assert.equal((await fetch(url,options)).status,401);continue;}
      for(const body of [{preference:"rtspPublication",value:1},{preference:"speakerVolume",value:101},{preference:"microphone",value:2}])assert.equal((await fetch(url,{...options,body:JSON.stringify(body)})).status,409);
      assert.equal(dedicated,0);
      const failure = await fetch(url,options);assert.equal(failure.status,503);assert.deepEqual(await failure.json(),{stage:"outcome_unknown"});
      assert.equal(state.getCamera("care").carePreferences?.speakerVolume,20);assert.equal(emitted,0);
      fail=false;assert.equal((await fetch(url,options)).status,200);
      assert.equal(state.getCamera("care").carePreferences?.speakerVolume,0);assert.equal(emitted,1);
    } finally {await server.close();}
  }
  assert.equal(legacy,0);assert.equal(dedicated,2);state.close();await rm(directory,{recursive:true,force:true});
});
