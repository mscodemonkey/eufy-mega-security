/**
 * Observes the pinned Werift transport factories and negotiated keys for private
 * replay. The process composition root owns installation and restoration. Peers
 * still own sockets, crypto, callbacks and cleanup. UDP input is copied before
 * ICE, DTLS or SRTP parsing, including packets those layers reject.
 */
import { randomUUID } from "node:crypto";
import { UdpTransport, TcpTransport, TlsTransport, RTCDtlsTransport,
  type Transport, type RTCDataChannel, type RTCPeerConnection } from "werift";
import { recordRaw, rawHistoryEnabled } from "./raw-history.js";
import { observeRawSocket } from "./raw-network.js";

function observeFramedTransport(transport: Transport): void {
  const connection = randomUUID();
  const boundary = "rtc_relay_stream";
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(transport), "onData");
  if (!descriptor?.get || !descriptor.set) {
    recordRaw({ boundary, connection, direction: "state", metadata: { event: "unsupported_input_accessor" } });
    return;
  }
  const originalSend = transport.send;
  const initial = transport.onData;
  Object.defineProperty(transport, "onData", {
    configurable: true,
    get: () => descriptor.get!.call(transport),
    set: (handler: Transport["onData"]) => {
      if (typeof handler !== "function") { descriptor.set!.call(transport, handler); return; }
      descriptor.set!.call(transport, function(this: unknown, data: Buffer, address: unknown) {
        recordRaw({ boundary, connection, direction: "receive", metadata: { address, kind: transport.type } }, data);
        return Reflect.apply(handler, this, [data, address]);
      });
    },
  });
  transport.onData = initial;
  transport.send = function(this: Transport, ...args: Parameters<Transport["send"]>) {
    recordRaw({ boundary, connection, direction: "send", metadata: { address: args[1], kind: transport.type } }, args[0]);
    return Reflect.apply(originalSend, this, args) as ReturnType<Transport["send"]>;
  };
}

/**
 * Install once while recording is enabled, before constructing peers. Only these
 * library factories and public crypto lifecycle methods are wrapped. Restoration
 * leaves another owner's replacements intact. A disabled recorder is inert.
 */
export function installRawRtcCapture(): () => void {
  if (!rawHistoryEnabled()) return () => undefined;
  const udp = UdpTransport.init, tcp = TcpTransport.init, tls = TlsTransport.init;
  const start = RTCDtlsTransport.prototype.start;
  const update = RTCDtlsTransport.prototype.updateSrtpSession;
  const observedUdp: typeof udp = async function(this: typeof UdpTransport, ...args) {
    const transport = await Reflect.apply(udp, this, args) as UdpTransport;
    try { observeRawSocket(transport.socket, "rtc_udp_datagram", "udp"); }
    catch { recordRaw({ boundary: "rtc_udp_datagram", connection: "factory", direction: "state", metadata: { event: "observation_failed" } }); }
    return transport;
  };
  const observedTcp: typeof tcp = async function(this: typeof TcpTransport, ...args) {
    const transport = await Reflect.apply(tcp, this, args) as TcpTransport;
    try { observeFramedTransport(transport); }
    catch { recordRaw({ boundary: "rtc_relay_stream", connection: "factory", direction: "state", metadata: { event: "observation_failed" } }); }
    return transport;
  };
  const observedTls: typeof tls = async function(this: typeof TlsTransport, ...args) {
    const transport = await Reflect.apply(tls, this, args) as TlsTransport;
    try { observeFramedTransport(transport); }
    catch { recordRaw({ boundary: "rtc_relay_stream", connection: "factory", direction: "state", metadata: { event: "observation_failed" } }); }
    return transport;
  };
  const observedStart = async function(this: RTCDtlsTransport): Promise<void> {
    try { await start.call(this); }
    catch (error) {
      recordRaw({ boundary: "rtc_dtls_keys", connection: this.id, direction: "state", metadata: { event: "start_failed" } });
      throw error;
    }
    try {
      const cipher = this.dtls?.cipher;
      if (cipher) recordRaw({ boundary: "rtc_dtls_keys", connection: this.id, direction: "decode",
        metadata: { ice: this.iceTransport.id, role: cipher.sessionType, cipherSuite: cipher.cipherSuite,
          masterSecret: cipher.masterSecret, localRandom: cipher.localRandom.serialize(), remoteRandom: cipher.remoteRandom.serialize(),
          selectedPair: this.iceTransport.getSelectedCandidatePair() } });
    } catch { recordRaw({ boundary: "rtc_dtls_keys", connection: this.id, direction: "state", metadata: { event: "key_observation_failed" } }); }
  };
  const observedUpdate = function(this: RTCDtlsTransport): void {
    update.call(this);
    try { recordRaw({ boundary: "rtc_srtp_keys", connection: this.id, direction: "decode",
      metadata: { ice: this.iceTransport.id, config: this.srtp.config } }); }
    catch { recordRaw({ boundary: "rtc_srtp_keys", connection: this.id, direction: "state", metadata: { event: "key_observation_failed" } }); }
  };
  UdpTransport.init = observedUdp; TcpTransport.init = observedTcp; TlsTransport.init = observedTls;
  RTCDtlsTransport.prototype.start = observedStart;
  RTCDtlsTransport.prototype.updateSrtpSession = observedUpdate;
  return () => {
    if (UdpTransport.init === observedUdp) UdpTransport.init = udp;
    if (TcpTransport.init === observedTcp) TcpTransport.init = tcp;
    if (TlsTransport.init === observedTls) TlsTransport.init = tls;
    if (RTCDtlsTransport.prototype.start === observedStart) RTCDtlsTransport.prototype.start = start;
    if (RTCDtlsTransport.prototype.updateSrtpSession === observedUpdate) RTCDtlsTransport.prototype.updateSrtpSession = update;
  };
}

/** Bind peer, DTLS and ICE identities to the provider's private device context. */
export function observeRawPeer(peer: RTCPeerConnection, owner: unknown): void {
  if (!rawHistoryEnabled()) return;
  const connection = randomUUID();
  const record = (): void => {
    try { recordRaw({ boundary: "rtc_peer", connection, direction: "state", metadata: { owner,
      state: peer.connectionState, dtls: peer.dtlsTransports.map(transport => ({ id: transport.id, ice: transport.iceTransport.id })) } }); }
    catch { recordRaw({ boundary: "rtc_peer", connection, direction: "state", metadata: { event: "observation_failed" } }); }
  };
  record(); peer.connectionStateChange.subscribe(record); peer.iceGatheringStateChange.subscribe(record);
}

/** Copy data-channel messages before the NVR parser and command dispatch. */
export function observeRawDataChannel(channel: RTCDataChannel, owner: unknown): void {
  if (!rawHistoryEnabled()) return;
  const connection = randomUUID();
  const metadata = { owner, label: channel.label, dtls: channel.sctp.dtlsTransport?.id };
  channel.onMessage.subscribe(data => recordRaw({ boundary: "rtc_data_channel", connection, direction: "receive", metadata },
    typeof data === "string" ? Buffer.from(data) : data));
  const original = channel.send;
  channel.send = function(this: RTCDataChannel, data) {
    recordRaw({ boundary: "rtc_data_channel", connection, direction: "send", metadata }, typeof data === "string" ? Buffer.from(data) : data);
    return original.call(this, data);
  };
}
