/**
 * Normalizes Mega inventory and reconciles successive observations.
 *
 * This module holds no inventory, sessions or timers. The provider owns refresh,
 * publication and cleanup. Timestamp validation still uses the current clock.
 */

import { androidModelReference, predictLiveRequest } from "../diagnostics/model-reference.js";
import { sensorInventory, type SensorInventory } from "./sensor-inventory.js";
import { guardModeCustomNames, guardModeMetadataShape, guardModeMetadataStructure } from "../mega/guard-mode-metadata.js";
import { readCameraSetting } from "./camera-settings.js";
import { e21Readings, type E21Readings } from "./e21-profile.js";
import { entrySensorHealth } from "./entry-sensor-health.js";
import { homeBaseInventoryAlarmVolume } from "./homebase-inventory-volume.js";
import { readS340LiveModeEvidence, readS340LiveQuality, readS340LiveViewMode, type S340LiveModeEvidence } from "./s340-live-quality.js";

/** Normalized Mega inventory row used to decide camera support and routing. */
export interface MegaInventoryDevice {
  readonly serial: string;
  readonly name: string;
  readonly model: string;
  readonly parentSerial: string;
  readonly deviceType: number | null;
  readonly category: string | null;
  readonly channel: number | null;
  readonly p2pDid: string | null;
  readonly p2pConnection: string | null;
  readonly localAddress: string | null;
  readonly cipherId: number | null;
  readonly adminUserId: string | null;

  /** Current inventory member identity, kept internal for exact live-control admission. */
  readonly memberUserId?: string | null;

  /** Strict vendor membership code, never inferred from the administrator identity. */
  readonly memberType?: number | null;
  readonly userName: string | null;
  readonly firmware: string | null;

  /** Camera-reported hardware revision, absent in older inventory responses. */
  readonly hardwareVersion?: string | null;

  /** Secondary firmware reported by this device, never inherited from its station. */
  readonly firmwareSubVersion?: string | null;

  /** Explicit cloud update flag. Absent or malformed flags remain unknown. */
  readonly firmwareUpdateAvailable?: boolean | null;

  /** Privacy-safe shape of custom-mode metadata, never the account labels. */
  readonly guardModeMetadataShape?: string;

  /** Document-local aliases preserve nesting without retaining private labels or keys. */
  readonly guardModeMetadataStructure?: string;

  /** Private custom-mode labels retained only for the owner's local Home Assistant UI. */
  readonly guardModeNames?: Readonly<Record<number, string>>;
  readonly paramTypes: readonly number[];
  readonly reads: MegaInventoryReads;

  /** Latest bounded sensor-list projection for optional device diagnostics. */
  readonly sensorInventory?: SensorInventory;

  /** Android live-start prediction derived before the private parent identity is discarded. */
  readonly referenceStartRequest?: string;

  /** Content-free reason for withholding the mode, separate from reported device state. */
  readonly s340LiveModeEvidence?: S340LiveModeEvidence;
}

/** Allowlisted, validated current values retained from one Mega inventory row. */
export interface MegaInventoryReads {

  /** Explicit T8900 connection and low-power observations, never synthesized defaults. */
  readonly entrySensorConnected?: boolean;
  readonly entrySensorBatteryLow?: boolean;

  /** Exact standalone T8426 manual override, without inferring physical illumination. */
  readonly manualFloodlightEnabled?: boolean;

  /** Strict care-profile values, never merged with generic camera parameter interpretations. */
  readonly e21?: E21Readings;
  readonly ringtoneVolume?: number;
  readonly soundDetectionSensitivity?: number;
  readonly soundDetectionType?: number;

  /** Exact standalone C31 preferences, independent of detection or low-light results. */
  readonly soundRoundLookEnabled?: boolean;
  readonly enhanceLightingEnabled?: boolean;

  /** Exact C31 light setting and notification spacing, unrelated to recording intervals. */
  readonly lightBrightness?: number;
  readonly notificationIntervalMinutes?: number;

  /** Exact C31 publication and continuous recording switches, independent of active consumers. */
  readonly rtspPublicationEnabled?: boolean;
  readonly continuousRecordingEnabled?: boolean;
  readonly streamingQualityTier?: number;

  /** View mode reported by the S340 independently of its quality preference. */
  readonly s340LiveViewMode?: 0 | 12;

  readonly recordingQualityTier?: number;
  readonly solarIntensity?: number;
  readonly solarConnected24h?: boolean;
  readonly notificationStyle?: number;
  readonly watermarkMode?: number;
  readonly antiTheftDetectionEnabled?: boolean;
  readonly spotlightEnabled?: boolean;
  readonly motionSensitivityRaw?: number;
  readonly motionSensitivityStep?: number;
  readonly workingMode?: string;
  readonly recordingDurationSeconds?: number;
  readonly recordingIntervalSeconds?: number;
  readonly recordingAutoStop?: boolean;
  readonly homebaseChimeEnabled?: boolean;
  readonly mechanicalChimeEnabled?: boolean;
  readonly wideDynamicRangeEnabled?: boolean;
  readonly chimeVolume?: number;
  readonly doorbellVideoQuality?: number;
  readonly highCompressionEncoding?: boolean;

