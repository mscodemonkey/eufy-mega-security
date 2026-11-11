# Standalone T8420 live-video trial

This default-off trial is limited to the original Floodlight Cam **T8420,
Mega type 3, standalone channel 0**. T8420X, T8422 and HomeBase-attached cameras
are excluded. It does not enable light, alarm or other setting controls.

The alternate start applies only when the current peer connection reports
cipher 65433 and the authenticated key lookup explicitly returns no key. A
cached cipher number, failed lookup or failed key unwrap cannot select it.
A negotiated encrypted session keeps its existing start. Media still requires
the normal decoded-video checks. Hardware playback through EMS is unconfirmed.

After installing the containing app and integration release, enable
**Experimental T8420 live video** in the app configuration. Keep the existing
account, camera and encryption settings unchanged.

Open one normal HA camera view for about twenty seconds, then close it. If it
shows moving video, reopen it once and close it afterwards. Turn the experimental
option off after the check. No external capture or private footage is needed.

Report whether both views showed moving video. If a view fails, the complete
`camera_stream_closed model=T8420` line from the EMS app log is enough. It
includes the selected start protocol without account data or media. Keep
playback URLs, credentials, device identifiers and raw captures private.

The trial sends the observed explicit stop before ending its selected peer
session. Local send completion does not prove a physical stop acknowledgement.
Do not infer support for other models or settings from this video result.
