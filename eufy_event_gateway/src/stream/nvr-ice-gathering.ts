/**
 * Adapts pinned Werift 0.24.4 gathering for one single-use NVR peer. This module
 * owns its instance hooks, gathering cancellation and late relay registration.
 * The RTC session still owns signalling, candidate limits, camera stop and close.
 */
import { Candidate, CandidatePairState, Connection, ICE_COMPLETED, ICE_FAILED,
  candidateFoundation, candidatePriority, type CandidatePair, type IceState,
  type Protocol, type RTCPeerConnection } from "werift";
import { NvrTrialError } from "./nvr-protocol.js";
import { allocateNvrTurn, nvrRequestOptions } from "./nvr-turn-allocation.js";

/** Pinned instance-only seams, checked atomically before installing any hook. */
interface PinnedIce {
  protocols: Protocol[];
  checkList: CandidatePair[];
  checkListDone: boolean;
  checkListState: { put(value: Promise<number>): void };
  appendLocalCandidate(candidate: Candidate): void;
  ensureProtocol(protocol: Protocol): void;
  pairLocalProtocol(protocol: Protocol): void;
  sortCheckList(): void;
  schedulingChecks(): boolean;
  checkComplete(pair: CandidatePair): void;
  queryConsent(): void;
  setState(state: IceState): void;
  getCandidatePromises(addresses: string[], timeout?: number): Promise<unknown>[];
}

/** Werift's local-description gathering seam, kept inside this pinned adapter. */
interface PinnedPeer {
  gatherCandidates(): Promise<void>;
}

const installed = new WeakSet<Connection>();

/**
 * Start ICE after a useful UDP candidate and a one-second gathering grace. Late
 * relays remain eligible, and retirement cannot resurrect sockets or consent.
 * Unsupported pinned contracts fail before mutation. Install after ICE timing.
 */