  /** Native standalone C31 pre-recording preference, independent of clip contents. */
  readonly preRecordingEnabled?: boolean;

  readonly imageFlipped?: boolean;
  readonly statusLedEnabled?: boolean;
  readonly soundDetectionEnabled?: boolean;
  readonly microphoneEnabled?: boolean;
  readonly speakerEnabled?: boolean;
  readonly audioRecordingEnabled?: boolean;
  readonly speakerVolume?: number;
  readonly enabled?: boolean;

  /** Privacy-safe shape of parameter 1035 for support diagnostics. */
  readonly cameraSwitch1035?: "zero" | "one" | "other_number" | "boolean" | "text" | "structured" | "other";
  readonly motionDetectionEnabled?: boolean;

  /** Exact T8171 routing override. Missing native parameter means the HomeBase branch. */
  readonly t8171OutdoorMode?: boolean;

  /** Exact SoloCam tracking enable bit, independent of app-side cloud bookkeeping. */
  readonly aiTrackingEnabled?: boolean;
  readonly guardMode?: number;

  /** Cached T8030 station volume, never accepted as local command readback. */
  readonly alarmVolume?: number;
  readonly autoNightVisionEnabled?: boolean;
  readonly nightVisionMode?: number;

  /** Raw parameter 6250 value, retained without assigning privacy-mode polarity. */
  readonly privacy6250Value?: 0 | 1;
  readonly batteryLevel?: number;
  readonly backupBatteryLevel?: number;
  readonly batteryCharging?: boolean;
  readonly batteryHealth?: number;
  readonly batteryTemperature?: number;
  readonly lastChargingDays?: number;
  readonly contactOpen?: boolean;
  readonly lastSeen?: string;
  readonly rssi?: number;

  /** Latest standalone PIR event time in Unix seconds, retained for delayed cloud fallback. */
  readonly motionEventSeconds?: number;
}

/**
 * Parse the untrusted device list without sharing connection fields across rows.
 * Prefer the bounded app connection value, retaining the legacy peer list when
 * that field is missing, blank, oversized or of the wrong type.
 */
export function parseMegaInventory(response: unknown): MegaInventoryDevice[] {
  if (!isRecord(response) || !Array.isArray(response.devices)) return [];
  const devices: MegaInventoryDevice[] = [];
  const seen = new Set<string>();
  for (const value of response.devices) {
    if (!isRecord(value)) continue;
    const serial = safeValue(value.device_sn, 128);
    if (!serial || seen.has(serial)) continue;
    if (value.device_model === "T8354" && response.devices.filter((row: unknown) => isRecord(row) && row.device_sn === serial).length !== 1) continue;
    seen.add(serial);
    const model = safeValue(value.device_model, 100) ?? "Unknown Eufy device";
    const deviceType = integer(value.device_type);
    const parentSerial = safeValue(value.parent_sn, 128) ?? safeValue(value.station_sn, 128) ?? "";
    const channel = integer(value.device_channel) ?? integer(value.channel);
    const reads = safeInventoryReads(value.params, deviceType, model, (!parentSerial || parentSerial === serial) && channel === 0);
    const s340ModeEvidence = model === "T8170" && deviceType === 48 && parentSerial && parentSerial !== serial
      ? readS340LiveModeEvidence(Array.isArray(value.params) ? value.params.flatMap(row => (
        isRecord(row) && integer(row.param_type) === 6243 ? [{ param_type: 6243, param_value: row.param_value }] : []
      )) : []) : undefined;
    const sensors = sensorInventory(value.params);
    const referenceStartRequest = referenceStart(model, serial, value.parent_sn, value.params);
    const lastChargingDays = safeLastChargingDays(value.charging_days);
    devices.push({
      serial,
      name: safeValue(value.device_name, 100) ?? model,
      model,
      parentSerial,
      deviceType,
      category: safeValue(value.category, 100),
      channel,
      p2pDid: safeValue(value.p2p_did, 128),
      p2pConnection: safeValue(value.app_conn, 512) ?? safeValue(value.p2p_conn, 512),
      localAddress: freshestLanAddress(value),
      cipherId: integer(value.cipher_id),
      adminUserId: isRecord(value.member) ? safeValue(value.member.admin_user_id, 128) : null,
      ...(isRecord(value.member) && safeValue(value.member.member_user_id, 128)
        ? { memberUserId: safeValue(value.member.member_user_id, 128) } : {}),
      ...(isRecord(value.member) && typeof value.member.member_type === "number" && Number.isInteger(value.member.member_type)
        ? { memberType: value.member.member_type } : {}),
      userName: isRecord(value.member) ? safeValue(value.member.nick_name, 128) : null,
      firmware: safeValue(value.main_sw_version, 100),
      hardwareVersion: safeValue(value.main_hw_version, 100),
      firmwareSubVersion: safeValue(value.sec_sw_version, 100),
      firmwareUpdateAvailable: value.needUpdate === true || value.needUpdate === 1 || value.needUpdate === "1"
        ? true : value.needUpdate === false || value.needUpdate === 0 || value.needUpdate === "0" ? false : null,
      ...(safeParamTypes(value.params).includes(1256) ? (() => {
        const metadata = Array.isArray(value.params)
          ? value.params.find((row: unknown) => isRecord(row) && integer(row.param_type) === 1256)?.param_value
          : undefined;
        const guardModeNames = guardModeCustomNames(metadata);
        return {
          guardModeMetadataShape: guardModeMetadataShape(metadata),
          guardModeMetadataStructure: guardModeMetadataStructure(metadata),
          ...(guardModeNames === undefined ? {} : { guardModeNames }),
        };
      })() : {}),
      paramTypes: safeParamTypes(value.params),
      reads: lastChargingDays === undefined ? reads : { ...reads, lastChargingDays },
      ...(sensors.status !== "missing" ? { sensorInventory: sensors } : {}),
      ...(referenceStartRequest ? { referenceStartRequest } : {}),
      ...(s340ModeEvidence ? { s340LiveModeEvidence: s340ModeEvidence } : {}),
    });
  }
  const adminUserIds = new Map(
    devices.filter((device) => device.adminUserId).map((device) => [device.serial, device.adminUserId!]),
  );
  return devices.map((device) => device.adminUserId || !device.parentSerial
    ? device
    : { ...device, adminUserId: adminUserIds.get(device.parentSerial) ?? null });
}

