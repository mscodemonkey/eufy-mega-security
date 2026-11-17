# HomeBase 2 live audio trial

A receive-only trial is available for exact T8210/type 7 and T8140-Z/type 14 cameras attached to T8010/type 0. A reporter confirmed audible playback on v0.1.270 with one T8210 doorbell and three T8140-Z cameras on HomeBase 2. Intermittent slow video startup remains unresolved in [#854](https://github.com/mscodemonkey/eufy-mega-security/issues/854). It uses checked clear AAC from the existing camera video session. Protected, unsupported and foreign-channel audio is discarded.

The Live audio (Experimental) switch starts disabled in the device entity list and its choice starts off. If you choose to try it, enable that entity, turn it on and use Native video for one ordinary live view. Turn the choice off afterwards if sound does not work. No camera audio-recording setting, account, HomeBase setting or recording is changed. Existing videos and snapshots remain available.

Just whether sound was audible is enough. If it stays silent, the complete `camera_native_transport` and model-specific `camera_stream_closed` lines after closing that ordinary view help identify the missing boundary. Keep playback URLs and full logs private. There is no repeated switching or longer session to arrange.

This trial does not provide microphone talkback. T8210 talkback remains a separate scope decision.
