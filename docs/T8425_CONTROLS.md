# Experimental T8425 brightness

Enable **Experimental model controls** to try the brightness number for an exact
standalone T8425 reporting type 47 on channel zero. The current Eufy account must
own the device, the direct route must be ready, and a brightness value must be
reported before Home Assistant offers the control. This candidate has not been
confirmed on T8425 hardware. T8426 and other models are excluded.

The range is 1 to 100%. Each change reads the camera's current value, sends one
absolute setting, then independently reads the result. An acknowledgement alone
does not count as confirmation. If the result is uncertain, brightness becomes
unavailable until a new observation. Check the Eufy app before retrying.

Brightness is separate from floodlight on/off and motion detection. This release
does not add the remaining motion settings or pan/tilt controls in #470.

For a reversible test, note the current brightness in the Eufy app, choose a
small different value in Home Assistant, compare both displays and the light's
brightness, then restore the original value and confirm it in the app. Do not
change motion detection, siren or camera power for this test.
