# E330 manual-light trial

This opt-in trial covers only E330 Professional **T8600, device type 24** attached
to HomeBase 3 **T8030, device type 18**. It is a candidate for manual on/off, not
the setting that enables automatic spotlight use. Other models and standalone
routes are excluded. Normal HA light controls are not added by this trial.

Enable **Experimental model controls** only if you want to try it. Keep your
existing account arrangement. The trial requires the configured account to own
the camera and HomeBase, and a gateway API token. Shared accounts are excluded.

In the E330's normal Home Assistant device page, enable **Turn camera light on
(experimental)** and **Turn camera light off (experimental)**. Both buttons start
disabled. Close all live views and let recording retrieval finish. Note the
starting light state, make sure you can watch and restore it in Eufy, then press
the opposite-state button once. No Diagnostics page or extra checkbox is needed.

The equivalent manual-light action remains available in Diagnostics for an
investigation, but it is not required for these device buttons.

The trial sends one command and does not automatically retry it. It keeps other
operations off the HomeBase until its connection finishes closing. A successful
reply acknowledges the command only. It does not establish illumination, a
durable light setting or an automatic-off guarantee.

Observe whether the light changes and whether it returns to its starting state
when the trial connection closes. Restore the original state in Eufy afterwards.
If the result is uncertain, check the light independently and do not repeat the
trial. Report what the light did and, on failure, only the complete
`model_control_trial_failed` line. Keep account details and identifiers private.
