# Experimental S340 manual light

This trial covers only SoloCam S340 T8170, type 48, attached to HomeBase 3 T8030, type 18, through its reported child channel. Standalone S340, HomeBase S1 and nearby model variants are excluded. Physical light behaviour, the requested timer and restoration remain unconfirmed.

The EMS account must own both camera and HomeBase and gateway API authentication must be enabled. Enable Experimental model controls in the EMS app configuration. On the normal HA device page, show disabled entities and enable Turn camera light on (experimental) and Turn camera light off (experimental). They are stateless buttons, with no invented light state. Enabling a button sends nothing.

Wait until all HomeBase views and recordings have finished. Note the light's starting state in the Eufy app. Try one watched press for the opposite state, then restore the starting state with the other button. The request asks for a 60-second manual-light interval, but automatic switch-off is not confirmed. Keep watching the camera and restore the original state yourself if necessary. Do not leave an uncertain request unattended or repeat a failed write.

The gateway reserves the HomeBase, checks the current child and owner, sends once and waits for its receipt before retiring the connection. Acknowledgement is not proof that the light changed. The test does not start video, change motion-triggered illumination or affect live quality. Keep other viewers and recordings running rather than interrupting them to force the trial.

Report whether the light changed, whether the timer behaved as expected and whether the original state was restored. On failure, send only the complete `model_control_trial_failed` line. Do not change accounts or send a raw capture for this trial.
