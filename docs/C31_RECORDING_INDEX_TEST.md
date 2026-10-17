# C31 continuous-recording index test

This experimental diagnostic is for a standalone C31, model T817L and device type 10031, on its direct channel-zero connection. It is separate from the working event-recording browser and does not enable continuous playback.

The request is intended to read the recording index, based on the native app's source. Its hardware effects have not been confirmed. The gateway sends one query for the previous thirty minutes. It does not intentionally change recording settings, start video, fetch clips or delete anything. A timeout is inconclusive. It does not mean the recording list is empty.

Use this test only when the camera already has continuous footage. Do not enable recording or change account settings for this test.

1. Update both the app and integration to the release containing this test.
2. Enable **Experimental model controls** in the app options.
3. Close the camera's live viewers and open the gateway's **Diagnostics** page.
4. Enter the gateway API token, load devices and select the standalone C31.
5. Open **Experimental C31 continuous-recording index test**, read and tick its consent box, then choose **Check recording index once**.

The response contains structural counts only. It excludes recording times, paths, identities, encryption keys and footage. A matching reply does not confirm that recordings can be played. The gateway checks current device and account ownership around the query, rejects competing activity and applies a short cooldown before another attempt.

Share the displayed summary publicly if requested. If the test fails, share only the complete `recording_index_trial_failed` log line. Do not post the API token, account or device details, private links, footage or raw responses. Cancel, changing the selected device or leaving the page stops the request. No diagnostic runs automatically on startup.
