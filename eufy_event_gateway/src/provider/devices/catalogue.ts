/**
 * Records current device compatibility evidence for provider tooling and
 * generated documentation. The provider's executable admission and capability
 * decisions remain in the neighbouring capability-core modules.
 */

import type { DeviceCompatibility, HomeBaseCompatibility } from "./types.js";

const developerRelease = "0.1.70";

/** Current camera, doorbell, lock, and sensor compatibility evidence. */
export const DEVICE_COMPATIBILITY: readonly DeviceCompatibility[] = [
  {
    family: "camera", marketingName: "EufyCam 2C", eufyModel: "T8113-Z", deviceTypes: [8],
    topologies: {
      homebase3: { status: "confirmed", capabilities: { discovery: "confirmed", motionEvents: "confirmed", personEvents: "confirmed", snapshots: "confirmed", liveVideo: "confirmed", sirenControl: "confirmed" } },
    }, evidence: [{ status: "developer-tested", date: "2026-09-21", appVersion: developerRelease, integrationVersion: developerRelease, capabilities: ["discovery", "motionEvents", "personEvents", "snapshots", "liveVideo", "sirenControl"], note: "Five-second trigger and explicit stop heard on a local camera." }],
  },
  {
    family: "camera", marketingName: "eufyCam 2", eufyModel: "T8114", deviceTypes: [9],
    topologies: { homebase3: { status: "implemented", capabilities: { discovery: "implemented", motionEvents: "unverified", snapshots: "unverified", liveVideo: "unverified" }, quirks: ["Admission is implemented from the reported model and numeric device type. Hardware media confirmation is outstanding."] } },
    evidence: [],
  },
  {
    family: "camera", marketingName: "EufyCam 2C Pro", eufyModel: "T8142-Z", deviceTypes: [15],
    topologies: { homebase2: { status: "confirmed", capabilities: { discovery: "confirmed", snapshots: "confirmed", liveVideo: "confirmed" }, quirks: ["Event delivery needs focused confirmation."] } },
    evidence: [{ status: "developer-tested", date: "2026-09-20", appVersion: developerRelease, integrationVersion: developerRelease, capabilities: ["discovery", "snapshots", "liveVideo"] }],
  },
  {
    family: "camera", marketingName: "USB-C-powered camera", eufyModel: "T817L", deviceTypes: [10031],
    topologies: { homebase3: { status: "confirmed", capabilities: { discovery: "confirmed", snapshots: "confirmed", liveVideo: "confirmed", nightVisionControl: "confirmed" }, quirks: ["Battery-shaped fields are suppressed."] } },
    evidence: [{ status: "developer-tested", date: "2026-09-21", appVersion: developerRelease, integrationVersion: developerRelease, capabilities: ["discovery", "snapshots", "liveVideo", "nightVisionControl"], note: "Night vision readback and app labels confirmed for raw 0 PureColor, 1 Infrared, and 2 Spotlight." }],
  },
  {
    family: "camera", marketingName: "eufyCam S330", eufyModel: "T8160", deviceTypes: [19],
    topologies: { homebase3: { status: "confirmed", capabilities: { discovery: "confirmed", snapshots: "confirmed", liveVideo: "confirmed" } } },
    evidence: [{ status: "developer-tested", date: "2026-09-20", appVersion: developerRelease, integrationVersion: developerRelease, capabilities: ["discovery", "snapshots", "liveVideo"] }],
  },
  {
    family: "camera", marketingName: "eufyCam S300 / 3C", eufyModel: "T8161", deviceTypes: [23],
    topologies: {
      homebase3: { status: "confirmed", capabilities: { discovery: "confirmed", personEvents: "confirmed", liveVideo: "confirmed" } },
      homebasePro: { status: "partial", capabilities: { discovery: "confirmed", snapshots: "confirmed", liveVideo: "partial" }, quirks: ["PPCS lookup blocks live video."] },
    }, evidence: [{ status: "developer-tested", date: "2026-09-20", appVersion: developerRelease, integrationVersion: developerRelease, capabilities: ["discovery", "personEvents", "liveVideo"] }],
  },
  {
    family: "camera", marketingName: "eufyCam S3 Pro", eufyModel: "T8162", deviceTypes: [26],
    topologies: { homebasePro: { status: "partial", capabilities: { discovery: "confirmed", personEvents: "confirmed", snapshots: "confirmed", liveVideo: "partial" }, quirks: ["PPCS lookup blocks live video."] } },
    evidence: [],
  },
  {
    family: "camera", marketingName: "SoloCam C20", eufyModel: "T8134", deviceTypes: [63],
    topologies: { homebase3: { status: "confirmed", capabilities: { discovery: "confirmed", motionEvents: "confirmed", personEvents: "confirmed", liveVideo: "confirmed" }, quirks: ["Battery and retained event images need separate confirmation."] } },
    evidence: [],
  },
  {
    family: "camera", marketingName: "SoloCam E30", eufyModel: "T8171", deviceTypes: [88],
    topologies: { homebase3: { status: "implemented", capabilities: { discovery: "implemented", motionEvents: "unverified", snapshots: "unverified", liveVideo: "unverified" }, quirks: ["Requires a ready parent route before media is offered."] } },
    evidence: [],
  },
  {
    family: "camera", marketingName: "SoloCam S230 / S40", eufyModel: "T8124", deviceTypes: [62],
    topologies: { homebase3: { status: "confirmed", capabilities: { discovery: "confirmed", liveVideo: "confirmed", motionEvents: "unverified", snapshots: "unverified" } } },
    evidence: [],
  },
  {
    family: "camera", marketingName: "SoloCam S340", eufyModel: "T8170", deviceTypes: [48],
    topologies: { homebasePro: { status: "partial", capabilities: { discovery: "confirmed", personEvents: "confirmed", snapshots: "confirmed", liveVideo: "partial" }, quirks: ["PPCS lookup blocks live video."] } },
    evidence: [],
  },
  {
    family: "camera", marketingName: "Solar Wall Light Cam S120", eufyModel: "T81A0", deviceTypes: [10005],
    topologies: { direct: { status: "confirmed", capabilities: { discovery: "confirmed", motionEvents: "confirmed", snapshots: "confirmed", liveVideo: "confirmed" }, quirks: ["Fresh capture can time out during peer lookup."] } },
    evidence: [],
  },
  {
    family: "camera", marketingName: "Floodlight Cam E340", eufyModel: "T8425", deviceTypes: [47],
    topologies: { homebasePro: { status: "partial", capabilities: { discovery: "confirmed", personEvents: "confirmed", snapshots: "confirmed", liveVideo: "partial" }, quirks: ["PPCS lookup blocks live video."] } }, evidence: [],
  },
  {
    family: "camera", marketingName: "Floodlight Cam S330 / 2 Pro", eufyModel: "T8423", deviceTypes: [38],
    topologies: { homebase3: { status: "partial", capabilities: { discovery: "confirmed", snapshots: "confirmed", liveVideo: "partial" }, quirks: ["Live sessions still lack a usable H.265 decoder bootstrap."] } }, evidence: [],
  },
  {
    family: "camera", marketingName: "Wired Wall Light Cam S100", eufyModel: "T84A1", deviceTypes: [151],
    topologies: { direct: { status: "partial", capabilities: { discovery: "confirmed", liveVideo: "partial" }, quirks: ["One setup produces H.264 live video, another receives only delta slices."] } }, evidence: [],
  },
  {
    family: "camera", marketingName: "Indoor Cam Pan & Tilt", eufyModel: "T8410", deviceTypes: [31],
    topologies: { homebase3: { status: "confirmed", capabilities: { discovery: "confirmed", snapshots: "confirmed", liveVideo: "confirmed" } } }, evidence: [],
  },
  {
    family: "camera", marketingName: "Indoor Cam Pan & Tilt", eufyModel: "T8410C", deviceTypes: [],
    topologies: { homebase3: { status: "confirmed", capabilities: { discovery: "confirmed", snapshots: "confirmed", liveVideo: "confirmed" }, quirks: ["The current evidence confirms the model but does not retain its numeric inventory type."] } }, evidence: [],
  },
  {
    family: "camera", marketingName: "Indoor Cam S350", eufyModel: "T8416", deviceTypes: [104],
    topologies: { direct: { status: "implemented", capabilities: { discovery: "confirmed", liveVideo: "partial" } }, homebasePro: { status: "partial", capabilities: { discovery: "confirmed", liveVideo: "partial" }, quirks: ["PPCS lookup blocks live video. Privacy mode is not exposed."] } }, evidence: [],
  },
  {
    family: "camera", marketingName: "Indoor Cam E30 4K", eufyModel: "T8417", deviceTypes: [105],
    topologies: { direct: { status: "partial", capabilities: { discovery: "confirmed", liveVideo: "partial" }, quirks: ["Direct media arrives, but codec startup remains unresolved."] } }, evidence: [],
  },
  {
    family: "camera", marketingName: "Indoor Cam 2K", eufyModel: "T8400", deviceTypes: [30],
    topologies: { homebase3: { status: "implemented", capabilities: { discovery: "implemented", snapshots: "unverified", liveVideo: "unverified" } } }, evidence: [],
  },
  {
    family: "camera", marketingName: "Indoor Cam 2K Pan&Tilt", eufyModel: "T8419", deviceTypes: [10009],
    topologies: { homebase3: { status: "implemented", capabilities: { discovery: "implemented", snapshots: "unverified", liveVideo: "unverified" } } }, evidence: [],
  },
  {
    family: "camera", marketingName: "eufyCam C37", eufyModel: "T814X", deviceTypes: [10037],
    topologies: { homebase3: { status: "implemented", capabilities: { discovery: "implemented", snapshots: "unverified", liveVideo: "unverified" } } }, evidence: [],
  },
  {
    family: "camera", marketingName: "eufyCam E40", eufyModel: "T8144", deviceTypes: [49],
    topologies: { homebase2: { status: "implemented", capabilities: { discovery: "implemented", snapshots: "unverified", liveVideo: "unverified" }, quirks: ["Admission is implemented from the reference device identity. Hardware media confirmation is outstanding."] } }, evidence: [],
  },
  {
    family: "doorbell", marketingName: "Video Doorbell C30", eufyModel: "T8224", deviceTypes: [96],
    topologies: { direct: { status: "implemented", capabilities: { discovery: "implemented", doorbellPress: "implemented", liveVideo: "unverified" } } },
    evidence: [{ status: "community-tested", date: "2026-09-20", appVersion: "0.1.59", integrationVersion: "0.1.59", githubUser: "lsnewman", issue: 83, capabilities: ["discovery", "doorbellPress"], note: "Type 96 and event_type=3103 supplied by the reporter. Press handling released in 0.1.63." }],
  },
  {
    family: "doorbell", marketingName: "Video Doorbell", eufyModel: "T8210", deviceTypes: [7],
    topologies: { direct: { status: "confirmed", capabilities: { discovery: "confirmed", snapshots: "confirmed", liveVideo: "confirmed" } }, homebase2: { status: "partial", capabilities: { liveVideo: "partial" }, quirks: ["Blank or frozen playback remains under investigation."] } }, evidence: [],
  },
  {
    family: "doorbell", marketingName: "Video Doorbell", eufyModel: "T8213", deviceTypes: [91],
    topologies: { homebase3: { status: "confirmed", capabilities: { discovery: "confirmed", snapshots: "confirmed", liveVideo: "confirmed" } } }, evidence: [],
  },
  {
    family: "doorbell", marketingName: "Video Doorbell E340", eufyModel: "T8214", deviceTypes: [94],
    topologies: { homebase3: { status: "partial", capabilities: { discovery: "confirmed", liveVideo: "partial" }, quirks: ["T8030 live video can jump back to an earlier frame."] }, homebasePro: { status: "partial", capabilities: { discovery: "confirmed", liveVideo: "partial", doorbellPress: "unverified" }, quirks: ["PPCS lookup blocks live video."] } }, evidence: [],
  },
  {
    family: "doorbell", marketingName: "Video Doorbell", eufyModel: "T8200", deviceTypes: [5],
    topologies: { direct: { status: "partial", capabilities: { discovery: "confirmed", liveVideo: "unverified", doorbellPress: "unverified" } } }, evidence: [],
  },
  {
    family: "doorbell", marketingName: "Familock S3 Max", eufyModel: "T85V0", deviceTypes: [203],
    topologies: { homebase3: { status: "partial", capabilities: { discovery: "confirmed", battery: "confirmed", liveVideo: "unverified", doorbellPress: "unverified", lockControl: "unsupported" }, quirks: ["H.265 media arrives, but visible playback remains unconfirmed."] } }, evidence: [],
  },
];

