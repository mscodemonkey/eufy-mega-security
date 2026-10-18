# NVR Schedule guard-mode test

This default-off diagnostic is limited to a T8E00 camera (device type 301) attached to a T8N00 NVR (device type 300). It temporarily changes the whole NVR from Schedule to Home and then attempts to restore Schedule. It does not enable a normal Home Assistant alarm control.

The change can arm cameras or alarms. Only run it while you can observe the whole NVR and can restore Schedule in the Eufy app if the gateway cannot confirm recovery.

## Before starting

1. Update the app and integration to a release containing this test.
2. Confirm the NVR is configured for Schedule in the Eufy app.
3. Enable Experimental NVR video, Experimental model controls, and Experimental NVR controls.
4. Close other live viewers and NVR diagnostics.
5. Confirm the NVR clock is correct and note its IANA timezone, such as `Europe/London`. The gateway cannot retrieve or independently verify that timezone.
6. Open Diagnostics, enter the gateway API token locally, load devices, and select one T8E00 attached to the T8N00.

## Run the test

Expand **Experimental NVR Schedule guard-mode test**, enter the NVR timezone, read the warning, tick the consent box, and choose **Test Home and restore Schedule**.

The gateway records the configured mode and private schedule data from fresh cloud inventory, requests Home once, checks a fresh inventory read and a fresh correlated NVR state reply matching the schedule in the entered timezone, and then restores Schedule under an independent recovery budget. A successful summary requires a fresh effective-mode report from the restored Schedule policy, two fresh Schedule reads, and byte-identical schedule data after restoration.

Cancelling or leaving the page requests restoration, but the browser cannot show the final result after it leaves. A lost connection or gateway restart can prevent automatic restoration. Check the whole NVR in Eufy and restore Schedule manually whenever the result is uncertain.

## What to report

Please share only the displayed summary and whether the NVR visibly entered Home and returned to Schedule. If it fails, share only the `nvr_guard_trial_failed` log line. Do not share account details, device identifiers, schedule data, signalling logs, or captures.

Hardware behaviour remains unconfirmed until a reporter completes the trial. Normal guard-mode controls remain unavailable.

The preflight refuses to write if the schedule cannot be interpreted, the active mode is already Home, the native state disagrees, or a schedule boundary, midnight or daylight-saving change is too close. A baseline mismatch means no change was sent. This deliberately restricted schedule format comes from reporter evidence and still needs hardware confirmation. The state reply establishes a new gateway query, not the age of the appliance's internal cache.

Recovery has its own two-minute budget. A lost response can produce `home_unconfirmed_restored` even when restoration is verified. An unconfirmed restore blocks further NVR trials and normal live starts until the gateway restarts. Restarting does not restore the NVR. Check and restore Schedule in Eufy before restarting, and never use a restart to bypass an uncertain state. A restored trial also has a one-minute cooldown. The entered timezone and consent are cleared after the run.

Browser, proxy or Home Assistant ingress timeouts can hide the final result. Cancellation still requests gateway recovery, so always check the whole NVR when the displayed result is uncertain.

The gateway allows up to 185 seconds for the response. Its Node HTTP request and header timeouts cover receiving the small consent request, rather than imposing a response deadline. The socket timeout is disabled by default and keep-alive applies after a response. External ingress and proxy limits are outside the gateway's control. No proxy settings are changed by this diagnostic.
