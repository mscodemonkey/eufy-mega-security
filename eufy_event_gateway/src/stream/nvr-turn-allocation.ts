/**
 * Owns cancellable relay acquisition for one NVR ICE connection. The caller
 * registers successful protocols and retires them after its camera stop request.
 * Public Werift TURN primitives retain authentication, framing and permissions.
 */
import { connect, type Socket } from "node:net";
import { TurnProtocol, StunOverTurnProtocol, UdpTransport, Message, methods, classes,
  type Address, type InterfaceAddresses, type Transport, type TransactionRequestOptions } from "werift";

/** Relay settings copied from the pinned connection before acquisition starts. */
export interface NvrTurnOptions {
  readonly server: Address;
  readonly username: string;
  readonly credential: string;
  readonly transport: "udp" | "tcp";
  readonly portRange?: [number, number];
  readonly interfaceAddresses?: InterfaceAddresses;
}

/** Normalize supported request forms without letting Werift mutate caller options. */
export function nvrRequestOptions(options: number | TransactionRequestOptions | undefined,
  signal: AbortSignal, onRequestSent?: (attempt: number) => void): TransactionRequestOptions {
  const original = typeof options === "object" ? options : {
    ...(options === undefined ? {} : { retransmissions: options }),
    ...(onRequestSent ? { onRequestSent } : {}),
  };
  return { ...original, signal: original.signal ? AbortSignal.any([original.signal, signal]) : signal };
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("NVR relay acquisition cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

async function tcpTransport(server: Address, signal: AbortSignal): Promise<Transport> {
  signal.throwIfAborted();
  const socket: Socket = connect({ host: server[0], port: server[1], signal });
  const transport: Transport = {
    type: "tcp",
    get address() {
      const address = socket.address();
      if (typeof address === "string" || !("address" in address)) throw new Error("NVR relay socket unavailable");
      return address;
    },
    get closed() { return socket.destroyed; },
    onData() {},
    send(data) {
      signal.throwIfAborted();
      return new Promise<void>((resolve, reject) => socket.write(data, error => error ? reject(error) : resolve()));
    },
    async close() { socket.destroy(); },
  };
  socket.on("data", data => transport.onData(data, server));

  // Startup errors reject the wait. A permanent handler also owns later errors.
  socket.on("error", () => {});
  try {
    await abortable(new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("NVR relay socket closed")));
    }), signal);
    return transport;
  } catch (error) { socket.destroy(); throw error; }
}

/**
 * Acquire a UDP relay with TCP fallback, bounded by phase deadlines. Gathering
 * cancellation stops pending acquisition. Successful relays remain usable until
 * retirement so the session can send its camera stop command before closing.
 */
export async function allocateNvrTurn(options: NvrTurnOptions, gathering: AbortSignal,
  retirement: AbortSignal): Promise<StunOverTurnProtocol> {
  const total = AbortSignal.timeout(12_000);
  const transports = options.transport === "udp" ? ["udp", "tcp"] as const : ["tcp"] as const;
  for (const kind of transports) {
    gathering.throwIfAborted(); retirement.throwIfAborted(); total.throwIfAborted();
    const allocation = new AbortController();
    const phase = AbortSignal.timeout(6_000);
    const pending = AbortSignal.any([gathering, retirement, total, phase]);
    const abortAllocation = (): void => allocation.abort();
    pending.addEventListener("abort", abortAllocation, { once: true });
    if (pending.aborted) allocation.abort();
    let transport: Transport | undefined;
    let turn: TurnProtocol | undefined;
    let refreshTimer: NodeJS.Timeout | undefined;
    let closed = false;
    const cleanup = (): void => {
      if (refreshTimer) clearTimeout(refreshTimer);
      allocation.abort();
      if (turn) void turn.close().catch(() => {});
      else if (transport) void transport.close().catch(() => {});
    };
    try {
      const creating = kind === "udp"
        ? UdpTransport.init("udp4", {
          ...(options.portRange ? { portRange: options.portRange } : {}),
          ...(options.interfaceAddresses ? { interfaceAddresses: options.interfaceAddresses } : {}),
        }) : tcpTransport(options.server, allocation.signal);
      void creating.then(value => { if (allocation.signal.aborted) void value.close().catch(() => {}); }, () => {});
      transport = await abortable(creating, allocation.signal);
      turn = new TurnProtocol(options.server, options.username, options.credential, 600, transport);
      const owned = turn;
      const request = owned.request.bind(owned);
      owned.request = (message, address, key, policy, attempt) => {
        allocation.signal.throwIfAborted();
        return request(message, address, key, nvrRequestOptions(policy, allocation.signal, attempt));
      };
      const originalClose = owned.close.bind(owned);
      owned.close = async () => {
        if (closed) return;
        closed = true;
        if (refreshTimer) clearTimeout(refreshTimer);
        allocation.abort();
        retirement.removeEventListener("abort", cleanup);
        await originalClose();
      };
      if (typeof Reflect.get(owned, "refresh") !== "function") throw new Error("Unsupported NVR relay refresh contract");
      const refresh = (lifetime: number): void => {
        if (refreshTimer) clearTimeout(refreshTimer);
        if (allocation.signal.aborted) return;
        const seconds = Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 600;
        refreshTimer = setTimeout(() => {
          const message = new Message(methods.REFRESH, classes.REQUEST).setAttribute("LIFETIME", seconds);
          void owned.requestWithRetry(message, options.server).then(([response]) => {
            refresh(response.getAttributeValue("LIFETIME"));
          }, () => { if (!allocation.signal.aborted) refresh(seconds); });
        }, seconds * 5 / 6 * 1000);
        refreshTimer.unref();
      };
      Object.defineProperty(owned, "refresh", { configurable: true, writable: true, value: refresh });
      retirement.addEventListener("abort", cleanup, { once: true });
      await abortable(owned.connectionMade(), allocation.signal);
      allocation.signal.throwIfAborted();
      pending.removeEventListener("abort", abortAllocation);
      return new StunOverTurnProtocol(owned);
    } catch (error) {
      cleanup();
      retirement.removeEventListener("abort", cleanup);
      if (gathering.aborted || retirement.aborted || total.aborted || kind === "tcp") throw error;
    } finally { pending.removeEventListener("abort", abortAllocation); }
  }
  throw new Error("NVR relay allocation failed");
}