/** Current HomeBase compatibility evidence. */
export const HOMEBASE_COMPATIBILITY: readonly HomeBaseCompatibility[] = [
  {
    family: "homebase", marketingName: "HomeBase 2", eufyModel: "T8010", deviceTypes: [0],
    capabilities: { discovery: "confirmed", liveVideo: "implemented", enableControl: "unsupported" },
    quirks: ["Read-only station path. T8030 controls are not inherited."], evidence: [{ status: "developer-tested", date: "2026-09-20", appVersion: developerRelease, integrationVersion: developerRelease, capabilities: ["discovery", "liveVideo"] }],
  },
  {
    family: "homebase", marketingName: "HomeBase 3 S380", eufyModel: "T8030", deviceTypes: [18],
    capabilities: { discovery: "confirmed", liveVideo: "confirmed", enableControl: "partial" },
    quirks: ["Siren, storage diagnostics, volume ranges, and stop codes still need focused hardware confirmation."], evidence: [{ status: "developer-tested", date: "2026-09-20", appVersion: developerRelease, integrationVersion: developerRelease, capabilities: ["discovery", "liveVideo"] }],
  },
  {
    family: "homebase", marketingName: "HomeBase Professional S1", eufyModel: "T9000", deviceTypes: [27],
    capabilities: { discovery: "confirmed", liveVideo: "partial", enableControl: "unsupported" },
    quirks: ["Inventory parent is recognised, but PPCS lookup remains unresolved for affected camera families."], evidence: [],
  },
];
