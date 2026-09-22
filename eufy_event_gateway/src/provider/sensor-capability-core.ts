/**
 * Standalone sensor capabilities kept separate from camera admission.
 *
 * Mega inventory supplies settled reads while normalized push events update
 * contact and PIR state. The Home Assistant adapter consumes only rows whose
 * device evidence matches one of these implemented paths.
 */

import type { CoreCapabilityEntry } from "./device-capability-core.js";
import { GENERATED_SENSOR_DEVICE_TYPES } from "./devices/generated-catalogue.js";

/** Inventory types treated as sensor-family rows, not camera candidates. */
export const SENSOR_DEVICE_TYPES: ReadonlySet<number> = GENERATED_SENSOR_DEVICE_TYPES;

/** Reads and events implemented by the standalone-sensor adapter. */
export const SENSOR_CAPABILITY_CORE: readonly CoreCapabilityEntry[] = [
  { id: "sensor.contact_open", family: "contact", kind: "read", evidenceParamIds: [1550], gatewaySupport: "implemented", note: "Refreshed from inventory and updated by contact pushes." },
  { id: "sensor.contact_event", family: "contact", kind: "event", evidenceParamIds: [1550], gatewaySupport: "implemented", note: "Push code 3 carries the settled open or closed state." },
  { id: "sensor.motion_event", family: "motion", kind: "event", evidenceParamIds: [1605], gatewaySupport: "implemented", baselineWithoutParam: true, note: "Push code 14 is realtime. A later cloud timestamp provides a delayed fallback without enabling test mode." },
  { id: "sensor.battery_level", family: "battery", kind: "read", evidenceParamIds: [1101], gatewaySupport: "implemented", note: "Refreshed from validated Mega inventory values." },
  { id: "sensor.last_seen", family: "diagnostic", kind: "read", evidenceParamIds: [1551, 1605], gatewaySupport: "implemented", note: "Normalized from the family-specific cloud event timestamp." },
] as const;
