# C31 continuous-recording index test

This experimental diagnostic is for a standalone C31, model T817L and device type 10031, on its direct channel-zero connection. It is separate from the working event-recording browser and does not enable continuous playback.

The request reads the recording index using the native app's query shape. The normal Diagnostics page sends one query for the previous thirty minutes. The saved-connection helper can instead select one historical interval of at most thirty minutes within the previous day. It does not intentionally change recording settings, start video, fetch clips or delete anything. A timeout is inconclusive. It does not mean the recording list is empty.

Use this test only when the camera already has continuous footage. Do not enable recording or change account settings for this test.

An image on the recording timeline or the Home card's event count does not establish a playable continuous interval. A local app check returned an authenticated empty full-day continuous index while still displaying an image. A positive interval is still needed to qualify continuous playback.

## Saved-connection historical check

Use this helper after installing the release containing the historical-window support. Download both scripts from the same revision, following the saved-connection setup in [Private diagnostics](PRIVATE_DIAGNOSTICS.md#1-open-the-capture-tool), then run:

```sh
python3 /config/eufy-diagnostics-tools/diagnostic-bundle.py list
python3 /config/eufy-diagnostics-tools/diagnostic-bundle.py recording-index-check --target-index 1 --consent-read
```

Replace `1` with the current C31 index. Without time flags this checks the previous thirty minutes. To check a known older continuous recording, add both `--begin-time START_SECONDS --end-time END_SECONDS`, replacing the placeholders with UTC Unix seconds around that recording, with an interval no longer than thirty minutes and entirely within the previous day. These are seconds, not milliseconds. The helper uses HA's saved gateway connection without displaying its generated token. It sends once and never falls back to another window after a refusal. An older release rejects the new request rather than silently checking a different interval.

Close live viewers and playback in Eufy first. Enable Experimental model controls for the test, then restore that option afterwards. Share only the structural summary or the fixed error if requested. The helper does not confirm playback.

## Recent interval through Diagnostics

1. Update both the app and integration to the release containing this test.
2. Enable **Experimental model controls** in the app options.
3. Close the camera's live viewers and open the gateway's **Diagnostics** page.
4. Use an already authenticated Diagnostics page, load devices and select the standalone C31. If HA's generated token is not available on that page, use the saved-connection helper instead of copying or sharing credentials.
5. Open **Experimental C31 continuous-recording index test**, read and tick its consent box, then choose **Check recording index once**.

The response contains structural counts only. It excludes recording times, paths, identities, encryption keys and footage. A matching reply does not confirm that recordings can be played. The gateway checks current device and account ownership around the query, rejects competing activity and applies a short cooldown before another attempt.

Share the displayed summary publicly if requested. If the test fails, share only the complete `recording_index_trial_failed` log line. Do not post the API token, account or device details, private links, footage or raw responses. Cancel, changing the selected device or leaving the page stops the request. No diagnostic runs automatically on startup.
