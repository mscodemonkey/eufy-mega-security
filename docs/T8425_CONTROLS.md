# Experimental floodlight controls

Enable **Experimental model controls** to try the brightness number for an exact
standalone T8425/type 47 or T8426/type 87 on channel zero. The current Eufy account must
own the device, the direct route must be ready, and a brightness value must be
reported before Home Assistant offers the control. This candidate has not been
confirmed on either model. Model aliases and attached routes are excluded.

The range is 1 to 100%. Each change reads the camera's current value, sends one
absolute setting, then independently reads the result. An acknowledgement alone
does not count as confirmation. If the result is uncertain, brightness becomes
unavailable until a new observation. Check the Eufy app before retrying.

Brightness is separate from floodlight on/off and motion detection. The same
opt-in now also offers a motion-detection switch and a sensitivity number from
1 to 5 for these exact standalone models. A unique, readable native value is
required for each control. Both use one absolute command and fresh readback,
and uncertain results withdraw only the affected value. A missing control is a
reason to stop and report that result, not to try another model's commands.

Physical motion detection and sensitivity changes remain unconfirmed. For a
motion-switch test, note the current app setting, change it once, then restore
it immediately and confirm the app agrees. Leave it in the original state. For
sensitivity, try one nearby step and restore the original. These settings do not
change notification types, zones or motion-triggered lighting schedules.
Pan/tilt and the other remaining controls in #470 and #481 stay open.

For a reversible test, note the current brightness in the Eufy app, choose a
small different value in Home Assistant, compare both displays and the light's
brightness, then restore the original value and confirm it in the app. Do not
change motion detection, siren or camera power for this test.
