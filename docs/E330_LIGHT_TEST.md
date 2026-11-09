# E330 manual-light trial

This opt-in trial covers only E330 Professional **T8600, device type 24** attached
to HomeBase 3 **T8030, device type 18**. It is a candidate for manual on/off, not
the setting that enables automatic spotlight use. Other models and standalone
routes are excluded. Normal HA light controls are not added by this trial.

Enable **Experimental model controls** only if you want to try it. Keep your
existing account arrangement. The trial requires the configured account to own
the camera and HomeBase, and a gateway API token. Shared accounts are excluded.

Close all live views and let recording retrieval finish. In **Diagnostics**,
select the E330 and choose **Manual light (through HomeBase 3)**. Note whether
the light is on or off, and make sure you can watch it and restore that state in
the Eufy app. Choose the opposite state and use **Try once** once.

The trial sends one command and does not automatically retry it. It keeps other
operations off the HomeBase until its connection finishes closing. A successful
reply acknowledges the command only. It does not establish illumination, a
durable light setting or an automatic-off guarantee.

Observe whether the light changes and whether it returns to its starting state
when the trial connection closes. Restore the original state in Eufy afterwards.
If the result is uncertain, check the light independently and do not repeat the
trial. Report what the light did and, on failure, only the complete
`model_control_trial_failed` line. Keep account details and identifiers private.
