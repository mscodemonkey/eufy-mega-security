/**
 * Defines the exact E21 event, reported-state and experimental command profile.
 * Inventory owns identity and freshness. The provider owns authentication,
 * transport, serialization and confirmation. This pure boundary supplies no
 * default state and never opens media, changes a device or infers a physical result.
 */

/** Source-backed transient care notifications, independent of security-camera event numbers. */
export const e21DetectionKinds = ["motion", "crying", "sound", "pet", "babyLeft", "babyEntered", "temperatureHigh", "temperatureLow", "careAreaLeft", "careAreaEntered", "babyActivity"] as const;

/** One recent care notification, not a continuous classification of the room. */
export type E21DetectionKind = typeof e21DetectionKinds[number];

/** Exact inventory facts required before applying this model's namespace. */
export interface E21Identity {
  readonly model: string;
  readonly deviceType: number | null;
  readonly category: string | null;
}

/** Return true only for the reviewed E21 model, numeric type and product category together. */
export function isE21(device: E21Identity): boolean {
  return device.model === "T8354" && device.deviceType === 86 && device.category === "eufy_care";
}

/** Map a native care notification without reusing vehicle or dog meanings from other cameras. */
export function e21PushKind(messageType: number | null, eventType: number | null): E21DetectionKind | null {
  if (messageType !== 18 || eventType === null) return null;
  const kinds: Readonly<Record<number, E21DetectionKind>> = {
    3101: "motion", 3104: "crying", 3105: "sound", 3106: "pet", 3107: "babyLeft", 3108: "babyEntered",
    3298: "temperatureHigh", 3299: "temperatureLow", 3601: "careAreaLeft", 3602: "careAreaEntered", 3603: "babyActivity",
  };
  return kinds[eventType] ?? null;
}

/** A separately reviewed absolute preference; unsupported privacy and publication writes are absent. */
export const e21PreferenceNames = ["microphone", "speaker", "speakerVolume", "imageFlipped", "watermark", "statusLed", "soundDetection", "soundSensitivity", "soundType", "soundRoundLook", "audioRecording", "continuousRecording", "motionDetection", "motionSensitivity", "aiTracking", "cruise", "streamingQuality", "recordingQuality", "whiteNoiseVolume", "temperatureMonitoring"] as const;

/** One model-owned preference routed exclusively through the E21 queue and writer. */
export type E21Preference = typeof e21PreferenceNames[number];

/** An independently read parameter and its native absolute write shape. */
export interface E21PreferenceContract {
  readonly parameter: number;
  readonly outer: "binary" | 1350 | 1700;
  readonly field: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly choices?: readonly number[];
}

/** Contracts traced through the T8354-to-T8352 model binding and BabyMonitorBase parsers. */
export const e21PreferenceContracts: Readonly<Record<E21Preference, E21PreferenceContract>> = {
  microphone: { parameter: 1240, outer: "binary", field: "value", minimum: 0, maximum: 1 },
  speaker: { parameter: 1241, outer: "binary", field: "value", minimum: 0, maximum: 1 },
  speakerVolume: { parameter: 1230, outer: "binary", field: "value", minimum: 0, maximum: 100 },
  imageFlipped: { parameter: 1207, outer: "binary", field: "value", minimum: 0, maximum: 1 },
  watermark: { parameter: 1214, outer: "binary", field: "value", minimum: 0, maximum: 2 },
  statusLed: { parameter: 6014, outer: 1700, field: "value", minimum: 0, maximum: 1 },
  soundDetection: { parameter: 6043, outer: 1700, field: "status", minimum: 0, maximum: 1 },
  soundSensitivity: { parameter: 6044, outer: 1700, field: "index", minimum: 1, maximum: 5 },
  soundType: { parameter: 6046, outer: 1700, field: "type", minimum: 128, maximum: 256, choices: [128, 256] },
  soundRoundLook: { parameter: 6208, outer: 1350, field: "onoff", minimum: 0, maximum: 1 },
  audioRecording: { parameter: 6012, outer: 1700, field: "enable", minimum: 0, maximum: 1 },
  continuousRecording: { parameter: 6010, outer: 1700, field: "enable", minimum: 0, maximum: 1 },
  motionDetection: { parameter: 6040, outer: 1700, field: "status", minimum: 0, maximum: 1 },
  motionSensitivity: { parameter: 6041, outer: 1700, field: "value", minimum: 1, maximum: 5 },
  aiTracking: { parameter: 6016, outer: 1700, field: "value", minimum: 0, maximum: 1 },
  cruise: { parameter: 6031, outer: 1700, field: "value", minimum: 0, maximum: 1 },
  streamingQuality: { parameter: 2730, outer: 1350, field: "quality", minimum: 0, maximum: 4 },
  recordingQuality: { parameter: 2731, outer: 1350, field: "quality", minimum: 1, maximum: 4 },
  whiteNoiseVolume: { parameter: 6283, outer: 1350, field: "volume", minimum: 0, maximum: 100 },
  temperatureMonitoring: { parameter: 7004, outer: 1350, field: "value", minimum: 0, maximum: 1 },
};

