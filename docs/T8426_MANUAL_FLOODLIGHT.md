# Experimental T8426 manual floodlight

Enable **Experimental model controls** to try a normal Home Assistant light
named **Manual floodlight** on exact standalone T8426/type 87, channel zero.
The current Eufy account must own the device, its direct route must be ready,
and a manual override value must be reported before the entity appears.
T8426121 and attached routes are excluded. Physical behaviour is unconfirmed.

This light controls the manual override independently of motion detection. Its
state reports that setting, not a measurement of whether the lamp is glowing.
Turning the manual override off does not disable motion lighting. There is no
promised automatic-off timer, and no motion, siren or camera-power setting changes.

Each request reads the current setting, sends one absolute command when needed,
then independently reads it back. A transport acknowledgement alone is not
confirmation. If the outcome is uncertain, the light becomes unavailable until
a new observation. Check the Eufy app before retrying.

For a reversible test, note the original manual setting in the Eufy app, change
it once through Home Assistant, compare the app and actual light, then restore
the original setting and confirm restoration in the app. Leave motion detection
and its lighting settings unchanged. If the entity does not appear, report that
result first rather than trying another model's controls.

Brightness, night vision, motion settings, pan/tilt and siren remain separate
work in #481.
