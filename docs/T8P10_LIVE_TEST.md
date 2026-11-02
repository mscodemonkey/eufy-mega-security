# Experimental T8P10 NVR video

Exact **T8P10 cameras, device type 303, attached to T8N00 NVR S4, type 300**
have an opt-in live-video candidate. Physical playback remains unconfirmed.
Enable **Experimental NVR live** in the gateway options only if you want to
test it. The option is off by default and requires gateway API authentication.
Other parent devices and model variants are excluded.

The candidate exposes the fixed camera view through the normal Home Assistant
camera. It does not expose pan, zoom, light, guard or other setting controls.
Startup snapshot capture, stored-recording playback and live audio remain
unavailable on this trial. A shared NVR does not make those separate features
supported.

Use a build containing this candidate. Test one camera at a time, with other NVR
viewers, recording retrieval and diagnostic trials closed. Open its live view,
check for moving video, close it, then reopen it. Check that the second view is
also playable. Opening this view does not change camera or NVR security settings.

If it fails, share the complete `nvr_live_stream_failed` line and whether any
moving picture appeared. Keep device identifiers, account details and raw
captures private. Software checks establish admission and cleanup behaviour,
not physical compatibility. Each T8P10 still needs that first playback result.