/** Bounded public failure category shared by HTTP, provider admission and confirmation. */
export class E21ControlError extends Error {

  /** No device or account material is retained in an E21 failure. */
  constructor(readonly stage: "validation" | "admission" | "busy" | "outcome_unknown") {
    super(`E21 preference ${stage}`);
  }
}

/** Validate one absolute native value without widening any other camera's range. */
export function validateE21Preference(name: unknown, value: unknown): E21Preference {
  if (typeof name !== "string" || !e21PreferenceNames.includes(name as E21Preference)) throw new E21ControlError("validation");
  const contract = e21PreferenceContracts[name as E21Preference];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < contract.minimum || value > contract.maximum
    || contract.choices && !contract.choices.includes(value)) throw new E21ControlError("validation");
  return name as E21Preference;
}

/** Reported room state normalized to Celsius so native unit changes do not change HA units. */
export interface E21CareSettings {
  readonly roomTemperatureCelsius: number | null;
  readonly highTemperatureCelsius: number | null;
  readonly lowTemperatureCelsius: number | null;
  readonly temperatureMonitoringEnabled: boolean | null;
  readonly whiteNoiseVolume: number | null;
  readonly whiteNoiseTimerRaw: number | null;
  readonly rtspPublicationEnabled: boolean | null;
}

/** Strict model-owned reads; the provider supplies separate generation and fetch ordering proof. */
export interface E21Readings {
  readonly preferences: Readonly<Partial<Record<E21Preference, number>>>;
  readonly careSettings: E21CareSettings;

  /** Native view mode selects the streaming-quality bank; it is never defaulted. */
  readonly videoMode: 0 | 12 | null;
}

/** Accept canonical integer values only, preserving unknown rather than coercing hostile forms. */
export function e21Integer(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string" || !/^(?:0|-?[1-9]\d{0,14})$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Read a scalar or native bounded base64 quality bank using its independently reported mode. */
function qualityValue(value: unknown, mode: 0 | 12 | null): number | null {
  const scalar = e21Integer(value);
  if (scalar !== null) return scalar;
  if (typeof value !== "string" || value.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) return null;
    const decoded: unknown = JSON.parse(bytes.toString("utf8"));
    const direct = e21Integer(decoded);
    if (direct !== null) return direct;
    if (mode === null || !decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const bank = (decoded as Record<string, unknown>)[mode === 12 ? "mode_1" : "mode_0"];
    return bank && typeof bank === "object" && !Array.isArray(bank) ? e21Integer((bank as Record<string, unknown>).quality) : null;
  } catch { return null; }
}

/** Decode only exact model parameters, rejecting duplicate IDs before any value can escape. */
export function e21Readings(params: unknown): E21Readings {
  const rows = new Map<number, unknown>();
  const duplicates = new Set<number>();
  if (Array.isArray(params) && params.length <= 512) {
    for (const row of params) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const id = e21Integer(row.param_type);
      if (id === null || id < 0 || id > 65_535) continue;
      if (rows.has(id)) duplicates.add(id);
      rows.set(id, row.param_value);
    }
  }
  const raw = (id: number): unknown => duplicates.has(id) ? undefined : rows.get(id);
  const integer = (id: number): number | null => e21Integer(raw(id));
  const mode = integer(6243);
  const videoMode = mode === 0 || mode === 12 ? mode : null;
  const preferences: Partial<Record<E21Preference, number>> = {};
  for (const name of e21PreferenceNames) {
    const contract = e21PreferenceContracts[name];
    const value = name === "streamingQuality" ? qualityValue(raw(contract.parameter), videoMode) : integer(contract.parameter);
    if (value === null || name === "streamingQuality" && videoMode === null) continue;
    try { validateE21Preference(name, value); preferences[name] = value; } catch { /* Malformed native values remain unknown. */ }
  }
  const unit = integer(7003);
  const temperature = (id: number, ambient = false): number | null => {
    const value = integer(id);
    if (value === null || unit !== 0 && unit !== 1 || ambient && value === 0) return null;
    if (unit === 1 && (value < 0 || value > 50) || unit === 0 && (value < 32 || value > 120)) return null;
    return Math.round((unit === 0 ? (value - 32) * 5 / 9 : value) * 10) / 10;
  };
  const publication = integer(1145);
  const timer = integer(6282);
  return {
    preferences,
    videoMode,
    careSettings: {
      roomTemperatureCelsius: temperature(7000, true), highTemperatureCelsius: temperature(7001), lowTemperatureCelsius: temperature(7002),
      temperatureMonitoringEnabled: preferences.temperatureMonitoring === undefined ? null : preferences.temperatureMonitoring === 1,
      whiteNoiseVolume: preferences.whiteNoiseVolume ?? null,
      whiteNoiseTimerRaw: timer !== null && timer >= 0 && timer <= 2_147_483_647 ? timer : null,
      rtspPublicationEnabled: publication === 0 || publication === 1 ? publication === 1 : null,
    },
  };
}
