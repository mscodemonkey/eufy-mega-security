/**
 * Defines the exact, passive E21 baby-monitor notification boundary.
 *
 * Mega inventory owns device identity and the push receiver owns delivery.
 * This sensor adapter opens no media or controls. The provider consumes its normalized
 * sensor state and event predicate, while capability reporting consumes the
 * source-backed matrix rows.
 */

import type { CapabilityMatrixRow, SecuritySensorState } from "../domain/types.js";
import { e21DetectionKinds, e21PushKind, isE21, type E21DetectionKind, type E21Readings } from "./e21-profile.js";

/** Inventory identity required for the reviewed E21 notification adapter. */
export interface CareMonitorIdentity {
  readonly serial: string;
  readonly name: string;
  readonly model: string;
  readonly deviceType: number | null;
  readonly category: string | null;
}

/** Source-backed event capabilities exposed only by the exact E21 adapter. */
export const CARE_MONITOR_CAPABILITY_ROWS: readonly CapabilityMatrixRow[] = e21DetectionKinds.map((kind) => ({
  id: `sensor.${kind}_event`, family: kind, kind: "event", reportedParamIds: [], deviceEvidence: "gateway-baseline",
  gatewaySupport: "implemented", offerable: true, note: "Passive E21 notification. Physical delivery remains unconfirmed.",
}));

/** Return whether inventory exactly matches the reviewed E21 notification profile. */
export function isCareBabyMonitor(
  device: Pick<CareMonitorIdentity, "model" | "deviceType" | "category">,
): boolean {
  return isE21(device);
}

/** Build the passive sensor baseline for one exact E21 device. */
export function careMonitorSensorState(device: CareMonitorIdentity & { readonly reads?: { readonly e21?: E21Readings } }): SecuritySensorState | null {
  if (!isCareBabyMonitor(device)) return null;
  return {
    serial: device.serial,
    name: device.name,
    model: device.model,
    deviceType: 86,
    available: true,
    capabilities: [...e21DetectionKinds, "roomTemperature", "careDiagnostics"],
    ...(device.reads?.e21 ? { careSettings: device.reads.e21.careSettings } : {}),
    batteryLevel: null,
    contactOpen: null,
    lastSeen: null,
    motionDetected: false,
    cryingDetected: false,
    soundDetected: false,
    rssi: null,
  };
}

/** Map an exact E21 notification to its independent transient sensor kind. */
export function careMonitorPushKind(
  device: Pick<CareMonitorIdentity, "model" | "deviceType" | "category">,
  messageType: number | null,
  eventType: number | null,
): E21DetectionKind | null {
  return isCareBabyMonitor(device) ? e21PushKind(messageType, eventType) : null;
}
