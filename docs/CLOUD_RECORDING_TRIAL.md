# Experimental cloud recording preview

This default-off Diagnostics test downloads an existing cloud recording and
prepares a private video-only preview. It needs an existing recording available
to the gateway's account. It does not create a subscription or trial, change
settings, delete recordings or list clips stored only on a HomeBase.

1. Update the app and integration to a release containing this test.
2. Enable **Experimental cloud recording test** in the app options. An API token
   must be configured.
3. Open **Diagnostics**, enter the API token, load devices and select a camera.
4. Expand **Experimental cloud recording preview**, select a day and choose
   **Load cloud recordings**.
5. Select one recording, confirm private-video consent and choose
   **Preview selected recording**. Use **Cancel cloud test** to stop early.
6. Check whether the preview plays and shows the selected recording. If preview
   preparation fails, share only the complete `cloud_recording_trial_failed` line.

Keep footage, account details and private links out of public issues. The preview
stays in the browser and is never uploaded automatically. Disable the experimental
option after testing. No account or encryption-setting change is needed.

The preview has no audio and is limited to two minutes. The trial supports plain
MP4 and source-defined v8 H.264 recording frames. Legacy encrypted v1/v5 and other
codecs remain unavailable. Downloads are limited to 32 MiB. Some valid recordings
may exceed the trial's format, frame or size limits. Synthetic media verifies the
software path, while actual cloud recording and shared-account behaviour remain
unconfirmed until tested.
