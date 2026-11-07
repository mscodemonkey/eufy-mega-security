# Experimental C35 spotlight

The exact C35 T8110/type10035 has an opt-in manual Spotlight light entity. This
profile is limited to standalone Wi-Fi, channel zero, with a configured owner
account, gateway API authentication and Experimental model controls enabled.
HomeBase-attached cameras and model aliases are not included.

This is a candidate for hardware testing. It uses the manual spotlight switch,
not the setting that allows motion to activate the light. It does not change
brightness, schedules or motion-light configuration. No light command runs at
startup or when the option is enabled.

The light shows a reported manual switch value. Missing state leaves it
unavailable. Each explicit action first reads the current setting, sends at
most one command and requires a fresh matching report. A failed action clears
its HA state to unknown. Check the light in Eufy before retrying an uncertain
result. A matching setting report does not establish physical illumination.

When testing, record the original manual switch value, try a single change,
check the physical light and whether it stays on after the action finishes, then restore the original value. Keep any diagnostic
files private. The existing experimental controls page also offers the C35
spotlight trial if a baseline cannot yet be shown in HA.
