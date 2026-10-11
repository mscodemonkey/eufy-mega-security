/**
 * Defines exact-model experimental control contracts recovered from official
 * Android handlers. The provider owns routes and sessions, while HTTP and PPCS
 * consume these strict requests. Profiles establish a command contract, not
 * physical success on a reporter's hardware.
 */

import { setTimeout as delay } from "node:timers/promises";

/** Only these operations may cross the experimental control boundary. */
export type ModelControlTrial =
  | { readonly action: "motion"; readonly enabled: boolean }
  | { readonly action: "spotlight"; readonly enabled: boolean }
  | { readonly action: "ptz"; readonly direction: "left" | "right" | "up" | "down" };

/** Report acknowledgement separately from fresh reported state and physical movement. */
export interface ModelControlTrialResult {
  readonly outcome: "confirmed" | "acknowledged" | "unchanged";
  readonly physicalConfirmationRequired: boolean;

  /** Present for changed settings, separating readback proof from a lost result frame. */
  readonly acknowledgementReceived?: boolean;
}

/** Exact routing facts required by official handler selection. */
export interface ModelControlRoute {
  readonly model: string;
  readonly deviceType: number | null;
  readonly channel: number | null;
  readonly homeBaseAttached: boolean;
  readonly peerModel: string;
  readonly selfPeer: boolean;
}

/** Parse a closed request shape, rejecting raw commands and implicit conversions. */
export function parseModelControlTrial(value: unknown): ModelControlTrial {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("Invalid model control trial");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2) throw new SyntaxError("Model control trial requires exactly two fields");
  if ((row.action === "motion" || row.action === "spotlight") && typeof row.enabled === "boolean") {
    return { action: row.action, enabled: row.enabled };
  }
  if (row.action === "ptz" && ["left", "right", "up", "down"].includes(String(row.direction))) {
    if (typeof row.direction !== "string") throw new SyntaxError("Invalid PTZ direction");
    return { action: "ptz", direction: row.direction as "left" | "right" | "up" | "down" };
  }
  throw new SyntaxError("Unsupported model control trial");
}

/** Admit exact model/type/topology combinations without changing verified capabilities. */
export function modelControlTrialActions(route: ModelControlRoute): readonly ModelControlTrial["action"][] {
  if (route.homeBaseAttached) {
    return route.model === "T8410" && route.deviceType === 31 && route.peerModel === "T8030"
      && !route.selfPeer && route.channel !== null && Number.isInteger(route.channel)
      && route.channel >= 0 && route.channel <= 255 ? ["ptz"] : [];
  }
  if (!route.selfPeer || route.channel !== 0) return [];
  if (route.model === "T8423" && route.deviceType === 38) return ["motion", "spotlight", "ptz"];
  if ((route.model === "T84A1" && route.deviceType === 151)
    || (route.model === "T8417" && route.deviceType === 105)) return ["motion"];
  return [];
}

/** Build semantic JSON before transport encryption; master spotlight uses a binary body instead. */
export function modelControlTrialCommand(
  request: ModelControlTrial, route: ModelControlRoute, accountId: string, transaction: number,
): { readonly command: number; readonly value: string | boolean } {
  if (!accountId || !modelControlTrialActions(route).includes(request.action)) throw new Error("Model control trial route unavailable");
  if (!Number.isSafeInteger(transaction) || transaction < 1_000_000_000_000) throw new Error("Invalid control transaction");
  if (request.action === "spotlight") return { command: 1403, value: request.enabled };
  const data = request.action === "motion" ? { status: request.enabled ? 1 : 0, transaction: `${transaction}` }
    : { cmd_type: 1, rotate_type: { left: 1, right: 2, up: 3, down: 4 }[request.direction],
      ...(route.model === "T8423" ? { zoom: 1, ivalue: -1 } : {}), transaction: `${transaction}` };
  const command = request.action === "motion" ? 6040 : 6030;
  if (request.action === "ptz" && route.model === "T8423") {
    return { command: 1350, value: JSON.stringify({ account_id: accountId, cmd: command,
      mChannel: route.channel, mValue3: command, payload: data }) };
  }
  return { command: 1700, value: JSON.stringify({ commandType: command, data }) };
}

/** Minimal owned session used by the trial runner and synthetic failure tests. */
export interface ModelControlTrialSession {
  read(): Promise<{ readonly motionDetectionEnabled?: boolean; readonly spotlightEnabled?: boolean }>;
  write(request: ModelControlTrial): Promise<void>;
}

/** Submit once and require fresh native readback for absolute settings, never cached state. */
export async function runModelControlTrial(
  session: ModelControlTrialSession, request: ModelControlTrial, checkOwnership: () => void,
  isAcknowledgementTimeout: (error: unknown) => boolean = () => false,
): Promise<ModelControlTrialResult> {
  checkOwnership();
  if (request.action === "ptz") {
    await session.write(request);
    checkOwnership();
    return { outcome: "acknowledged", physicalConfirmationRequired: true };
  }
  const field = request.action === "motion" ? "motionDetectionEnabled" : "spotlightEnabled";
  const original = (await session.read())[field];
  checkOwnership();
  if (original === undefined) throw new Error("Trial requires a fresh reported original setting");
  if (original === request.enabled) return { outcome: "unchanged", physicalConfirmationRequired: true };
  let acknowledgementReceived = true;
  try { await session.write(request); }
  catch (error) {
    if (!isAcknowledgementTimeout(error)) throw error;
    acknowledgementReceived = false;
  }
  checkOwnership();
  for (let attempt = 0; attempt < 3; attempt++) {
    await delay(500);
    checkOwnership();
    const fresh = await session.read();
    checkOwnership();
    if (fresh[field] === request.enabled) return { outcome: "confirmed", physicalConfirmationRequired: true, acknowledgementReceived };
  }
  throw new Error("Model control trial was not confirmed by fresh readback. Check the setting in the Eufy app before retrying");
}
