/**
 * HomeBase baseline features already normalized by the gateway.
 *
 * Inventory presence and child-camera route readiness apply to discovered
 * HomeBases. A discovered station may attempt the conservative state read,
 * while general commands remain T8030-only. The separately evidenced siren
 * command may be offered to discovered stations.
 */

import type { CoreCapabilityEntry } from "./device-capability-core.js";

/** Locally recognized station endpoints; only type 18/T8030 is managed. */
export const HOMEBASE_DEVICE_TYPES: ReadonlySet<number> = new Set([0, 18, 27]);

/** Existing station state and controls needed for the HA baseline. */
export const HOMEBASE_CAPABILITY_CORE: readonly CoreCapabilityEntry[] = [
  { id: "homebase.available", family: "connection", kind: "read", evidenceParamIds: [], gatewaySupport: "implemented", baselineWithoutParam: true, note: "Inventory availability is separate from PPCS connection." },
  { id: "homebase.camera_route", family: "connection", kind: "read", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true, note: "Readiness covers child-camera PPCS prerequisites, not the station command protocol." },
  { id: "homebase.connected", family: "connection", kind: "read", evidenceParamIds: [], gatewaySupport: "implemented", note: "Disconnected remains an informative state when the PPCS route is unavailable." },
  { id: "homebase.firmware", family: "diagnostic", kind: "read", evidenceParamIds: [], gatewaySupport: "implemented" },
  { id: "homebase.guard_mode", family: "security", kind: "read", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true },
  { id: "homebase.guard_mode_write", family: "security", kind: "action", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true, note: "Gateway waits for command acknowledgement and a fresh readback." },
  { id: "homebase.effective_mode", family: "security", kind: "read", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true },
  { id: "homebase.alarm_active", family: "security", kind: "read", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true },
  { id: "homebase.alarm_volume", family: "audio", kind: "read", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true },
  { id: "homebase.alarm_volume_write", family: "audio", kind: "action", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true },
  { id: "homebase.prompt_volume", family: "audio", kind: "read", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true },
  { id: "homebase.prompt_volume_write", family: "audio", kind: "action", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true },
  { id: "homebase.alarm_tone", family: "audio", kind: "read", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true },
  { id: "homebase.alarm_tone_write", family: "audio", kind: "action", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true },
  { id: "homebase.emmc_storage", family: "storage", kind: "read", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true, note: "Status and capacity appear only after a successful station read." },
  { id: "homebase.hdd_storage", family: "storage", kind: "read", evidenceParamIds: [], gatewaySupport: "implemented", requiresRoute: true, note: "A missing HDD is not a failed read." },
] as const;
