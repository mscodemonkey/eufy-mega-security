/**
 * Runs one isolated ICE acceptance scenario and exits naturally after cleanup.
 * The parent owns a loopback coturn fixture. This child owns every peer/proxy
 * socket and reports only timing, selected candidate types and byte delivery.
 */
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer, connect, type Socket } from "node:net";
import { RTCPeerConnection, type RTCIceCandidate, type Protocol } from "werift";
import { installNvrIceGathering } from "../../src/stream/nvr-ice-gathering.js";

const scenario = process.argv[2];
const relayPort = Number(process.env.NVR_TEST_TURN_PORT ?? "34780");

async function bounded<T>(operation: Promise<T>, milliseconds = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("ICE acceptance deadline")), milliseconds);
  })]); } finally { if (timer) clearTimeout(timer); }
}

async function run(): Promise<void> {
  const sink = createSocket("udp4");
  await new Promise<void>(resolve => sink.bind(0, "127.0.0.1", resolve));
  const sinkPort = sink.address().port;
  const cancellation = new AbortController();
  const config = { iceServers: [{ urls: `turn:127.0.0.1:${scenario === "unreachable" ? sinkPort : relayPort}?transport=${scenario === "tcp" ? "tcp" : "udp"}`,
    username: "probe", credential: "local-fixture-only" }], iceUseIpv4: false, iceUseIpv6: false,
    iceAdditionalHostAddresses: ["127.0.0.1"], iceTransportPolicy: "relay" as const };
  let failedDirectChecks = 0;
  const lateRelay = scenario?.startsWith("late") || ["cancel-late", "remote-ended"].includes(scenario ?? "");

  // Block incoming host checks too, so peer-reflexive checks cannot bypass the delayed relay.
  const a = new RTCPeerConnection(config), b = new RTCPeerConnection({ ...config,
    ...(lateRelay ? { iceTransportPolicy: "all" as const,
      iceFilterStunResponse: (_message, _address, protocol) => protocol.type === "turn",
      iceFilterCandidatePair: (pair: { localCandidate: { type: string } }) => scenario === "late-failed" ? true : pair.localCandidate.type === "relay" } : {}) });
  const channel = a.createDataChannel("data"); b.createDataChannel("owned");
  for (const peer of [a, b]) {
    peer.iceTransports[0]!.connection.stunServer = ["127.0.0.1", sinkPort];
    installNvrIceGathering(peer, cancellation.signal);
  }
  let endedChecks = 0;
  if (scenario === "remote-ended") {
    const ice = a.iceTransports[0]!.connection as unknown as { ensureProtocol(protocol: Protocol): void };
    const ensure = ice.ensureProtocol.bind(ice);
    ice.ensureProtocol = protocol => {
      ensure(protocol);
      const request = protocol.request.bind(protocol);
      protocol.request = (message, address, key, policy, attempt) => key
        ? (endedChecks++, Promise.reject(new Error("synthetic failed remote route")))
        : request(message, address, key, policy, attempt);
    };
  }
  const proxies: ReturnType<typeof createSocket>[] = [];
  const tcpSockets = new Set<Socket>();
  const tcpProxy = scenario === "fallback" ? createServer(socket => {
    const upstream = connect({ host: "127.0.0.1", port: relayPort });
    for (const value of [socket, upstream]) {
      tcpSockets.add(value); value.on("error", () => {}); value.on("close", () => tcpSockets.delete(value));
    }
    socket.pipe(upstream).pipe(socket);
  }) : undefined;
  if (tcpProxy) {
    await new Promise<void>(resolve => tcpProxy.listen(sinkPort, "127.0.0.1", resolve));
    b.iceTransports[0]!.connection.turnServer = ["127.0.0.1", sinkPort];
  }
  let releaseTimer: NodeJS.Timeout | undefined;
  if (scenario === "late-failed") {
    const ice = b.iceTransports[0]!.connection as unknown as { ensureProtocol(protocol: Protocol): void };
    const original = ice.ensureProtocol.bind(ice);
    ice.ensureProtocol = protocol => {
      original(protocol);
      const request = protocol.request.bind(protocol);
      protocol.request = (message, address, key, policy, attempt) => protocol.type === "stun" && key
        ? (failedDirectChecks++, Promise.reject(new Error("synthetic initial direct-check failure")))
        : request(message, address, key, policy, attempt);
    };
  }
  if (lateRelay) {
    const front = createSocket("udp4"), back = createSocket("udp4"); proxies.push(front, back);
    await Promise.all(proxies.map(socket => new Promise<void>(resolve => socket.bind(0, "127.0.0.1", resolve))));
    let target: { port: number; address: string } | undefined;
    let ready = false;
    const pending: Buffer[] = [];
    front.on("message", (data, remote) => {
      target = remote;
      if (ready) back.send(data, relayPort, "127.0.0.1"); else pending.push(Buffer.from(data));
    });
    back.on("message", data => { if (target) front.send(data, target.port, target.address); });
    b.iceTransports[0]!.connection.turnServer = ["127.0.0.1", front.address().port];
    releaseTimer = setTimeout(() => { ready = true; for (const data of pending) back.send(data, relayPort, "127.0.0.1"); pending.length = 0; }, 2500);
  }
  const started = performance.now();
  try {
    if (scenario === "unreachable") {
      const local = a.setLocalDescription(await a.createOffer());
      await new Promise(resolve => setTimeout(resolve, 100));
      cancellation.abort();
      await bounded(Promise.all([a.close(), b.close(), local]), 2000);
      console.log(JSON.stringify({ scenario, passed: true, cleanup_ms: Math.round(performance.now() - started) }));
      return;
    }
    const fromB: RTCIceCandidate[] = [];
    b.onIceCandidate.subscribe(candidate => {
      if (candidate) {
        if (a.remoteDescription) void a.addIceCandidate(candidate).catch(() => {});
        else fromB.push(candidate);
      }
    });
    let delivered: (value: string) => void = () => {};
    const received = new Promise<string>(resolve => { delivered = resolve; });
    b.onDataChannel.subscribe(value => { value.onmessage = event => { delivered(String(event.data)); value.send("ack"); }; });
    let acknowledged: (value: string) => void = () => {};
    const ack = new Promise<string>(resolve => { acknowledged = resolve; });
    channel.onmessage = event => acknowledged(String(event.data));
    const open = new Promise<void>(resolve => { channel.onopen = resolve; });
    await bounded(a.setLocalDescription(await a.createOffer()));
    await b.setRemoteDescription(a.localDescription!);
    const answerAt = performance.now();
    await bounded(b.setLocalDescription(await b.createAnswer()));
    const answerMilliseconds = Math.round(performance.now() - answerAt);
    if (lateRelay) {
      assert.ok(answerMilliseconds < 750);
      assert.doesNotMatch(b.localDescription!.sdp, / typ relay /);
    }
    if (scenario === "cancel-late") {
      cancellation.abort();
      await bounded(Promise.all([a.close(), b.close()]), 2000);
      assert.equal(b.iceTransports[0]!.connection.state, "closed");
      console.log(JSON.stringify({ scenario, passed: true, answer_ms: answerMilliseconds }));
      return;
    }
    let failed = false;
    const remoteFailure = new Promise<void>(resolve => {
      a.connectionStateChange.subscribe(state => { if (state === "failed") { failed = true; resolve(); } });
    });
    await a.setRemoteDescription(b.localDescription!);
    if (scenario === "remote-ended") {
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(endedChecks > 0);
      assert.equal(failed, false);
      await a.addIceCandidate();
      await bounded(remoteFailure, 2000);
      console.log(JSON.stringify({ scenario, passed: true, failed_checks: endedChecks }));
      return;
    }
    for (const candidate of fromB) await a.addIceCandidate(candidate);
    await bounded(open).catch(error => {
      const states = [a, b].map(peer => {
        const ice = peer.iceTransports[0]!.connection;
        return { state: ice.state, candidates: ice.localCandidates.map(candidate => candidate.type),
          pairs: ice.candidatePairs.map(pair => ({ local: pair.localCandidate.type, remote: pair.remoteCandidate.type, state: pair.state })) };
      });
      throw new Error(JSON.stringify(states), { cause: error });
    });
    cancellation.abort();
    channel.send("camera-stop-1004");
    assert.equal(await bounded(received), "camera-stop-1004");
    assert.equal(await bounded(ack), "ack");
    const selected = b.iceTransports[0]!.connection.nominated;
    assert.equal(selected?.localCandidate.type, "relay");
    if (scenario === "late-failed") assert.ok(failedDirectChecks > 0);
    console.log(JSON.stringify({ scenario, passed: true, answer_ms: answerMilliseconds,
      connected_ms: Math.round(performance.now() - started), selected: selected?.localCandidate.type }));
  } finally {
    if (releaseTimer) clearTimeout(releaseTimer);
    await Promise.allSettled([a.close(), b.close()]);
    for (const socket of tcpSockets) socket.destroy();
    if (tcpProxy) await new Promise<void>(resolve => tcpProxy.close(() => resolve()));
    await Promise.all([sink, ...proxies].map(socket => new Promise<void>(resolve => socket.close(() => resolve()))));
  }
}

await run();
