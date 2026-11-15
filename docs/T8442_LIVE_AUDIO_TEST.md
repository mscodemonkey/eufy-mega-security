# E210 live audio trial

This trial is for Outdoor Cam E210 T8442, device type 46, attached to HomeBase 3 T8030, device type 18. Live video and clear AAC arrival have been reported on this route. Listening through Home Assistant still needs confirmation.

After installing an app and integration release containing this trial:

1. On the camera's normal Home Assistant device page, enable the disabled **Live audio (Experimental)** entity.
2. Close an existing view, turn Live audio on, then open the camera in HA and unmute the player.
3. Check whether moving video and camera sound play together. Turn Live audio off afterwards if you prefer video-only views.

This is a local playback choice. It does not change the camera microphone, recording sound, detection settings or account. It does not add talkback. Other camera controls and the separate restart-period startup failure remain unchanged.

If sound is missing, the complete `camera_native_transport model=T8442` line from that view is useful. No extra motion event, account change or private media is needed.