/**
 * Refresh complete cloud device rows, including renamed cameras and new station bindings.
 * Clearly partial metadata rows retain their prior routing identity. The provider
 * retires sessions and route-local overlays before publishing a changed binding.
 * A primary-only confirmation may retain an existing charging-days value for
 * the same binding because that optional metadata was deliberately not queried.
 */
export function mergeInventoryMetadata(existing: MegaInventoryDevice, fresh: MegaInventoryDevice, preserveChargingDays = false): MegaInventoryDevice {
  if (existing.serial !== fresh.serial) throw new Error("Inventory metadata ownership changed");
  const complete = fresh.model !== "Unknown Eufy device" && fresh.deviceType !== null && fresh.category !== null;
  const merged = {
    ...(complete ? fresh : existing),
    firmware: fresh.firmware,
    hardwareVersion: fresh.hardwareVersion ?? null,
    firmwareSubVersion: fresh.firmwareSubVersion ?? null,
    firmwareUpdateAvailable: fresh.firmwareUpdateAvailable ?? null,
  };
  return preserveChargingDays && !inventoryBindingChanged(existing, merged) && existing.reads.lastChargingDays !== undefined
    ? { ...merged, reads: { ...merged.reads, lastChargingDays: existing.reads.lastChargingDays } } : merged;
}

/** Identify changes that invalidate an already owned camera session or local parameter overlay. */
export function inventoryBindingChanged(existing: MegaInventoryDevice, fresh: MegaInventoryDevice): boolean {
  return existing.parentSerial !== fresh.parentSerial || existing.channel !== fresh.channel
    || existing.model !== fresh.model || existing.deviceType !== fresh.deviceType
    || existing.category !== fresh.category || existing.adminUserId !== fresh.adminUserId;
}

/** Evaluate only known parent and outdoor inputs before dropping the raw device response. */
function referenceStart(model: string, serial: string, parent: unknown, params: unknown): string | undefined {
  if (typeof parent !== "string") return undefined;
  const rows = Array.isArray(params) ? params.filter(p => p?.param_type === 6271) : undefined;
  const outdoor = rows && rows.length <= 1
    ? [true, 1, "1", "true"].some(on => on === rows[0]?.param_value) : undefined;
  if (model === "T8170" && parent.startsWith("T8030") && parent[7] === "1" && outdoor === false) {
    return "recorder-style start request";
  }
  return predictLiveRequest(androidModelReference(model)?.liveHandler ?? undefined, parent, serial, outdoor);
}

function safeLastChargingDays(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= 0 && parsed <= 36_500
    ? parsed
    : undefined;
}

