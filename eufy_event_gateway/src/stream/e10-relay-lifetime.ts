/**
 * Keeps TURN permissions alive on one admitted E10 RTP peer using pinned Werift
 * 0.24.4 instance seams. The RTC session owns cancellation and relay closure.
 * No package files, global prototypes, consent deadlines or other peers change.
 */
import { Connection, StunOverTurnProtocol, TurnProtocol, type RTCPeerConnection } from "werift";

const PERMISSION_REFRESH_SECONDS = 240;

interface PinnedTurn {
  channelRefreshTime: number;
  permissionByAddr: Record<string, boolean>;
}

/**
 * Renew channel bindings before their separate five-minute permission expires.
 * Send-indication fallback permissions are also expired locally before reuse.
 * The dependency still owns authenticated requests, coalescing and retry limits.
 * Cancellation restores only hooks and settings still owned by this adapter.
 */
export function retainE10RelayPermissions(turn: TurnProtocol, signal: AbortSignal): void {
  signal.throwIfAborted();
  const pinned = turn as unknown as PinnedTurn;
  const cache = pinned.permissionByAddr;
  if (!(turn instanceof TurnProtocol) || !Number.isFinite(pinned.channelRefreshTime) || pinned.channelRefreshTime <= 0
    || !cache || Object.getPrototypeOf(cache) !== Object.prototype || Object.values(cache).some(value => value !== true)
    || typeof turn.getPermission !== "function") throw new Error("Unsupported E10 relay permission contract");
  const previousRefresh = pinned.channelRefreshTime;
  const refresh = Math.min(previousRefresh, PERMISSION_REFRESH_SECONDS);
  const previousPermission = turn.getPermission;
  const expires = new Map<string, number>();
  const permission: typeof turn.getPermission = async address => {
    signal.throwIfAborted();
    const key = address[0];
    const startedAt = Date.now();
    if (cache[key] && (expires.get(key) ?? 0) <= startedAt) delete cache[key];
    await previousPermission.call(turn, address);
    if (!signal.aborted && (expires.get(key) ?? 0) <= startedAt) expires.set(key, startedAt + PERMISSION_REFRESH_SECONDS * 1000);
  };
  pinned.channelRefreshTime = refresh;
  turn.getPermission = permission;
  const restore = (): void => {
    if (pinned.channelRefreshTime === refresh) pinned.channelRefreshTime = previousRefresh;
    if (turn.getPermission === permission) turn.getPermission = previousPermission;
    expires.clear();
    signal.removeEventListener("abort", restore);
  };
  signal.addEventListener("abort", restore, { once: true });
}

/**
 * Attach relay maintenance before this RTP peer's first connectivity check.
 * Install after the remote description creates its single bundled ICE transport.
 * Direct routes keep the dependency's original behavior. The RTC owner must
 * close the peer after cancellation, including any in-flight relay transaction.
 */
export function installE10RelayLifetime(peer: RTCPeerConnection, signal: AbortSignal): void {
  signal.throwIfAborted();
  const connection = peer.iceTransports[0]?.connection;
  if (peer.iceTransports.length !== 1 || !(connection instanceof Connection)
    || typeof connection.checkStart !== "function") throw new Error("Unsupported E10 ICE relay contract");
  const previous = connection.checkStart;
  const installed = new WeakSet<TurnProtocol>();
  const check: typeof connection.checkStart = pair => {
    signal.throwIfAborted();
    if (pair.protocol instanceof StunOverTurnProtocol && !installed.has(pair.protocol.turn)) {
      retainE10RelayPermissions(pair.protocol.turn, signal);
      installed.add(pair.protocol.turn);
    }
    return previous.call(connection, pair);
  };
  connection.checkStart = check;
  signal.addEventListener("abort", () => { if (connection.checkStart === check) connection.checkStart = previous; }, { once: true });
}
