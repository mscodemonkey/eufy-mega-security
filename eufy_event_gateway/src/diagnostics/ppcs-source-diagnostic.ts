/**
 * Projects an existing PPCS source into bounded startup evidence without I/O.
 * EufyProvider owns the source and its transient identity. Private bundle capture
 * consumes the projection; peer addresses, payloads and key bytes stay excluded.
 */
import type { StreamDiagnostic, StreamFrameKind, StreamStartupBoundary } from "../domain/types.js";
import type { FirstPartyPpcsSession } from "../stream/first-party-ppcs.js";

type SourceStats = Pick<FirstPartyPpcsSession["stats"], "camId" | "gatewayInfo" | "level2" | "cameraInfoFrames"
  | "foreignVideoFrames" | "gatewayInfoAcknowledged" | "gatewayInfoRetransmitted" | "gatewayInfoExpired"
  | "mediaStartAttempts" | "mediaStartAcknowledged" | "mediaStartRetransmitted" | "mediaStartExpired"
  | "dataDatagrams" | "frameHeaders" | "videoFrames" | "videoOutputFrames" | "sequenceGaps" | "sequenceRestarts"
  | "duplicateDatagrams" | "staleDatagrams" | "parserResyncs" | "pendingBytes" | "incompleteAccessUnits"
  | "incompleteAccessUnitBytes" | "frameShapes">;

/**
 * Snapshot the observed source boundary and complete frame kinds without copying raw stats.
 * The source identity describes sampled instances, not every connection attempt.
 * A start ACK is transport evidence only. Frame kinds are distinct observations,
 * not per-kind counts, and deliberately omit frame sizes and payload prefixes.
 */
export function ppcsSourceDiagnostic(stats: SourceStats, sourceAttempt: number): StreamDiagnostic {
  const counters = {
    camId: stats.camId, gatewayInfo: stats.gatewayInfo, level2: stats.level2,
    cameraInfoFrames: stats.cameraInfoFrames, foreignVideoFrames: stats.foreignVideoFrames,
    gatewayInfoAcknowledged: stats.gatewayInfoAcknowledged, gatewayInfoRetransmitted: stats.gatewayInfoRetransmitted,
    gatewayInfoExpired: stats.gatewayInfoExpired, mediaStartAttempts: stats.mediaStartAttempts,
    mediaStartAcknowledged: stats.mediaStartAcknowledged, mediaStartRetransmitted: stats.mediaStartRetransmitted,
    mediaStartExpired: stats.mediaStartExpired, dataDatagrams: stats.dataDatagrams, frameHeaders: stats.frameHeaders,
    videoFrames: stats.videoFrames, videoOutputFrames: stats.videoOutputFrames, sequenceGaps: stats.sequenceGaps,
    sequenceRestarts: stats.sequenceRestarts, duplicateDatagrams: stats.duplicateDatagrams,
    staleDatagrams: stats.staleDatagrams, parserResyncs: stats.parserResyncs, pendingBytes: stats.pendingBytes,
    incompleteAccessUnits: stats.incompleteAccessUnits, incompleteAccessUnitBytes: stats.incompleteAccessUnitBytes,
  };
  let startupBoundary: StreamStartupBoundary = "unknown";
  if ([stats.camId, stats.mediaStartAttempts, stats.mediaStartAcknowledged, stats.videoFrames, stats.videoOutputFrames]
    .every(value => Number.isSafeInteger(value) && value >= 0)) {
    startupBoundary = stats.videoOutputFrames > 0 ? "output" : stats.videoFrames > 0 ? "video-without-output"
      : stats.camId === 0 ? "lookup" : stats.mediaStartAttempts === 0 ? "start-not-sent"
        : stats.mediaStartAcknowledged === 0 ? "start-unacknowledged" : "start-acknowledged-no-video";
  }
  const frameKinds: StreamFrameKind[] = [];
  for (const shape of stats.frameShapes.slice(0, 20)) {
    const match = /^(\d{1,5}):(\d{1,3}):(\d{1,8}):(\d{1,5})$/.exec(shape);
    if (!match) continue;
    const command = Number(match[1]), sign = Number(match[2]), transportType = Number(match[4]);
    if (command > 65535 || sign > 255 || transportType > 65535) continue;
    const kind: StreamFrameKind["kind"] = command === 1100 ? "gateway-info" : command === 1103 ? "camera-info"
      : command === 1300 ? "video" : command === 1301 ? "audio" : command === 1350 ? "response"
        : command === 1351 ? "notification" : "other";
    const signCode = sign;
    if (!frameKinds.some(value => value.command === command && value.signCode === signCode && value.transportType === transportType)) {
      frameKinds.push({ kind, command, signCode, transportType });
    }
  }
  return { stage: stats.camId === 0 ? "lookup" : stats.videoFrames === 0 ? "first-frame" : "media",
    ...(Number.isSafeInteger(sourceAttempt) && sourceAttempt > 0 ? { sourceAttempt } : {}),
    startupBoundary, frameKinds, counters };
}
