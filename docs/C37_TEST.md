# Standalone C37 control trials

These trials cover exact **T814X, device type 10037, standalone channel 0**.
Physical behaviour remains unconfirmed. T814XS, type 10039 and HomeBase-attached
cameras are excluded from these controls.

Enable **Experimental model controls** only if you want to test them. The option
is off by default and requires a gateway API token. The configured Eufy account
must own the camera. Keep your existing account arrangement if you do not want
to run an owner-account experiment.

| Control | Where to test | What the software verifies |
| --- | --- | --- |
| AI tracking | HA tracking buttons or Diagnostics | Current setting before the write and fresh reported setting afterwards. HA also requires a matching command acknowledgement. |
| Saved positions | HA buttons for occupied slots | Fresh slot occupancy before selecting a position and a matching command acknowledgement. |
| Directional movement | Diagnostics | One directional click and a matching acknowledgement. Observe actual movement. |
| Spotlight | Diagnostics | Fresh original manual-light setting and matching reported setting after the write. |

Unknown preset replies fail visibly. They are not reported as a successful empty
list. Scene names, pictures and coordinates are discarded. These controls do not
create or delete positions or change which position is the default.

The spotlight reading describes its manual setting. It does not establish actual
illumination or provide an automatic-off guarantee. An acknowledged position
request does not establish that the camera reached that position.

## Before a physical test

Use a build that includes these controls. Close live views first. C37 controls
refuse an existing viewer instead of interrupting it. Check the current setting
in the Eufy app and note the starting value or position so you can restore it.

Test one control at a time. For Diagnostics, select the camera, check available
controls, choose the operation and confirm that you can observe and restore the
camera. AI tracking and spotlight require a fresh readable original value before
any change. A missing value stops the test before a write.

Compare the result with the Eufy app and the camera's actual behaviour. Restore
the starting setting or position afterwards. If a request fails or times out,
check independently before retrying. A failed response can leave the outcome
unknown, and the gateway never automatically repeats the C37 write.

For an HA failure, share only the complete `camera_c37_control_failed` line.
For a Diagnostics failure, share only `model_control_trial_failed`. Keep account
details, device identifiers, images and raw recordings private.
