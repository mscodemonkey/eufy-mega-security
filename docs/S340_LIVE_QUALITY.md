# S340 live-quality trial

This optional trial covers the exact SoloCam S340 T8170, type 48, attached to HomeBase 3. It offers Auto, 720p, 1080p and 3K live-quality preferences. Actual capture dimensions and playback on this hardware remain unconfirmed. Telephoto selection is separate and is not added by this trial.

The gateway must already have an authenticated owner account, API authentication, a ready HomeBase route and a recognised current live-quality state. Missing or conflicting state keeps the control unavailable. This trial changes the live preference only. It does not change recording quality, recording mode or lens selection.

Enable **Experimental model controls** in the EMS app configuration. A startup reason of `trial_disabled` means this option is off. The separate `experimental_s340_smooth_live` option is not required for this quality trial and can stay off. On the S340 device page in Home Assistant, show disabled entities and enable **Streaming quality (experimental)** for the S340. The entity starts disabled and enabling it does not send a setting change.

Wait until the HomeBase has no active views or recordings. Do not interrupt a recording to force the test. Note the original preference. If **3K** is already selected, leave it there. Otherwise select **3K** once. The gateway sends at most one request and reports success only after fresh matching state arrives. If the outcome is unknown, check the Eufy app before retrying.

After confirmation, capture one snapshot or a short clip and check its actual pixel dimensions. A 3K preference label does not prove that the camera delivered a 3K source. Report the dimensions and whether the preference was confirmed. If you want to revert, select the original preference. No repeated switching, account change, recording-setting change or private capture is needed.

If the select is absent even from the entity registry, send the single startup `camera_s340_quality_admission` line from the EMS app (add-on) log. It is not written to the Home Assistant core or integration debug log. It distinguishes the app opt-in, account, connection and reported-state requirements without sending a camera command. Do not change accounts or recording settings to make the selector appear. The EMS app configuration and Home Assistant integration options are separate pages.
