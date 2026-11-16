# HomeBase 3 saved-playback trial

Experimental model controls add saved event playback for exact eufyCam 2C T8113-Z/type 8 and battery doorbell T8210/type 7 children on HomeBase 3 T8030/type 18. Open **Media > Eufy recordings** in Home Assistant, choose the camera, then a day and clip.

API authentication and either the owner account or explicit administrator membership on both the camera and HomeBase are required. Guest and foreign memberships are excluded. Fresh inventory must preserve the same child, parent, channel and account before retrieval and before the result is returned. Each clip gets its own recipient key. Only completed local recordings belonging to that exact camera and type can become opaque playback references.

The day query examines the first one hundred station events, so older events on a busy day may be outside that window. Close live views on the same HomeBase before browsing. A clip is returned only after EOF and complete media validation, including recorded audio when present. Saved paths and media keys are not exposed to Home Assistant clients.

These routes are opt-in candidates. Physical playback is unconfirmed. HomeBase 2, other 2C model strings and other doorbell types remain outside this trial. Existing E30 and C31 recording routes are unchanged. This feature does not delete recordings, change recording settings or enable live microphone talkback.
