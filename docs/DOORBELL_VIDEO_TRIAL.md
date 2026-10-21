# Experimental standalone doorbell video test

This default-off test requests one private ten-second clip from an exact standalone
Video Doorbell C30, T8224/type 96. Discovery and events remain separate. The
same default-off option now enables normal Home Assistant live view for this
exact route after the diagnostic produced reporter-confirmed H.264 playback.
Normal-view startup, reopening and sustained playback remain unconfirmed. It
does not enable camera controls or audio.

An independent T8223 owner-account result provides the connection lead. T8224
and dedicated guest accounts still need physical confirmation. No Web Portal
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
