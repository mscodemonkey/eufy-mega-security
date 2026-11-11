# Standalone C37 control trials

These trials cover exact **T814X, device type 10037, standalone channel 0**.
Tracking on and off is reporter-confirmed on v0.1.257, including independent
app readback and restoration of the original off setting. Movement, saved
positions and spotlight behaviour remain unconfirmed. T814XS, type 10039 and
HomeBase-attached cameras are excluded from these controls.

Enable **Experimental model controls** only if you want to test them. The option
is off by default and requires a gateway API token. The configured Eufy account
must own the camera. Keep your existing account arrangement if you do not want
to run an owner-account experiment.

| Control | Where to test | What the software verifies |
| --- | --- | --- |
| AI tracking | HA tracking buttons or Diagnostics | Current setting before the write and fresh reported setting afterwards. A missing acknowledgement permits the fresh read, without repeating the write. An explicit rejection still fails. |
| Saved positions | HA buttons for occupied slots | Fresh slot occupancy before selecting a position and a matching command acknowledgement. |
| Directional movement | HA pan buttons or Diagnostics | One directional click and a matching acknowledgement. Observe actual movement. |
| Spotlight | HA light buttons or Diagnostics | Fresh original manual-light setting and matching reported setting after the write. |

Unknown preset replies fail visibly. They are not reported as a successful empty
list. Scene names, pictures and coordinates are discarded. These controls do not
create or delete positions or change which position is the default.

The spotlight reading describes its manual setting. It does not establish actual
illumination or provide an automatic-off guarantee. An acknowledged position
request does not establish that the camera reached that position.

A T814X report on v0.1.253 confirmed physical tracking changes despite a failure
response from EMS. The updated tracking path checks the fresh setting after a
missing acknowledgement. The reporter confirmed that correction on v0.1.257,
with both tracking changes succeeding and the original setting restored. The
reported spotlight read failure and movement returning to its default position
when the connection closes remain separate, unresolved limitations.

## Before a physical test

Use a build that includes these controls. Close live views first. C37 controls
refuse an existing viewer instead of interrupting it. Check the current setting
in the Eufy app and note the starting value or position so you can restore it.

Test one control at a time. For Diagnostics, select the camera, check available
controls, choose the operation and confirm that you can observe and restore the
camera. AI tracking and spotlight require a fresh readable original value before
any change. A missing value stops the test before a write.

HA movement buttons send one click per press. They do not hold a direction or
report position. Commands waiting in the queue are discarded if the camera's
connection, ownership or provider lifetime changes before they start.

Compare the result with the Eufy app and the camera's actual behaviour. Restore
the starting setting or position afterwards. If a request fails or times out,
check independently before retrying. A failed response can leave the outcome
unknown, and the gateway never automatically repeats the C37 write.

For an HA movement, tracking or position failure, share only the complete
`camera_c37_control_failed` line. HA light and Diagnostics failures use
`model_control_trial_failed`. Keep account
details, device identifiers, images and raw recordings private.

## Experimental light buttons

On the normal HA device page, the light on/off buttons are labelled
**Experimental** and start disabled. Enabling an entity is the explicit opt-in.
They use the existing guarded command path and do not guess the lamp's state.
The reported initial-read failure remains open, so these labels do not imply
that the spotlight has been repaired. No repeated light test is requested.
