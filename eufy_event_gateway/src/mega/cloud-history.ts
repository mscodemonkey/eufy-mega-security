/**
 * Defines the read-only cloud-history boundary consumed by the gateway API.
 * The Mega client owns authentication and ciphertext. These projections keep
 * recording keys and temporary URLs out of history responses and diagnostics.
 */

/** A bounded query for one camera's cloud records, in Unix seconds. */
export interface CloudHistoryQuery {
  readonly startTime: number;
  readonly endTime: number;

  /** Browser-style timezone displacement in seconds, not a page offset. */
  readonly timezoneOffset?: number;
  readonly cursor?: number;
  readonly count?: number;
}

/** Metadata for one cloud record. Its existence does not prove playable bytes. */
export interface CloudHistoryRecord {
  readonly id: string;
  readonly startTime: number;
  readonly endTime: number;

  /** Shared-account owner supplied by the record, retained for later key lookup. */
  readonly ownerId: string | null;
  readonly hasCloudMedia: boolean;
}

/** Validate caller bounds before any history request can reach the cloud. */
export function validateCloudHistoryQuery(query: CloudHistoryQuery): void {
  if (!Number.isSafeInteger(query.startTime) || !Number.isSafeInteger(query.endTime) ||
    query.startTime < 0 || query.endTime <= query.startTime || query.endTime - query.startTime > 31 * 86_400 ||
    !Number.isSafeInteger(query.cursor ?? 0) || (query.cursor ?? 0) < 0 ||
    !Number.isSafeInteger(query.count ?? 100) || (query.count ?? 100) < 1 || (query.count ?? 100) > 1_000 ||
    !Number.isInteger(query.timezoneOffset ?? 0) || Math.abs(query.timezoneOffset ?? 0) > 86_400) {
    throw new SyntaxError("Invalid cloud history query");
  }
}

/** Project checked records for the requested camera, rejecting mixed ownership. */
export function projectCloudHistory(value: unknown, cameraSerial: string, count: number): readonly CloudHistoryRecord[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > count) throw new Error("Cloud history has an invalid record list");
  return value.map((row: unknown) => {
    if (!record(row) || row.device_sn !== cameraSerial ||
      !(typeof row.monitor_id === "string" && row.monitor_id.length > 0 || typeof row.monitor_id === "number" && Number.isSafeInteger(row.monitor_id) && row.monitor_id >= 0) ||
      !Number.isSafeInteger(row.start_time) || !Number.isSafeInteger(row.end_time) ||
      Number(row.start_time) < 0 || Number(row.end_time) < Number(row.start_time)) {
      throw new Error("Cloud history has an invalid record");
    }
    const owner = record(row.member) && typeof row.member.action_user_id === "string"
      ? row.member.action_user_id : typeof row.cipher_user_id === "string" ? row.cipher_user_id : null;
    return {
      id: String(row.monitor_id), startTime: Number(row.start_time), endTime: Number(row.end_time),
      ownerId: owner, hasCloudMedia: typeof row.cloud_path === "string" && row.cloud_path.length > 0,
    };
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Private operation-owned fields, never returned through the history API. */
export interface CloudRecordingReference {
  readonly monitorId: string | number;
  readonly cipherOwner: string;
  readonly keyOwner: string;
  readonly cipherId: string | number | null;
  readonly encryptedKey: string | null;
}

/** Select exactly one freshly returned recording with the requested camera and parent binding. */
export function selectCloudRecording(value: unknown, camera: string, station: string, id: string,
  query: CloudHistoryQuery): CloudRecordingReference {
  validateCloudHistoryQuery(query);
  if (!id || id.length > 128) throw new Error("Invalid cloud recording selection");
  projectCloudHistory(value, camera, query.count ?? 100);
  if (!Array.isArray(value)) throw new Error("Cloud recording is unavailable");
  const matches = value.filter(row => record(row) && String(row.monitor_id) === id);
  if (matches.length !== 1 || !record(matches[0])) throw new Error("Cloud recording is unavailable");
  const row = matches[0];
  if (row.station_sn !== station || Number(row.start_time) >= query.endTime || Number(row.end_time) < query.startTime
    || typeof row.cipher_user_id !== "string" || !row.cipher_user_id.length || row.cipher_user_id.length > 256) {
    throw new Error("Cloud recording ownership is unavailable");
  }
  const keyOwner = record(row.member) && typeof row.member.action_user_id === "string" && row.member.action_user_id
    ? row.member.action_user_id : row.cipher_user_id;
  if (keyOwner.length > 256) throw new Error("Cloud recording ownership is unavailable");
  let encryptedKey: string | null = null;
  if (row.extra !== undefined && row.extra !== null && row.extra !== "") {
    if (typeof row.extra !== "string" || row.extra.length > 16_384 || !/^[A-Za-z0-9_+/-]+={0,2}$/.test(row.extra)) {
      throw new Error("Cloud recording key metadata is unavailable");
    }
    let extra: unknown;
    try { extra = JSON.parse(Buffer.from(row.extra, "base64url").toString("utf8")); }
    catch { throw new Error("Cloud recording key metadata is unavailable"); }
    if (!record(extra)) throw new Error("Cloud recording key metadata is unavailable");
    if (extra.aes_key !== undefined) {
      if (typeof extra.aes_key !== "string" || !extra.aes_key.length || extra.aes_key.length > 4096) throw new Error("Cloud recording key metadata is unavailable");
      encryptedKey = extra.aes_key;
    }
  }
  return { monitorId: row.monitor_id as string | number, cipherOwner: row.cipher_user_id, keyOwner,
    cipherId: (typeof row.cipher_id === "number" || typeof row.cipher_id === "string" && /^\d{1,16}$/.test(row.cipher_id))
      && Number.isSafeInteger(Number(row.cipher_id)) && Number(row.cipher_id) > 0 ? row.cipher_id as string | number : null, encryptedKey };
}

/** Require one correlated renewal, never selecting another recording's temporary URL. */
export function cloudRecordingUrl(value: unknown, reference: CloudRecordingReference): string {
  if (!Array.isArray(value) || value.length !== 1 || !record(value[0])
    || value[0].monitor_id !== undefined && String(value[0].monitor_id) !== String(reference.monitorId)
    || typeof value[0].cloud_path !== "string" || !value[0].cloud_path.length || value[0].cloud_path.length > 8192) {
    throw new Error("Cloud recording URL is unavailable");
  }
  return value[0].cloud_path;
}

/** Recover only the exact cipher and fresh request-map entry, checking the AES-256 key length. */
export function cloudRecordingKey(value: unknown, cipherId: string | number, label: string): Buffer {
  if (!record(value) || !Array.isArray(value.cipher_keys) || value.cipher_keys.length > 100) throw new Error("Cloud recording key is unavailable");
  const matches = value.cipher_keys.filter(row => record(row) && row.cipher_id === cipherId);
  const keys: unknown = matches.length === 1 && record(matches[0]) ? matches[0].aes_keys : null;
  const encoded: unknown = record(keys) && Object.hasOwn(keys, label) ? keys[label] : null;
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_+/-]{43}=?$/.test(encoded)) throw new Error("Cloud recording key is unavailable");
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")) {
    key.fill(0); throw new Error("Cloud recording key is unavailable");
  }
  return key;
}
