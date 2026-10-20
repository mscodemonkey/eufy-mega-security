/**
 * Defines the exact, passive E21 baby-monitor notification boundary.
 *
 * Mega inventory owns device identity and the push receiver owns delivery.
 * This module admits no media or controls. The provider consumes its normalized
 * sensor state and event predicate, while capability reporting consumes the
 * source-backed matrix rows.
 */

import type { CapabilityMatrixRow, SecuritySensorState } from "../domain/types.js";

/** Inventory identity required for the reviewed E21 notification adapter. */
export interface CareMonitorIdentity {
  readonly serial: string;
  readonly name: string;
  readonly model: string;
  readonly deviceType: number | null;
  readonly category: string | null;
}

/** Source-backed event capabilities exposed only by the exact E21 adapter. */
export const CARE_MONITOR_CAPABILITY_ROWS: readonly CapabilityMatrixRow[] = [
  {
    id: "sensor.crying_event", family: "crying", kind: "event",
    reportedParamIds: [], deviceEvidence: "gateway-baseline",
    gatewaySupport: "implemented", offerable: true,
    note: "Passive message-type 18 push event 3104. Hardware delivery remains unconfirmed.",
  },
  {
    id: "sensor.sound_event", family: "sound", kind: "event",
    reportedParamIds: [], deviceEvidence: "gateway-baseline",
    gatewaySupport: "implemented", offerable: true,
    note: "Passive message-type 18 push event 3105. Hardware delivery remains unconfirmed.",
  },
] as const;

/** Return whether inventory exactly matches the reviewed sensor-only E21 profile. */
export function isCareBabyMonitor(
  device: Pick<CareMonitorIdentity, "model" | "deviceType" | "category">,
): boolean {
  return device.model === "T8354"
    && device.deviceType === 86
    && device.category === "eufy_care";
}

/** Build the notification-only sensor baseline for one exact E21 device. */
export function careMonitorSensorState(device: CareMonitorIdentity): SecuritySensorState | null {
  if (!isCareBabyMonitor(device)) return null;
  return {
    serial: device.serial,
    name: device.name,
    model: device.model,
    deviceType: 86,
    available: true,
    capabilities: ["crying", "sound"],
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
): "crying" | "sound" | null {
  if (!isCareBabyMonitor(device) || messageType !== 18) return null;
  if (eventType === 3104) return "crying";
  if (eventType === 3105) return "sound";
  return null;
}
