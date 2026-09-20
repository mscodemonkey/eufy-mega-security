/**
 * Public provider-device catalogue entry point. Tooling and future generated
 * documentation import this boundary instead of reaching into individual data
 * files or runtime capability evaluators.
 */

export { DEVICE_COMPATIBILITY, HOMEBASE_COMPATIBILITY } from "./catalogue.js";
export type {
  CompatibilityEvidence,
  CompatibilityStatus,
  DeviceCapability,
  DeviceCompatibility,
  DeviceTopology,
  HomeBaseCompatibility,
  TopologyCompatibility,
} from "./types.js";
