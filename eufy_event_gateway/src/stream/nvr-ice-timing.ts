/**
 * Scopes the pinned werift connectivity-check timing to one experimental peer.
 * The RTC owner supplies cancellation and closes the peer. No package source,
 * process-global defaults, consent requests or other peers are changed.
 */
import { Connection, type Protocol, type RTCPeerConnection } from "werift";
import { NvrTrialError } from "./nvr-protocol.js";

/** Install once before applying the remote description, retaining integrity and TCP policy. */
export function installNvrIceTiming(peer: RTCPeerConnection, signal: AbortSignal): void {
  const protocols = new WeakSet<Protocol>();
  if (peer.iceTransports.length !== 1) throw new NvrTrialError("timing");
  for (const transport of peer.iceTransports) {
    const connection = transport.connection;
    if (!(connection instanceof Connection) || typeof connection.checkStart !== "function") throw new NvrTrialError("timing");
    const check = connection.checkStart.bind(connection);
    connection.checkStart = pair => {
      if (!protocols.has(pair.protocol)) {
        protocols.add(pair.protocol);
        const original = pair.protocol.request.bind(pair.protocol);
        pair.protocol.request = (request, address, key, options, onAttempt) => {
          if (pair.protocol.type !== "tcp" && options === 4 && request.messageMethod === 1) {
            return original(request, address, key, { retransmissions: 7, responseTimeout: 500, signal,
              ...(onAttempt ? { onRequestSent: onAttempt } : {}) });
          }
          return original(request, address, key, options, onAttempt);
        };
      }
      return check(pair);
    };
  }
}