export function installNvrIceGathering(peer: RTCPeerConnection, signal: AbortSignal): void {
  if (signal.aborted) throw new NvrTrialError("cancelled");
  const transport = peer.iceTransports[0];
  if (peer.iceTransports.length !== 1 || !transport || !(transport.connection instanceof Connection)) {
    throw new NvrTrialError("timing");
  }
  const connection = transport.connection;
  const ice = connection as unknown as PinnedIce;
  const pinnedPeer = peer as unknown as PinnedPeer;
  const hooks = ["appendLocalCandidate", "ensureProtocol", "pairLocalProtocol", "sortCheckList", "schedulingChecks",
    "checkComplete", "queryConsent", "setState", "getCandidatePromises"] as const;
  if (installed.has(connection) || hooks.some(key => typeof ice[key] !== "function")
    || !Array.isArray(ice.protocols) || !Array.isArray(ice.checkList) || typeof ice.checkListDone !== "boolean"
    || typeof ice.checkListState?.put !== "function" || typeof pinnedPeer.gatherCandidates !== "function"
    || connection.options.turnTransport === "tls") {
    throw new NvrTrialError("timing");
  }
  const saved = new Map<object, Map<PropertyKey, PropertyDescriptor | undefined>>();
  const replace = (target: object, key: PropertyKey, value: unknown): void => {
    if (!saved.has(target)) saved.set(target, new Map());
    saved.get(target)!.set(key, Object.getOwnPropertyDescriptor(target, key));
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  };
  const restorePeerGather = (): void => {
    const descriptor = saved.get(peer)?.get("gatherCandidates");
    if (descriptor) Object.defineProperty(peer, "gatherCandidates", descriptor);
    else Reflect.deleteProperty(peer, "gatherCandidates");
  };
  const gathering = new AbortController();
  const retirement = new AbortController();
  const known = new Set<Protocol>();
  const paired = new WeakSet<Protocol>();
  let retired = false;
  let gatherSettled = false;
  let connectStarted = false;
  let terminalFailure = false;
  let deferredPair: CandidatePair | undefined;
  let completingPair: CandidatePair | undefined;
  let release: (() => void) | undefined;
  let grace: NodeJS.Timeout | undefined;
  let early: Promise<void> | undefined;
  let eligible = false;
  const clearGrace = (): void => { if (grace) clearTimeout(grace); grace = undefined; };
  const closeKnown = (): void => {
    for (const protocol of known) void protocol.close().catch(() => {});
  };
  const retire = (): void => {
    retired = true;
    clearGrace(); gathering.abort(); retirement.abort(); closeKnown(); release?.();
    signal.removeEventListener("abort", abort);
    restorePeerGather();
  };
  const abort = (): void => {
    clearGrace(); gathering.abort(); release?.();
    if (!connection.nominated && connection.state !== "connected") retire();
  };
  const append = ice.appendLocalCandidate.bind(connection);
  const ensure = ice.ensureProtocol.bind(connection);
  const pair = ice.pairLocalProtocol.bind(connection);
  const sort = ice.sortCheckList.bind(connection);
  const schedule = ice.schedulingChecks.bind(connection);
  const complete = ice.checkComplete.bind(connection);
  const consent = ice.queryConsent.bind(connection);
  const setState = ice.setState.bind(connection);
  const jobs = ice.getCandidatePromises.bind(connection);
  const put = ice.checkListState.put.bind(ice.checkListState);
  const gatherConnection = connection.gatherCandidates.bind(connection);
  const connectConnection = connection.connect.bind(connection);
  const close = connection.close.bind(connection);
  const check = connection.checkStart.bind(connection);
  const gatherPeer = pinnedPeer.gatherCandidates.bind(peer);
  try {
    replace(ice, "ensureProtocol", (protocol: Protocol): void => {
      known.add(protocol);
      const request = protocol.request.bind(protocol);
      protocol.request = (message, address, key, policy, attempt) => {
        retirement.signal.throwIfAborted();
        const stun = !key && connection.stunServer?.[0] === address[0] && connection.stunServer?.[1] === address[1];
        const cancellation = stun ? gathering.signal : retirement.signal;
        cancellation.throwIfAborted();
        return request(message, address, key, nvrRequestOptions(policy, cancellation, attempt));
      };
      ensure(protocol);
      if (retired) closeKnown();
    });
    replace(ice, "appendLocalCandidate", (candidate: Candidate): void => {
      const protocol = ice.protocols.find(value => value.localCandidate === candidate);
      if (protocol) known.add(protocol);
      if (retired || gathering.signal.aborted) { if (retired) closeKnown(); return; }
      if (protocol?.type === "turn" && candidate.type === "relay" && !paired.has(protocol)
        && !connection.nominated && !ice.checkListDone) {
        paired.add(protocol); pair(protocol); if (connectStarted) sort();
      }
      append(candidate);
      if (!eligible && candidate.transport.toLowerCase() === "udp" && (!connection.options.forceTurn || candidate.type === "relay")) {
        eligible = true;
        if (release) grace = setTimeout(() => { clearGrace(); release?.(); }, 1000);
      }
    });
    replace(ice, "getCandidatePromises", (addresses: string[], timeout?: number): Promise<unknown>[] => {
      const server = connection.turnServer;
      const { turnUsername: username, turnPassword: credential, turnTransport: kind, portRange, interfaceAddresses } = connection.options;
      const hasRelay = !connection.iceLite && server && username && credential;
      let pending: Promise<unknown>[];
      Reflect.set(connection, "turnServer", undefined);
      try { pending = jobs(hasRelay && connection.options.forceTurn ? [] : addresses, timeout); }
      finally { Reflect.set(connection, "turnServer", server); }
      if (hasRelay) pending.push(allocateNvrTurn({ server, username, credential, transport: kind === "tcp" ? "tcp" : "udp",
        ...(portRange ? { portRange } : {}), ...(interfaceAddresses ? { interfaceAddresses } : {}) }, gathering.signal, retirement.signal)
        .then(protocol => {
          if (retired || gathering.signal.aborted) { void protocol.close().catch(() => {}); return; }
          ice.ensureProtocol(protocol);
          ice.protocols.push(protocol);
          const [host, port] = protocol.turn.relayedAddress;
          const [relatedHost, relatedPort] = protocol.turn.mappedAddress;
          protocol.localCandidate = new Candidate(candidateFoundation("relay", "udp", host), 1, "udp", candidatePriority("relay"),
            host, port, "relay", relatedHost, relatedPort, undefined, connection.generation, connection.localUsername);
          ice.appendLocalCandidate(protocol.localCandidate);
        }).catch(() => {}));
      return pending;
    });
    replace(ice, "schedulingChecks", (): boolean => {
      if (retired || terminalFailure) return false;
      return schedule() || (!gatherSettled && !connection.nominated && !ice.checkListDone);
    });
    replace(ice, "checkComplete", (candidatePair: CandidatePair): void => {
      completingPair = candidatePair;
      try { complete(candidatePair); } finally { completingPair = undefined; }
    });
    replace(ice.checkListState, "put", (value: Promise<number>): void => {
      const candidatePair = completingPair;
      void value.then(result => {
        if (result === ICE_FAILED && !gatherSettled && !retired) { deferredPair = candidatePair; return; }
        if (result === ICE_FAILED) {
          terminalFailure = true;
          const failed = Promise.reject<number>(new NvrTrialError("negotiation"));
          void failed.catch(() => {}); put(failed);
        } else if (result === ICE_COMPLETED) put(Promise.resolve(result));
      }, () => { terminalFailure = true; });
    });
    replace(ice, "queryConsent", (): void => { if (!retired) consent(); });
    replace(connection, "checkStart", ((candidatePair: CandidatePair) => {
      if (retired) return { awaitable: Promise.resolve(), resolve() {}, reject() {} };
      return check(candidatePair);
    }) satisfies Connection["checkStart"]);
    replace(ice, "setState", (state: IceState): void => {
      if (retired && state !== "closed") return;
      if (state === "completed" && (connectStarted || connection.nominated || connection.state === "connected")) return;
      setState(state);
    });
    replace(connection, "connect", async (): Promise<void> => {
      if (retired) return;
      connectStarted = true;
      try { await connectConnection(); } catch (error) { if (!retired) throw error; }
    });
    replace(connection, "gatherCandidates", async (): Promise<void> => {
      try { await gatherConnection(); }
      finally {
        gatherSettled = true;
        if (retired) closeKnown();
        if (deferredPair && !retired && !connection.nominated) {
          const terminal = [CandidatePairState.SUCCEEDED, CandidatePairState.FAILED];
          if (ice.checkList.every(value => terminal.includes(value.state))) complete(deferredPair);
        }
      }
    });
    replace(connection, "close", async (): Promise<void> => { retire(); await close(); });
    replace(peer, "gatherCandidates", (): Promise<void> => {
      if (early) return early;
      early = new Promise<void>((resolve, reject) => {
        release = resolve;
        if (retired || gathering.signal.aborted) { resolve(); return; }
        if (eligible) grace = setTimeout(() => { clearGrace(); resolve(); }, 1000);
        Promise.resolve().then(gatherPeer).then(resolve, reject).finally(clearGrace).catch(() => {});
      });
      return early;
    });
    installed.add(connection);
    signal.addEventListener("abort", abort, { once: true });
  } catch (error) {
    for (const [target, properties] of saved) for (const [key, descriptor] of properties) {
      if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key);
    }
    throw error;
  }
}
