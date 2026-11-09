/**
 * Classifies an already rejected E10 offer without accepting a media route.
 * The RTC session owns the private SDP and binding. This stateless boundary
 * consumes the existing strict track parser and returns only fixed failures
 * to that session, never SDP, credentials, addresses or a playable peer.
 */
import { doorbellRtcOffer } from "./doorbell-rtc-offer.js";
import { NvrTrialError, type NvrTrialReason } from "./nvr-protocol.js";

/**
 * Refine only an exact standalone E10 track rejection. A checked H.264 shape
 * identifies a candidate for the existing receiver, not E10 playback support.
 * A data-section category reports presence only, never an accepted data path.
 * Other models, bindings and failure classes retain the original error.
 */
export function refineE10OfferFailure(error: unknown, value: unknown,
  binding: { readonly cameraType?: number; readonly station: string; readonly camera: string; readonly channel: number }): unknown {
  if (!(error instanceof NvrTrialError) || error.reason !== "offer_media_tracks"
    || binding.cameraType !== 314 || binding.station !== binding.camera || binding.channel !== 0) return error;
  let reason: NvrTrialReason = "offer_e10_tracks_unqualified";
  if (typeof value === "string" && Buffer.byteLength(value) <= 32768 && !/[^\x09\x0a\x0d\x20-\x7e]/.test(value)) {
    try {
      const checked = doorbellRtcOffer(value);
      reason = checked.media.some(section => section.line.startsWith("m=application "))
        ? "offer_e10_h264_data_section" : "offer_e10_h264_no_data_section";
    } catch {

      // This is a declared codec hint only. No H.265 parser or receiver is admitted.
      if (value.split(/\r?\n/).some(line => /^a=rtpmap:[0-9]{1,3} H265\/90000$/i.test(line))) reason = "offer_e10_h265_declared";
    }
  }
  return new NvrTrialError("negotiation", reason);
}
