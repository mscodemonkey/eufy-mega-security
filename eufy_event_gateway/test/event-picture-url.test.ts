/**
 * Verifies bounded native picture-list selection and snapshot integration using
 * synthetic URLs. No vendor service or physical device is contacted.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { eventPictureUrl } from "../src/provider/event-picture-url.js";
import { downloadPushSnapshot } from "../src/provider/eufy-provider.js";
import { parsePushEvent } from "../src/mega/push.js";

const first = "https://example.invalid/first", second = "https://example.invalid/second";

test("first source image is selected without changing raw push deduplication input", async () => {
  const raw = `${first},${second}`;
  const event = parsePushEvent({ device_sn: "synthetic", pic_url: raw, a: 1 });
  assert.equal(event?.pictureUrl, raw);
  const calls: string[] = [];
  const jpeg = Buffer.from([0xff,0xd8,1,2,0xff,0xd9]);
  assert.deepEqual(await downloadPushSnapshot({download:async url => {calls.push(url);return jpeg;}},event!,new Map()),{data:jpeg});
  assert.deepEqual(calls,[first]);
  assert.equal(event?.pictureUrl,raw);
});

test("native literal separators, whitespace empties and encoded commas", () => {
  assert.equal(eventPictureUrl(` , , ${first},,${second},`),first);
  assert.equal(eventPictureUrl(`${first}%2Cdetail`),`${first}%2Cdetail`);
  assert.equal(eventPictureUrl(`${first},detail`),first);
  assert.equal(eventPictureUrl(` ${first} `),first);
  assert.equal(eventPictureUrl(" , , "),null);
  assert.equal(eventPictureUrl(`bad-host,${second}`),"bad-host");
});

test("selected-entry and whole-list bounds fail closed", async () => {
  const exact = "x".repeat(8192);
  assert.equal(eventPictureUrl(exact),exact);
  assert.equal(eventPictureUrl(exact+"x"),null);
  assert.equal(eventPictureUrl([first,...Array(7).fill("")].join(",")),first);
  assert.equal(eventPictureUrl([first,...Array(8).fill("")].join(",")),null);
  const boundary=first+","+"x".repeat(32768-first.length-1);
  assert.equal(eventPictureUrl(boundary),first);
  assert.equal(eventPictureUrl(boundary+"x"),null);
  for(const value of [undefined,null,{},[],1,`${first}\npath`,`${first}\tpath`,`${first}\x7f`,`${first} path`]) assert.equal(eventPictureUrl(value),null);
  const rejected=[first,...Array(8).fill("")].join(",");
  const event=parsePushEvent({device_sn:"synthetic",pic_url:rejected,a:1})!;
  assert.equal(event.pictureUrl,rejected);
  let calls=0;
  assert.equal(await downloadPushSnapshot({download:async()=>{calls++;throw Error("Forbidden");}},event,new Map()),null);
  assert.equal(calls,0);
});

test("failure of the first image never fetches a different list entry", async () => {
  const calls: string[]=[];
  await assert.rejects(downloadPushSnapshot({download:async url=>{calls.push(url);throw Error("Synthetic unavailable");}},
    {pictureUrl:`${first},${second}`,stationSerial:"synthetic"},new Map()),/unavailable/);
  assert.deepEqual(calls,[first]);
});
