# Experimental standalone doorbell video test

This default-off test requests one private ten-second clip from an exact standalone
Video Doorbell C30, T8224/type 96. Discovery and events remain separate. The
same default-off option now enables normal Home Assistant live view for this
exact route after the diagnostic produced reporter-confirmed H.264 playback.
One reporter confirmed normal-view startup and reopening on v0.1.191, then
confirmed that Capture snapshot saved a current JPEG. Sustained playback and
physical camera sleep remain unconfirmed. It does not enable camera controls or audio.

An independent T8223 owner-account result provides the connection lead.
Dedicated guest accounts still need physical confirmation. No Web Portal
PIN, account switch or encryption-setting change is required for this trial.

1. Update both the app and integration to a release containing this test.
2. Enable **Experimental standalone doorbell video test** in the app options.
   The gateway must have an API token configured.
3. Open **Diagnostics**, enter the API token, load devices and select the
   standalone T8224. Stop other viewers.
4. Expand the standalone doorbell test, confirm private-video consent and choose
   **Try doorbell video once**. Use **Cancel doorbell test** to stop early.
5. Check whether the clip plays and shows the selected doorbell. If it fails,
   share only the complete `doorbell_rtc_trial_failed` line.

The clip is checked for complete decoding before download. It stays in the
browser and is never uploaded automatically. Keep clips, credentials and private
links out of public issues. Disable the experimental option after the test.

The video-service region setting is shared with the NVR diagnostic because both
use the same regional service. Leave it on **auto** unless the connection needs
a specifically established regional comparison.

## Startup failure and cancellation

For normal live view, closing the last waiting viewer now cancels an unfinished
startup rather than leaving it alive until the startup deadline. A recording or
source lease keeps its existing protection, and the reservation remains held
until disconnect finishes. After media startup, normal idle grace is unchanged.
The separately consented diagnostic clip keeps its existing lifetime and
cancellation behaviour.

One startup failure is logged once, even when both the output and the start
promise report it. The existing failure line adds only fixed metadata:

- `call_progress=not_sent`: no call request was queued locally.
- `waiting`: a request was queued locally, with no recognised reply yet.
- `pending`: a bound provisional reply arrived.
- `accepted`: a bound acceptance arrived.
- `rejected` or `invalid_response`: a bound call reply rejected the request or
  did not match a supported reply form.
- `offer_received=true` means a bound offer candidate arrived. It does not
  establish valid SDP, call acceptance, a connected peer or playable video.

These fields remain available after cleanup. They include no received payload,
account, address, timestamp, token or media. A queued local request is not proof
that the camera received it. Existing call messages, authentication, service
region, response checks, retry policy and startup deadlines remain unchanged.

The unresolved startup refusal still needs a real result on the affected
account. If asked to check a containing release, use one ordinary live view and
share only `doorbell_rtc_stream_failed` on failure. Do not repeat the regional
matrix, change account or PIN settings, or run a broad capture for these fields.
