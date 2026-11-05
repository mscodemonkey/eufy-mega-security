# Experimental general camera video test

This default-off trial requests a ten-second private H.264 clip. Hardware behaviour is unconfirmed. It does not enable normal Home Assistant live view or change existing camera routes, capabilities, snapshots or diagnostic bundles.

The account already configured in the gateway must own the camera. Guest accounts are refused. The camera must be admitted by the integration and its camera or HomeBase must report portal RTC support. NVR cameras and the T8224 doorbell are excluded.

## Run once

1. In **Settings > Apps > Eufy Mega Security**, enable **Experimental general camera video test** (`experimental_general_rtc`) in the app options and restart the app once to apply it.
2. Choose **Open web UI > Open diagnostics**. Enter the gateway API token, load devices and select one camera. Finish other camera activity first.
3. Expand **Experimental general camera video test**. Use HTTPS before entering the Eufy live-view PIN. This is the PIN used for Eufy live view, not the gateway API token.
4. Read the consent text, enter that PIN and tick consent. Choose **Run video test once**.
5. Allow about three minutes. The test wakes the camera and uses battery. It can remain awake for about 40 seconds after capture while the clip is processed.
6. If a clip is offered, download it privately and check whether it plays and shows the selected camera. Keep it private. Report that result, or just the complete `general_rtc_trial_failed` line on failure.

**Cancel video test**, changing the selected camera or leaving the page cancels the request and clears the PIN field. No automatic recording or retry starts.

## Sign-in and PIN limits

Enabling this option does not force login or exchange keys. A valid saved sign-in is reused. If the page reports `reconnect_required`, use the optional explicit sign-in preparation below, or wait for the next natural sign-in. A restart helps only if the saved sign-in has expired.

The gateway also needs its existing native request identities. Normal traffic refreshes them. A missing identity, or a refresh during a trial, can make the run unavailable, including at the final camera check. Try again shortly rather than forcing authentication.

The PIN is sent to Eufy once per dispatched attempt. Wait at least 60 seconds between attempts. Three consecutive unconfirmed requests trigger an advisory local lockout until gateway restart. A connection or service failure can count even when the PIN was correct. A confirmed success resets consecutive failures but keeps the cooldown. Pause after a failed attempt.

## Privacy and limits

The PIN, video-service signature and clip are never persisted by the gateway. The browser clears its PIN field on submission, selection change and page exit. The clip is held in memory and downloaded only when requested. Never include the PIN, token, clip or private account details in a public issue.

While enabled, a future normal sign-in can save an additional private video identity alongside the existing gateway session, using its restricted file permissions. Disabling the option removes that identity from the saved session.

The trial checks fresh ownership and topology before sending a PIN and again after capture. A changed binding or failed final check discards the clip. A required camera start command causes an early refusal because this trial does not send those commands. Native acceptance of the portal preparation endpoints is unconfirmed.

Only H.264 video is accepted. Audio and application sections are rejected, and both the raw recording and MP4 are limited to 32 MiB. Relay servers must use public IP addresses. Hostname relays and some otherwise usable portal configurations are refused. Camera connection candidates may contain private IP addresses, so connection checks can reach local network addresses supplied by Eufy.

The trial uses the current Security service host. The NVR region override has no effect. Some GB-style accounts may fail even when the official portal works. A successful local fixture or decoded test clip does not establish support for another model or account.

## Optional video sign-in preparation

Diagnostics offers a separate **Sign in again for video test** action under the default-off general camera experiment. It asks for explicit, unticked consent and never runs from enabling the option, restarting, opening the page, or requesting a clip. It uses the configured account. It does not ask for a password or PIN.

This pauses the whole gateway, including live view and event delivery. Events during the pause can be missed. The action may replace the saved sign-in and remove its previous video identity. A CAPTCHA or email code may be required in Open web UI. If preparation fails or is abandoned, restart the gateway and complete any authentication there before other operations can resume. There is no automatic rollback or retry.

Stop other viewers, recordings, diagnostic captures and controls first. A temporary busy refusal can also be an existing background lock check. Preparation is account-wide and allows one attempt per ten minutes, including failures. A duplicate request joins the existing attempt. A lost browser response is checked with status reads and never automatically sends another sign-in. Signing-in work has a three-minute active deadline, paused while waiting for challenge input.

Ready means only that a video identity is currently bound. It does not confirm playable camera video. The clip still needs its own PIN and consent, and can refuse if another required native account identity is missing. A completed sign-in can also report identity-unavailable without changing normal media support. Physical behaviour remains unconfirmed until the private clip is tested.

QA must use mocked authentication for this action. Do not force a real account login or actuate a security device during automated validation.
