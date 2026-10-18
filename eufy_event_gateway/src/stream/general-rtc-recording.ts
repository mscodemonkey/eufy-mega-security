/**
 * Records one manual RTC trial in a disposable media manager and state registry.
 * The route owns the provider lease. This boundary owns transient video and
 * media-process budgets, and cannot write retained images or publish events.
 */
import { GatewayState } from "../domain/gateway-state.js";
import type { GeneralRtcTrialLease, PreparedGeneralRtcTrial } from "../provider/general-rtc-trial.js";
import type { SnapshotStore } from "../storage/snapshot-store.js";
import { LiveStreamManager, remuxVideoToMp4 } from "./live-stream-manager.js";
import { validateStoredMedia } from "./stored-recordings.js";
import { GeneralRtcError, generalRtcAwait } from "./general-rtc-protocol.js";

/** Synthetic tests replace media processes without using a camera or account. */
export interface GeneralRtcRecordingDependencies {
  readonly remux: typeof remuxVideoToMp4;
  readonly validate: typeof validateStoredMedia;
}

const PRIVATE_CAMERA = "general-rtc-private";
const MAXIMUM_BYTES = 32 * 1024 * 1024;

/** Prepare first, capture ten seconds, validate within one media budget, then recheck ownership. */
export async function recordGeneralRtcClip(lease: GeneralRtcTrialLease, pin: string, signal: AbortSignal,
  dependencies: GeneralRtcRecordingDependencies = { remux: remuxVideoToMp4, validate: validateStoredMedia }): Promise<Buffer> {
  const state = new GatewayState();
  state.registerCamera({ serial: PRIVATE_CAMERA, name: "Private video trial", model: "Private trial",
    stationSerial: PRIVATE_CAMERA, streamSupported: true, doorbellSupported: false });
  const snapshots = new Proxy({} as SnapshotStore, { get: () => () => { throw new GeneralRtcError("video", "media"); } });
  let prepared: PreparedGeneralRtcTrial | null = null;
  const forbidden = (): never => { throw new GeneralRtcError("video", "media"); };
  const manager = new LiveStreamManager(state, snapshots, {
    startStream: async () => lease.start(output => manager.attachSource(PRIVATE_CAMERA, output, () => "h264")),
    stopStream: async () => { try { await prepared?.stop(); } finally { manager.markStopped(PRIVATE_CAMERA); } },
  }, 0, async (video, codec, audio, _signal, frameRate) => {
    const stage = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    try {
      const clip = await generalRtcAwait(dependencies.remux(video, codec, audio, stage, frameRate), stage, "video");
      if (stage.aborted || clip.length > MAXIMUM_BYTES) throw new GeneralRtcError("video", "media");
      await generalRtcAwait(dependencies.validate(clip, stage, 4096 * 2160), stage, "video");
      if (stage.aborted) throw new GeneralRtcError("video", "timeout");
      return clip;
    } catch { throw new GeneralRtcError("video", "media"); }
  }, forbidden, forbidden);
  manager.on("warning", () => undefined);
  try {
    prepared = await lease.prepare(pin);
    const clip = await manager.recordClip(PRIVATE_CAMERA, 10, 40_000, true, signal, { maximumRecordingBytes: MAXIMUM_BYTES });
    if (clip.length > MAXIMUM_BYTES) throw new GeneralRtcError("video", "media");
    await prepared.verify();
    if (signal.aborted) throw new GeneralRtcError("cancelled");
    return clip;
  } catch (error) {
    if (signal.aborted) throw signal.reason instanceof GeneralRtcError ? signal.reason : new GeneralRtcError("cancelled");
    throw error instanceof GeneralRtcError ? error : new GeneralRtcError("video", "media");
  } finally {
    try { await manager.close(); } finally { state.close(); }
  }
}
