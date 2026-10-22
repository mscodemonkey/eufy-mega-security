# Unwanted playback diagnostics

If camera starts recur while you are not watching, keep camera views closed and
open **Settings > Devices & services > Eufy Mega Security > Download diagnostics**.
Download twice a few minutes apart during a natural burst. You do not need to
restart Home Assistant, open live view or change any settings for this check.

Share only the `playback` rows from those two files, after checking them for
anything private. The rows omit camera names, entity IDs, serials, source URLs,
tokens and error text. They describe only this integration's existing Home
Assistant camera streams. Downloading them does not create a stream or start a
camera, and the rows remain available if the gateway cannot be reached.

`created` means Home Assistant has cached a stream object. It can remain true
while idle. `hls_output` and `recorder_output` show which playback consumers exist,
and `hls_idle` reports the HLS consumer's idle state. `preload` shows the existing
stream's preload setting. `native_video` and `short_hls_idle` show the integration
options currently used by that camera entity.

`start_worker` and `worker_error` are cumulative counters. Compare the two
downloads to see whether they increase. `retry_timeout` is Home Assistant's last
reported retry delay in seconds. Missing or null readings are unavailable, and
`unavailable: true` means the row could not be collected.

These are Home Assistant observations, not a count of people watching or proof
that a physical camera woke up. They do not establish the cause of battery drain
or confirm that it is fixed.
