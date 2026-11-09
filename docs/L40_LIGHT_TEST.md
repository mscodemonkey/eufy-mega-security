# L40 timed manual-light trial

This opt-in candidate covers only standalone SoloCam L40 **T8123, device type
61**, using its own channel-zero route. It does not start video, admit a
HomeBase-attached camera or add a normal HA light entity.

Enable **Experimental model controls** only if you want to test it. Keep your
existing account arrangement. The configured account must own this camera, and
the gateway must have an API token. Close live views and wait for other camera
operations to finish.

On the L40's normal Home Assistant device page, enable **Turn camera light on
(experimental)** and **Turn camera light off (experimental)**. Both buttons start
disabled. Note the starting light state and make sure you can watch it and
restore it in Eufy, then press the opposite-state button once. No separate
Diagnostics page or observation checkbox is required. If the result is uncertain,
check the light independently and do not retry.

The command requests a 60-second manual-light period. Device enforcement,
physical illumination and the light's behaviour after the connection closes
remain unconfirmed. A successful reply acknowledges the command only. It does
not establish a durable light setting or permission to repeat it automatically.

Report whether the light changed and how long it remained on after the trial
finished. Restore its starting state in Eufy afterwards. On failure, share only
the complete `model_control_trial_failed` line. Keep account details and device
identifiers private. Do not use video start/stop as a substitute for this trial.
