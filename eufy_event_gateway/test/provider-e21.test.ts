/**
 * Exercises E21 ownership, queueing, raw confirmation and push attribution.
 * Fixtures own synthetic inventory, clocks, transport and downloads. No real
 * account, camera media or physical setting is contacted by these tests.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { GatewayState } from "../src/domain/gateway-state.js";
import { MegaClient } from "../src/mega/client.js";
import { MegaPushReceiver, parsePushEvent, type MegaPushEvent } from "../src/mega/push.js";
import { decodeMcsAppData } from "../src/mega/android-push/push-client.js";
import { EufyProvider } from "../src/provider/eufy-provider.js";
import { E21ControlError, e21DetectionKinds } from "../src/provider/e21-profile.js";
import type { ProviderEvents } from "../src/provider/provider.js";
import { FirstPartyPpcsSession } from "../src/stream/first-party-ppcs.js";
import { supportsStartupSnapshot } from "../src/startup-snapshot-warmup.js";

async function fixture(context: TestContext, mode = "valid") {
  const directory = await mkdtemp(join(tmpdir(), "e21-provider-"));
  const network = context.mock.method(globalThis, "fetch", async () => { throw Error("Network forbidden"); });
  context.mock.method(MegaClient.prototype, "connect", async () => ({ state: "authenticated" }));
  context.mock.getter(MegaClient.prototype, "isAuthenticated", () => true);
  context.mock.method(MegaClient.prototype, "isAuthenticatedUser", (id: string) => mode !== "guest" && id === "synthetic-owner");
  let values = { microphone: 0, speaker: 0 };
  const row = { device_sn: "synthetic-e21", device_model: mode === "wrong-model" ? "T8354A" : "T8354",
    device_type: mode === "wrong-type" ? 85 : 86, category: mode === "wrong-category" ? "eufy_security" : "eufy_care",
    parent_sn: mode === "attached" ? "synthetic-parent" : "synthetic-e21", device_channel: mode === "channel" ? 1 : 0,
    p2p_did: "synthetic-did", p2p_conn: "synthetic-route", member: { admin_user_id: "synthetic-owner" } };
  let replacement: unknown = null;
  const inventory = context.mock.method(MegaClient.prototype, "inventory", async () => replacement ?? ({ groups: [], devices: [
    { ...row, params: [{ param_type:1240, param_value:values.microphone }, { param_type:1241, param_value:values.speaker }] },
  ] }));
  context.mock.method(MegaClient.prototype, "dskKeys", async () => mode === "no-dsk" ? {} : ({ "synthetic-e21": { key:"synthetic-key", expiresAt:null } }));
  let deliver!: (event: MegaPushEvent) => void;
  context.mock.method(MegaPushReceiver.prototype, "start", async function(this: MegaPushReceiver) {
    deliver = Reflect.get(this,"onEvent") as typeof deliver;
  });
  const state = new GatewayState(25);
  const pictures: Buffer[] = [];
  const identities: Parameters<ProviderEvents["camera"]>[0][] = [];
  const events = new Proxy({ camera: (camera: Parameters<ProviderEvents["camera"]>[0]) => { identities.push(camera); state.registerCamera(camera); },
    sensor: (sensor: Parameters<ProviderEvents["sensor"]>[0]) => state.registerSensor(sensor),
    sensorDetection: (serial: string, kind: typeof e21DetectionKinds[number], active: boolean) => state.recordSensorDetection(serial,kind,active),
    snapshot: (_serial: string, data: Buffer) => pictures.push(data),
  }, { get: (target,key) => Reflect.get(target,key) ?? (() => {}) }) as unknown as ProviderEvents;
  const provider = new EufyProvider({ username:"synthetic", password:"synthetic", country:"AU", persistentDirectory:directory,
    maxStreamSeconds:120, experimentalModelControls:mode !== "disabled", apiAuthenticationConfigured:mode !== "no-api" });
  const opens = context.mock.method(FirstPartyPpcsSession.prototype,"start",async () => {});
  const writes = context.mock.method(FirstPartyPpcsSession.prototype,"writeE21Preference",async (name: string,value: number) => {
    if (name === "microphone" || name === "speaker") values = { ...values, [name]: value };
  });
  await provider.start(events); inventory.mock.resetCalls();
  context.after(async () => { await provider.close(); state.close(); assert.equal(network.mock.callCount(),0); await rm(directory,{recursive:true,force:true}); });
  return { provider,state,inventory,opens,writes,row,pictures,identities,deliver:(event:MegaPushEvent)=>deliver(event),
    replace:(value:unknown)=>{replacement=value;} };
}

test("E21 creates independent camera and sensor adapters without duplicate detections or startup media", async context => {
  const f = await fixture(context);
  const camera = f.state.getCamera("synthetic-e21");
  assert.equal(camera.careMonitor,true); assert.deepEqual(camera.supportedDetections,[]);
  assert.equal(camera.streamSupported,true); assert.equal(camera.talkbackSupported,false);
  assert.deepEqual(camera.preferenceControls,["microphone","speaker"]);
  assert.equal(supportsStartupSnapshot(f.identities.at(-1)!),false);
  assert.deepEqual(f.state.listSensors()[0]?.capabilities,[...e21DetectionKinds,"roomTemperature","careDiagnostics"]);
  assert.equal(f.opens.mock.callCount(),0);
});

for (const mode of ["disabled","no-api","guest","no-dsk","attached","channel","wrong-model","wrong-type","wrong-category"]) {
  test(`E21 preference refuses ${mode} before transport`,async context => {
    const f = await fixture(context,mode);
    await assert.rejects(f.provider.setE21Preference("synthetic-e21","microphone",1),E21ControlError);
    assert.equal(f.opens.mock.callCount(),0); assert.equal(f.writes.mock.callCount(),0); assert.equal(f.inventory.mock.callCount(),0);
    if (mode === "disabled") await assert.rejects(f.provider.startStream("synthetic-e21"));
  });
}

test("legacy public operations refuse E21 before opening media or controls",async context => {
  const f = await fixture(context);
  const operations = [() => f.provider.setCameraEnabled("synthetic-e21",true), () => f.provider.setCameraMotionDetection("synthetic-e21",true),
    () => f.provider.setCameraAudioRecording("synthetic-e21",true), () => f.provider.setCameraStreamingQuality("synthetic-e21",0),
    () => f.provider.refreshCameraCapabilities("synthetic-e21"), () => f.provider.setCameraGuardMode("synthetic-e21",1),
    () => f.provider.setCameraNightVision("synthetic-e21",0), () => f.provider.setCameraLight("synthetic-e21",true),
    () => f.provider.setCameraSiren("synthetic-e21",5), () => f.provider.getCameraPresetPositions("synthetic-e21"),
    () => f.provider.setCameraAutoCruise("synthetic-e21",true), () => f.provider.setCameraAiTracking("synthetic-e21",true),
    () => f.provider.playCameraAudio("synthetic-e21",Buffer.alloc(1)), () => f.provider.setCameraPreference("synthetic-e21","microphone",1)];
  for (const operation of operations) await assert.rejects(async () => operation());
  assert.deepEqual(f.provider.modelControlTrials("synthetic-e21"),[]);
  assert.equal(f.opens.mock.callCount(),0); assert.equal(f.inventory.mock.callCount(),0);
});

test("all E21 preferences share one queue and confirm through new raw inventory",async context => {
  const f = await fixture(context);
  const first = f.provider.setE21Preference("synthetic-e21","microphone",1);
  const second = f.provider.setE21Preference("synthetic-e21","speaker",1);
  const results = await Promise.all([first,second]);
  assert.equal(results[0]?.carePreferences?.microphone,1); assert.equal(results[1]?.carePreferences?.speaker,1);
  assert.equal(f.writes.mock.callCount(),2); assert.equal(f.inventory.mock.callCount(),2);
  await f.provider.setE21Preference("synthetic-e21","speaker",1);
  assert.equal(f.writes.mock.callCount(),2);
});

test("the overall E21 deadline closes a stalled setup and prevents a late write",async context => {
  const f = await fixture(context);
  context.mock.timers.enable({apis:["setTimeout"]});
  let resume!: () => void;
  f.opens.mock.mockImplementation(async () => await new Promise<void>(resolve => {resume=resolve;}));
  const pending = f.provider.setE21Preference("synthetic-e21","microphone",1);
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof E21ControlError && error.stage === "outcome_unknown");
  for(let n=0;n<4;n++) await new Promise(resolve=>setImmediate(resolve));
  context.mock.timers.tick(35_000); await rejected;
  resume();
  for(let n=0;n<4;n++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.writes.mock.callCount(),0);
});

for (const mode of ["absent","empty","duplicate","missing-owner","owner-drift","binding-drift","failure","stale-value"]) {
  test(`post-write ${mode} cannot confirm a setting from retained metadata`,async context => {
    const f = await fixture(context);
    let now = 1791464400000;
    context.mock.method(Date,"now",()=>now);
    let reads = 0;
    f.inventory.mock.mockImplementation(async () => {
      now += ++reads === 1 ? 34_000 : 36_000;
      if (mode === "failure") throw Error("Synthetic failure");
      const row = { ...f.row, params:[{param_type:1240,param_value:mode === "stale-value" ? 0 : 1}],
        ...(mode === "missing-owner" ? {member:undefined} : mode === "owner-drift" ? {member:{admin_user_id:"other-owner"}}
          : mode === "binding-drift" ? {parent_sn:"other-parent"} : {}) };
      return { groups:[],devices:mode === "empty" ? [] : mode === "absent" ? [{...row,params:[]}] : mode === "duplicate" ? [row,row] : [row] };
    });
    await assert.rejects(f.provider.setE21Preference("synthetic-e21","microphone",1), (error: unknown) => error instanceof E21ControlError && error.stage === "outcome_unknown");
    assert.equal(f.writes.mock.callCount(),1);
  });
}

test("real MCS decoding and push parsing preserve all care kinds and attributable event pictures",async context => {
  const f = await fixture(context);
  const jpeg = Buffer.from([255,216,1,2,255,217]);
  const downloads = context.mock.method(MegaClient.prototype,"download",async () => jpeg);
  const events = [3101,3104,3105,3106,3107,3108,3298,3299,3601,3602,3603];
  for (const eventType of events) {
    const payload = {device_sn:"synthetic-e21",station_sn:"synthetic-e21",
      payload:{msg_type:18,event_type:eventType,pic_url:"https://example.invalid/event.jpg"},unique_id:`event-${eventType}`};
    const decoded = decodeMcsAppData({appData:[{key:"payload",value:Buffer.from(JSON.stringify(payload)).toString("base64")}]});
    const event = parsePushEvent(decoded.payload);
    assert.ok(event); f.deliver(event);
  }
  for(let n=0;n<30;n++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(downloads.mock.callCount(),events.length); assert.equal(f.pictures.length,events.length);
  for(const kind of e21DetectionKinds) assert.equal(f.state.listSensors()[0]?.[`${kind}Detected`],true);
  for(const [station,eventType] of [["wrong-parent",3104],["synthetic-e21",3102]] as const) {
    const event = parsePushEvent({device_sn:"synthetic-e21",station_sn:station,msg_type:18,a:eventType,pic_url:"https://example.invalid/ignored.jpg",unique_id:`ignored-${eventType}`});
    assert.ok(event); f.deliver(event);
  }
  for(let n=0;n<6;n++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(downloads.mock.callCount(),events.length);
});
