# Window Camera E10 private video test

The exact T8404 Android handler selects an RTC live-start request. EMS offers a
manual, default-off ten-second clip trial for standalone T8404/type 314, channel
0, using an already configured owner account. It uses the existing bounded RTC
adapter to establish whether that camera supplies a compatible offer and video.
It has no fallback to another model, transport, account or service region.

This does not enable normal HA video or establish E10 hardware playback.
Event pictures and camera settings remain separate. No setting is written, and
the trial sends no power, privacy, siren or movement command. Connection cleanup
is awaited on success, failure and cancellation.

If the gateway already uses the E10 owner account, update the app and integration
to the release containing this test. Do not switch a working shared account for
it. Enable **Experimental NVR live video** in the app options, open Diagnostics,
select the E10, close other viewers and expand **Experimental NVR and E10 video
test**. Confirm private-video consent and choose **Try NVR video once**. The
existing option and button are shared with the RTC clip test.

Cancel if needed. A successful result downloads only to the browser and must be
checked privately in a compatible player. Report whether it contains ten seconds
of playable video. On failure, send only the complete `nvr_live_trial_failed`
line. Keep the clip, identifiers and any private download links out of GitHub.
Do not repeat a failed trial or use **Read NVR state once** for the E10.

After the check, restore the experimental option to its starting value. A failure
at the offer or framing stage is an observation to investigate, not evidence that
the camera has no video or permission to loosen the media parser.
