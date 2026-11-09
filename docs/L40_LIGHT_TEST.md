# L40 timed manual-light trial

This opt-in candidate covers only standalone SoloCam L40 **T8123, device type
61**, using its own channel-zero route. It does not start video, admit a
HomeBase-attached camera or add a normal HA light entity.

Enable **Experimental model controls** only if you want to test it. Keep your
existing account arrangement. The configured account must own this camera, and
the gateway must have an API token. Close live views and wait for other camera
operations to finish before opening **Diagnostics**.

Select the L40, check the available controls, then choose **Manual light
(experimental)**. Note the starting light state and make sure you can watch it
and restore that state in Eufy. Select the opposite state and use **Try once**
once. If the result is uncertain, check the light independently and do not retry.

The command requests a 60-second manual-light period. Device enforcement,
physical illumination and the light's behaviour after the connection closes
remain unconfirmed. A successful reply acknowledges the command only. It does
not establish a durable light setting or permission to repeat it automatically.

Report whether the light changed and how long it remained on after the trial
finished. Restore its starting state in Eufy afterwards. On failure, share only
the complete `model_control_trial_failed` line. Keep account details and device
identifiers private. Do not use video start/stop as a substitute for this trial.
