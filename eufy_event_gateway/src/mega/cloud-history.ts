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
