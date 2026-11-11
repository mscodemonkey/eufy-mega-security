/**
 * Defines the opt-in standalone T8420 keyless media contract.
 * The PPCS session owns negotiation, packet lifetime and cleanup. This module
 * only checks its exact route and constructs the captured start value consumed
 * by that session. It neither selects a cipher nor sends a command.
 */

/** Inventory and explicit opt-in facts required before considering the alternate start. */
export interface T8420LiveRoute {
  readonly enabled?: boolean | undefined;
  readonly model: string;
  readonly deviceType?: number | null | undefined;
  readonly stationModel?: string | undefined;
  readonly channel: number;
  readonly attached?: boolean | undefined;
  readonly purpose?: "media" | "control" | "passive" | undefined;
  readonly accountId: string | null;
}

/** Restrict the trial to its exact self-peer media route, without authorizing any setting write. */
export function t8420ClearLiveRoute(route: T8420LiveRoute): boolean {
  return route.enabled === true && route.model === "T8420" && route.deviceType === 3
    && route.stationModel === "T8420" && route.channel === 0 && route.attached === false
    && (route.purpose === undefined || route.purpose === "media")
    && typeof route.accountId === "string" && route.accountId.length > 0 && route.accountId.length <= 128;
}

/**
 * Construct the observed clear 1350/1003 body with this session's public RSA key.
 * Only an explicitly missing key for the freshly observed cipher 65433 may
 * select this body. Callers must preserve that negotiation and route boundary.
 */
export function t8420ClearLiveStart(accountId: string, modulus: string, timestamp: number): string {
  if (!accountId || accountId.length > 128 || !/^[a-f0-9]{256}$/i.test(modulus)
    || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("T8420 live start inputs are unavailable");
  return JSON.stringify({ cmd: 1003, payload: { ClientOS: "IOS", key: modulus, entrytype: 0,
    timestamp, msg_id: 2, streamtype: 2 }, account_id: accountId });
}
