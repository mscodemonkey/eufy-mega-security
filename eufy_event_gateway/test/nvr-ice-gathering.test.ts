/**
 * Exercises pinned ICE gathering with owned loopback peers and sockets. These
 * tests prove signalling, byte delivery and cleanup without cloud or camera data.
 * An external loopback coturn fixture enables the additional relay scenarios.
 */
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import { installNvrIceGathering } from "../src/stream/nvr-ice-gathering.js";
import { installNvrIceTiming } from "../src/stream/nvr-ice-timing.js";

async function deadline<T>(operation: Promise<T>, milliseconds = 8000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("owned ICE test deadline")), milliseconds);
  })]); } finally { if (timer) clearTimeout(timer); }
}

test("the pinned adapter contract requires the exact audited dependency", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(manifest.dependencies.werift, "0.24.4");
  assert.equal(lock.packages["node_modules/werift"].version, "0.24.4");
});

for (const scenario of ["unreachable", "udp", "tcp", "late", "late-failed", "fallback"]) test(`isolated ${scenario} scenario exits naturally with no owned relay handles`, {
  skip: scenario !== "unreachable" && !process.env.NVR_TEST_TURN_PORT ? "requires the task-owned loopback coturn fixture" : false,
}, async () => {
  const child = fileURLToPath(new URL("./fixtures/nvr-ice-process.ts", import.meta.url));
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", child, scenario], {
    timeout: 20_000, cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  assert.equal(JSON.parse(result.stdout).passed, true);
  assert.equal(result.stderr, "");
});

test("install is isolated, rejects repeats and leaves an aborted or unsupported peer untouched", async () => {
  const peer = new RTCPeerConnection(), other = new RTCPeerConnection();
  peer.createDataChannel("test"); other.createDataChannel("test");
  const signal = new AbortController();
  const originalOther = other.iceTransports[0]!.connection.gatherCandidates;
  const prototype = Object.getPrototypeOf(peer);
  const originalPrototype = Object.getOwnPropertyDescriptor(prototype, "gatherCandidates");
  try {
    assert.throws(() => installNvrIceGathering(peer, AbortSignal.abort()), /cancelled/);
    assert.equal(Object.hasOwn(peer, "gatherCandidates"), false);
    installNvrIceGathering(peer, signal.signal);
    assert.throws(() => installNvrIceGathering(peer, signal.signal), /timing/);
    assert.equal(other.iceTransports[0]!.connection.gatherCandidates, originalOther);
    assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "gatherCandidates"), originalPrototype);
  } finally { await peer.close(); await other.close(); }
  assert.equal(Object.hasOwn(peer, "gatherCandidates"), false);
});

test("real early answer omits end-of-candidates, carries data and preserves stop traffic after gathering abort", async () => {
  const sink = createSocket("udp4");
  await new Promise<void>(resolve => sink.bind(0, "127.0.0.1", resolve));
  const address = sink.address();
  const configuration = { iceServers: [], iceUseIpv4: false, iceUseIpv6: false, iceAdditionalHostAddresses: ["127.0.0.1"] };
  const offerer = new RTCPeerConnection(configuration), answerer = new RTCPeerConnection(configuration);
  const channel = offerer.createDataChannel("WebrtcDataChannel");
  answerer.createDataChannel("owned");
  for (const peer of [offerer, answerer]) peer.iceTransports[0]!.connection.stunServer = ["127.0.0.1", address.port];
  const cancellation = new AbortController();
  installNvrIceTiming(answerer, cancellation.signal);
  installNvrIceGathering(answerer, cancellation.signal);
  let ended = false;
  answerer.onIceCandidate.subscribe(candidate => { if (!candidate) ended = true; });
  const states: string[] = [];
  answerer.iceTransports[0]!.connection.stateChanged.subscribe(state => states.push(state));
  let remote: RTCDataChannel | undefined;
  let receive: (value: string) => void = () => {};
  const received = new Promise<string>(resolve => { receive = resolve; });
  answerer.onDataChannel.subscribe(value => {
    remote = value;
    value.onmessage = event => { receive(String(event.data)); value.send("stop-acknowledged"); };
  });
  let acknowledged: (value: string) => void = () => {};
  const ack = new Promise<string>(resolve => { acknowledged = resolve; });
  channel.onmessage = event => acknowledged(String(event.data));
  const open = new Promise<void>(resolve => { channel.onopen = resolve; });
  try {
    const controlAt = performance.now();
    await deadline(offerer.setLocalDescription(await offerer.createOffer()));
    assert.ok(performance.now() - controlAt >= 4500, "full gather control establishes the silent STUN wait");
    await answerer.setRemoteDescription(offerer.localDescription!);
    const start = performance.now();
    await deadline(answerer.setLocalDescription(await answerer.createAnswer()));
    assert.ok(performance.now() - start < 2500, "early answer should precede full gathering by a substantial margin");
    assert.equal(ended, false);
    assert.doesNotMatch(answerer.localDescription!.sdp, /a=end-of-candidates/);
    await offerer.setRemoteDescription(answerer.localDescription!);
    await deadline(open);
    assert.ok(remote);
    cancellation.abort();
    channel.send("camera-stop-1004");
    assert.equal(await deadline(received), "camera-stop-1004");
    assert.equal(await deadline(ack), "stop-acknowledged");
    assert.notEqual(answerer.iceTransports[0]!.connection.state, "closed");
    await answerer.close();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(answerer.iceTransports[0]!.connection.state, "closed");
    assert.equal(states.slice(states.indexOf("closed")).every(value => value === "closed"), true);
  } finally {
    await answerer.close(); await offerer.close();
    await new Promise<void>(resolve => sink.close(() => resolve()));
  }
});
