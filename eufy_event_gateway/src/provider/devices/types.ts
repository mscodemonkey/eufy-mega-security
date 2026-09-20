/**
 * Defines the typed compatibility evidence consumed by provider tooling and
 * documentation generation. Runtime admission remains owned by the existing
 * capability-core modules, so this catalogue cannot silently enable a device.
 */

/** A capability result for one physical device topology. */
export type CompatibilityStatus =
  | "confirmed"
  | "implemented"
  | "partial"
  | "unverified"
  | "unsupported";

/** A supported or investigated connection topology. */
export type DeviceTopology = "homebase2" | "homebase3" | "homebasePro" | "direct";

/** Capability names tracked by the compatibility catalogue. */
export type DeviceCapability =
  | "discovery"
  | "motionEvents"
  | "personEvents"
  | "snapshots"
  | "liveVideo"
  | "doorbellPress"
  | "battery"
  | "enableControl"
  | "motionDetectionControl"
  | "privacyMode"
  | "lockControl";

/** Version and provenance details for one developer or community result. */
export interface CompatibilityEvidence {
  readonly status: "developer-tested" | "community-tested";
  readonly date: string;
  readonly appVersion?: string;
  readonly integrationVersion?: string;
  readonly homeAssistantVersion?: string;
  readonly githubUser?: string;
  readonly issue?: number;
  readonly capabilities: readonly DeviceCapability[];
  readonly note?: string;
}

/** Capability outcomes for one device under one HomeBase or direct topology. */
export interface TopologyCompatibility {
  readonly status: CompatibilityStatus;
  readonly capabilities: Readonly<Partial<Record<DeviceCapability, CompatibilityStatus>>>;
  readonly quirks?: readonly string[];
}

/** Compatibility record for one camera, doorbell, lock, or sensor model. */
export interface DeviceCompatibility {
  readonly family: "camera" | "doorbell" | "lock" | "sensor";
  readonly marketingName: string;
  readonly eufyModel: string;
  readonly deviceTypes: readonly number[];
  readonly topologies: Readonly<Partial<Record<DeviceTopology, TopologyCompatibility>>>;
  readonly evidence: readonly CompatibilityEvidence[];
}

/** Compatibility record for one HomeBase model. */
export interface HomeBaseCompatibility {
  readonly family: "homebase";
  readonly marketingName: string;
  readonly eufyModel: string;
  readonly deviceTypes: readonly number[];
  readonly capabilities: Readonly<Partial<Record<DeviceCapability, CompatibilityStatus>>>;
  readonly quirks: readonly string[];
  readonly evidence: readonly CompatibilityEvidence[];
}
