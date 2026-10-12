/**
 * Defines the offline S100 primary siren contract. Callers own returned clear
 * bytes. A future authenticated transport must negotiate encryption, own and
 * terminate its session, correlate wire-channel results, and verify audible
 * start and explicit stop. This module sends nothing and owns no state.
 */

import { types } from "node:util";

/** Inventory routing facts required for the exact standalone S100 contract. */
export interface S100SirenRoute {
  readonly model: string;
  readonly deviceType: number | null;
  readonly peerModel: string;
  readonly selfPeer: boolean;
  readonly homeBaseAttached: boolean;
  readonly channel: number | null;
}

/**
 * Caller-owned clear bytes that must never be sent unencrypted. Wire channel 255
 * differs from inventory channel 0 and is the acknowledgement correlation
 * channel. This primary command excludes the secondary stop step.
 */
export interface S100SirenCommand {
  readonly command: 1201;
  readonly wireChannel: 255;
  readonly body: Uint8Array;
}

/**
 * Build sound-only start with a fixed 30-second timeout, or primary timeout-zero
 * stop. Requires exact standalone S100 routing, accepting negative zero as zero.
 * Throws synchronously for malformed or unsupported input without echoing it.
 * Returned bytes require authenticated encryption and wire-channel 255 result
 * correlation. Complete early stop also needs the separate command 1202 step.
 */
export function buildS100SirenCommand(route: S100SirenRoute, enabled: boolean): S100SirenCommand {
  if (!route || typeof route !== "object" || types.isProxy(route)) throw new TypeError("Invalid S100 route");
  const prototype = Object.getPrototypeOf(route);
  const names = ["model", "deviceType", "peerModel", "selfPeer", "homeBaseAttached", "channel"] as const;
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(route).length !== names.length) {
    throw new TypeError("Invalid S100 route shape");
  }
  const fields = names.map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(route, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError("Invalid S100 route field");
    return descriptor.value as unknown;
  });
  const [model, deviceType, peerModel, selfPeer, homeBaseAttached, channel] = fields;
  if (typeof model !== "string" || typeof peerModel !== "string" || typeof deviceType !== "number"
    || typeof selfPeer !== "boolean" || typeof homeBaseAttached !== "boolean" || typeof channel !== "number") {
    throw new TypeError("Invalid S100 route field type");
  }
  if (model !== "T84A1" || deviceType !== 151 || peerModel !== model || !selfPeer || homeBaseAttached || channel !== 0) {
    throw new RangeError("Unsupported S100 route");
  }
  if (typeof enabled !== "boolean") throw new TypeError("Invalid S100 siren state");
  const body = Buffer.alloc(8);
  body.writeUInt32LE(4, 0);
  body.writeUInt32LE(enabled ? 30 : 0, 4);
  return { command: 1201, wireChannel: 255, body };
}
