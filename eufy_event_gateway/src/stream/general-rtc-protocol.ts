/**
 * Defines the general RTC experiment's closed errors and checked HTTP inputs.
 * The provider owns leases and private account state. This boundary performs
 * pure validation and exposes no account data in failures or diagnostic logs.
 */
import { TextDecoder } from "node:util";

/** Fixed failure stages shared by the lease, manual route and diagnostic UI. */
export type GeneralRtcStage = "admission" | "reconnect_required" | "busy" | "cooldown" | "locked"
  | "preflight_required" | "preflight" | "inventory" | "binding" | "pin" | "sign" | "budget"
  | "join" | "call" | "turn" | "offer" | "peer" | "video" | "cancelled" | "deadline" | "shutdown";

/** Content-free reasons usable only in the private support log. */
export type GeneralRtcReason = "unspecified" | "shape" | "transport" | "response" | "identity" | "ownership"
  | "topology" | "rtc_flag" | "timeout" | "socket" | "frame" | "code" | "binding" | "call_limit"
  | "heartbeat" | "turn_address" | "turn_change" | "offer_shape" | "candidate" | "media"
  | "native_identity_missing" | "native_identity_rejected";

/** Carries only fixed codes across asynchronous cleanup and HTTP responses. */
export class GeneralRtcError extends Error {
  constructor(readonly stage: GeneralRtcStage, readonly reason: GeneralRtcReason = "unspecified") {
    super(`General video trial failed at ${stage}`);
  }
}

/** Explicit per-request consent. The route owns and discards the PIN after submission. */
export interface GeneralRtcSubmission {
  readonly consent: true;
  readonly pin: string;
}

/** Parse exactly two scalar JSON keys, rejecting duplicate and escaped duplicate names. */
export function generalRtcSubmission(bytes: Buffer): GeneralRtcSubmission {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new SyntaxError("Invalid trial input"); }
  let offset = 0;
  const whitespace = (): void => { while (/[\x20\x09\x0a\x0d]/.test(text[offset] ?? "x")) offset++; };
  const string = (): string => {
    const start = offset;
    if (text[offset++] !== '"') throw new SyntaxError("Invalid trial input");
    while (offset < text.length) {
      const c = text[offset++]!;
      if (c === '"') {
        try { return JSON.parse(text.slice(start, offset)) as string; }
        catch { throw new SyntaxError("Invalid trial input"); }
      }
      if (c === "\\") offset++;
      else if (c.charCodeAt(0) < 32) throw new SyntaxError("Invalid trial input");
    }
    throw new SyntaxError("Invalid trial input");
  };
  whitespace();
  if (text[offset++] !== "{") throw new SyntaxError("Invalid trial input");
  const seen = new Set<string>();
  let pin: string | undefined, consent = false;
  for (;;) {
    whitespace();
    const key = string();
    if (seen.has(key) || key !== "pin" && key !== "consent") throw new SyntaxError("Invalid trial input");
    seen.add(key);
    whitespace();
    if (text[offset++] !== ":") throw new SyntaxError("Invalid trial input");
    whitespace();
    if (key === "pin") pin = string();
    else {
      if (text.slice(offset, offset + 4) !== "true") throw new SyntaxError("Invalid trial input");
      offset += 4; consent = true;
    }
    whitespace();
    const delimiter = text[offset++];
    if (delimiter === "}") break;
    if (delimiter !== ",") throw new SyntaxError("Invalid trial input");
  }
  whitespace();
  if (offset !== text.length || !consent || typeof pin !== "string" || !/^[\x20-\x7e]{1,32}$/.test(pin)) throw new SyntaxError("Invalid trial input");
  return { consent: true, pin };
}

/** Choose only the documented smart-service region, without using the NVR region override. */
export function generalRtcSmartHost(securityHost: string): string | null {
  const hosts: Readonly<Record<string, string>> = {
    "security-app-eu.eufylife.com": "security-smart-eu.eufylife.com",
    "security-app-ie.eufylife.com": "security-smart-ie.eufylife.com",
    "security-app.eufylife.com": "security-smart.eufylife.com",
  };
  return Object.hasOwn(hosts, securityHost) ? hosts[securityHost]! : null;
}

/** Bound an already signal-aware operation even while it waits in another owner's queue. */
export function generalRtcAwait<T>(operation: Promise<T>, signal: AbortSignal, stage: GeneralRtcStage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener("abort", abort); reject(new GeneralRtcError(stage, "timeout")); };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => {
      signal.removeEventListener("abort", abort); reject(error);
    });
    if (signal.aborted) abort();
  });
}
