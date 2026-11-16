# HomeBase-connected SoloCam E30 control trial

The exact SoloCam E30 T8171, type 88, on HomeBase 3 T8030 has opt-in camera-enable, recording-audio and AI-tracking candidates on its observed child channel. Enable experimental model controls in the gateway options, then enable each desired experimental entity on the HomeBase-connected camera device page. New camera-enable and recording-audio switches and tracking buttons start disabled. Existing entity identities and saved user choices are retained.

Each control requires its own reported value. An absent setting stays unavailable. Camera-enable uses the reported privacy bit, recording audio uses the HomeBase recording-mute bit, and tracking uses its separate tracking preference. Other connections and nearby model variants are excluded. The existing motion-detection and active-stream quality controls are unchanged.

API authentication and either the owner account or explicit administrator membership on both devices are required. The camera and HomeBase must report the same owner. Guest, foreign and missing memberships do not qualify. The provider checks fresh inventory before sending one absolute setting, then requires fresh confirmation. A lost result is unknown and must not be retried until the Eufy app confirms the setting.

Close live views on the same HomeBase before changing a setting. Note the original value, make one change, independently check it, then restore the original value and check again. Recording audio controls sound in saved clips. Live microphone talkback retains its separate option and test requirements.

These candidates are source-qualified and software-tested. Physical behaviour remains unconfirmed. A successfully displayed HA setting establishes its reported state, not physical camera operation or recorded audio content.