function freshestLanAddress(value: Record<string, unknown>): string | null {
  let freshest: { readonly address: string; readonly updatedAt: number } | null = null;
  if (Array.isArray(value.params)) {
    for (const raw of value.params) {
      if (!isRecord(raw)) continue;
      const address = safeValue(raw.param_value, 45);
      if (!address || !isPrivateIpv4(address)) continue;
      const updatedAt = finiteNumber(raw.update_time) ?? 0;
      if (!freshest || updatedAt > freshest.updatedAt) freshest = { address, updatedAt };
    }
  }
  if (freshest) return freshest.address;
  for (const raw of [value.local_ip, value.ip_addr]) {
    const address = safeValue(raw, 45);
    if (address && isPrivateIpv4(address)) return address;
  }
  return null;
}

function isPrivateIpv4(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

/**
 * Decode only capability-backed inventory reads; arbitrary values are discarded.
 *
 * The caller explicitly identifies standalone channel-zero inventory before
 * model-specific fields can override legacy HomeBase meanings. Reported state
 * does not authorize a write or establish the physical effect of a control.
 */
export function safeInventoryReads(value: unknown, deviceType: number | null = null, model?: string, standaloneChannelZero = false): MegaInventoryReads {
  if (deviceType === 86 && model === "T8354") return { e21: e21Readings(value) };
  if (!Array.isArray(value)) return {};
  const alarmVolume = homeBaseInventoryAlarmVolume(value, model, deviceType);
  const sensorHealth = entrySensorHealth(value, model, deviceType);
  const params = new Map<number, unknown>();
  for (const row of value) {
    if (!isRecord(row)) continue;
    const type = integer(row.param_type);
    if (type !== null) params.set(type, row.param_value);
  }
  const settingRows = value.flatMap(row => {
    if (!isRecord(row)) return [];
    const type = integer(row.param_type);
    return type === null ? [] : [{ param_type: type, param_value: row.param_value }];
  });
  const motionStep = readCameraSetting(settingRows, model ?? "", deviceType, standaloneChannelZero, "motionSensitivity");
  const manualFloodlight = readCameraSetting(settingRows, model ?? "", deviceType, standaloneChannelZero, "manualFloodlight");
  const reviewedChime = readCameraSetting(settingRows, model ?? "", deviceType, standaloneChannelZero, "homebaseChime");
  const percentage = (type: number): number | undefined => {
    const parsed = finiteNumber(params.get(type));
    return parsed !== null && parsed >= 0 && parsed <= 100 ? parsed : undefined;
  };
  const temperature = finiteNumber(params.get(1138));
  const batteryStatus = finiteNumber(params.get(2111));
  const contact = finiteNumber(params.get(1550));
  const rssi = finiteNumber(params.get(1141));
  const contactLastSeen = validUnixSeconds(params.get(1551));
  const motionValue = params.get(1605);
  const milliseconds = deviceType === 10 && model === "T8910"
    && (typeof motionValue === "number" || typeof motionValue === "string" && /^\d+$/.test(motionValue))
    && Number.isSafeInteger(Number(motionValue)) && Number(motionValue) >= 946_684_800_000
    ? Number(motionValue) / 1_000 : undefined;
  const motionEventSeconds = deviceType === 10 || deviceType === 127
    ? validUnixSeconds(milliseconds ?? motionValue)
    : undefined;
  const lastSeen = contactLastSeen ?? motionEventSeconds;
  const batteryLevel = percentage(1101);
  const backupRows = deviceType === 203 && model === "T85V0"
    ? value.filter(row => isRecord(row) && (row.param_type === 6485 || row.param_type === "6485")) : [];
  const backupValue = backupRows.length === 1 && isRecord(backupRows[0]) ? backupRows[0].param_value : undefined;
  const backupNumber = typeof backupValue === "number" ? backupValue
    : typeof backupValue === "string" && /^(?:[1-9]\d?|100)$/.test(backupValue) ? Number(backupValue) : NaN;
  const backupBatteryLevel = Number.isInteger(backupNumber) && backupNumber >= 1 && backupNumber <= 100
    ? backupNumber : undefined;
  const imageFlipped = finiteNumber(params.get(1207));
  const doorbell = isDoorbellDevice({ deviceType, category: "eufy_security" });
  const soundDetection = finiteNumber(params.get(6043));
  const microphone = finiteNumber(params.get(1240));
  const speaker = finiteNumber(params.get(1241));
  const recordMute = finiteNumber(params.get(1288));
  const soloE30 = deviceType === 88 && model === "T8171";
  const c31 = standaloneChannelZero && deviceType === 10_031 && model === "T817L";
  const statusLed = finiteNumber(params.get(c31 ? 6014 : doorbell ? 1716 : 1045));
  const preRecording = c31 ? finiteNumber(params.get(6257)) : null;
  const soloAudioRecording = soloE30 || c31 ? finiteNumber(params.get(6012)) : null;
  const c37Tracking = standaloneChannelZero && deviceType === 10_037 && model === "T814X";
  const soloAiTracking = soloE30 || (deviceType === 10_031 && model === "T817L") || c37Tracking
    ? finiteNumber(params.get(6016)) : null;
  const speakerVolume = percentage(1230);

  // These reads have model-specific evidence. Shared parameter IDs alone do not
  // establish their meaning for every device that reports them.
  const verifiedDoorbell = deviceType === 5 || deviceType === 94;
  const homebaseChime = reviewedChime !== undefined ? (reviewedChime ? 1 : 0) : verifiedDoorbell ? finiteNumber(params.get(1702)) : null;
  const mechanicalChime = verifiedDoorbell ? finiteNumber(params.get(1703)) : null;
  const wideDynamicRange = verifiedDoorbell ? finiteNumber(params.get(1704)) : null;
  const chimeVolume = verifiedDoorbell ? percentage(1717) : undefined;
  const ringtoneVolume = deviceType === 94 ? percentage(1708) : undefined;
  const soundFamily = deviceType === 31 && /^T8410(?:$|[A-Z0-9-])/.test(model ?? "");
  const soundSensitivity = soundFamily || c31 ? finiteNumber(params.get(6044)) : null;
  const soundType = soundFamily || c31 ? finiteNumber(params.get(6046)) : null;
  const soundRoundLook = c31 ? finiteNumber(params.get(6208)) : null;
  const reviewedBrightness = readCameraSetting(settingRows, model ?? "", deviceType, standaloneChannelZero, "lightBrightness");
  const lightBrightness = typeof reviewedBrightness === "number" ? reviewedBrightness : c31 ? percentage(1401) : undefined;
  const notificationInterval = c31 ? finiteNumber(params.get(1250)) : null;
  const rtspPublication = c31 ? finiteNumber(params.get(1145)) : null;
  const continuousRecording = c31 ? finiteNumber(params.get(6010)) : null;
  const enhanceLighting = c31 ? finiteNumber(params.get(6484)) : null;
  const qualityFamily = deviceType === 48 && /^T8170(?:$|[A-Z0-9-])/.test(model ?? "");
  const t8171 = deviceType === 88 && /^T8171(?:$|[A-Z0-9-])/.test(model ?? "");
  const t8425 = deviceType === 47 && /^T8425(?:$|[A-Z0-9-])/.test(model ?? "");
  const attachedS340 = model === "T8170" && deviceType === 48 && !standaloneChannelZero;
  const s340LiveViewMode = attachedS340 ? readS340LiveViewMode(settingRows) : undefined;
  const reviewedStreamingQuality = readCameraSetting(settingRows, model ?? "", deviceType, standaloneChannelZero, "streamingQuality");
  const streamingQuality = attachedS340 ? readS340LiveQuality(settingRows)?.quality ?? null
    : c31 ? activeRecordingQuality(params.get(2730), 0) ?? null
    : typeof reviewedStreamingQuality === "number" ? reviewedStreamingQuality
      : qualityFamily || t8171 ? finiteNumber(params.get(1020)) : null;
  const recordingQuality = c31 ? activeRecordingQuality(params.get(2731), 2)
    : qualityFamily || soloE30 ? activeRecordingQuality(params.get(2731)) : undefined;
  const solarIntensity = qualityFamily ? finiteNumber(params.get(1309)) : null;
  const solarConnected = qualityFamily ? finiteNumber(params.get(6482)) : null;
  const notificationStyle = t8171 ? finiteNumber(params.get(6020)) : null;
  const watermark = t8425 || c31 ? finiteNumber(params.get(1214)) : null;
  const antiTheft = t8425 ? finiteNumber(params.get(1015)) : null;
  const nativeLightProfile = (deviceType === 38 && model === "T8423")
    || (deviceType === 105 && model === "T8417")
    || (deviceType === 151 && model === "T84A1");
  const c35ManualLight = deviceType === 10035 && model === "T8110" && standaloneChannelZero;
  const spotlight = c37Tracking || c35ManualLight ? finiteNumber(params.get(1400))
    : qualityFamily || nativeLightProfile ? finiteNumber(params.get(1403)) : null;
  const sensitivity = qualityFamily ? finiteNumber(params.get(1276)) : null;
  const compositeQuality = deviceType === 5 ? finiteNumber(params.get(1705)) : null;
  const validComposite = compositeQuality !== null && Number.isInteger(compositeQuality)
    && [0, 1, 2, 3, 5, 6, 7, 8].includes(compositeQuality);
  const recordingPolicy = deviceType === 48 && /^T8170(?:$|[A-Z0-9-])/.test(model ?? "");
  const mode = recordingPolicy ? finiteNumber(params.get(1246)) : null;
  const modeNames = ["Optimal Battery Life", "Optimal Surveillance", "Customize Recording"] as const;
  const autoStop = recordingPolicy ? finiteNumber(params.get(1251)) : null;
  const recordingSeconds = (type: number): number | undefined => {
    const seconds = recordingPolicy ? finiteNumber(params.get(type)) : null;
    return seconds !== null && Number.isInteger(seconds) && seconds >= 0 && seconds <= 0xffff_ffff
      ? seconds : undefined;
  };
  const duration = recordingSeconds(1249);
  const interval = recordingSeconds(1250);
  const batteryHealth = percentage(1198);
  const openDevice = finiteNumber(params.get(2001));
  const cameraSwitch = finiteNumber(params.get(1035));
  const cameraSwitch1035 = params.has(1035) ? diagnosticCameraSwitch(params.get(1035)) : undefined;

  // The selected standalone profiles report detection through their native switch.
  // A conflicting legacy bit must not override that model-specific read.
  const nativeLightMotion = standaloneChannelZero && nativeLightProfile;
  const floodlight = model === "T8425" || model === "T8426";
  const reviewedMotion = readCameraSetting(settingRows, model ?? "", deviceType, standaloneChannelZero, "motionDetection");
  const outdoorRows = settingRows.filter(row => row.param_type === 6271);
  const outdoorModeValue = outdoorRows.length > 1 ? null : params.has(6271) ? finiteNumber(params.get(6271)) : 0;
  const t8171OutdoorMode = soloE30 && !standaloneChannelZero
    ? outdoorModeValue === 0 ? false : outdoorModeValue === 1 ? true : undefined : undefined;
  const e30NativeMotion = soloE30 && (standaloneChannelZero || t8171OutdoorMode === true);
  const attachedMotionAmbiguous = soloE30 && !standaloneChannelZero
    && (t8171OutdoorMode === undefined || settingRows.filter(row => row.param_type === (e30NativeMotion ? 6040 : 1011)).length > 1);
  const motionSwitch = attachedMotionAmbiguous ? null : floodlight ? (typeof reviewedMotion === "boolean" ? Number(reviewedMotion) : null)
    : finiteNumber(params.get(e30NativeMotion || c31 || nativeLightMotion ? 6040 : 1011));
  const guardMode = finiteNumber(params.get(1224));
  const autoNightVision = finiteNumber(params.get(1013));
  const nightVisionMode = finiteNumber(params.get(1277));
  const privacy6250 = finiteNumber(params.get(6250));
  const attachedT8171Settings = soloE30 && !standaloneChannelZero && t8171OutdoorMode === false;
  const attachedAudio = attachedT8171Settings ? readCameraSetting(settingRows, model, deviceType, false, "audioRecording") : undefined;
  const attachedTracking = attachedT8171Settings ? readCameraSetting(settingRows, model, deviceType, false, "aiTracking") : undefined;
  const c35Enabled = model === "T8110" && deviceType === 10035;
  const enabled = attachedT8171Settings ? readCameraSetting(settingRows, model, deviceType, false, "cameraEnabled") as boolean | undefined
    : c35Enabled ? readCameraSetting(settingRows, model, deviceType, standaloneChannelZero, "cameraEnabled") as boolean | undefined : c31
    ? privacy6250 === 0 || privacy6250 === 1 ? privacy6250 === 0 : undefined
    : openDevice === 0 || openDevice === 1
    ? openDevice === 1
    : cameraSwitch === 0 || cameraSwitch === 1
      ? cameraSwitch === cameraEnableRawValue(deviceType, true)
      : undefined;
  return {
    ...sensorHealth,
    ...(ringtoneVolume !== undefined && Number.isInteger(ringtoneVolume) ? { ringtoneVolume } : {}),
    ...(alarmVolume !== undefined ? { alarmVolume } : {}),
    ...(soundSensitivity !== null && Number.isInteger(soundSensitivity) && (c31 ? soundSensitivity >= 1 && soundSensitivity <= 5 : [1, 3, 5].includes(soundSensitivity))
      ? { soundDetectionSensitivity: soundSensitivity } : {}),
    ...((c31 ? soundType === 128 || soundType === 256 : soundType === 1 || soundType === 2) ? { soundDetectionType: soundType! } : {}),
    ...(typeof lightBrightness === "number" && Number.isInteger(lightBrightness) ? { lightBrightness } : {}),
    ...(rtspPublication === 0 || rtspPublication === 1 ? { rtspPublicationEnabled: rtspPublication === 1 } : {}),
    ...(continuousRecording === 0 || continuousRecording === 1 ? { continuousRecordingEnabled: continuousRecording === 1 } : {}),
    ...(notificationInterval !== null && Number.isInteger(notificationInterval) && notificationInterval >= 0 && notificationInterval <= 300 && notificationInterval % 60 === 0 ? { notificationIntervalMinutes: notificationInterval / 60 } : {}),
    ...(soundRoundLook === 0 || soundRoundLook === 1 ? { soundRoundLookEnabled: soundRoundLook === 1 } : {}),
    ...(enhanceLighting === 0 || enhanceLighting === 1 ? { enhanceLightingEnabled: enhanceLighting === 0 } : {}),
    ...(streamingQuality !== null && Number.isInteger(streamingQuality) && streamingQuality >= 0 && streamingQuality <= 3
      ? { streamingQualityTier: streamingQuality } : {}),
    ...(s340LiveViewMode !== undefined ? { s340LiveViewMode } : {}),
    ...(recordingQuality !== undefined ? { recordingQualityTier: recordingQuality } : {}),
    ...(solarIntensity !== null && solarIntensity >= 0 && solarIntensity <= Number.MAX_SAFE_INTEGER
      ? { solarIntensity } : {}),
    ...(solarConnected === 0 || solarConnected === 1 ? { solarConnected24h: solarConnected === 1 } : {}),
    ...(notificationStyle !== null && [1, 2, 3].includes(notificationStyle) ? { notificationStyle } : {}),
    ...(watermark !== null && [0, 1, 2].includes(watermark) ? { watermarkMode: watermark } : {}),
    ...(antiTheft === 0 || antiTheft === 1 ? { antiTheftDetectionEnabled: antiTheft === 1 } : {}),
    ...(spotlight === 0 || spotlight === 1 ? { spotlightEnabled: spotlight === 1 } : {}),
    ...(typeof manualFloodlight === "boolean" ? { manualFloodlightEnabled: manualFloodlight } : {}),
    ...(typeof motionStep === "number" ? { motionSensitivityStep: motionStep } : {}),
    ...(sensitivity !== null && Number.isInteger(sensitivity) && sensitivity >= 1 && sensitivity <= 7
      ? { motionSensitivityRaw: sensitivity } : {}),
    ...(mode !== null && Number.isInteger(mode) && mode >= 0 && mode <= 2 ? { workingMode: modeNames[mode]! } : {}),
    ...(duration !== undefined ? { recordingDurationSeconds: duration } : {}),
    ...(interval !== undefined ? { recordingIntervalSeconds: interval } : {}),

    // This setting reports a disable bit: zero means stop early when motion ends.
    ...(autoStop === 0 || autoStop === 1 ? { recordingAutoStop: autoStop === 0 } : {}),
    ...(homebaseChime === 0 || homebaseChime === 1 ? { homebaseChimeEnabled: homebaseChime === 1 } : {}),
    ...(mechanicalChime === 0 || mechanicalChime === 1 ? { mechanicalChimeEnabled: mechanicalChime === 1 } : {}),
    ...(wideDynamicRange === 0 || wideDynamicRange === 1 ? { wideDynamicRangeEnabled: wideDynamicRange === 1 } : {}),
    ...(chimeVolume !== undefined && Number.isInteger(chimeVolume) ? { chimeVolume } : {}),
    ...(validComposite ? {
      doorbellVideoQuality: compositeQuality! % 5,
      highCompressionEncoding: compositeQuality! >= 5,
    } : {}),
    ...(preRecording === 0 || preRecording === 1 ? { preRecordingEnabled: preRecording === 1 } : {}),
    ...(imageFlipped === 0 || imageFlipped === 1 ? { imageFlipped: imageFlipped === 1 } : {}),
    ...(statusLed === 0 || statusLed === 1 ? { statusLedEnabled: statusLed === 1 } : {}),
    ...(soundDetection === 0 || soundDetection === 1 ? { soundDetectionEnabled: soundDetection === 1 } : {}),
    ...(microphone === 0 || microphone === 1 ? { microphoneEnabled: microphone === 1 } : {}),
    ...(speaker === 0 || speaker === 1 ? { speakerEnabled: speaker === 1 } : {}),

    // Verified standalone profiles report an enable bit. Other models retain
    // the inverted mute field. Missing native state cannot use the legacy bit.
    ...(attachedT8171Settings ? typeof attachedAudio === "boolean" ? { audioRecordingEnabled: attachedAudio } : {} : soloE30 || c31
      ? soloAudioRecording === 0 || soloAudioRecording === 1 ? { audioRecordingEnabled: soloAudioRecording === 1 } : {}
      : recordMute === 0 || recordMute === 1 ? { audioRecordingEnabled: recordMute === 0 } : {}),
    ...(speakerVolume !== undefined ? { speakerVolume } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(cameraSwitch1035 !== undefined ? { cameraSwitch1035 } : {}),
    ...(soloE30 && !standaloneChannelZero && t8171OutdoorMode !== undefined ? { t8171OutdoorMode } : {}),
    ...(motionSwitch === 0 || motionSwitch === 1 ? { motionDetectionEnabled: motionSwitch === 1 } : {}),
    ...(attachedT8171Settings ? typeof attachedTracking === "boolean" ? { aiTrackingEnabled: attachedTracking } : {}
      : soloAiTracking === 0 || soloAiTracking === 1 ? { aiTrackingEnabled: soloAiTracking === 1 } : {}),
    ...(guardMode !== null && [0, 1, 2, 3, 4, 5, 6, 47, 63].includes(guardMode) ? { guardMode } : {}),
    ...(autoNightVision === 0 || autoNightVision === 1 ? { autoNightVisionEnabled: autoNightVision === 1 } : {}),
    ...(nightVisionMode === 0 || nightVisionMode === 1 || nightVisionMode === 2
      || (deviceType === 88 && model === "T8171" && nightVisionMode === 3) ? { nightVisionMode } : {}),
    ...(privacy6250 === 0 || privacy6250 === 1 ? { privacy6250Value: privacy6250 } : {}),
    ...(batteryLevel !== undefined ? { batteryLevel } : {}),
    ...(backupBatteryLevel !== undefined ? { backupBatteryLevel } : {}),
    ...(batteryStatus !== null ? { batteryCharging: batteryStatus !== 0 && batteryStatus !== 2 } : {}),
    ...(batteryHealth !== undefined ? { batteryHealth } : {}),
    ...(temperature !== null && temperature >= -50 && temperature <= 100 ? { batteryTemperature: temperature } : {}),
    ...(contact === 0 || contact === 1 ? { contactOpen: contact === 1 } : {}),
    ...(rssi !== null && rssi >= -150 && rssi <= -1 ? { rssi } : {}),
    ...(lastSeen !== undefined
      ? { lastSeen: new Date(lastSeen * 1_000).toISOString() }
      : {}),
    ...(motionEventSeconds !== undefined ? { motionEventSeconds } : {}),
  };
}

/** Classify parameter 1035 without retaining untrusted text or structured values. */
function diagnosticCameraSwitch(value: unknown): NonNullable<MegaInventoryReads["cameraSwitch1035"]> {
  const numeric = finiteNumber(value);
  if (numeric === 0) return "zero";
  if (numeric === 1) return "one";
  if (numeric !== null) return "other_number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "text";
  if (Array.isArray(value) || isRecord(value)) return "structured";
  return "other";
}

/** Decode plain or canonical base64 JSON and require an explicitly selected recording mode. */
function activeRecordingQuality(value: unknown, minimum = 1): number | undefined {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (value.length > 4096) return undefined;
    try { parsed = JSON.parse(value); } catch {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
      const decoded = Buffer.from(value, "base64");
      if (decoded.toString("base64") !== value) return undefined;
      try { parsed = JSON.parse(decoded.toString("utf8")); } catch { return undefined; }
    }
  }
  if (!isRecord(parsed)) return undefined;
  const mode = parsed.cur_mode;
  if (typeof mode !== "number" || !Number.isSafeInteger(mode) || mode < 0 || mode > 255) return undefined;
  const selected = parsed[`mode_${mode}`];
  if (!isRecord(selected)) return undefined;
  const tier = selected.quality;
  return typeof tier === "number" && Number.isInteger(tier) && tier >= minimum && tier <= 3 ? tier : undefined;
}

/** Resolve the family-specific raw 1035 value for a desired camera state. */
export function cameraEnableRawValue(deviceType: number | null, enabled: boolean): number {
  const directPolarity = deviceType === 31;
  return directPolarity ? (enabled ? 1 : 0) : enabled ? 0 : 1;
}

/** Retain only bounded numeric parameter IDs, never provider values or blobs. */
export function safeParamTypes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const types = new Set<number>();
  for (const row of value.slice(0, 512)) {
    if (!isRecord(row)) continue;
    const rawType = row.param_type;
    const type = typeof rawType === "number" && Number.isSafeInteger(rawType) ? rawType
      : typeof rawType === "string" && /^\d{1,5}$/.test(rawType) ? Number(rawType) : null;
    if (type !== null && type >= 0 && type <= 65_535) types.add(type);
  }
  return [...types].sort((left, right) => left - right);
}

/** Identify supported Mega doorbells that should expose a press sensor. */
export function isDoorbellDevice(device: Pick<MegaInventoryDevice, "deviceType" | "category">): boolean {
  return device.category === "eufy_security" && [5, 7, 16, 91, 94, 95, 96, 97, 203].includes(device.deviceType ?? -1);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^-?\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validUnixSeconds(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 946_684_800 && parsed <= Date.now() / 1_000 + 86_400
    ? parsed
    : undefined;
}

/** Narrow an untrusted inventory value to an object that can carry named fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trim a reported text field and require a nonempty value within its limit. */
export function safeValue(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  return candidate.length > 0 && candidate.length <= maxLength ? candidate : null;
}

/** Decode a safe integer using the existing Mega inventory string conversion. */
export function integer(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}
