# Window Camera E10 private video test

The exact T8404 Android handler selects an RTC live-start request. EMS offers a
manual, default-off ten-second clip trial for standalone T8404/type 314, channel
0, using an already configured owner account. It uses the existing bounded RTC
adapter to establish whether that camera supplies a compatible offer and video.
It has no fallback to another model, account or service region.

The H.264 candidate uses the checked RTP video track returned by the E10 offer.
Unused audio and data sections are explicitly declined. It does not create data
channels or send NVR inventory, live-start or setting commands on this route.
A complete keyframe and parameter sets are required before the video consumer
starts. Packet loss waits for another keyframe, and cancellation retires the call.
One reporter confirmed a cleanly decoded, approximately ten-second 1080p clip
on v0.1.254. On v0.1.255 the same reporter confirmed two clean 90-second
normal HA views, including close/reopen and normal daylight colour.

## Normal Home Assistant video candidate

The next candidate uses that same video receiver from the normal HA camera
entity. In a release containing this change, enable **Experimental NVR live
video** using the already configured owner account, then open the E10 camera
in HA. The route is
limited to standalone T8404/type 314 on channel zero. It stays off without the
experimental option and does not admit shared accounts or attached variants.

This is video-only. Normal views remain open while checked video is arriving,
until the existing media owner closes the source. A 45-second video stall ends
the call. Signalling and keepalive traffic cannot renew that deadline. The
manual clip trial retains its finite lifetime and grants no additional controls.

The v0.1.257 report confirmed 150 seconds of clean HA HLS playback and closure
when the viewer closed. Later plain HA and Frigate-via-HA views both ended after
about five minutes. A v0.1.260 result identifies a remote hang-up after 301 seconds. Its cause remains unresolved. The E10
signalling diagnostic distinguishes the rejected message layer and shape,
and counts queued keepalives and observed service responses without logging
message contents or accepting additional messages. v0.1.261 also corrects the E10 keepalive profile.
Longer real-camera playback remains unconfirmed.

No extra long view or private clip test is requested. If a view stops during
ordinary use of a release containing this diagnostic, send only the complete
`nvr_live_stream_failed` line. Keep footage and raw messages private, and restore
the experimental option when finished.

## Existing manual clip test

Event pictures and camera settings remain separate. No setting is written, and
the trial sends no power, privacy, siren or movement command. Connection cleanup
is awaited on success, failure and cancellation.

If the gateway already uses the E10 owner account, update the app and integration
to the release containing this test. Do not switch a working shared account for
it. Enable **Experimental NVR live video** in the app options, open Diagnostics,
select the E10, close other viewers and expand **Experimental NVR and E10 video
test**. Confirm private-video consent and choose **Try NVR video once**. The
existing option and button are shared with the RTC clip test.

### Home Assistant app installs without a visible API token

The app generates its gateway token automatically. The empty field on the
Diagnostics page is not a missing Eufy password. Do not change accounts, paste
credentials into GitHub or extract the token for a support reply.

Use the saved-connection utility revision linked in the test request. Older
utility releases do not contain `e10-video-test`. Download both support scripts
from that same revision as described in [private diagnostics](PRIVATE_DIAGNOSTICS_REFERENCE.md#home-assistant-app-installs), then run `list` to obtain the current E10 index.
With the experimental option enabled, close other viewers and run once in the
Home Assistant Terminal & SSH app, replacing `1` with that current index:

```sh
python3 /config/eufy-diagnostics-tools/diagnostic-bundle.py e10-video-test --target-index 1 --consent-private-media --output /config/e10-video-test.mp4
```

The command uses the integration's saved connection without displaying the
token. It reserves a new private file before starting the trial and refuses
existing files, symlinks and public folders. It makes one request with no retry.
A saved clip is not a playback confirmation. Retrieve it through your usual
private file transfer, check it in a compatible player and keep it out of
`/config/www`. If the command fails or is cancelled, do not repeat it until its
outcome has been checked. Restore the experimental option afterwards.

Cancel if needed. A successful result downloads only to the browser and must be
checked privately in a compatible player. Report whether it contains ten seconds
of playable video. On failure, send only the complete `nvr_live_trial_failed`
line. Keep the clip, identifiers and any private download links out of GitHub.
Do not repeat a failed trial or use **Read NVR state once** for the E10.

After the check, restore the experimental option to its starting value. A failure
at the offer or framing stage is an observation to investigate, not evidence that
the camera has no video or permission to loosen the media parser.


A normal E10 view now retains its already-connected media peer after a bound
signalling hang-up while valid pictures are still arriving. The same peer stays
owned until the viewer closes, the existing video-progress deadline expires or
the peer fails. This sends no replacement call. Foreign-session messages,
pre-media hang-ups and finite private clips still fail or close normally.
Continuation past the reported five-minute stop remains hardware-unconfirmed.
There is no extra long view or private capture to arrange for this candidate.

For a reconnectable go2rtc input that does not reuse an expiring HA HLS link, see [E10 source for go2rtc](E10_GO2RTC.md). The separate five-minute media failure remains unresolved.
