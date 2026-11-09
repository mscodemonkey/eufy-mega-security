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

If the trial stops at `stage=initial_read`, no light command was sent. The
`model_control_trial_failed` line now includes a fixed `reason`: `no_reply`,
`not_decoded`, `invalid_json`, `invalid_schema`, `setting_missing`, or
`unavailable`. These distinguish a missing response from an unusable response
and a response lacking the manual switch value. They contain no response text.
An earlier response in the same session cannot qualify the current read.

Keep the normal light setting and avoid repeating a failed write attempt just
to collect diagnostics. The reason identifies the read boundary that needs
investigation. It does not establish a repair or authorize skipping the fresh
baseline. A failure at `stage=confirmation_read` happens after the write may
have reached the camera, so check the actual setting before any further action.

For diagnosis, choose **Read spotlight state (no light command)** in Diagnostics
instead of the Spotlight control. With Experimental model controls enabled,
close live view, check available controls, select that read action and consent
to one read. Leave the light in its usual state. This action has no On option,
sends no light command and does not update the HA light entity. A reported
switch value does not prove physical illumination or identify a matching reply
by transaction. Changing device, leaving the page or cancelling the HTTP request
closes the owned read session. The peer remains reserved until cleanup finishes.

The saved-connection helper offers the same action without copying a token:

```sh
python3 /config/eufy-diagnostics-tools/diagnostic-bundle.py spotlight-read-check --target-index 1 --consent-read
```

Use the current device list to select the C35's index. Keep the helper beside
its saved-connection companion script as described in the diagnostics guide.
An older gateway rejects this action. The helper never falls back to a light
command. Share only its closed summary or the `model_control_trial_failed` line
for `action=spotlightState`. Restore the gateway's Experimental model controls
option if it was enabled only for this check.

The state-only check has a separate request candidate for the exact standalone
C35 profile. It waits for the negotiated key and sends one protected camera-info
query using the app-observed integer pair (255, 903) on channel zero. Only an
authenticated, correctly routed parameter-table response can complete it. Key
failure, cancellation or an unusable response stops the check without a light
command, a fallback request or an HA state update. The normal Spotlight control
retains its existing read and write path.

The retained C35 app handler binds the camera-info request to the Android
dispatcher that supplies those two integers. Independently authenticated native
app captures confirm the protected serializer, including channel-zero queries.
Those captures do not establish a C35 hardware response. The request candidate
still needs one state-only check on a C35 after publication. A successful state
read would not establish that the normal light control or physical light works.

## Home Assistant device buttons

The existing C35 light buttons are labelled **Experimental** and start disabled.
They use the same guarded command path as the trial. They do not publish a
guessed on/off state. The separate C35 spotlight entity is also labelled
experimental and disabled by default. Its state still requires an independent
reported value. If a state-only check is outstanding, finish that investigation
before trying a light change.
